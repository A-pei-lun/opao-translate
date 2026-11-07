(() => {
  const marker = Symbol.for('opao.subtitle.hook');
  if (globalThis[marker]) return;
  globalThis[marker] = true;
  const interesting = (url) =>
    /timedtext|\.vtt(?:\?|$)|\.srt(?:\?|$)|\.ttml(?:\?|$)|\/subtitle|\/caption|\/bfs\/subtitle/i.test(
      String(url),
    );
  const publish = (url, text) => {
    if (typeof text !== 'string' || text.length > 3000000 || !text.trim()) return;
    globalThis.postMessage(
      { type: 'opao-caption-source', url: String(url).slice(0, 4000), text },
      location.origin === 'null' ? '*' : location.origin,
    );
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || response.url;
    if (response.ok && interesting(url))
      response
        .clone()
        .text()
        .then((text) => publish(url, text))
        .catch(() => {});
    return response;
  };
  const urls = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    urls.set(this, url);
    return originalOpen.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener(
      'load',
      () => {
        if (!interesting(urls.get(this))) return;
        try {
          if (this.responseType === '' || this.responseType === 'text')
            publish(urls.get(this), this.responseText);
          else if (this.responseType === 'json')
            publish(urls.get(this), JSON.stringify(this.response));
        } catch {}
      },
      { once: true },
    );
    return originalSend.apply(this, args);
  };
})();
