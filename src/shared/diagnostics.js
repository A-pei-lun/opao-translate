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
  'toast-queued',
  'toast-shown',
  'toast-hidden',
  'toast-suppressed',
]);
export function diagnosticEntry(raw, context = {}) {
  if (!raw || !events.has(raw.event)) return null;
  const entry = { at: new Date().toISOString(), event: raw.event };
  if (['REQUEST_TIMEOUT', 'CANCELLED', 'HTTP_ERROR', 'REQUEST_FAILED'].includes(raw.code))
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
