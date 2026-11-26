export const DIAGNOSTIC_KEY = 'opao.diagnostics.v1';
export const DIAGNOSTIC_LIMIT = 1000;
const events = new Set([
  'request',
  'attempt',
  'retry',
  'timeout',
  'ready',
  'reset',
  'scan',
  'translation-validation',
  'toast-queued',
  'toast-shown',
  'toast-hidden',
  'toast-suppressed',
]);
const translationIssues = new Set([
  'invalid-format', 'missing-id', 'invalid-id', 'unknown-id', 'normalized-id',
  'duplicate-id', 'invalid-translation', 'empty-translation', 'invalid-placeholders',
]);
const responseExcerptLimit = 800;
const responseSourceLimit = 4096;
const responseSyntax = /(?:\x60{3}(?:json|txt|text)?(?=\s|$)|<\/?(?:translations?|results?|items?|item|id|text|response|output|html|body|p|span|code|pre)(?=[\s/>])|(?:\{[\s\\]*){0,2}OPAO(?:[0-9a-f]{8}[SEK]\d{1,6}|(?:PRIV|SUB)\d{1,6})?(?:[\s\\]*\}){0,2}|"id"\s*:\s*"[ \t]*[\d\uFF10-\uFF19]{1,7}[ \t]*[-\u2010-\u2015\u2212\uFF0D][ \t]*[\d\uFF10-\uFF19]{1,7}[ \t]*"(?=\s*[,}])|"(?:translations|translation|translated|results|items|id|text)"(?=\s*:)|\[redacted\]|[\[\]{}<>()",:\\/=\x60]|\r?\n|[ \t]+)/gi;

export function translationResponseExcerpt(value, secrets = []) {
  const text = String(value ?? '');
  let source = text.slice(0, responseSourceLimit);
  // The excerpt is a syntax skeleton. Unrecognized text, including echoed input,
  // attributes and values, never enters the diagnostic store.
  for (const secret of secrets)
    if (secret && source.includes(secret)) source = source.replaceAll(secret, '[redacted]');
  let excerpt = '';
  let end = 0;
  for (const match of source.matchAll(responseSyntax)) {
    if (match.index > end) excerpt += '[redacted]';
    excerpt += match[0];
    end = match.index + match[0].length;
    if (excerpt.length > responseExcerptLimit) break;
  }
  if (end < source.length && excerpt.length <= responseExcerptLimit) excerpt += '[redacted]';
  return {
    responseExcerpt: excerpt.slice(0, responseExcerptLimit),
    responseLength: text.length,
    responseTruncated: text.length > responseSourceLimit || excerpt.length > responseExcerptLimit,
  };
}

function diagnosticIds(ids) {
  return (Array.isArray(ids) ? ids : []).slice(0, 30).map((id) => {
    if (id === '') return '[invalid-id]';
    return typeof id === 'string' && id.length <= 40 &&
      /^[ \t]*[\d\uFF10-\uFF19]{1,7}[ \t]*[-\u2010-\u2015\u2212\uFF0D][ \t]*[\d\uFF10-\uFF19]{1,7}[ \t]*$/.test(id)
      ? id : '[redacted-id]';
  });
}
export function diagnosticEntry(raw, context = {}) {
  if (!raw || !events.has(raw.event)) return null;
  const entry = { at: new Date().toISOString(), event: raw.event };
  if (['REQUEST_TIMEOUT', 'CANCELLED', 'HTTP_ERROR', 'REQUEST_FAILED', 'TRANSLATION_VALIDATION'].includes(raw.code))
    entry.code = raw.code;
  for (const key of [
    'page',
    'site',
    'jobId',
    'profileId',
    'profileName',
    'model',
    'from',
    'to',
    'action',
    'status',
  ]) {
    const value = context[key] ?? raw[key];
    if (typeof value === 'string') entry[key] = value.slice(0, 120);
  }
  for (const key of [
    'durationMs',
    'httpStatus',
    'retry',
    'candidates',
    'selected',
    'excluded',
    'short',
    'hidden',
    'oversize',
    'controlsSplit',
    'nested',
    'queued',
    'records',
  ]) {
    if (Number.isFinite(raw[key])) entry[key] = Math.max(0, Math.floor(raw[key]));
  }
  if (raw.event === 'translation-validation') {
    entry.expectedIds = diagnosticIds(raw.expectedIds);
    entry.actualIds = diagnosticIds(raw.actualIds);
    entry.failedIds = diagnosticIds(raw.failedIds);
    entry.issues = (Array.isArray(raw.issues) ? raw.issues : [])
      .filter((issue) => translationIssues.has(issue)).slice(0, translationIssues.size);
    const excerpt = translationResponseExcerpt(raw.responseExcerpt);
    entry.responseExcerpt = excerpt.responseExcerpt;
    entry.responseLength = Number.isSafeInteger(raw.responseLength) ? Math.max(0, raw.responseLength) : 0;
    entry.responseTruncated = raw.responseTruncated === true || excerpt.responseTruncated;
  }
  return entry;
}
export function createDiagnosticStore(storage) {
  let pending = Promise.resolve();
  const serial = (work) => {
    const result = pending.then(work, work);
    pending = result.catch(() => {});
    return result;
  };
  return {
    append(raw, context) {
      const entry = diagnosticEntry(raw, context);
      if (!entry) return Promise.resolve();
      return serial(async () => {
        const data = await storage.get(DIAGNOSTIC_KEY);
        const cutoff = Date.now() - 7 * 86400000;
        const entries = (Array.isArray(data[DIAGNOSTIC_KEY]) ? data[DIAGNOSTIC_KEY] : []).filter(
          (item) => Date.parse(item?.at) >= cutoff,
        );
        entries.push(entry);
        await storage.set({ [DIAGNOSTIC_KEY]: entries.slice(-DIAGNOSTIC_LIMIT) });
      });
    },
    read(page = '') {
      return serial(async () => {
        const data = await storage.get(DIAGNOSTIC_KEY);
        return (Array.isArray(data[DIAGNOSTIC_KEY]) ? data[DIAGNOSTIC_KEY] : []).filter(
          (item) =>
            Date.parse(item?.at) >= Date.now() - 7 * 86400000 && (!page || item.page === page),
        );
      });
    },
    clear() {
      return serial(() => storage.remove(DIAGNOSTIC_KEY));
    },
  };
}
