import { TRANSLATION_STYLES, cleanFontFamily } from './appearance.js';
export const CONFIG_KEY = 'opao.settings.v1';
export const FLOATING_POSITION_KEY = 'opao.floating.position.v1';
export const PROTOCOLS = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  claude: 'Claude Messages',
  gemini: 'Gemini 原生',
  deepl: 'DeepL API',
  microsoft: 'Microsoft Translator',
  google: 'Google Cloud Translation',
  libre: 'LibreTranslate / DeepLX',
  custom: '自定义 HTTP JSON',
  'google-free': 'Google 网页翻译接口',
  'bing-free': 'Bing 网页翻译接口',
  asr: 'OpenAI 兼容语音识别',
};
export const TRADITIONAL_PROTOCOLS = [
  'deepl',
  'microsoft',
  'google',
  'libre',
  'custom',
  'google-free',
  'bing-free',
];
export { LANGUAGES } from './languages.js';
export function createProfile(id = crypto.randomUUID()) {
  return {
    id,
    name: '自定义接口',
    protocol: 'chat',
    endpointMode: 'auto',
    baseUrl: '',
    modelsUrl: '',
    model: '',
    apiKey: '',
    capabilities: { text: true, vision: false, asr: false },
    enabled: true,
    timeout: 120,
    concurrency: 4,
    retries: 2,
    batchSize: 8,
    maxChars: 5000,
    stream: false,
    temperature: '',
    maxTokens: '',
    tokenField: 'max_completion_tokens',
    headers: {},
    body: {},
    prompt: '',
    responsePath: '',
    responseFormat: 'json',
  };
}
export function defaults() {
  return {
    version: 1,
    throughputRevision: 1,
    profiles: [createProfile('main')],
    roles: { text: 'main', input: '', vision: '', subtitle: '', asr: '', layout: '' },
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    inputTargetLanguage: 'en',
    theme: 'system',
    mode: 'bilingual',
    textSize: 100,
    translationColor: '',
    translationStyle: 'muted',
    translationFont: '',
    translationFontWeight: 'inherit',
    translationLineHeight: 1.8,
    translationParagraphGap: 0.65,
    hover: true,
    hoverModifier: 'Alt',
    selection: true,
    floatingButton: true,
    translateTitle: false,
    replaceTraditionalChinese: false,
    aiLayout: false,
    aiLayoutFullHtml: false,
    lazy: true,
    autoSites: [],
    blockSites: [],
    siteRules: [],
    glossary: [],
    maskPrivacy: false,
    privacyPatterns: [],
    cache: true,
    cacheDays: 7,
    cacheEntries: 10000,
    maxConcurrent: 5,
    subtitlePretranslate: true,
    subtitleFontSize: 22,
    subtitleSelector: '',
    imageMaxEdge: 1800,
    imageTileHeight: 1800,
    imageConcurrency: 2,
    imageRender: 'cover',
    imageFont: 'Microsoft YaHei',
    asrChunkSeconds: 12,
    comparisonProfiles: [],
    serviceFallback: { enabled: false, order: [] },
    prompt: '',
  };
}
function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function text(value, fallback = '', max = 20000) {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}
function array(value, limit = 5000) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}
export function jsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !['__proto__', 'prototype', 'constructor'].includes(key),
    ),
  );
}
export function normalizeSettings(raw = {}) {
  const base = defaults();
  const data = jsonObject(raw);
  const sourceProfiles = Array.isArray(data.profiles) ? data.profiles : base.profiles;
  const seen = new Set();
  let upgradedThroughput = false;
  const profiles = sourceProfiles.slice(0, 100).map((value) => {
    const initial = createProfile(text(value?.id, crypto.randomUUID(), 80));
    const profile = jsonObject(value);
    const upgradeThroughput = data.throughputRevision !== 1 &&
      profile.concurrency === 3 && profile.batchSize === 5;
    if (upgradeThroughput) upgradedThroughput = true;
    if (seen.has(initial.id)) initial.id = crypto.randomUUID();
    seen.add(initial.id);
    return {
      ...initial,
      name: text(profile.name, initial.name, 100).trim() || initial.name,
      protocol: Object.hasOwn(PROTOCOLS, profile.protocol) ? profile.protocol : 'chat',
      endpointMode: profile.endpointMode === 'exact' ? 'exact' : 'auto',
      baseUrl: text(profile.baseUrl, '', 4000).trim(),
      modelsUrl: text(profile.modelsUrl, '', 4000).trim(),
      model: text(profile.model, '', 300).trim(),
      apiKey: text(profile.apiKey, '', 30000),
      capabilities: {
        text:
          typeof profile.capabilities?.text === 'boolean'
            ? profile.capabilities.text
            : initial.capabilities.text,
        vision: Boolean(profile.capabilities?.vision),
        asr: Boolean(profile.capabilities?.asr),
      },
      enabled: profile.enabled !== false,
      timeout: number(profile.timeout, 120, 5, 600),
      concurrency: upgradeThroughput ? 4 : number(profile.concurrency, initial.concurrency, 1, 20),
      retries: number(profile.retries, 2, 0, 5),
      batchSize: upgradeThroughput ? 8 : number(profile.batchSize, initial.batchSize, 1, 30),
      maxChars: number(profile.maxChars, 5000, 200, 30000),
      stream: Boolean(profile.stream),
      temperature: text(String(profile.temperature ?? ''), '', 20),
      maxTokens: text(String(profile.maxTokens ?? ''), '', 20),
      tokenField: profile.tokenField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
      headers: jsonObject(profile.headers),
      body: jsonObject(profile.body),
      prompt: text(profile.prompt),
      responsePath: text(profile.responsePath, '', 300),
      responseFormat: ['json', 'verbose_json', 'srt', 'vtt', 'text', 'diarized_json'].includes(
        profile.responseFormat,
      )
        ? profile.responseFormat
        : 'json',
    };
  });
  const next = { ...base, profiles };
  const profileIds = new Set(profiles.map((profile) => profile.id));
  next.serviceFallback = {
    enabled: data.serviceFallback?.enabled === true,
    order: [
      ...new Set([
        ...array(data.serviceFallback?.order).filter(
          (id) => typeof id === 'string' && profileIds.has(id),
        ),
        ...profileIds,
      ]),
    ],
  };
  for (const key of ['theme', 'mode', 'translationStyle', 'hoverModifier', 'imageRender'])
    next[key] = text(data[key], base[key], 40);
  for (const key of [
    'sourceLanguage',
    'targetLanguage',
    'inputTargetLanguage',
    'translationColor',
    'subtitleSelector',
    'imageFont',
    'prompt',
  ])
    next[key] = text(data[key], base[key]);
  for (const key of [
    'hover',
    'selection',
    'floatingButton',
    'translateTitle',
    'replaceTraditionalChinese',
    'aiLayout',
    'aiLayoutFullHtml',
    'lazy',
    'maskPrivacy',
    'cache',
    'subtitlePretranslate',
  ])
    next[key] = typeof data[key] === 'boolean' ? data[key] : base[key];
  for (const key of ['autoSites', 'blockSites', 'privacyPatterns', 'comparisonProfiles'])
    next[key] = array(data[key])
      .filter((value) => typeof value === 'string')
      .map((value) => value.slice(0, 1000));
  next.siteRules = array(data.siteRules)
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      matches: array(rule.matches).filter((value) => typeof value === 'string'),
      selectors: array(rule.selectors).filter((value) => typeof value === 'string'),
      excludeSelectors: array(rule.excludeSelectors).filter((value) => typeof value === 'string'),
    }));
  next.glossary = array(data.glossary)
    .filter((item) => item?.source && typeof item.source === 'string')
    .map((item) => ({
      source: item.source.slice(0, 300),
      target: text(item.target, '', 300),
      domain: text(item.domain, '', 300),
    }));
  next.roles = Object.fromEntries(
    Object.keys(base.roles).map((role) => [
      role,
      profiles.some((profile) => profile.id === data.roles?.[role])
        ? data.roles[role]
        : role === 'text'
          ? profiles[0]?.id || ''
          : '',
    ]),
  );
  for (const [key, min, max] of [
    ['textSize', 70, 180],
    ['cacheDays', 0, 365],
    ['cacheEntries', 100, 50000],
    ['maxConcurrent', 1, 12],
    ['subtitleFontSize', 12, 48],
    ['imageMaxEdge', 600, 4096],
    ['imageTileHeight', 600, 4096],
    ['imageConcurrency', 1, 5],
    ['asrChunkSeconds', 5, 60],
  ])
    next[key] = number(data[key], base[key], min, max);
  if (upgradedThroughput && data.maxConcurrent === 4) next.maxConcurrent = 5;
  if (!['system', 'light', 'dark'].includes(next.theme)) next.theme = 'system';
  if (!['bilingual', 'translation'].includes(next.mode)) next.mode = 'bilingual';
  if (!TRANSLATION_STYLES.some(([id]) => id === next.translationStyle))
    next.translationStyle = base.translationStyle;
  next.translationFont = cleanFontFamily(data.translationFont);
  next.translationFontWeight = ['inherit', '400', '500', '600', '700'].includes(
    String(data.translationFontWeight),
  )
    ? String(data.translationFontWeight)
    : 'inherit';
  next.translationLineHeight = number(data.translationLineHeight, 1.8, 1.2, 2.8);
  next.translationParagraphGap = number(data.translationParagraphGap, 0.65, 0, 2);
  return next;
}
export function translationSettingsChanged(previous, next) {
  const inputs = (settings) =>
    Object.fromEntries(
      [
        'profiles',
        'roles',
        'sourceLanguage',
        'targetLanguage',
        'inputTargetLanguage',
        'glossary',
        'prompt',
        'maskPrivacy',
        'privacyPatterns',
        'siteRules',
        'autoSites',
        'blockSites',
        'translateTitle',
        'replaceTraditionalChinese',
        'aiLayout',
        'aiLayoutFullHtml',
        'lazy',
        'serviceFallback',
      ].map((key) => [
        key,
        key === 'profiles'
          ? settings.profiles.map(({ name, ...profile }) => profile)
          : settings[key],
      ]),
    );
  return JSON.stringify(inputs(previous)) !== JSON.stringify(inputs(next));
}
export function publicSettings(settings) {
  return {
    ...settings,
    profiles: settings.profiles.map(
      ({ id, name, protocol, model, baseUrl, enabled, capabilities, concurrency, batchSize }) => ({
        id,
        name,
        protocol,
        model,
        enabled,
        capabilities,
        concurrency,
        batchSize,
        configured: Boolean(baseUrl && (model || TRADITIONAL_PROTOCOLS.includes(protocol))),
      }),
    ),
  };
}
export function resolveProfile(settings, role = 'text', explicitId) {
  const id =
    explicitId ||
    settings.roles[role] ||
    (['vision', 'asr'].includes(role) ? '' : settings.roles.text);
  const profile = settings.profiles.find((item) => item.id === id && item.enabled);
  if (!profile)
    throw new Error(
      `请先在设置中为${{ vision: '图片', asr: '语音', input: '输入', subtitle: '字幕', text: '文本', layout: '排版' }[role] || role}选择服务`,
    );
  if (!profile.baseUrl || (!profile.model && !TRADITIONAL_PROTOCOLS.includes(profile.protocol)))
    throw new Error(`请补全“${profile.name}”的接口地址和模型名`);
  if (role === 'vision' && !profile.capabilities.vision)
    throw new Error(`“${profile.name}”尚未标记支持视觉输入，请在设置中检查能力`);
  if (role === 'asr' && !profile.capabilities.asr)
    throw new Error(`“${profile.name}”尚未标记支持语音识别`);
  if (
    !['vision', 'asr'].includes(role) &&
    (!profile.capabilities.text || profile.protocol === 'asr')
  )
    throw new Error(`“${profile.name}”没有启用文本能力，请选择文本服务`);
  return profile;
}
export function exportSettings(settings, includeSecrets = false) {
  const result = structuredClone(settings);
  if (!includeSecrets) {
    result.secretsRemoved = true;
    for (const profile of result.profiles) {
      profile.apiKey = '';
      profile.headers = Object.fromEntries(
        Object.entries(profile.headers).filter(
          ([key]) =>
            !/authorization|authentication|cookie|key|secret|token|password|signature/i.test(key),
        ),
      );
      profile.body = stripBodyCredentials(profile.body);
      for (const field of ['baseUrl', 'modelsUrl']) {
        try {
          const url = new URL(profile[field]);
          url.username = '';
          url.password = '';
          url.hash = '';
          for (const key of [...url.searchParams.keys()])
            if (/key|token|secret|signature|password|credential|auth/i.test(key))
              url.searchParams.delete(key);
          profile[field] = url.href;
        } catch {}
      }
    }
  }
  return result;
}
function stripBodyCredentials(value) {
  if (Array.isArray(value)) return value.map(stripBodyCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/authorization|authentication|cookie|api.?key|secret|password|signature|^(key|token|access_token|refresh_token|credentials)$/i.test(
            key,
          ),
      )
      .map(([key, item]) => [key, stripBodyCredentials(item)]),
  );
}
export function matchesUrl(pattern, value) {
  if (!pattern) return false;
  try {
    const url = new URL(value);
    if (pattern === '<all_urls>') return ['http:', 'https:', 'file:'].includes(url.protocol);
    if (!pattern.includes('/') && !pattern.includes(':')) {
      const host = pattern.replace(/^\*\./, '');
      if (!host.includes('*')) return url.hostname === host || url.hostname.endsWith('.' + host);
      return new RegExp(
        '^' + host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$',
        'i',
      ).test(url.hostname);
    }
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*\\.', '(?:[^/]+\\.)?')
      .replaceAll('*', '.*');
    const prefix = pattern.includes('://') ? '' : '(?:https?://)?';
    return new RegExp('^' + prefix + escaped + '$', 'i').test(value);
  } catch {
    return false;
  }
}
export function importLegacy(raw) {
  if (Array.isArray(raw.profiles)) return normalizeSettings(raw);
  if (!raw.translationServices) throw new Error('配置需要包含 profiles 或旧版 translationServices');
  const profiles = [];
  for (const [id, service] of Object.entries(raw.translationServices)) {
    if (!service || service.provider === 'pro' || (!service.apiUrl && !service.APIKEY)) continue;
    const protocol = id.includes('claude')
      ? 'claude'
      : id.includes('gemini')
        ? 'gemini'
        : service.apiProtocol === 'openai-responses'
          ? 'responses'
          : 'chat';
    profiles.push({
      ...createProfile(id),
      name: service.name || id,
      protocol,
      baseUrl: service.apiUrl || '',
      model: service.model || '',
      apiKey: String(service.APIKEY || '').startsWith('imt_aes_') ? '' : service.APIKEY || '',
      headers: service.headerConfigs || {},
      body: service.bodyConfigs || {},
    });
  }
  return normalizeSettings({
    profiles,
    roles: { text: raw.translationService || profiles[0]?.id },
    targetLanguage: raw.targetLanguage || 'zh-CN',
    sourceLanguage: raw.sourceLanguage || 'auto',
  });
}
