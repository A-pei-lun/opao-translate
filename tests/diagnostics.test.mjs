import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticStore,
  diagnosticEntry,
  DIAGNOSTIC_KEY,
} from '../src/shared/diagnostics.js';

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(data) {
      Object.assign(values, structuredClone(data));
    },
    async remove(key) {
      delete values[key];
    },
  };
}
test('diagnostics accept only metadata, without text, keys, headers, URLs or raw errors', () => {
  const result = diagnosticEntry(
    {
      event: 'request',
      profileId: 'main',
      httpStatus: 504,
      text: 'private source',
      apiKey: 'private-key',
      headers: { Authorization: 'private' },
      url: 'https://test/?key=private',
      error: 'upstream private source',
      unknown: 'private',
    },
    { page: 'document-one', site: 'https://test' },
  );
  assert.equal(result.page, 'document-one');
  assert.equal(result.httpStatus, 504);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(diagnosticEntry({ event: 'untrusted-arbitrary-event' }), null);
});
test('concurrent appends are serialized, remain readable after store recreation and filter by page', async () => {
  const storage = memoryStorage();
  const first = createDiagnosticStore(storage);
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      first.append({
        event: 'attempt',
        jobId: String(index),
        page: index % 2 ? 'a' : 'b',
        status: 'PASS',
      }),
    ),
  );
  const restarted = createDiagnosticStore(storage);
  assert.equal((await restarted.read()).length, 40);
  assert.equal((await restarted.read('a')).length, 20);
  assert.equal(new Set((await restarted.read()).map((entry) => entry.jobId)).size, 40);
  await restarted.clear();
  assert.deepEqual(await restarted.read(), []);
});
test('retention removes old records and enforces the 1000 event bound', async () => {
  const old = { event: 'scan', at: new Date(Date.now() - 8 * 86400000).toISOString() };
  const recent = Array.from({ length: 1000 }, (_, index) => ({
    event: 'request',
    at: new Date().toISOString(),
    jobId: String(index),
  }));
  const store = createDiagnosticStore(memoryStorage({ [DIAGNOSTIC_KEY]: [old, ...recent] }));
  await store.append({ event: 'timeout', jobId: 'last' });
  const entries = await store.read();
  assert.equal(entries.length, 1000);
  assert.equal(entries[0].jobId, '1');
  assert.equal(entries.at(-1).event, 'timeout');
});
test('invalid persisted storage and expired records do not break diagnostics', async () => {
  const store = createDiagnosticStore(memoryStorage({ [DIAGNOSTIC_KEY]: { bad: true } }));
  assert.deepEqual(await store.read(), []);
  await store.append({ event: 'scan', selected: 3, hidden: 2 });
  assert.equal((await store.read())[0].selected, 3);
});
