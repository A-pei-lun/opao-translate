import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfile,
  defaults,
  normalizeSettings,
  publicSettings,
  resolveProfile,
  exportSettings,
  importLegacy,
  matchesUrl,
  LANGUAGES,
} from '../src/shared/config.js';
import {
  endpoint,
  generationRequest,
  readEventStream,
  discoverModels,
  request,
  HttpError,
  traditionalTranslate,
} from '../src/engine/protocols.js';
import {
  parseTranslations,
  splitText,
  maskText,
  normalizeBoxes,
  validateTokens,
  joinTranslatedParts,
} from '../src/shared/text.js';
import {
  parseSubtitle,
  serializeSubtitle,
  timestamp,
  protectSubtitle,
  parseCaptionPayload,
} from '../src/shared/subtitles.js';
import { safeError, runJob, cancelJob } from '../src/engine/service.js';

test('endpoint paths preserve custom prefixes and queries', () => {
  const profile = {
    ...createProfile('p'),
    baseUrl: 'https://example.test/gateway/v1/chat/completions?tenant=one',
  };
  assert.equal(endpoint(profile).href, profile.baseUrl);
  assert.equal(endpoint({ ...profile, protocol: 'responses' }).pathname, '/gateway/v1/responses');
  assert.equal(
    endpoint(profile, 'models').href,
    'https://example.test/gateway/v1/models?tenant=one',
  );
  assert.equal(
    endpoint({ ...profile, baseUrl: 'https://example.test' }).pathname,
    '/v1/chat/completions',
  );
  assert.equal(
    endpoint({ ...profile, protocol: 'asr' }).pathname,
    '/gateway/v1/audio/transcriptions',
  );
  assert.equal(
    endpoint({
      ...profile,
      endpointMode: 'exact',
      baseUrl: 'https://example.test/private/infer?tenant=a',
    }).href,
    'https://example.test/private/infer?tenant=a',
  );
  assert.throws(() => endpoint({ ...profile, baseUrl: 'javascript:alert(1)' }));
});
test('all original language codes remain selectable', () => {
  assert.ok(LANGUAGES.length >= 116);
  for (const code of ['auto', 'zh-CN', 'zh-TW', 'zh-HK', 'yue', 'wyw', 'bo'])
    assert.ok(LANGUAGES.some(([value]) => value === code));
});
test('native protocols have independent image bodies', () => {
  const image = 'data:image/png;base64,AAAA';
  const profile = { ...createProfile(), baseUrl: 'https://example.test/v1', model: 'model' };
  const response = JSON.parse(
    generationRequest(
      { ...profile, protocol: 'responses' },
      { system: 's', prompt: 'p', images: [image] },
    ).options.body,
  );
  assert.equal(response.input[0].content[1].type, 'input_image');
  assert.equal(response.store, false);
  const claude = generationRequest(
    { ...profile, protocol: 'claude' },
    { system: 's', prompt: 'p', images: [image], key: 'test' },
  );
  assert.equal(claude.options.headers['x-api-key'], 'test');
  assert.equal(
    JSON.parse(claude.options.body).messages[0].content[1].source.media_type,
    'image/png',
  );
  const gemini = JSON.parse(
    generationRequest(
      { ...profile, protocol: 'gemini' },
      { system: 's', prompt: 'p', images: [image] },
    ).options.body,
  );
  assert.equal(gemini.contents[0].parts[1].inlineData.mimeType, 'image/png');
});
test('model listing supports a server without an API key', async () => {
  const profile = { ...createProfile(), baseUrl: 'http://localhost:11434/v1/chat/completions' };
  const result = await discoverModels(profile, {
    key: '',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/v1/models');
      assert.equal(options.headers.Authorization, undefined);
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.deepEqual(result, ['local-model']);
});
test('anonymous Bing and Google use array and form contracts without keys', async () => {
  const items = [
    { id: 'a', text: 'Hello' },
    { id: 'b', text: 'World' },
  ];
  const profile = { ...createProfile(), baseUrl: 'https://example.test/translate' };
  const bing = await traditionalTranslate(
    { ...profile, protocol: 'bing-free' },
    items,
    'auto',
    'zh-CN',
    {
      fetchImpl: async (url, options) => {
        assert.equal(new URL(url).searchParams.get('to'), 'zh-Hans');
        assert.deepEqual(JSON.parse(options.body), ['Hello', 'World']);
        return new Response(
          JSON.stringify([
            { translations: [{ text: '你好' }] },
            { translations: [{ text: '世界' }] },
          ]),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    },
  );
  assert.deepEqual(
    bing.map((item) => item.text),
    ['你好', '世界'],
  );
  const google = await traditionalTranslate(
    { ...profile, protocol: 'google-free' },
    items,
    'auto',
    'zh-CN',
    {
      fetchImpl: async (_url, options) => {
        assert.deepEqual(new URLSearchParams(options.body).getAll('q'), ['Hello', 'World']);
        return new Response(
          JSON.stringify([
            ['你好', 'en'],
            ['世界', 'en'],
          ]),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    },
  );
  assert.deepEqual(
    google.map((item) => item.text),
    ['你好', '世界'],
  );
});
test('UTF8 fragmented SSE returns complete response text', async () => {
  const bytes = new TextEncoder().encode(
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":" world"}\n\ndata: [DONE]\n\n',
  );
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else {
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset += 7;
      }
    },
  });
  assert.equal(await readEventStream(new Response(stream), 'responses'), '你好 world');
});
test('translation IDs are restored in input order and missing IDs fail', () => {
  const items = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ];
  assert.deepEqual(
    parseTranslations(
      '```json\n{"translations":[{"id":"b","text":"乙"},{"id":"a","text":"甲"}]}\n```',
      items,
    ),
    [
      { id: 'a', text: '甲' },
      { id: 'b', text: '乙' },
    ],
  );
  assert.throws(
    () => parseTranslations('{"translations":[{"id":"a","text":"甲"}]}', items),
    /漏掉/,
  );
  assert.throws(
    () => parseTranslations('{"translations":[{"id":"a","text":""}]}', [items[0]]),
    /空译文/,
  );
});
test('text splitting preserves content and avoids splitting placeholder tokens', () => {
  const text = 'Some words. '.repeat(200) + '{{OPAO123S1}}' + 'test'.repeat(200);
  const chunks = splitText(text, 200);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => !chunk.includes('{{OPAO') || chunk.includes('}}')));
});
test('missing or duplicated protected tokens are rejected', () => {
  validateTokens('A {{OPAOabcK1}} {{OPAOPRIV0}}', '译文 {{OPAOPRIV0}} {{OPAOabcK1}}');
  assert.throws(() => validateTokens('A {{OPAOPRIV0}}', '译文'), /占位符/);
  assert.throws(() => validateTokens('{{OPAOabcK1}}', '{{OPAOabcK1}} {{OPAOabcK1}}'), /占位符/);
});
test('translated chunks preserve explicit whitespace and separate English sentences', () => {
  assert.equal(joinTranslatedParts(['First.', 'Next.'], 'en'), 'First. Next.');
  assert.equal(joinTranslatedParts(['First.\n\n', 'Next.'], 'en'), 'First.\n\nNext.');
  assert.equal(joinTranslatedParts(['第一句。', '第二句。'], 'zh-CN'), '第一句。第二句。');
});
test('privacy tokens restore the original values', () => {
  const masked = maskText('Contact person@example.test or +86 138 0013 8000.', true);
  assert.ok(!masked.text.includes('person@example.test'));
  assert.equal(masked.restore(masked.text), 'Contact person@example.test or +86 138 0013 8000.');
});
test('vision coordinate units are explicit and invalid boxes are removed', () => {
  const boxes = normalizeBoxes(
    [
      { box: [0.1, 0.2, 0.3, 0.4], translation: '译文' },
      { box: [100, 200, 300, 400], units: '1000', translation: '译文' },
      { box: [4, 3, 2, 1], translation: 'invalid' },
      { box: [0, 0, 0, 1], translation: 'invalid' },
    ],
    1000,
    500,
  );
  assert.equal(boxes.length, 2);
  assert.deepEqual([boxes[0].x, boxes[0].y, boxes[0].w, boxes[0].h], [100, 100, 300, 200]);
});
test('SRT and VTT preserve timecodes and settings', () => {
  const srt = parseSubtitle(
    '1\n00:00:01,000 --> 00:00:03,200\nHello\n\n2\n00:00:04,000 --> 00:00:05,000\nWorld',
  );
  assert.equal(srt.cues.length, 2);
  srt.cues[0].translation = '你好';
  const output = serializeSubtitle(srt);
  assert.match(output, /Hello\n你好/);
  assert.match(output, /00:00:03,200/);
  const vtt = parseSubtitle('WEBVTT\n\nfirst\n00:01.200 --> 00:03.000 align:start\nHello', 'vtt');
  assert.equal(vtt.cues[0].start, 1.2);
  assert.match(serializeSubtitle(vtt), /align:start/);
  assert.equal(timestamp(3601.015), '01:00:01,015');
});
test('ASS dialogue commas and styling survive translation', () => {
  const ass =
    '[Script Info]\nTitle: test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello, world{\\i0}';
  const document = parseSubtitle(ass, 'ass');
  assert.match(document.cues[0].text, /Hello, world/);
  const protectedText = protectSubtitle(document.cues[0].text);
  assert.ok(!protectedText.text.includes('{\\i1}'));
  document.cues[0].translation = protectedText.restore(
    protectedText.text.replace('Hello, world', '你好，世界'),
  );
  const output = serializeSubtitle(document, 'translation');
  assert.match(output, /\{\\i1\}你好，世界\{\\i0\}/);
});
test('YouTube JSON and Bilibili JSON subtitle payloads parse', () => {
  assert.equal(
    parseCaptionPayload(
      JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] }],
      }),
    )[0].start,
    1,
  );
  assert.equal(
    parseCaptionPayload(JSON.stringify({ body: [{ from: 1, to: 2, content: 'World' }] }))[0].text,
    'World',
  );
});
test('profiles retain roles and public settings exclude secrets', () => {
  const profile = {
    ...createProfile('one'),
    apiKey: 'private-secret',
    baseUrl: 'https://example.test/v1',
    model: 'example',
    headers: { Authorization: 'secret' },
  };
  const settings = normalizeSettings({
    profiles: [profile],
    roles: { text: 'one', vision: 'one' },
  });
  assert.equal(settings.roles.vision, 'one');
  assert.ok(!JSON.stringify(publicSettings(settings)).includes('private-secret'));
  assert.throws(() => resolveProfile(settings, 'vision'), /视觉/);
});
test('default export removes nested body and URL credentials', () => {
  const settings = normalizeSettings({
    profiles: [
      {
        ...createProfile('one'),
        baseUrl: 'https://private-user:private-pass@example.test/v1?api_key=hidden',
        apiKey: 'hidden',
        headers: { Cookie: 'private-cookie', 'x-api-key': 'private-header' },
        body: {
          api_key: 'private-body',
          extra: { access_token: 'private-nested' },
          max_tokens: 4000,
        },
      },
    ],
  });
  const result = exportSettings(settings);
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.ok(!result.profiles[0].baseUrl.includes('hidden'));
  assert.equal(result.profiles[0].body.max_tokens, 4000);
});
test('URL patterns cover domains, subdomains and scheme-less paths', () => {
  assert.equal(matchesUrl('example.test', 'https://sub.example.test/a'), true);
  assert.equal(matchesUrl('*.example.test', 'https://example.test/a'), true);
  assert.equal(matchesUrl('example.test/articles/*', 'https://example.test/articles/one'), true);
  assert.equal(matchesUrl('https://*.example.test/*', 'https://sub.example.test/a'), true);
  assert.equal(matchesUrl('example.test', 'https://badexample.test/a'), false);
});
test('legacy imports exclude paid profiles and retain custom credentials', () => {
  const settings = importLegacy({
    translationService: 'mine',
    translationServices: {
      paid: { provider: 'pro', apiUrl: 'https://paid.test', APIKEY: 'paid' },
      mine: { apiUrl: 'https://example.test/v1', model: 'model', APIKEY: 'mine-key' },
    },
  });
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0].apiKey, 'mine-key');
});
test('upstream errors redact all configured keys', () => {
  const settings = normalizeSettings({
    profiles: [{ ...createProfile(), apiKey: 'one-secret,two-secret' }],
  });
  const result = safeError(new Error('one-secret two-secret https://test/a?token=other'), settings);
  assert.ok(!result.includes('one-secret'));
  assert.ok(!result.includes('two-secret'));
  assert.ok(!result.includes('=other'));
});
test('HTTP errors include status but exclude HTML bodies', async () => {
  await assert.rejects(
    request(
      'https://example.test',
      {},
      { fetchImpl: async () => new Response('<html>Bad gateway</html>', { status: 502 }) },
    ),
    (error) =>
      error instanceof HttpError && error.status === 502 && !error.message.includes('html'),
  );
});
test('text generation honors per-profile concurrency and cancellation ownership', async () => {
  const originalFetch = globalThis.fetch;
  let active = 0,
    peak = 0;
  globalThis.fetch = async (_url, options) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        const abort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      active--;
    }
  };
  try {
    const settings = normalizeSettings({
      ...defaults(),
      cache: false,
      profiles: [
        {
          ...createProfile('one'),
          baseUrl: 'https://example.test/v1',
          model: 'fixture',
          retries: 0,
          concurrency: 1,
        },
      ],
      roles: { text: 'one' },
    });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runJob(
          settings,
          { kind: 'generate', prompt: 'test', jobId: 'concurrent-' + index },
          'owner',
        ),
      ),
    );
    assert.equal(peak, 1);
    const promise = runJob(
      settings,
      { kind: 'generate', prompt: 'test', jobId: 'cancel-me' },
      'owner',
    );
    cancelJob('cancel-me', 'different-owner');
    await promise;
    const cancelled = runJob(
      settings,
      { kind: 'generate', prompt: 'test', jobId: 'cancel-real' },
      'owner',
    );
    cancelJob('cancel-real', 'owner');
    await assert.rejects(cancelled);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
