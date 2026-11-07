import { PageServiceRouter } from './failover.js';

let pageRouter;
export function configurePageRouting(settings, onChange, forceReset = false) {
  pageRouter ||= new PageServiceRouter(rawRpc, () => location.href, onChange);
  pageRouter.configure(settings, forceReset);
}
export function resetPageRouting() {
  pageRouter?.reset();
}
export function pageServiceStatus() {
  return pageRouter?.status();
}
export function rpc(kind, payload = {}) {
  if (kind === 'cancel') pageRouter?.cancel(payload.jobId);
  if (pageRouter && ['translate', 'vision'].includes(kind)) return pageRouter.run(kind, payload);
  return rawRpc(kind, payload);
}
function rawRpc(kind, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ channel: 'opao', kind, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok)
        return reject(
          Object.assign(new Error(response?.error || '扩展请求未返回结果，请重新打开页面'), {
            code: response?.code,
            status: response?.status,
          }),
        );
      resolve(response.data);
    });
  });
}
export function jobId() {
  return crypto.randomUUID();
}
export function onProgress(id, handler) {
  const listener = (message) => {
    if (message.channel === 'opao-progress' && message.jobId === id) handler(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
export async function translateItems(
  items,
  {
    role = 'text',
    profileId,
    targetLanguage,
    sourceLanguage,
    context = '',
    domain = '',
    fallback = true,
    jobId: id = jobId(),
  } = {},
) {
  return rpc('translate', {
    items,
    role,
    profileId,
    targetLanguage,
    sourceLanguage,
    context,
    domain,
    fallback,
    jobId: id,
  });
}
export function applyTheme(settings) {
  document.documentElement.dataset.theme = settings.theme || 'system';
  document.documentElement.style.colorScheme =
    settings.theme === 'system' ? 'light dark' : settings.theme;
}
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected')
      node[key] = Boolean(value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== null && child !== undefined && child !== false)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function textFile(text, filename, type = 'text/plain;charset=utf-8') {
  download(new Blob([text], { type }), filename);
}
export function status(node, value, error = false) {
  node.textContent = value;
  node.classList.toggle('error-text', error);
}
export function profileOptions(settings, selected, capability = 'text', inherit = false) {
  const options = [];
  if (inherit)
    options.push(
      el(
        'option',
        { value: '', selected: !selected },
        capability === 'vision' || capability === 'asr' ? '请单独选择服务' : '跟随文本服务',
      ),
    );
  for (const profile of settings.profiles.filter(
    (profile) => profile.enabled && profile.capabilities[capability],
  ))
    options.push(
      el(
        'option',
        { value: profile.id, selected: profile.id === selected },
        profile.name + (profile.model ? ` / ${profile.model}` : ''),
      ),
    );
  return options;
}
