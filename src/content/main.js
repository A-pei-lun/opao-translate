import { rpc, translateItems, jobId } from '../shared/client.js';
import { matchesUrl } from '../shared/config.js';
import { imageCanvas, translateImage } from '../shared/images.js';
import { PageTranslator } from './dom.js';
import { ContentUI } from './ui.js';
import { CaptionController } from './captions.js';

if (!globalThis.__opaoContent) {
  globalThis.__opaoContent = true;
  const ready = initialize();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (sender.id !== chrome.runtime.id) return false;
    if (message.channel === 'opao-action') {
      ready
        .then((app) => app.action(message.action, message))
        .then(
          (data) => sendResponse({ ok: true, data }),
          (error) => sendResponse({ ok: false, error: error.message }),
        );
      return true;
    }
    if (message.channel === 'opao-settings') {
      ready.then((app) => app.update(message.settings, message.translationChanged !== false));
      return false;
    }
    if (message.channel === 'opao-progress') {
      ready.then((app) => {
        if (message.type === 'capture-cue') app.captions.asrCue(message.cue);
        else if (message.type === 'capture-error') app.ui.notify(message.error);
        else if (message.type === 'capture-stopped') {
          app.captions.asrMode = false;
          app.ui.notify('页面音频识别已停止');
        }
      });
    }
    return false;
  });
  ready.catch(() => {});
}

async function initialize() {
  let [settings, rules] = await Promise.all([
    rpc('get-public-settings'),
    rpc('get-site-rules').catch(() => []),
  ]);
  const ui = new ContentUI(settings);
  const page = new PageTranslator(settings, rules, (message) => ui.notify(message));
  const captions = new CaptionController(settings, ui);
  const imageStates = new Map();
  let focused,
    selectedText = '',
    hoverTimer,
    lastUrl = location.href;

  function requireText(role = 'text') {
    const id = settings.roles[role] || settings.roles.text;
    const profile = settings.profiles.find((value) => value.id === id && value.enabled);
    if (!profile?.configured) throw new Error('请先打开设置，补全翻译接口和模型，再选择场景服务');
  }
  function editable() {
    let active = focused || document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active?.matches('input,textarea,[contenteditable]:not([contenteditable=false])')
      ? active
      : null;
  }
  function inputSelection(element, explicitText) {
    if (!element) throw new Error('请先把光标放入要翻译的输入框');
    if (element.matches('input[type=password],input[type=hidden]'))
      throw new Error('密码和隐藏输入框不参与翻译');
    if ('value' in element) {
      const start = element.selectionStart ?? 0;
      const end = element.selectionEnd ?? start;
      const selected =
        explicitText || (end > start ? element.value.slice(start, end) : element.value);
      const original = element.value;
      return {
        text: selected,
        apply(text) {
          if (!element.isConnected) throw new Error('原输入框已经移除，请重新选择');
          const value = end > start ? original.slice(0, start) + text + original.slice(end) : text;
          const prototype =
            element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
          element.focus();
          element.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: 'insertReplacementText',
              data: text,
            }),
          );
          element.dispatchEvent(new Event('change', { bubbles: true }));
        },
      };
    }
    const selection = document.getSelection();
    let range =
      selection.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const hasSelection = range && !range.collapsed;
    const text = explicitText || (hasSelection ? range.toString() : element.innerText);
    return {
      text,
      apply(value) {
        if (!element.isConnected) throw new Error('原输入框已经移除，请重新选择');
        if (!hasSelection) {
          range = document.createRange();
          range.selectNodeContents(element);
        }
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
        range.collapse(false);
        element.focus();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertReplacementText',
            data: value,
          }),
        );
      },
    };
  }
  async function imageSource(image) {
    const src = image.currentSrc || image.src;
    if (!/^https?:/i.test(src)) return src;
    try {
      const response = await fetch(src, { credentials: 'omit' });
      if (response.ok) return URL.createObjectURL(await response.blob());
    } catch {}
    return (await rpc('fetch-image', { url: src })).dataUrl;
  }
  function restoreImage(image) {
    const record = imageStates.get(image);
    if (!record) return;
    for (const id of record.jobs) rpc('cancel', { jobId: id }).catch(() => {});
    for (const [name, value] of Object.entries(record.attributes)) {
      if (value === null) image.removeAttribute(name);
      else image.setAttribute(name, value);
    }
    for (const { element, srcset } of record.sources) {
      if (srcset === null) element.removeAttribute('srcset');
      else element.setAttribute('srcset', srcset);
    }
    delete image.dataset.opaoTranslated;
    imageStates.delete(image);
  }
  async function translateOneImage(image) {
    if (imageStates.has(image)) {
      restoreImage(image);
      return;
    }
    const profile = settings.profiles.find(
      (value) => value.id === settings.roles.vision && value.enabled && value.capabilities.vision,
    );
    if (!profile?.configured) throw new Error('请在设置中为图片单独选择支持视觉输入的模型');
    const originalSrc = image.currentSrc || image.src;
    const record = {
      attributes: Object.fromEntries(
        ['src', 'srcset', 'sizes'].map((name) => [name, image.getAttribute(name)]),
      ),
      sources: [...(image.closest('picture')?.querySelectorAll('source') || [])].map((element) => ({
        element,
        srcset: element.getAttribute('srcset'),
      })),
      jobs: new Set(),
    };
    imageStates.set(image, record);
    ui.notify('正在读取图片…');
    let source;
    try {
      source = await imageSource(image);
      const canvas = await imageCanvas(source);
      const result = await translateImage(
        canvas,
        settings,
        async (imageData) => {
          if (imageStates.get(image) !== record) throw new Error('已取消图片翻译');
          const id = jobId();
          record.jobs.add(id);
          try {
            return await rpc('vision', {
              jobId: id,
              image: imageData,
              targetLanguage: settings.targetLanguage,
            });
          } finally {
            record.jobs.delete(id);
          }
        },
        (progress) => ui.notify(`图片识别 ${progress.completed}/${progress.total}`),
      );
      if (imageStates.get(image) !== record) return;
      if ((image.currentSrc || image.src) !== originalSrc)
        throw new Error('页面已更新图片来源，请重新翻译');
      for (const item of record.sources) item.element.removeAttribute('srcset');
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
      image.src = result.canvas.toDataURL('image/png');
      image.dataset.opaoTranslated = 'true';
      ui.notify('图片翻译完成，再次翻译此图可恢复原图');
    } catch (error) {
      if (imageStates.get(image) === record) imageStates.delete(image);
      throw error;
    } finally {
      if (source?.startsWith('blob:') && source !== originalSrc) URL.revokeObjectURL(source);
    }
  }
  async function action(name, payload = {}) {
    if (name === 'notify') {
      ui.notify(payload.text);
      return;
    }
    if (name === 'get-status')
      return {
        active: page.active,
        subtitles: captions.enabled,
        mode: page.settings.mode,
        images: imageStates.size,
      };
    if (name === 'capture-state') {
      captions.asrMode = Boolean(payload.running);
      captions.enabled = Boolean(payload.running);
      if (payload.running) ui.notify('正在识别页面音频，请保持播放');
      else {
        ui.showCaption('', '');
        ui.notify('页面音频识别已停止');
      }
      return;
    }
    if (name === 'toggle-page' || name === 'whole-page') {
      if (page.active && name === 'toggle-page') {
        page.restore();
        return { active: false };
      }
      requireText();
      await page.start(name === 'whole-page');
      return { active: true };
    }
    if (name === 'restore') {
      page.restore();
      for (const image of imageStates.keys()) restoreImage(image);
      return;
    }
    if (name === 'only-translation') {
      if (!page.active) {
        requireText();
        await page.start();
      }
      page.toggleMode();
      return;
    }
    if (name === 'toggle-mask') {
      page.toggleMask();
      return;
    }
    if (name === 'selection' || name === 'compare') {
      requireText();
      const text = payload.text || document.getSelection()?.toString() || selectedText;
      if (!text?.trim()) throw new Error('请先选中文字');
      ui.showText(text, { comparison: name === 'compare' });
      return;
    }
    if (name === 'translate-input' || name === 'writing') {
      requireText('input');
      const element = editable();
      const input = element
        ? inputSelection(element, payload.text)
        : { text: payload.text || selectedText, apply: undefined };
      if (!input.text?.trim() && name === 'translate-input')
        throw new Error('输入框当前没有可翻译文字');
      ui.showText(input.text || '', {
        writing: name === 'writing',
        apply: input.apply,
        role: 'input',
        targetLanguage: settings.inputTargetLanguage,
      });
      return;
    }
    if (name === 'translate-image') {
      const image = [...document.images].find(
        (image) => (image.currentSrc || image.src) === payload.src || image.src === payload.src,
      );
      if (!image)
        return rpc('open-workspace', { payload: { tool: 'images', url: payload.src || '' } });
      return translateOneImage(image);
    }
    if (name === 'translate-images') {
      const images = [...document.images].filter(
        (image) =>
          image.naturalWidth >= 100 && image.naturalHeight >= 100 && !imageStates.has(image),
      );
      let index = 0,
        done = 0;
      await Promise.all(
        Array.from({ length: Math.min(settings.imageConcurrency, images.length) }, async () => {
          while (index < images.length) {
            const image = images[index++];
            try {
              await translateOneImage(image);
              done++;
            } catch (error) {
              ui.notify(error.message);
            }
          }
        }),
      );
      ui.notify(`已处理 ${done}/${images.length} 张图片`);
      return;
    }
    if (name === 'toggle-subtitles') {
      requireText('subtitle');
      return captions.toggle();
    }
    if (name === 'download-subtitles') return captions.export();
    if (name === 'capture-audio') return rpc('capture-audio');
    if (name === 'auto-site') return rpc('set-site-rule', { mode: 'auto' });
    if (name === 'block-site') {
      page.restore();
      return rpc('set-site-rule', { mode: 'block' });
    }
    throw new Error('页面操作尚未识别');
  }
  ui.floating(() =>
    rpc('page-action', { action: 'toggle-page' }).catch((error) => ui.notify(error.message)),
  );
  document.addEventListener(
    'focusin',
    (event) => {
      if (!event.target.closest?.('[data-opao-ui]')) focused = event.target;
    },
    true,
  );
  document.addEventListener('mouseup', (event) => {
    if (event.composedPath().includes(ui.host)) return;
    setTimeout(() => {
      const selection = document.getSelection();
      const text = selection?.toString().trim();
      if (
        !settings.selection ||
        !text ||
        (editable() && editable().contains(selection.anchorNode)) ||
        text.length > 100000
      ) {
        ui.hideBubble();
        return;
      }
      selectedText = text;
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range)
        ui.selectionBubble(range.getBoundingClientRect(), () =>
          action('selection', { text }).catch((error) => ui.notify(error.message)),
        );
    }, 30);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      ui.close();
      ui.hideBubble();
      speechSynthesis.cancel();
    }
  });
  document.addEventListener(
    'mouseover',
    (event) => {
      clearTimeout(hoverTimer);
      const modifier =
        settings.hoverModifier === 'Control'
          ? event.ctrlKey
          : settings.hoverModifier === 'Shift'
            ? event.shiftKey
            : event.altKey;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !settings.hover ||
        !modifier ||
        !target ||
        target.closest('[data-opao-ui],.opao-target,input,textarea,[contenteditable]')
      )
        return;
      hoverTimer = setTimeout(() => {
        if (target instanceof HTMLImageElement)
          translateOneImage(target).catch((error) => ui.notify(error.message));
        else {
          try {
            requireText();
            page.translateElement(target).catch((error) => ui.notify(error.message));
          } catch (error) {
            ui.notify(error.message);
          }
        }
      }, 550);
    },
    true,
  );
  document.addEventListener('mouseout', () => clearTimeout(hoverTimer), true);
  setInterval(() => {
    if (lastUrl === location.href) return;
    const wasActive = page.active;
    lastUrl = location.href;
    page.restore();
    captions.cues = [];
    captions.cache.clear();
    if (
      !page.blocked() &&
      (wasActive || settings.autoSites.some((pattern) => matchesUrl(pattern, location.href)))
    )
      page.start().catch((error) => ui.notify(error.message));
  }, 700);
  if (!page.blocked() && settings.autoSites.some((pattern) => matchesUrl(pattern, location.href))) {
    try {
      requireText();
      page.start().catch((error) => ui.notify(error.message));
    } catch (error) {
      ui.notify(error.message);
    }
  }
  return {
    ui,
    captions,
    action,
    update(next, translationChanged = true) {
      settings = next;
      ui.update(next);
      captions.update(next, translationChanged);
      page.update(next, translationChanged);
    },
  };
}
