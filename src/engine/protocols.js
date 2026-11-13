import { parseJsonText } from '../shared/text.js';

const endings =
  /\/(?:chat\/completions|responses|messages|audio\/transcriptions|models|completions)\/?$/i;
export function endpoint(profile, action = 'generate') {
  const url = new URL((action === 'models' && profile.modelsUrl) || profile.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('接口地址需要使用 HTTP 或 HTTPS，并通过密钥字段设置凭据');
  let pathname = url.pathname.replace(/\/+$/, '');
  const isGemini = /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(pathname);
  let base = isGemini
    ? pathname.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, '')
    : pathname.replace(endings, '');
  if (action === 'models' && profile.modelsUrl) return url;
  if (action !== 'models' && profile.endpointMode === 'exact') return url;
  if (['google-free', 'bing-free'].includes(profile.protocol)) return url;
  if (action === 'models')
    url.pathname = (base || (profile.protocol === 'gemini' ? '/v1beta' : '/v1')) + '/models';
  else if (profile.protocol === 'custom') return url;
  else if (profile.protocol === 'gemini')
    url.pathname =
      (base || '/v1beta') +
      `/models/${encodeURIComponent(profile.model.replace(/^models\//, ''))}:${profile.stream ? 'streamGenerateContent' : 'generateContent'}`;
  else if (profile.protocol === 'deepl')
    url.pathname = /\/translate$/.test(pathname) ? pathname : (pathname || '/v2') + '/translate';
  else if (profile.protocol === 'google') url.pathname = pathname || '/language/translate/v2';
  else if (profile.protocol === 'microsoft' || profile.protocol === 'libre')
    url.pathname = /\/translate$/.test(pathname) ? pathname : pathname + '/translate';
  else {
    const suffix =
      {
        chat: '/chat/completions',
        responses: '/responses',
        claude: '/messages',
        asr: '/audio/transcriptions',
      }[profile.protocol] || '/chat/completions';
    url.pathname = (base || '/v1') + suffix;
  }
  if (profile.protocol === 'gemini' && profile.stream && action !== 'models')
    url.searchParams.set('alt', 'sse');
  return url;
}
export function keysOf(profile) {
  return String(profile.apiKey || '')
    .split(/[\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}
function interpolate(value, variables) {
  if (typeof value === 'string')
    return value.replace(/\{\{(text|from|to|model|key)\}\}/g, (_, key) =>
      String(variables[key] ?? ''),
    );
  if (Array.isArray(value)) return value.map((item) => interpolate(item, variables));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, variables)]),
    );
  return value;
}
export function headersFor(profile, key = '', json = true) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  if (profile.protocol === 'claude')
    Object.assign(headers, {
      'anthropic-version': '2023-06-01',
      ...(key ? { 'x-api-key': key } : {}),
    });
  else if (profile.protocol === 'gemini' && key) headers['x-goog-api-key'] = key;
  else if (profile.protocol === 'deepl' && key) headers.Authorization = 'DeepL-Auth-Key ' + key;
  else if (profile.protocol === 'microsoft' && key) headers['Ocp-Apim-Subscription-Key'] = key;
  else if (key) headers.Authorization = 'Bearer ' + key;
  return { ...headers, ...interpolate(profile.headers || {}, { key, model: profile.model }) };
}
export function generationRequest(profile, { system, prompt, images = [], key = '' }) {
  const url = endpoint(profile);
  const options = { method: 'POST', headers: headersFor(profile, key) };
  let body;
  if (profile.protocol === 'responses') {
    body = {
      model: profile.model,
      instructions: system,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            ...images.map((image) => ({ type: 'input_image', image_url: image, detail: 'auto' })),
          ],
        },
      ],
      store: false,
      stream: profile.stream,
    };
    if (profile.maxTokens) body.max_output_tokens = Number(profile.maxTokens);
  } else if (profile.protocol === 'claude') {
    body = {
      model: profile.model,
      system,
      max_tokens: Number(profile.maxTokens) || 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map((image) => {
              const match = image.match(/^data:([^;]+);base64,(.+)$/s);
              if (!match) throw new Error('Claude 视觉输入需要编码后的图片');
              return {
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              };
            }),
          ],
        },
      ],
      stream: profile.stream,
    };
  } else if (profile.protocol === 'gemini') {
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            ...images.map((image) => {
              const match = image.match(/^data:([^;]+);base64,(.+)$/s);
              if (!match) throw new Error('Gemini 视觉输入需要编码后的图片');
              return { inlineData: { mimeType: match[1], data: match[2] } };
            }),
          ],
        },
      ],
      generationConfig: {},
    };
    if (profile.temperature !== '') body.generationConfig.temperature = Number(profile.temperature);
    if (profile.maxTokens) body.generationConfig.maxOutputTokens = Number(profile.maxTokens);
  } else {
    body = {
      model: profile.model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: images.length
            ? [
                { type: 'text', text: prompt },
                ...images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
              ]
            : prompt,
        },
      ],
      stream: profile.stream,
    };
    if (profile.maxTokens)
      body[profile.tokenField || 'max_completion_tokens'] = Number(profile.maxTokens);
  }
  if (profile.protocol !== 'gemini' && profile.temperature !== '')
    body.temperature = Number(profile.temperature);
  body = { ...body, ...profile.body };
  options.body = JSON.stringify(body);
  return { url: url.href, options };
}
export function extractText(data, protocol = 'chat') {
  if (typeof data === 'string') return data;
  if (protocol === 'gemini')
    return (
      data?.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join('') || ''
    );
  if (protocol === 'claude')
    return (
      data?.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('') || ''
    );
  if (typeof data?.output_text === 'string') return data.output_text;
  if (Array.isArray(data?.output))
    return data.output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text || '')
      .join('');
  const message = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map((item) => item.text || '').join('');
  return '';
}
export async function readEventStream(response, protocol, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    output = '',
    done = false;
  function frame(value) {
    const data = value
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('接口返回了无效的流式 JSON');
    }
    if (event.error || event.type === 'error' ||
        ['response.failed', 'response.incomplete'].includes(event.type))
      throw new Error(event.error?.message || event.response?.error?.message ||
        event.message || '模型流式输出未完整结束，请重试');
    let delta =
      event.type === 'response.output_text.delta'
        ? event.delta
        : event.type === 'content_block_delta'
          ? event.delta?.text
          : event.choices?.[0]?.delta?.content;
    if (protocol === 'gemini') delta = extractText(event, protocol);
    if (typeof delta !== 'string') delta = '';
    if (!delta && !output && event.type === 'response.completed')
      delta = extractText(event.response, 'responses');
    if (delta) {
      output += delta;
      onToken?.(output);
    }
  }
  try {
    while (!done) {
      const next = await reader.read();
      done = next.done;
      buffer += decoder.decode(next.value, { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    if (buffer.trim()) frame(buffer);
    return output;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class HttpError extends Error {
  constructor(message, status, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export async function request(
  url,
  options,
  { signal, timeout = 120, onToken, protocol, fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeout * 1000);
  try {
    const response = await fetchImpl(url, {
      ...options,
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      let reason = '';
      try {
        const content = await response.text();
        const json = JSON.parse(content);
        reason = json.error?.message || json.message || '';
      } catch {}
      const rawRetry = response.headers.get('Retry-After');
      const retryAfter =
        Number(rawRetry) || Math.max(0, (Date.parse(rawRetry) - Date.now()) / 1000) || 0;
      throw new HttpError(
        `HTTP ${response.status}${reason ? ' ' + String(reason).slice(0, 240) : ''}`,
        response.status,
        Math.min(retryAfter, 120),
      );
    }
    if (response.headers.get('Content-Type')?.includes('text/event-stream'))
      return await readEventStream(response, protocol, onToken);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      if (/^\s*</.test(text)) throw new Error('接口返回了 HTML，请检查 API 地址和网络');
      return text;
    }
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted)
      throw Object.assign(new Error('请求超时，请增大超时或减小单批文本'), {
        code: 'REQUEST_TIMEOUT',
      });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export async function generate(profile, content, options = {}) {
  const { url, options: init } = generationRequest(profile, { ...content, key: options.key });
  const response = await request(url, init, {
    ...options,
    timeout: profile.timeout,
    protocol: profile.protocol,
  });
  const text = extractText(response, profile.protocol);
  if (!text.trim()) throw new Error('模型没有返回可显示的文字，请检查模型、接口协议和输出参数');
  return text;
}
function pathValue(value, path) {
  return path
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}
export async function traditionalTranslate(profile, items, from, to, options) {
  const url = endpoint(profile);
  const headers = headersFor(profile, options.key);
  const init = { method: 'POST', headers };
  const target = to === 'zh-CN' ? 'zh' : to === 'zh-TW' ? 'zh-TW' : to;
  if (profile.protocol === 'bing-free') {
    url.searchParams.set('to', to === 'zh-CN' ? 'zh-Hans' : to === 'zh-TW' ? 'zh-Hant' : to);
    if (from !== 'auto') url.searchParams.set('from', from);
    url.searchParams.set('isEnterpriseClient', 'false');
    init.body = JSON.stringify(items.map((item) => item.text));
    const data = await request(url.href, init, { ...options, timeout: profile.timeout });
    if (
      !Array.isArray(data) ||
      data.length !== items.length ||
      data.some((item) => typeof item.translations?.[0]?.text !== 'string')
    )
      throw new Error('Bing 网页接口返回的译文结构无效');
    return data.map((item, index) => ({ id: items[index].id, text: item.translations[0].text }));
  }
  if (profile.protocol === 'google-free') {
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('dt', 't');
    url.searchParams.set('sl', from);
    url.searchParams.set('tl', to);
    const form = new URLSearchParams();
    for (const item of items) form.append('q', item.text);
    const data = await request(
      url.href,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      { ...options, timeout: profile.timeout },
    );
    if (!Array.isArray(data) || data.length !== items.length)
      throw new Error('Google 网页接口返回的段落数量不一致');
    return data.map((item, index) => {
      const text = Array.isArray(item) ? item[0] : item;
      if (typeof text !== 'string') throw new Error('Google 网页接口返回的译文无效');
      return { id: items[index].id, text };
    });
  }
  if (profile.protocol === 'deepl') {
    init.body = JSON.stringify({
      text: items.map((item) => item.text),
      target_lang: to === 'zh-CN' ? 'ZH-HANS' : to === 'zh-TW' ? 'ZH-HANT' : to.toUpperCase(),
      ...(from !== 'auto' ? { source_lang: from.toUpperCase() } : {}),
      ...profile.body,
    });
    const data = await request(url.href, init, { ...options, timeout: profile.timeout });
    if (data.translations?.length !== items.length) throw new Error('翻译接口返回的段落数量不一致');
    return data.translations.map((item, index) => ({ id: items[index].id, text: item.text }));
  }
  if (profile.protocol === 'microsoft') {
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', to === 'zh-CN' ? 'zh-Hans' : to === 'zh-TW' ? 'zh-Hant' : to);
    if (from !== 'auto') url.searchParams.set('from', from);
    init.body = JSON.stringify(items.map((item) => ({ Text: item.text })));
    const data = await request(url.href, init, { ...options, timeout: profile.timeout });
    if (!Array.isArray(data) || data.length !== items.length)
      throw new Error('Microsoft 翻译段落响应无效');
    return data.map((item, index) => ({
      id: items[index].id,
      text: item.translations?.[0]?.text || '',
    }));
  }
  if (profile.protocol === 'google') {
    if (options.key) url.searchParams.set('key', options.key);
    init.body = JSON.stringify({
      q: items.map((item) => item.text),
      target,
      format: 'text',
      ...(from !== 'auto' ? { source: from } : {}),
      ...profile.body,
    });
    const data = await request(url.href, init, { ...options, timeout: profile.timeout });
    if (data.data?.translations?.length !== items.length)
      throw new Error('Google 翻译段落响应无效');
    return data.data.translations.map((item, index) => ({
      id: items[index].id,
      text: item.translatedText,
    }));
  }
  const results = [];
  for (const item of items) {
    const body =
      profile.protocol === 'custom'
        ? {
            text: item.text,
            source: from,
            target: to,
            ...interpolate(profile.body, {
              text: item.text,
              from,
              to,
              key: options.key,
              model: profile.model,
            }),
          }
        : {
            q: item.text,
            text: item.text,
            source: from,
            source_lang: from,
            target,
            target_lang: to,
            api_key: options.key || undefined,
            ...profile.body,
          };
    const data = await request(
      url.href,
      { ...init, body: JSON.stringify(body) },
      { ...options, timeout: profile.timeout },
    );
    const translated = profile.responsePath
      ? pathValue(data, profile.responsePath)
      : (data.translatedText ?? data.translation ?? data.data ?? data.text);
    if (typeof translated !== 'string')
      throw new Error('自定义接口需要设置译文字段路径，例如 data.translation');
    results.push({ id: item.id, text: translated });
  }
  return results;
}
export async function discoverModels(profile, options) {
  const url = endpoint(profile, 'models');
  const headers = headersFor(profile, options.key, false);
  const data = await request(
    url.href,
    { method: 'GET', headers },
    { ...options, timeout: profile.timeout },
  );
  const values = Array.isArray(data) ? data : data.data || data.models;
  if (!Array.isArray(values)) throw new Error('接口未返回模型数组，仍可手动填写模型名');
  const models = values
    .map((value) => (typeof value === 'string' ? value : value.id || value.name || value.model))
    .filter(Boolean)
    .map((value) => (profile.protocol === 'gemini' ? value.replace(/^models\//, '') : value));
  return [...new Set(models)].sort();
}
export async function transcribe(profile, payload, options) {
  const form = new FormData();
  const data = payload.dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!data) throw new Error('音频数据编码无效');
  const bytes = Uint8Array.from(atob(data[2]), (character) => character.charCodeAt(0));
  form.append(
    'file',
    new Blob([bytes], { type: data[1] || 'audio/webm' }),
    payload.filename || 'audio.webm',
  );
  form.append('model', profile.model);
  form.append('response_format', profile.responseFormat || 'json');
  if (payload.language && payload.language !== 'auto')
    form.append('language', payload.language.split('-')[0]);
  for (const [key, value] of Object.entries(profile.body))
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  const result = await request(
    endpoint({ ...profile, protocol: 'asr' }).href,
    { method: 'POST', headers: headersFor(profile, options.key, false), body: form },
    { ...options, timeout: profile.timeout },
  );
  if (typeof result === 'string')
    return { text: result, raw: result, format: profile.responseFormat };
  return {
    text: result.text || '',
    segments: result.segments || [],
    duration: result.duration,
    format: profile.responseFormat,
  };
}
export function parseVision(text) {
  const result = parseJsonText(text);
  return Array.isArray(result) ? result : result?.blocks || result?.regions || [];
}
