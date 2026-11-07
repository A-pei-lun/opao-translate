import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { createProfile, normalizeSettings } from '../src/shared/config.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(source, '..');
const manifestSource = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
const version = manifestSource.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid test version');
const extension = path.join(project, '05_构建产物', 'O泡翻译-' + version);
const evidence = path.join(project, '04_验证', version, 'Edge端到端');
const profile = path.join(evidence, '测试配置');
await fs.mkdir(evidence, { recursive: true });
if (
  path.resolve(profile) !==
  path.join(path.resolve(project), '04_验证', version, 'Edge端到端', '测试配置')
)
  throw new Error('Invalid test profile path');
try {
  const info = await fs.lstat(profile);
  if (info.isSymbolicLink()) throw new Error('Test profile is a symbolic link');
  if ((await fs.readFile(path.join(profile, 'TASK_OWNED'), 'utf8')) !== 'opao-browser-tests')
    throw new Error('Test profile ownership mismatch');
  await fs.rm(profile, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(path.join(profile, 'TASK_OWNED'), 'opao-browser-tests');
const image = await fs.readFile(path.join(source, 'tests/fixtures/image.png'));
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf
  .addPage([500, 300])
  .drawText('Hello world. Read this document carefully.', { x: 40, y: 230, size: 18, font });
const embedded = await pdf.embedPng(image);
pdf.addPage([500, 300]).drawImage(embedded, { x: 10, y: 30, width: 480, height: 240 });
const pdfBytes = await pdf.save();
const epubBytes = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
  ),
  'OPS/book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
  ),
  'OPS/one.xhtml': strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title></head><body><h1>Chapter one</h1><p>Hello <em>world</em>.</p><img src="cover.png"/></body></html>',
  ),
  'OPS/two.xhtml': strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1>Chapter two</h1><p>Another paragraph.</p></body></html>',
  ),
  'OPS/cover.png': image,
});
await fs.writeFile(path.join(evidence, 'fixture.pdf'), pdfBytes);
await fs.writeFile(path.join(evidence, 'fixture.epub'), epubBytes);
const srt =
  '1\n00:00:00,000 --> 00:00:02,000\n<i>Hello world</i>\n\n2\n00:00:02,000 --> 00:00:04,000\nRead together.\n';
await fs.writeFile(path.join(evidence, 'fixture.srt'), srt);
await fs.writeFile(
  path.join(evidence, 'fixture.html'),
  '<!doctype html><html><head><title>Test</title></head><body><p>Hello <em>world</em></p><script>window.UNTRUSTED_FILE_EXECUTED=true</script></body></html>',
);
await fs.writeFile(path.join(evidence, 'fixture.txt'), 'Hello world.\n\nRead together.');
const wav = Buffer.alloc(44 + 32000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(32000, 40);
await fs.writeFile(path.join(evidence, 'fixture.wav'), wav);

const apiCalls = [],
  browserErrors = [],
  requests = [];
function json(response, data, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(data));
}
const html = `<!doctype html><html lang="en"><head><title>Fixture article</title><style>body{font:18px/1.8 Arial;padding:35px;max-width:900px}img{max-width:480px}iframe{width:100%;height:150px}</style></head><body><main><h1>Reading together</h1><p id="plain">Hello world. This paragraph is ready for translation.</p><p id="rich">Read <em>carefully</em> and open <a href="#notes" id="link">this link</a>.</p><div id="dynamic"></div><div id="shadow-host"></div><textarea id="input">Hello input</textarea><p><img id="image" src="/image.png" width="480" height="240"></p><div data-opao-caption id="caption">Hello captions</div><iframe src="/frame"></iframe></main><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<p id="shadow-text">Hello shadow reader</p>';window.addDynamic=()=>{const p=document.createElement('p');p.id='added';p.textContent='A newly added paragraph.';document.querySelector('#dynamic').append(p)};</script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    res.end();
    return;
  }
  if (req.url === '/' || req.url === '/article' || req.url === '/next') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      html.replace('</main>', '</main><aside><p id="outside">Outside article text.</p></aside>'),
    );
    return;
  }
  if (req.url === '/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><p id="frame-text">Hello frame reader</p></body></html>');
    return;
  }
  if (req.url === '/image.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(image);
    return;
  }
  if (req.url === '/protected.png') {
    if (req.headers.referer !== base + '/') {
      res.writeHead(403);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(image);
    }
    return;
  }
  if (
    req.url.startsWith('/v1/models') ||
    (req.url.startsWith('/v1beta/models') && req.method === 'GET')
  ) {
    json(res, {
      data: [{ id: 'fixture-text' }, { id: 'fixture-vision' }, { id: 'fixture-asr' }],
      models: [{ name: 'models/fixture-text' }],
    });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  apiCalls.push({
    path: req.url,
    bytes: raw.length,
    hasAuth: Boolean(
      req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'],
    ),
  });
  if (req.url.includes('/audio/transcriptions')) {
    json(res, {
      text: 'Hello audio',
      duration: 1,
      segments: [{ start: 0, end: 1, text: 'Hello audio' }],
    });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString());
  } catch {
    json(res, { error: { message: 'Invalid JSON' } }, 400);
    return;
  }
  apiCalls.at(-1).model = body.model || '';
  const content =
    body.messages?.at(-1)?.content || body.input?.[0]?.content || body.contents?.[0]?.parts || '';
  const hasImage =
    Array.isArray(content) &&
    content.some(
      (part) =>
        part.type === 'image_url' ||
        part.type === 'input_image' ||
        part.type === 'image' ||
        part.inlineData,
    );
  const prompt =
    typeof content === 'string' ? content : content.map((part) => part.text || '').join('\n');
  let output;
  if (hasImage)
    output = JSON.stringify({
      blocks: [
        {
          box: [0.1, 0.15, 0.75, 0.5],
          units: 'normalized',
          text: 'Hello image',
          translation: '图片译文',
          direction: 'horizontal',
        },
      ],
    });
  else {
    let parsed;
    try {
      parsed = JSON.parse(prompt);
    } catch {}
    if (parsed?.items)
      output = JSON.stringify({
        translations: parsed.items.map((item) => ({ id: item.id, text: '译文 ' + item.text })),
      });
    else output = '生成文本 OK';
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const responseProtocol = req.url.endsWith('/responses');
    res.write(
      'data: ' +
        JSON.stringify(
          responseProtocol
            ? { type: 'response.output_text.delta', delta: output }
            : { choices: [{ delta: { content: output } }] },
        ) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  if (req.url.endsWith('/responses'))
    json(res, { output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] });
  else if (req.url.endsWith('/messages')) json(res, { content: [{ type: 'text', text: output }] });
  else if (req.url.includes(':generateContent'))
    json(res, { candidates: [{ content: { parts: [{ text: output }] } }] });
  else json(res, { choices: [{ message: { content: output } }] });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [];
let context;
async function check(name, work) {
  const started = Date.now();
  try {
    await work();
    checks.push({ name, status: 'PASS', durationMs: Date.now() - started });
    console.log('PASS ' + name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', durationMs: Date.now() - started, error: error.message });
    console.log('FAIL ' + name + ' ' + error.message.slice(0, 300));
  }
}
async function rpcPage(page, kind, payload = {}) {
  const result = await page.evaluate(
    ({ kind, payload }) => chrome.runtime.sendMessage({ channel: 'opao', kind, ...payload }),
    { kind, payload },
  );
  if (!result?.ok) throw new Error(result?.error || 'RPC failed');
  return result.data;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  context.setDefaultTimeout(8000);
  context.on('page', (page) =>
    page.on('pageerror', (error) => browserErrors.push({ url: page.url(), error: error.message })),
  );
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 20000 }));
  const workerUrl = new URL(worker.url());
  const origin = workerUrl.protocol + '//' + workerUrl.host;
  const configuration = normalizeSettings({
    profiles: [
      {
        ...createProfile('main'),
        name: '测试文本与视觉',
        baseUrl: base + '/v1',
        model: 'fixture-text',
        apiKey: '',
        retries: 0,
        capabilities: { text: true, vision: true, asr: false },
      },
      {
        ...createProfile('asr'),
        name: '测试语音',
        protocol: 'asr',
        baseUrl: base + '/v1',
        model: 'fixture-asr',
        retries: 0,
        capabilities: { text: false, vision: false, asr: true },
        responseFormat: 'verbose_json',
      },
      {
        ...createProfile('second'),
        name: '备选模拟接口',
        baseUrl: base + '/v1',
        model: 'fixture-second',
        retries: 0,
      },
    ],
    roles: { text: 'main', input: 'main', vision: 'main', subtitle: 'main', asr: 'asr' },
    lazy: false,
    subtitlePretranslate: false,
    cache: true,
    comparisonProfiles: ['main', 'second'],
  });
  const settingsPage = await context.newPage();
  await settingsPage.goto(origin + '/settings.html');
  await settingsPage.getByRole('button', { name: '保存设置', exact: true }).waitFor();
  await rpcPage(settingsPage, 'save-settings', { settings: configuration });
  await settingsPage.reload();
  await settingsPage.getByRole('button', { name: '保存设置', exact: true }).waitFor();
  await check('settings normal save and repeated edit', async () => {
    await settingsPage.getByLabel('服务名称', { exact: true }).fill('本地模拟接口');
    await settingsPage.getByRole('button', { name: '保存设置', exact: true }).click();
    await settingsPage.getByText('设置已保存', { exact: true }).waitFor();
    await settingsPage.getByLabel('模型 ID', { exact: true }).fill('fixture-text-edited');
    await settingsPage.getByRole('button', { name: '保存设置', exact: true }).click();
    await settingsPage.getByText('设置已保存', { exact: true }).waitFor();
    const config = await rpcPage(settingsPage, 'get-settings');
    assert.equal(config.profiles[0].model, 'fixture-text-edited');
  });
  await check('model discovery without an API key', async () => {
    const models = await rpcPage(settingsPage, 'models', { profileId: 'main' });
    assert.equal(models.length, 3);
  });
  await check('protected image referrer and temporary rule cleanup', async () => {
    const images = await Promise.all(
      [0, 1].map(() =>
        rpcPage(settingsPage, 'fetch-image', {
          url: base + '/protected.png',
          referrer: base + '/article?private=value',
        }),
      ),
    );
    assert.ok(images.every((image) => image.dataUrl.startsWith('data:image/png;base64,')));
    assert.deepEqual(
      await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()),
      [],
    );
  });
  await check('Chat Responses Claude Gemini runtime interoperability', async () => {
    for (const protocol of ['chat', 'responses', 'claude', 'gemini']) {
      const profile = {
        ...configuration.profiles[0],
        protocol,
        baseUrl: base + (protocol === 'gemini' ? '/v1beta' : '/v1'),
        apiKey: 'fixture-test-key',
      };
      const result = await rpcPage(settingsPage, 'test-profile', { profile });
      assert.match(result.text, /OK/);
    }
  });
  await check('settings light dark and narrow layout', async () => {
    await settingsPage.getByRole('button', { name: '阅读与交互', exact: true }).click();
    await settingsPage.getByLabel('界面主题', { exact: true }).selectOption('light');
    await settingsPage.screenshot({ path: path.join(evidence, '设置-浅色.png'), fullPage: true });
    await settingsPage.getByLabel('界面主题', { exact: true }).selectOption('dark');
    const dark = await settingsPage.evaluate(() => ({
      background: getComputedStyle(document.querySelector('#save-settings')).backgroundColor,
      foreground: getComputedStyle(document.querySelector('#save-settings')).color,
    }));
    assert.equal(dark.background.replace(/\s/g, ''), 'rgb(120,214,209)');
    assert.equal(dark.foreground.replace(/\s/g, ''), 'rgb(29,48,64)');
    await settingsPage.screenshot({ path: path.join(evidence, '设置-深色.png'), fullPage: true });
    await settingsPage.setViewportSize({ width: 390, height: 900 });
    assert.ok(
      await settingsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    );
    await settingsPage.screenshot({ path: path.join(evidence, '设置-窄屏.png'), fullPage: true });
    await settingsPage.setViewportSize({ width: 1280, height: 900 });
  });
  const page = await context.newPage();
  await page.goto(base + '/article');
  await page.locator('opao-reader-ui').waitFor();
  const act = async (action, payload = {}, frameId) => {
    await page.bringToFront();
    const result = await rpcPage(settingsPage, 'tab-action', { action, payload, frameId });
    if (result?.ok === false) throw new Error(result.error);
    return result;
  };
  await check('floating button translates and restores all page frames', async () => {
    await page
      .locator('opao-reader-ui')
      .getByRole('button', { name: '切换网页双语翻译', exact: true })
      .click();
    await page.locator('#plain > .opao-target[data-state=done]').waitFor();
    await page.frameLocator('iframe').locator('.opao-target[data-state=done]').waitFor();
    await page
      .locator('opao-reader-ui')
      .getByRole('button', { name: '切换网页双语翻译', exact: true })
      .click();
    await page.waitForFunction(() => !document.querySelector('.opao-target'));
  });
  await check(
    'complete inline paragraphs, breaks and flex/grid translations stack naturally',
    async () => {
      const originals = await page.evaluate(() => {
        const section = document.createElement('section');
        section.id = 'paragraph-fixtures';
        section.innerHTML =
          '<div id="inline-paragraph">A complete <strong>paragraph</strong> keeps <a href="#notes">every link</a> together.</div><div id="nested-paragraph"><span>Nested <em>inline nodes</em> belong to </span><span>one complete paragraph.</span></div><div id="break-paragraph">First full paragraph <em>before the break.</em><br><br>Second full paragraph <a href="#notes">after the break.</a></div><h3 id="flex-heading" style="display:flex;gap:8px"><span>Description</span><span>details</span></h3><div id="grid-paragraph" style="display:grid;grid-template-columns:auto 1fr;gap:8px"><span>A full</span><strong>grid paragraph</strong></div><div id="mixed-container">Text before the nested block.<p id="inner-canonical">A canonical paragraph.</p>Text after the nested block.</div>';
        document.querySelector('main').append(section);
        const shadow = document.createElement('div');
        shadow.id = 'inline-shadow-fixture';
        section.append(shadow);
        shadow.attachShadow({ mode: 'open' }).innerHTML =
          'A full <em>shadow paragraph</em> stays together.';
        return Object.fromEntries(
          [...section.children].map((element) => [element.id, element.innerHTML]),
        );
      });
      await act('toggle-page');
      for (const id of ['inline-paragraph', 'nested-paragraph', 'flex-heading', 'grid-paragraph'])
        await page.locator('#' + id + ' > .opao-target[data-state=done]').waitFor();
      assert.equal(await page.locator('#inline-paragraph .opao-target').count(), 1);
      assert.equal(await page.locator('#nested-paragraph .opao-target').count(), 1);
      await page
        .locator('#inline-shadow-fixture')
        .locator('.opao-target[data-state=done]')
        .waitFor();
      assert.equal(await page.locator('#inline-shadow-fixture').locator('.opao-target').count(), 1);
      await page.locator('#break-paragraph .opao-target[data-state=done]').nth(1).waitFor();
      assert.equal(await page.locator('#break-paragraph .opao-target').count(), 2);
      await page.locator('#mixed-container .opao-target[data-state=done]').nth(2).waitFor();
      const geometry = await page.evaluate(() =>
        ['inline-paragraph', 'nested-paragraph', 'flex-heading', 'grid-paragraph'].map((id) => {
          const element = document.getElementById(id),
            target = element.querySelector(':scope>.opao-target');
          const range = document.createRange();
          range.selectNodeContents(element);
          range.setEndBefore(target);
          return {
            id,
            originalBottom: range.getBoundingClientRect().bottom,
            translationTop: target.getBoundingClientRect().top,
          };
        }),
      );
      for (const item of geometry)
        assert.ok(item.translationTop >= item.originalBottom - 1, JSON.stringify(item));
      await page.waitForTimeout(650);
      assert.equal(await page.locator('#flex-heading .opao-target').count(), 1);
      assert.equal(await page.locator('#grid-paragraph .opao-target').count(), 1);
      await act('only-translation');
      assert.equal(
        await page.locator('#inline-paragraph>.opao-source.opao-source-hidden').count(),
        1,
      );
      assert.equal(await page.locator('#break-paragraph .opao-target').count(), 2);
      await act('only-translation');
      assert.equal(await page.locator('#inline-paragraph>.opao-source').count(), 0);
      await page
        .locator('#paragraph-fixtures')
        .screenshot({ path: path.join(evidence, '整段自然对照.png') });
      await act('restore');
      const restored = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelector('#paragraph-fixtures').children].map((element) => [
            element.id,
            element.innerHTML,
          ]),
        ),
      );
      assert.deepEqual(restored, originals);
      assert.equal(
        await page
          .locator('#flex-heading')
          .evaluate((element) => element.style.getPropertyValue('flex-wrap')),
        '',
      );
      await page.evaluate(() => document.querySelector('#paragraph-fixtures').remove());
    },
  );
  const revealDock = async () => {
    const button = page
      .locator('opao-reader-ui')
      .getByRole('button', { name: '切换网页双语翻译', exact: true });
    const box = await button.boundingBox();
    await page.mouse.move(Math.max(5, Math.min(1275, box.x + 12)), box.y + 23);
    await page.waitForFunction(
      () =>
        !document
          .querySelector('opao-reader-ui')
          .shadowRoot.querySelector('.floating-dock')
          .classList.contains('is-collapsed'),
    );
    await page.waitForTimeout(190);
    return button;
  };
  await check(
    'floating drag suppresses translation, persists and docks to both edges',
    async () => {
      let button = await revealDock(),
        box = await button.boundingBox();
      const count = apiCalls.length;
      await page.mouse.move(box.x + 23, box.y + 23);
      await page.mouse.down();
      await page.mouse.move(360, 330, { steps: 12 });
      await page.mouse.up();
      await page.mouse.move(150, 100);
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.opao-target').count(), 0);
      assert.equal(apiCalls.length, count);
      let stored = await rpcPage(settingsPage, 'get-floating-position');
      assert.equal(stored.side, null);
      const freeX = await button.evaluate((element) => element.getBoundingClientRect().left);
      await page.reload();
      await page.locator('opao-reader-ui').waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('opao-reader-ui').shadowRoot.querySelector('.floating-dock')
            .dataset.side === 'free',
      );
      button = await revealDock();
      assert.ok(Math.abs((await button.boundingBox()).x - freeX) < 3);
      await page.evaluate(() => {
        window.__dragTrace = [];
        const root = document.querySelector('opao-reader-ui').shadowRoot,
          button = root.querySelector('.floating');
        for (const type of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
          'lostpointercapture',
        ])
          button.addEventListener(type, (event) =>
            window.__dragTrace.push({
              type,
              x: event.clientX,
              y: event.clientY,
              left: root.querySelector('.floating-dock').style.left,
              side: root.querySelector('.floating-dock').dataset.side,
            }),
          );
      });
      box = await button.boundingBox();
      await page.mouse.move(box.x + 23, box.y + 23);
      await page.mouse.down();
      await page.mouse.move(7, 340, { steps: 12 });
      await page.mouse.up();
      await page.mouse.move(200, 200);
      await page.waitForTimeout(750);
      stored = await rpcPage(settingsPage, 'get-floating-position');
      const trace = await page.evaluate(() => window.__dragTrace);
      await fs.writeFile(
        path.join(evidence, '浮球拖动诊断.json'),
        JSON.stringify({ stored, trace }, null, 2),
      );
      if (stored.side !== 'left')
        await page.screenshot({ path: path.join(evidence, '浮球拖动诊断.png') });
      assert.equal(stored.side, 'left', JSON.stringify(trace));
      box = await button.boundingBox();
      assert.ok(box.x < 0 && box.x + box.width > 8);
      button = await revealDock();
      box = await button.boundingBox();
      await page.mouse.move(box.x + 23, box.y + 23);
      await page.mouse.down();
      await page.mouse.move(1274, 300, { steps: 12 });
      await page.mouse.up();
      await page.mouse.move(200, 150);
      await page.waitForTimeout(750);
      stored = await rpcPage(settingsPage, 'get-floating-position');
      assert.equal(stored.side, 'right');
      box = await button.boundingBox();
      assert.ok(box.x < 1280 && box.x + box.width > 1280);
    },
  );
  await check('hover setting entry switches configured models from the page', async () => {
    await revealDock();
    const host = page.locator('opao-reader-ui');
    await host.getByRole('button', { name: '打开页内设置', exact: true }).click();
    const panel = host.getByRole('dialog', { name: '页内设置', exact: true });
    await panel.waitFor();
    await panel.getByLabel('页内翻译服务', { exact: true }).selectOption('second');
    await panel.getByText('默认翻译服务已切换', { exact: true }).waitFor();
    const saved = await rpcPage(settingsPage, 'get-settings');
    assert.equal(saved.roles.text, 'second');
    assert.equal(saved.roles.vision, 'main');
    assert.equal(saved.roles.input, 'main');
    await panel.getByRole('button', { name: '翻译页面', exact: true }).click();
    await page.locator('#plain>.opao-target[data-state=done]').waitFor();
    assert.ok(apiCalls.some((call) => call.model === 'fixture-second'));
    await act('only-translation');
    await panel.getByLabel('页内翻译偏好', { exact: true }).selectOption('bilingual');
    await page.waitForFunction(
      () => !document.querySelector('#plain>.opao-source.opao-source-hidden'),
    );
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(100);
    assert.ok(
      await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      }),
    );
    await panel.screenshot({ path: path.join(evidence, '页内设置-窄屏.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.screenshot({ path: path.join(evidence, '页内服务设置.png') });
    await panel.getByRole('button', { name: '显示原文', exact: true }).click();
    await panel.getByLabel('页内翻译服务', { exact: true }).selectOption('main');
    await panel.getByText('默认翻译服务已切换', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '关闭页内设置', exact: true }).click();
  });
  await check('eight appearance styles and custom font update without model requests', async () => {
    await act('toggle-page');
    await page.locator('#plain>.opao-target[data-state=done]').waitFor();
    await page.frameLocator('iframe').locator('.opao-target[data-state=done]').waitFor();
    await page.waitForTimeout(450);
    const count = apiCalls.length;
    for (const style of [
      'muted',
      'plain',
      'line',
      'soft',
      'underline',
      'dashed',
      'highlight',
      'italic',
    ]) {
      await rpcPage(settingsPage, 'set-page-preferences', {
        translationStyle: style,
        translationFont: 'Georgia',
        translationFontWeight: '600',
        textSize: 115,
        translationLineHeight: 1.9,
        translationParagraphGap: 0.7,
      });
      await page.waitForFunction(
        (style) => document.querySelector('#plain>.opao-target')?.dataset.style === style,
        style,
      );
      assert.ok(
        (
          await page
            .locator('#plain>.opao-target')
            .evaluate((element) => getComputedStyle(element).fontFamily)
        ).includes('Georgia'),
      );
    }
    assert.equal(apiCalls.length, count);
    await settingsPage.reload();
    await settingsPage.getByRole('button', { name: '阅读与交互', exact: true }).click();
    await settingsPage.getByText('设置字体、字重和段落间距', { exact: true }).click();
    await settingsPage.getByLabel('译文字体', { exact: true }).selectOption('__custom');
    await settingsPage
      .getByLabel('自定义译文字体', { exact: true })
      .fill('Arial, SimSun, sans-serif');
    await settingsPage.getByLabel('译文样式', { exact: true }).selectOption('muted');
    assert.ok(
      (
        await settingsPage
          .locator('.reading-preview>.opao-target')
          .evaluate((element) => getComputedStyle(element).fontFamily)
      ).includes('Arial'),
    );
    await settingsPage.getByRole('button', { name: '保存设置', exact: true }).click();
    await settingsPage.getByText('设置已保存', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('#plain>.opao-target')).fontFamily.includes('Arial'),
    );
    assert.equal(apiCalls.length, count);
    await settingsPage.getByText('预览全部译文样式', { exact: true }).click();
    assert.equal(await settingsPage.locator('.style-choice').count(), 8);
    await settingsPage.getByText('设置字体、字重和段落间距', { exact: true }).click();
    const radioWidth = await settingsPage
      .locator('.style-choice input[type=radio]')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(radioWidth <= 20);
    await settingsPage.screenshot({
      path: path.join(evidence, '译文样式与自定义字体.png'),
      fullPage: true,
    });
    await act('restore');
  });
  await check('page bilingual rich text iframe and Shadow DOM', async () => {
    await act('toggle-page');
    await page.locator('#plain > .opao-target[data-state=done]').waitFor();
    assert.match(await page.locator('#plain > .opao-target').innerText(), /译文/);
    assert.equal(await page.locator('#rich > .opao-target em').count(), 1);
    assert.equal(await page.locator('#rich > .opao-target a').getAttribute('href'), '#notes');
    await page.locator('#shadow-host').locator('.opao-target[data-state=done]').waitFor();
    await page.frameLocator('iframe').locator('.opao-target[data-state=done]').waitFor();
    assert.equal(await page.locator('#outside > .opao-target').count(), 0);
  });
  await check('dynamic text and SPA follow the active translation state', async () => {
    await page.evaluate(() => window.addDynamic());
    await page.locator('#added > .opao-target[data-state=done]').waitFor();
    await page.evaluate(() => history.pushState({}, '', '/next'));
    await page.waitForTimeout(1100);
    await page.locator('#plain > .opao-target[data-state=done]').waitFor();
  });
  await check('translation-only mask and full restoration', async () => {
    await act('only-translation');
    assert.ok(
      await page
        .locator('#plain > .opao-source')
        .evaluate((element) => element.classList.contains('opao-source-hidden')),
    );
    await act('toggle-mask');
    assert.equal(await page.locator('#plain > .opao-target.opao-masked').count(), 1);
    await act('restore');
    assert.equal(await page.locator('.opao-target').count(), 0);
    assert.equal(await page.locator('#link').getAttribute('href'), '#notes');
  });
  await check('whole-page mode includes text outside the article', async () => {
    await act('whole-page');
    await page.locator('#outside > .opao-target[data-state=done]').waitFor();
    await act('restore');
  });
  await check('modifier hover translates one paragraph', async () => {
    await page.keyboard.down('Alt');
    await page.locator('#plain').hover();
    await page.locator('#plain > .opao-target[data-state=done]').waitFor();
    await page.keyboard.up('Alt');
    await act('restore');
  });
  await check('selection translation and writing panel', async () => {
    await act('selection', { text: 'Hello selection' });
    await page
      .locator('opao-reader-ui')
      .getByText('译文 Hello selection', { exact: true })
      .waitFor();
    await page.locator('opao-reader-ui').getByRole('button', { name: '关闭翻译面板' }).click();
    await act('writing', { text: 'Hello draft' });
    await page.locator('opao-reader-ui').getByText('生成文本 OK', { exact: true }).waitFor();
    await page.locator('opao-reader-ui').getByRole('button', { name: '关闭翻译面板' }).click();
  });
  await check('input translation and native value setter refill', async () => {
    await page.locator('#input').fill('Hello input');
    await page.locator('#input').focus();
    await act('translate-input');
    await page.locator('opao-reader-ui').getByText('译文 Hello input', { exact: true }).waitFor();
    await page
      .locator('opao-reader-ui')
      .getByRole('button', { name: '回填输入框', exact: true })
      .click();
    assert.equal(await page.locator('#input').inputValue(), '译文 Hello input');
  });
  await check('selection comparison returns two independent results', async () => {
    await act('compare', { text: 'Hello compare' });
    await page
      .locator('opao-reader-ui')
      .getByText('译文 Hello compare', { exact: true })
      .nth(1)
      .waitFor();
    await page.locator('opao-reader-ui').getByRole('button', { name: '关闭翻译面板' }).click();
  });
  await check('focused iframe input routes to one frame', async () => {
    const frame = page.frames().find((frame) => frame.url().endsWith('/frame'));
    await frame.evaluate(() => {
      const textarea = document.createElement('textarea');
      textarea.id = 'frame-input';
      document.body.append(textarea);
    });
    await frame.locator('#frame-input').fill('Hello inner input');
    await act('translate-input');
    await frame
      .locator('opao-reader-ui')
      .getByText('译文 Hello inner input', { exact: true })
      .waitFor();
    await frame
      .locator('opao-reader-ui')
      .getByRole('button', { name: '回填输入框', exact: true })
      .click();
    assert.equal(await frame.locator('#frame-input').inputValue(), '译文 Hello inner input');
  });
  await check('image translation and restoration', async () => {
    await act('translate-image', { src: base + '/image.png' }, 0);
    await page.waitForFunction(
      () => document.querySelector('#image').dataset.opaoTranslated === 'true',
    );
    assert.match(await page.locator('#image').getAttribute('src'), /^data:image\/png/);
    await act('translate-image', { src: await page.locator('#image').getAttribute('src') }, 0);
    assert.equal(await page.locator('#image').getAttribute('src'), '/image.png');
  });
  await check('visible meeting and video captions', async () => {
    await act('toggle-subtitles');
    await page
      .locator('opao-reader-ui')
      .getByText('译文 Hello captions', { exact: true })
      .waitFor();
    await act('toggle-subtitles');
  });
  const workspace = await context.newPage();
  await workspace.goto(origin + '/workspace.html');
  const tool = async (name) => workspace.getByRole('tab', { name, exact: true }).click();
  await check('workspace text translation and output', async () => {
    await workspace.getByLabel('待翻译文本', { exact: true }).fill('Hello workspace');
    await workspace.getByRole('button', { name: '翻译文本', exact: true }).click();
    await workspace
      .getByLabel('处理结果', { exact: true })
      .getByText('译文 Hello workspace', { exact: true })
      .waitFor();
  });
  await check('local images and translated PNG export', async () => {
    await tool('图片');
    await workspace
      .locator('input[type=file]')
      .setInputFiles(path.join(source, 'tests/fixtures/image.png'));
    await workspace.getByRole('button', { name: '翻译当前图片', exact: true }).click();
    await workspace.locator('.image-pair figure').nth(1).locator('canvas').waitFor();
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '保存当前译图', exact: true }).click();
    await (await download).saveAs(path.join(evidence, '导出-译图.png'));
  });
  await check('manga long-image tiling and batch archive export', async () => {
    const encoded = await workspace.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 4000;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f7fafc';
      context.fillRect(0, 0, 480, 4000);
      context.fillStyle = '#18354c';
      context.font = '36px Arial';
      for (let y = 60; y < 4000; y += 500) context.fillText('Hello long image', 40, y);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await workspace.locator('input[type=file]').setInputFiles([
      { name: 'long.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') },
      { name: 'normal.png', mimeType: 'image/png', buffer: image },
    ]);
    await workspace.getByText(/1 \/ 2，0 张已有译图/).waitFor();
    await workspace.getByRole('button', { name: '翻译全部图片', exact: true }).click();
    await workspace.getByText(/2 张已有译图/).waitFor();
    const downloaded = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '打包已有译图', exact: true }).click();
    await (await downloaded).saveAs(path.join(evidence, '导出-长图与批量.zip'));
    const entries = unzipSync(await fs.readFile(path.join(evidence, '导出-长图与批量.zip')));
    assert.equal(Object.keys(entries).length, 2);
    const long = entries[Object.keys(entries).find((name) => name.includes('long'))];
    assert.equal(new DataView(long.buffer, long.byteOffset, long.byteLength).getUint32(20), 4000);
  });
  await check('PDF text scanned page and bilingual export', async () => {
    await tool('文档');
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.pdf'));
    await workspace.locator('.pdf-pair canvas').waitFor();
    await workspace.getByRole('button', { name: '翻译全部', exact: true }).click();
    await workspace.getByText(/2 页已有译文/).waitFor({ timeout: 30000 });
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出整本文档', exact: true }).click();
    const file = await download;
    await file.saveAs(path.join(evidence, '导出-双语.pdf'));
    const exported = await PDFDocument.load(
      await fs.readFile(path.join(evidence, '导出-双语.pdf')),
    );
    assert.equal(exported.getPageCount(), 2);
    assert.equal(exported.getPage(0).getWidth(), 1000);
    await workspace.screenshot({ path: path.join(evidence, '工作台-PDF.png'), fullPage: true });
    await workspace.getByLabel('目标语言', { exact: true }).selectOption('ja');
    await workspace.getByText(/0 页已有译文/).waitFor();
  });
  await check('EPUB chapters rich inline markup and archive resources', async () => {
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.epub'));
    await workspace.locator('.reader-body h1').waitFor();
    await workspace.getByRole('button', { name: '翻译全部', exact: true }).click();
    await workspace.getByText(/2 章已有译文/).waitFor();
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出整本文档', exact: true }).click();
    await (await download).saveAs(path.join(evidence, '导出-双语.epub'));
    const entries = unzipSync(await fs.readFile(path.join(evidence, '导出-双语.epub')));
    assert.ok(entries['OPS/cover.png']);
    assert.match(strFromU8(entries['OPS/one.xhtml']), /opao-file-target/);
    assert.match(strFromU8(entries['OPS/two.xhtml']), /译文/);
  });
  await check('HTML file is sanitized and translated', async () => {
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.html'));
    await workspace.getByRole('button', { name: '翻译当前页或章', exact: true }).click();
    await workspace.locator('.reader-body .opao-file-target').waitFor();
    assert.equal(await workspace.evaluate(() => window.UNTRUSTED_FILE_EXECUTED), undefined);
  });
  await check('TXT file translation and export', async () => {
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.txt'));
    await workspace.getByRole('button', { name: '翻译当前页或章', exact: true }).click();
    await workspace.locator('.editor-result').nth(1).getByText(/译文/).waitFor();
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出当前结果', exact: true }).click();
    await (await download).saveAs(path.join(evidence, '导出-双语.txt'));
    assert.match(await fs.readFile(path.join(evidence, '导出-双语.txt'), 'utf8'), /译文/);
  });
  await check('SRT formatting timeline edit and export', async () => {
    await tool('字幕文件');
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.srt'));
    await workspace.getByRole('button', { name: '翻译字幕', exact: true }).click();
    await workspace.getByText(/2\/2 条已有译文/).waitFor();
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出原格式', exact: true }).click();
    await (await download).saveAs(path.join(evidence, '导出-双语.srt'));
    const result = await fs.readFile(path.join(evidence, '导出-双语.srt'), 'utf8');
    assert.match(result, /00:00:02,000/);
    assert.match(result, /<i>译文 |译文 <i>/);
  });
  await check('audio decode transcription translation and SRT export', async () => {
    await tool('音视频');
    await workspace.locator('input[type=file]').setInputFiles(path.join(evidence, 'fixture.wav'));
    await workspace.getByText(/fixture.wav，1 秒/).waitFor();
    await workspace.getByRole('button', { name: '识别并翻译', exact: true }).click();
    await workspace.getByText('译文 Hello audio', { exact: true }).waitFor();
    const download = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出双语 SRT', exact: true }).click();
    await (await download).saveAs(path.join(evidence, '导出-音频.srt'));
    assert.match(await fs.readFile(path.join(evidence, '导出-音频.srt'), 'utf8'), /Hello audio/);
  });
  await check('popup layout and registered context menu permissions', async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 850 });
    await page.bringToFront();
    await popup.goto(origin + '/popup.html');
    await popup.getByRole('button', { name: '切换网页双语翻译', exact: true }).waitFor();
    await popup.screenshot({ path: path.join(evidence, '弹窗.png'), fullPage: true });
    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.ok(manifest.permissions.includes('contextMenus'));
    assert.equal(manifest.permissions.includes('nativeMessaging'), false);
    const menuCount = await worker.evaluate(async () => {
      const ids = [
        'toggle-page',
        'whole-page',
        'selection',
        'compare',
        'translate-input',
        'writing',
        'translate-image',
        'toggle-subtitles',
        'capture-audio',
        'open-document',
        'open-workspace',
        'open-settings',
      ];
      await Promise.all(ids.map((id) => chrome.contextMenus.update(id, {})));
      return ids.length;
    });
    assert.equal(menuCount, 12);
  });
  await check(
    'diagnostics omit test API credentials and no official service requests',
    async () => {
      const logs = await rpcPage(settingsPage, 'logs');
      assert.ok(!JSON.stringify(logs).includes('fixture-test-key'));
      const remote = requests.filter((url) => !url.startsWith(base));
      assert.deepEqual(remote, []);
      assert.deepEqual(browserErrors, []);
    },
  );
  await check('local cache clearing and secret-free configuration export', async () => {
    const before = await rpcPage(settingsPage, 'cache-stats');
    assert.ok(before.entries > 0);
    await rpcPage(settingsPage, 'clear-cache');
    assert.equal((await rpcPage(settingsPage, 'cache-stats')).entries, 0);
    const exported = await rpcPage(settingsPage, 'export-settings');
    assert.equal(exported.secretsRemoved, true);
    assert.ok(exported.profiles.every((profile) => !profile.apiKey));
  });
} catch (error) {
  checks.push({ name: 'browser initialization', status: 'FAIL', error: error.stack });
  console.log(error.stack);
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  const report = {
    date: new Date().toISOString(),
    browser: 'Installed Microsoft Edge, isolated profile',
    mode: 'local mock API fixtures',
    checks,
    apiCalls,
    browserErrors,
    externalRequests: requests.filter((url) => !url.startsWith(base)),
    untested: [
      'Real provider credentials and model quality',
      'All live video and meeting sites',
      'Actual native context-menu clicking',
      'Real-time tab audio capture',
      'Complex real-world PDF layout quality',
    ],
  };
  await fs.writeFile(path.join(evidence, '集成验证结果.json'), JSON.stringify(report, null, 2));
  if (checks.some((check) => check.status === 'FAIL') || browserErrors.length || !checks.length)
    process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        passed: checks.filter((check) => check.status === 'PASS').length,
        failed: checks.filter((check) => check.status === 'FAIL').length,
        browserErrors: browserErrors.length,
        apiRequests: apiCalls.length,
        report: path.join(evidence, '集成验证结果.json'),
      },
      null,
      2,
    ),
  );
}
