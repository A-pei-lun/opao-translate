let database;
function open() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('opao-cache', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('translations', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
function operation(db, mode, work) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', mode);
    const request = work(transaction.objectStore('translations'));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}
export async function cacheGet(key, days) {
  const row = await operation(await open(), 'readonly', (store) => store.get(key));
  if (!row || (days && Date.now() - row.createdAt > days * 86400000)) return null;
  return row.text;
}
export async function cacheSet(key, text) {
  await operation(await open(), 'readwrite', (store) =>
    store.put({ key, text, createdAt: Date.now() }),
  );
}
export async function clearCache() {
  await operation(await open(), 'readwrite', (store) => store.clear());
}
export async function trimCache(max) {
  const db = await open();
  const count = await operation(db, 'readonly', (store) => store.count());
  if (count <= max) return count;
  const rows = await operation(db, 'readonly', (store) => store.getAll());
  const remove = rows.sort((a, b) => a.createdAt - b.createdAt).slice(0, count - max);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readwrite');
    const store = transaction.objectStore('translations');
    for (const row of remove) store.delete(row.key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return max;
}
export async function cacheStats() {
  return { entries: await operation(await open(), 'readonly', (store) => store.count()) };
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
