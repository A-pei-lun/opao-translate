import {
  CONFIG_KEY,
  normalizeSettings,
  publicSettings,
  resolveProfile,
  exportSettings,
  importLegacy,
} from './shared/config.js';

let runtimeCreation;
let mutation = Promise.resolve();
let siteRules;
let imageRuleId = 10000;
let imageRuleCleanup;
const imageRequests = new Map();
async function readImage(url, referrer) {
  const previous = imageRequests.get(url.href) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const id = ++imageRuleId;
      let installed = false;
      try {
        if (referrer && /^https?:/i.test(referrer)) {
          imageRuleCleanup ||= chrome.declarativeNetRequest.getSessionRules().then((rules) =>
            chrome.declarativeNetRequest.updateSessionRules({
              removeRuleIds: rules.filter((rule) => rule.id >= 10000).map((rule) => rule.id),
            }),
          );
          await imageRuleCleanup;
          const regex = '^' + url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
          await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [
              {
                id,
                priority: 1,
                action: {
                  type: 'modifyHeaders',
                  requestHeaders: [
                    { header: 'Referer', operation: 'set', value: new URL(referrer).origin + '/' },
                  ],
                },
                condition: {
                  regexFilter: regex,
                  initiatorDomains: [chrome.runtime.id],
                  resourceTypes: ['xmlhttprequest'],
                },
              },
            ],
          });
          installed = true;
        }
        const response = await fetch(url.href, {
          credentials: 'omit',
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('图片下载失败 HTTP ' + response.status);
        const type = response.headers.get('content-type') || '';
        if (!type.startsWith('image/')) throw new Error('该地址返回的内容类型不是图片');
        if (Number(response.headers.get('content-length')) > 32 * 1024 * 1024)
          throw new Error('图片超过 32MB，请先缩小');
        const blob = await response.blob();
        if (blob.size > 32 * 1024 * 1024) throw new Error('图片超过 32MB，请先缩小');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192)
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return { dataUrl: `data:${type.split(';')[0]};base64,${btoa(binary)}` };
      } finally {
        if (installed)
          await chrome.declarativeNetRequest
            .updateSessionRules({ removeRuleIds: [id] })
            .catch(() => {});
      }
    });
  imageRequests.set(url.href, task);
  try {
    return await task;
  } finally {
    if (imageRequests.get(url.href) === task) imageRequests.delete(url.href);
  }
}
async function settings() {
  const value = await chrome.storage.local.get(CONFIG_KEY);
  return normalizeSettings(value[CONFIG_KEY]);
}
async function saveSettings(raw) {
  const next = normalizeSettings(raw);
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}
function serializeMutation(work) {
  const next = mutation.then(work, work);
  mutation = next.catch(() => {});
  return next;
}
async function ensureRuntime() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!runtimeCreation)
    runtimeCreation = chrome.offscreen
      .createDocument({
        url: 'runtime.html',
        reasons: ['WORKERS', 'USER_MEDIA', 'BLOBS', 'DOM_PARSER'],
        justification: '运行用户请求的翻译队列、文档处理与音频识别',
      })
      .finally(() => {
        runtimeCreation = null;
      });
  await runtimeCreation;
}
async function runtime(payload, owner, config) {
  await ensureRuntime();
  const response = await chrome.runtime.sendMessage({
    channel: 'opao-runtime',
    payload,
    owner,
    settings: config || (await settings()),
  });
  if (!response?.ok) throw new Error(response?.error || '翻译运行时未返回结果');
  return response.data;
}
function trustedPage(sender) {
  return ['settings.html', 'popup.html', 'workspace.html'].some((page) =>
    sender.url?.startsWith(chrome.runtime.getURL(page)),
  );
}
function ownerOf(sender) {
  return sender.tab && !trustedPage(sender)
    ? `tab:${sender.tab.id}:${sender.frameId || 0}`
    : `page:${sender.documentId || sender.url}`;
}
async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}
async function focusedFrame(tabId) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const leaf = active?.tagName !== 'IFRAME';
        return {
          focused: document.hasFocus() && leaf,
          editable:
            leaf &&
            Boolean(
              active?.matches('input,textarea,[contenteditable]:not([contenteditable=false])'),
            ),
        };
      },
    });
    return (
      frames.find((frame) => frame.result?.focused)?.frameId ??
      frames.find((frame) => frame.result?.editable)?.frameId ??
      0
    );
  } catch {
    return 0;
  }
}
async function sendTab(tabId, action, payload = {}, frameId) {
  if (typeof tabId !== 'number') throw new Error('请先打开需要翻译的网页');
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      { channel: 'opao-action', action, ...payload },
      frameId === undefined ? undefined : { frameId },
    );
  } catch {
    throw new Error('当前页面尚未加载翻译脚本，请刷新网页。浏览器内部页面需要在工作台处理文件');
  }
}
async function openWorkspace(payload = {}) {
  const url = new URL(chrome.runtime.getURL('workspace.html'));
  for (const [key, value] of Object.entries(payload))
    if (typeof value === 'string') url.searchParams.set(key, value);
  return chrome.tabs.create({ url: url.href });
}
const menus = [
  ['toggle-page', '切换网页双语翻译', ['page', 'frame']],
  ['whole-page', '翻译整个页面', ['page', 'frame']],
  ['selection', '翻译选中文字', ['selection']],
  ['compare', '多模型对照翻译', ['selection']],
  ['translate-input', '翻译输入框', ['editable']],
  ['writing', 'AI 写作与改写', ['editable', 'selection']],
  ['translate-image', '翻译这张图片', ['image']],
  ['toggle-subtitles', '切换视频双语字幕', ['video', 'page']],
  ['capture-audio', '识别并翻译当前页面音频', ['video', 'page']],
  ['open-document', '用 O泡翻译打开文档', ['page', 'link']],
  ['open-workspace', '打开翻译工作台', ['action']],
  ['open-settings', '打开设置', ['action']],
];
async function createMenus() {
  await chrome.contextMenus.removeAll();
  for (const [id, title, contexts] of menus) chrome.contextMenus.create({ id, title, contexts });
}
async function startTabCapture(tabId) {
  const tab = await activeTab();
  if (!tab || tab.id !== tabId) throw new Error('请切换到要识别的页面后重新启动');
  const config = await settings();
  resolveProfile(config, 'asr');
  const status = await runtime({ kind: 'capture-status' }, `tab:${tabId}:0`, config);
  if (status?.tabId === tabId) {
    await runtime({ kind: 'stop-capture', discard: false }, `tab:${tabId}:0`, config);
    await sendTab(tabId, 'capture-state', { running: false }, 0).catch(() => {});
    return { stopped: true };
  }
  if (status) throw new Error('另一个页面正在识别，请先停止它的音频识别');
  await sendTab(tabId, 'capture-state', { running: true }, 0);
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return await runtime(
      { kind: 'start-capture', streamId, tabId, jobId: 'capture-' + tabId },
      `tab:${tabId}:0`,
      config,
    );
  } catch (error) {
    await sendTab(tabId, 'capture-state', { running: false }, 0).catch(() => {});
    throw error;
  }
}
async function action(name, tab, payload = {}, frameId) {
  if (name === 'open-settings') return chrome.runtime.openOptionsPage();
  if (name === 'open-workspace') return openWorkspace();
  if (name === 'open-document')
    return openWorkspace({ tool: 'documents', url: payload.url || tab?.url || '' });
  if (name === 'capture-audio') return startTabCapture(tab?.id);
  if (name === 'open-panel') {
    try {
      return await chrome.sidePanel.open({ tabId: tab?.id });
    } catch {
      return openWorkspace();
    }
  }
  const selectedFrame =
    frameId === undefined && ['selection', 'compare', 'translate-input', 'writing'].includes(name)
      ? await focusedFrame(tab?.id)
      : frameId;
  return sendTab(tab?.id, name, payload, selectedFrame);
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  action(
    info.menuItemId,
    tab,
    { text: info.selectionText, src: info.srcUrl, url: info.linkUrl },
    ['selection', 'compare', 'writing', 'translate-input', 'translate-image'].includes(
      info.menuItemId,
    )
      ? info.frameId || 0
      : undefined,
  ).catch(async (error) => {
    try {
      await sendTab(tab.id, 'notify', { text: error.message }, 0);
    } catch {
      await openWorkspace({ error: error.message });
    }
  });
});
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  action(command, tab).catch((error) =>
    sendTab(tab?.id, 'notify', { text: error.message }, 0).catch(() => {}),
  );
});
chrome.runtime.onInstalled.addListener(() => {
  serializeMutation(async () => {
    const value = await chrome.storage.local.get(CONFIG_KEY);
    if (!value[CONFIG_KEY]) await saveSettings({});
  });
  createMenus().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => createMenus().catch(() => {}));
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    if (!(await chrome.offscreen.hasDocument())) return;
    const status = await runtime({ kind: 'capture-status' }, 'background');
    if (status?.tabId === tabId)
      await runtime({ kind: 'stop-capture', discard: true }, 'background');
  } catch {}
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_KEY]) return;
  const config = publicSettings(normalizeSettings(changes[CONFIG_KEY].newValue));
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs)
      chrome.tabs
        .sendMessage(tab.id, { channel: 'opao-settings', settings: config })
        .catch(() => {});
  });
  chrome.runtime.sendMessage({ channel: 'opao-settings', settings: config }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.channel === 'opao-internal') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('runtime.html'))
      return false;
    if (message.kind === 'progress') {
      const data = { channel: 'opao-progress', jobId: message.jobId, ...message.data };
      const match = /^tab:(\d+):(\d+)$/.exec(message.owner);
      if (match)
        chrome.tabs
          .sendMessage(Number(match[1]), data, { frameId: Number(match[2]) })
          .catch(() => {});
      else chrome.runtime.sendMessage(data).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.channel !== 'opao' || sender.id !== chrome.runtime.id) return false;
  const privileged = trustedPage(sender);
  const publicMethods = [
    'get-public-settings',
    'get-site-rules',
    'page-action',
    'translate',
    'vision',
    'generate',
    'cancel',
    'fetch-image',
    'open-settings',
    'open-workspace',
    'set-site-rule',
    'capture-audio',
  ];
  if (!privileged && (!sender.tab || !publicMethods.includes(message.kind))) {
    sendResponse({ ok: false, error: '当前页面没有该操作权限' });
    return false;
  }
  (async () => {
    const owner = ownerOf(sender);
    if (message.kind === 'get-public-settings') return publicSettings(await settings());
    if (message.kind === 'get-site-rules') {
      siteRules ||= fetch(chrome.runtime.getURL('site-rules.json')).then((response) =>
        response.json(),
      );
      return siteRules;
    }
    if (message.kind === 'get-settings') return settings();
    if (message.kind === 'page-action') {
      if (
        !sender.tab ||
        ![
          'toggle-page',
          'whole-page',
          'restore',
          'only-translation',
          'toggle-mask',
          'toggle-subtitles',
          'translate-images',
        ].includes(message.action)
      )
        throw new Error('页面操作无效');
      return action(message.action, sender.tab);
    }
    if (message.kind === 'save-settings')
      return serializeMutation(() => saveSettings(message.settings));
    if (message.kind === 'patch-settings')
      return serializeMutation(async () => {
        const current = await settings();
        return saveSettings({
          ...current,
          ...message.patch,
          roles: { ...current.roles, ...message.patch?.roles },
        });
      });
    if (message.kind === 'export-settings')
      return exportSettings(await settings(), Boolean(message.includeSecrets));
    if (message.kind === 'import-settings')
      return serializeMutation(async () => {
        const current = await settings();
        const imported = importLegacy(message.settings);
        if (message.settings.secretsRemoved)
          for (const profile of imported.profiles) {
            const old = current.profiles.find((value) => value.id === profile.id);
            if (old) {
              profile.apiKey = old.apiKey;
              profile.headers = { ...old.headers, ...profile.headers };
            }
          }
        return saveSettings(imported);
      });
    if (message.kind === 'set-site-rule')
      return serializeMutation(async () => {
        const config = await settings();
        const host = new URL(trustedPage(sender) ? (await activeTab()).url : sender.tab.url)
          .hostname;
        if (message.mode === 'auto') config.autoSites = [...new Set([...config.autoSites, host])];
        else if (message.mode === 'block') {
          config.blockSites = [...new Set([...config.blockSites, host])];
          config.autoSites = config.autoSites.filter((value) => value !== host);
        } else {
          config.autoSites = config.autoSites.filter((value) => value !== host);
          config.blockSites = config.blockSites.filter((value) => value !== host);
        }
        await saveSettings(config);
        return publicSettings(config);
      });
    if (message.kind === 'active-tab') {
      const tab = await activeTab();
      return { id: tab?.id, title: tab?.title, url: tab?.url };
    }
    if (message.kind === 'tab-action')
      return action(
        message.action,
        await activeTab(),
        message.payload || {},
        Number.isInteger(message.frameId) && message.frameId >= 0 ? message.frameId : undefined,
      );
    if (message.kind === 'open-settings') return chrome.runtime.openOptionsPage();
    if (message.kind === 'open-workspace') return openWorkspace(message.payload);
    if (message.kind === 'capture-audio')
      return startTabCapture(sender.tab?.id || (await activeTab())?.id);
    if (message.kind === 'fetch-image') {
      const url = new URL(message.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('图片地址无效，请用工作台打开本地图片');
      return readImage(url, privileged ? message.referrer : sender.url);
    }
    if (
      [
        'translate',
        'vision',
        'generate',
        'transcribe',
        'models',
        'test-profile',
        'cancel',
        'clear-cache',
        'cache-stats',
        'logs',
        'capture-status',
      ].includes(message.kind)
    ) {
      const config = await settings();
      const payload = { ...message };
      if (!privileged) {
        delete payload.profile;
        if (!['text', 'input', 'vision', 'subtitle'].includes(payload.role)) payload.role = 'text';
      }
      if (payload.profile)
        payload.profile = normalizeSettings({ profiles: [payload.profile] }).profiles[0];
      return runtime(payload, owner, config);
    }
    throw new Error('未知扩展操作');
  })().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message || '操作失败' }),
  );
  return true;
});
