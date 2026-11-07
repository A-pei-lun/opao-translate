import {
  el,
  rpc,
  translateItems,
  jobId,
  onProgress,
  textFile,
  download,
} from '../shared/client.js';
import { wrapText, canvasBlob } from '../shared/images.js';
import { LANGUAGES } from '../shared/config.js';
import { TRANSLATION_STYLES } from '../shared/appearance.js';
import { FloatingDock, floatingCss } from './floating.js';

const css = `
:host {
  --paper: #f7fafc;
  --surface: #fff;
  --ink: #18354c;
  --muted: #5a7184;
  --brand: #086f83;
  --soft: #ddf2f1;
  --line: #d5e2e9;
  all: initial;
  font:
    14px/1.65 "Microsoft YaHei UI",
    "Microsoft YaHei",
    sans-serif;
  color: var(--ink);
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  pointer-events: none;
  overflow: clip;
  color-scheme: light;
}
:host([data-theme="dark"]) {
  --paper: #14212e;
  --surface: #1d3040;
  --ink: #ecf6ff;
  --muted: #b3c4d1;
  --brand: #78d6d1;
  --soft: #24494d;
  --line: #40576a;
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :host([data-theme="system"]) {
    --paper: #14212e;
    --surface: #1d3040;
    --ink: #ecf6ff;
    --muted: #b3c4d1;
    --brand: #78d6d1;
    --soft: #24494d;
    --line: #40576a;
    color-scheme: dark;
  }
}
* {
  box-sizing: border-box;
}
button,
select,
textarea,
input {
  font: inherit;
  color: inherit;
}
button,
select {
  cursor: pointer;
}
button {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 7px;
  padding: 5px 11px;
  min-height: 32px;
}
button:hover {
  background: var(--soft);
}
button:disabled {
  opacity: 0.55;
  cursor: wait;
}
button:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.primary {
  background: var(--brand);
  color: var(--surface);
  border-color: var(--brand);
}
.primary:hover {
  filter: brightness(1.08);
  background: var(--brand);
}
.floating {
  position: fixed;
  inset-inline-end: 18px;
  bottom: 26px;
  width: 46px;
  height: 46px;
  padding: 0;
  border-radius: 50% 50% 50% 14%;
  background: var(--brand);
  color: var(--surface);
  font:
    500 25px/1 Georgia,
    serif;
  box-shadow: 0 4px 20px #0002;
  pointer-events: auto;
}
.bubble {
  position: fixed;
  pointer-events: auto;
  padding: 3px 10px;
  background: var(--brand);
  color: var(--surface);
  border-radius: 14px;
}
.panel {
  position: fixed;
  inset-inline-end: 18px;
  top: 60px;
  width: min(510px, calc(100vw - 24px));
  max-height: calc(100vh - 80px);
  overflow: auto;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 12px 50px #0003;
  pointer-events: auto;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  position: sticky;
  top: 0;
  padding: 12px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  z-index: 1;
}
.panel-head strong {
  font-size: 16px;
  font-weight: 600;
  flex: 1;
}
.panel-body {
  display: grid;
  gap: 12px;
  padding: 16px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
}
.source {
  width: 100%;
  min-height: 90px;
  max-height: 220px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
  resize: vertical;
}
.result {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-height: 60px;
  max-height: 380px;
  overflow: auto;
  padding: 12px 0;
  user-select: text;
  line-height: 1.85;
  font-size: 16px;
}
.muted,
.status {
  color: var(--muted);
  font-size: 12px;
}
.error {
  color: #b42335;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(620px, calc(100vw - 30px));
  padding: 10px 16px;
  border-radius: 9px;
  background: var(--ink);
  color: var(--surface);
  box-shadow: 0 3px 18px #0003;
  pointer-events: auto;
}
.switch-toast { opacity: 0; transition: opacity 180ms ease; z-index: 2; }
.switch-toast.visible { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .switch-toast { transition: none; } }
.caption {
  position: fixed;
  bottom: 8%;
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 90vw;
  text-align: center;
  color: #fff;
  text-shadow: 0 1px 4px #000;
  background: #101820d9;
  border-radius: 7px;
  padding: 7px 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.4;
  pointer-events: none;
}
.caption-original {
  font-size: 0.78em;
  opacity: 0.9;
}
.caption-target {
  font-weight: 500;
}
.caption-controls {
  pointer-events: auto;
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  margin-bottom: 3px;
}
.caption-controls button {
  font-size: 11px;
  padding: 1px 7px;
  min-height: 23px;
  background: #223847;
  color: #fff;
  border-color: #5a7184;
}
.caption[hidden],
.panel[hidden],
.bubble[hidden],
.toast[hidden] {
  display: none;
}
@media (max-width: 480px) {
  .panel {
    top: 12px;
    inset-inline-end: 12px;
    max-height: calc(100vh - 24px);
  }
  .panel-body {
    padding: 12px;
  }
  .floating {
    bottom: 18px;
    inset-inline-end: 12px;
  }
}
@media (max-height: 420px) {
  .panel {
    top: 6px;
    inset-inline-end: 6px;
    max-height: calc(100vh - 12px);
  }
  .panel-head {
    position: static;
    padding: 6px 10px;
  }
  .panel-body {
    padding: 10px;
    gap: 8px;
  }
  .source {
    min-height: 60px;
  }
  .result {
    max-height: none;
    min-height: 40px;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
`;
export class ContentUI {
  constructor(settings) {
    this.settings = settings;
    this.host = el('opao-reader-ui', {
      'data-opao-ui': 'true',
      'data-theme': settings.theme || 'system',
    });
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.append(el('style', { text: css + floatingCss }));
    this.pageSettings = el('section', {
      id: 'opao-page-settings',
      class: 'page-settings',
      role: 'dialog',
      'aria-label': '页内设置',
      hidden: '',
    });
    this.toastNode = el('div', { class: 'toast', role: 'status', hidden: '' });
    this.switchToast = el('div', {
      class: 'toast switch-toast',
      role: 'status',
      'aria-live': 'polite',
      hidden: '',
    });
    this.switchQueue = [];
    this.panel = el('section', {
      class: 'panel',
      hidden: '',
      role: 'dialog',
      'aria-label': 'O泡翻译',
    });
    this.bubble = el('button', {
      class: 'bubble',
      hidden: '',
      'aria-label': '翻译选中文字',
      text: '译',
    });
    this.caption = el('div', { class: 'caption', hidden: '', 'aria-label': '双语字幕' });
    this.captionOriginal = el('div', { class: 'caption-original' });
    this.captionTarget = el('div', { class: 'caption-target' });
    this.caption.append(this.captionOriginal, this.captionTarget);
    this.shadow.append(this.panel, this.bubble, this.caption, this.toastNode, this.pageSettings);
    this.shadow.append(this.switchToast);
    document.documentElement.append(this.host);
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.pageSettings.hidden && !event.composedPath().includes(this.host))
          this.closePageSettings();
      },
      true,
    );
  }
  update(settings) {
    this.settings = settings;
    this.host.dataset.theme = settings.theme || 'system';
    this.caption.style.fontSize = settings.subtitleFontSize + 'px';
    if (this.onFloatTranslate) this.floating(this.onFloatTranslate);
    this.refreshPageSettings();
  }
  notify(message) {
    if (this.switchActive) {
      rpc('record-diagnostic', { entry: { event: 'toast-suppressed' } }).catch(() => {});
      return;
    }
    clearTimeout(this.toastTimer);
    this.toastNode.textContent = message;
    this.toastNode.hidden = false;
    this.toastTimer = setTimeout(() => {
      this.toastNode.hidden = true;
    }, 6500);
  }
  notifySwitch() {
    this.switchQueue.push(1);
    rpc('record-diagnostic', {
      entry: { event: 'toast-queued', queued: this.switchQueue.length },
    }).catch(() => {});
    if (!this.switchActive) this.showSwitchQueue();
  }
  async showSwitchQueue() {
    this.switchActive = true;
    clearTimeout(this.toastTimer);
    this.toastNode.hidden = true;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    while (this.switchQueue.length) {
      this.switchQueue.shift();
      this.switchToast.textContent = '提供商服务不可用，正在切换预设';
      this.switchToast.hidden = false;
      await pause(20);
      this.switchToast.classList.add('visible');
      rpc('record-diagnostic', { entry: { event: 'toast-shown' } }).catch(() => {});
      await pause(3180);
      this.switchToast.classList.remove('visible');
      await pause(180);
      this.switchToast.hidden = true;
      rpc('record-diagnostic', { entry: { event: 'toast-hidden' } }).catch(() => {});
    }
    this.switchActive = false;
  }
  floating(action) {
    this.onFloatTranslate = action;
    if (!this.settings.floatingButton || window !== window.top) {
      this.closePageSettings();
      this.dock?.destroy();
      this.dock = null;
      return;
    }
    if (this.dock) return;
    this.dock = new FloatingDock(this.shadow, {
      translate: () => {
        this.onFloatTranslate();
        if (!this.pageSettings.hidden) setTimeout(() => this.refreshPageState(), 60);
      },
      settings: () => this.togglePageSettings(),
      move: () => this.positionPageSettings(),
      notify: (message) => this.notify(message),
    });
    this.float = this.dock.button;
  }
  positionPageSettings() {
    if (this.pageSettings.hidden || !this.dock) return;
    const { x, y, size } = this.dock.anchor();
    const bounds = this.pageSettings.getBoundingClientRect();
    let left = x > innerWidth / 2 ? x - bounds.width - 12 : x + size + 12;
    let top = y;
    if (innerWidth < bounds.width + size + 36)
      top = y >= bounds.height + 24 ? y - bounds.height - 12 : y + size + 42;
    left = Math.max(12, Math.min(innerWidth - bounds.width - 12, left));
    top = Math.max(12, Math.min(innerHeight - bounds.height - 12, top));
    this.pageSettings.style.left = left + 'px';
    this.pageSettings.style.top = top + 'px';
  }
  closePageSettings() {
    this.pageSettings.hidden = true;
    this.dock?.setOpen(false);
  }
  async refreshPageState() {
    if (this.pageSettings.hidden || !this.pageTranslate) return;
    try {
      const value = await rpc('page-action', { action: 'get-status' });
      this.pageTranslate.textContent = value?.active ? '显示原文' : '翻译页面';
    } catch {}
  }
  refreshPageSettings() {
    if (!this.pageFields) return;
    const profiles = this.settings.profiles.filter(
      (profile) =>
        profile.enabled &&
        profile.capabilities.text &&
        profile.protocol !== 'asr' &&
        profile.configured,
    );
    const service = this.pageFields.profileId;
    service.replaceChildren(
      el('option', { value: '' }, profiles.length ? '请选择服务' : '请先配置文本服务'),
      ...profiles.map((profile) =>
        el(
          'option',
          { value: profile.id },
          profile.name + (profile.model ? ' / ' + profile.model : ''),
        ),
      ),
    );
    service.value = profiles.some((profile) => profile.id === this.settings.roles.text)
      ? this.settings.roles.text
      : '';
    for (const key of ['sourceLanguage', 'targetLanguage', 'mode', 'translationStyle'])
      this.pageFields[key].value = this.settings[key];
    for (const field of Object.values(this.pageFields)) field.disabled = Boolean(this.pageSaving);
    service.disabled = this.pageSaving || !profiles.length;
    this.pageTranslate.disabled = this.pageSaving || !service.value;
    if (!this.pageSaving) this.refreshPageState();
    this.updatePageService(this.pageService);
  }
  updatePageService(value) {
    this.pageService = value;
    if (!this.pageServiceNote) return;
    this.pageServiceNote.hidden = !value?.enabled;
    const profile = this.settings.profiles.find((profile) => profile.id === value?.profileId);
    this.pageServiceNote.textContent = value?.exhausted
      ? '本页备用服务均已超时，可手动更换服务后重试'
      : `本页实际服务 ${profile?.name || '尚未选择'}${value?.profileId !== value?.preferredId ? '（自动切换）' : ''}`;
  }
  togglePageSettings() {
    if (!this.pageSettings.hidden) {
      this.closePageSettings();
      return;
    }
    this.close(false);
    if (!this.pageFields) {
      const label = (name, control) => el('label', {}, el('span', { text: name }), control);
      const makeSelect = (name, pairs) =>
        el(
          'select',
          { 'aria-label': name },
          pairs.map(([value, text]) => el('option', { value }, text)),
        );
      this.pageFields = {
        profileId: makeSelect('页内翻译服务', []),
        sourceLanguage: makeSelect('页内源语言', LANGUAGES),
        targetLanguage: makeSelect(
          '页内目标语言',
          LANGUAGES.filter(([id]) => id !== 'auto'),
        ),
        mode: makeSelect('页内翻译偏好', [
          ['bilingual', '双语对照'],
          ['translation', '纯译文'],
        ]),
        translationStyle: makeSelect('页内译文样式', TRANSLATION_STYLES),
      };
      this.pageResult = el('div', { class: 'settings-result', role: 'status' });
      this.pageServiceNote = el('div', {
        class: 'settings-result',
        'aria-live': 'polite',
        hidden: true,
      });
      for (const [key, field] of Object.entries(this.pageFields))
        field.onchange = async () => {
          if (this.pageSaving) return;
          this.pageSaving = true;
          this.pageResult.classList.remove('error');
          this.pageResult.textContent = '正在保存…';
          const value = field.value;
          this.refreshPageSettings();
          try {
            this.settings = await rpc('set-page-preferences', { [key]: value });
            this.pageResult.textContent =
              key === 'profileId' ? '默认翻译服务已切换' : '阅读偏好已保存';
          } catch (error) {
            this.pageResult.textContent = error.message;
            this.pageResult.classList.add('error');
          } finally {
            this.pageSaving = false;
            this.refreshPageSettings();
            this.positionPageSettings();
          }
        };
      this.pageTranslate = el('button', {
        class: 'primary',
        text: '翻译页面',
        onclick: async () => {
          try {
            await rpc('page-action', { action: 'toggle-page' });
            this.refreshPageState();
          } catch (error) {
            this.pageResult.textContent = error.message;
            this.pageResult.classList.add('error');
          }
        },
      });
      this.pageSettings.append(
        el(
          'div',
          { class: 'page-settings-head' },
          el('strong', { text: '页内设置' }),
          el('button', {
            text: '关闭',
            'aria-label': '关闭页内设置',
            onclick: () => {
              this.closePageSettings();
              this.dock?.settingsButton.focus();
            },
          }),
        ),
        el(
          'div',
          { class: 'page-settings-body' },
          el(
            'div',
            { class: 'page-settings-row' },
            label('源语言', this.pageFields.sourceLanguage),
            label('目标语言', this.pageFields.targetLanguage),
          ),
          label('翻译服务', this.pageFields.profileId),
          this.pageServiceNote,
          el(
            'div',
            { class: 'page-settings-row' },
            label('翻译偏好', this.pageFields.mode),
            label('译文样式', this.pageFields.translationStyle),
          ),
          this.pageTranslate,
          this.pageResult,
          el('button', {
            text: '完整设置与字体',
            onclick: () => rpc('open-settings').catch((error) => this.notify(error.message)),
          }),
        ),
      );
    }
    this.pageSettings.hidden = false;
    this.dock?.setOpen(true);
    this.refreshPageSettings();
    this.positionPageSettings();
  }
  selectionBubble(rect, action) {
    this.bubble.hidden = false;
    this.bubble.style.left = Math.max(4, Math.min(innerWidth - 50, rect.right - 24)) + 'px';
    this.bubble.style.top = Math.max(4, Math.min(innerHeight - 40, rect.bottom + 6)) + 'px';
    this.bubble.onclick = () => {
      this.bubble.hidden = true;
      action();
    };
  }
  hideBubble() {
    this.bubble.hidden = true;
  }
  showCaption(original, translated = '') {
    this.caption.hidden = !original && !translated;
    this.captionOriginal.textContent = original;
    this.captionTarget.textContent = translated;
    this.caption.style.fontSize = this.settings.subtitleFontSize + 'px';
  }
  close(restoreFocus = true) {
    const wasOpen = !this.panel.hidden;
    this.closePageSettings();
    this.panel.hidden = true;
    for (const id of this.panelJobs || []) rpc('cancel', { jobId: id }).catch(() => {});
    this.panelJobs = new Set();
    if (
      wasOpen &&
      restoreFocus &&
      this.previousFocus?.isConnected &&
      this.previousFocus !== this.host
    )
      this.previousFocus.focus?.();
  }
  showText(
    source,
    {
      comparison = false,
      writing = false,
      apply,
      role = 'text',
      targetLanguage = this.settings.targetLanguage,
    } = {},
  ) {
    this.close();
    this.panel.hidden = false;
    this.previousFocus = document.activeElement;
    const title = writing ? '写作与改写' : comparison ? '多模型对照' : '划词翻译';
    const head = el(
      'div',
      { class: 'panel-head' },
      el('strong', { text: title }),
      el('button', {
        text: '工作台',
        onclick: () => rpc('open-workspace').catch((error) => this.notify(error.message)),
      }),
      el('button', { text: '关闭', 'aria-label': '关闭翻译面板', onclick: () => this.close() }),
    );
    const input = el('textarea', { class: 'source', 'aria-label': '原文', maxlength: '100000' });
    input.value = source;
    const result = el('div', { class: 'result', 'aria-live': 'polite' });
    const status = el('div', { class: 'status', role: 'status' });
    const instruction = el('textarea', {
      class: 'source',
      'aria-label': '写作指令',
      placeholder: '填写改写、解释、润色或写作要求',
    });
    instruction.value = writing ? '保留原意，使表达自然、准确、简洁。只返回处理后的文本。' : '';
    const profileSelect = el(
      'select',
      { 'aria-label': '翻译服务' },
      this.settings.profiles
        .filter((profile) => profile.enabled && profile.capabilities.text)
        .map((profile) =>
          el(
            'option',
            {
              value: profile.id,
              selected: profile.id === (this.settings.roles[role] || this.settings.roles.text),
            },
            profile.name,
          ),
        ),
    );
    const start = el('button', { class: 'primary', text: writing ? '生成文本' : '翻译' });
    const stop = el('button', {
      text: '取消',
      onclick: () => {
        for (const id of this.panelJobs) rpc('cancel', { jobId: id }).catch(() => {});
      },
    });
    let finalText = '';
    const perform = async () => {
      if (!input.value.trim()) return;
      for (const id of this.panelJobs) rpc('cancel', { jobId: id }).catch(() => {});
      this.panelJobs = new Set();
      start.disabled = true;
      input.disabled = true;
      instruction.disabled = true;
      profileSelect.disabled = true;
      result.replaceChildren();
      status.textContent = '正在处理…';
      finalText = '';
      const profileIds = comparison
        ? this.settings.comparisonProfiles.length
          ? this.settings.comparisonProfiles
          : this.settings.profiles
              .filter((profile) => profile.enabled && profile.capabilities.text)
              .slice(0, 3)
              .map((profile) => profile.id)
        : [profileSelect.value];
      if (!profileIds.length) {
        start.disabled = false;
        input.disabled = false;
        instruction.disabled = false;
        profileSelect.disabled = false;
        status.textContent = '请先在设置中添加文本服务';
        return;
      }
      await Promise.all(
        profileIds.map(async (profileId) => {
          const id = jobId();
          this.panelJobs.add(id);
          const block = el('div');
          if (comparison)
            block.append(
              el('div', {
                class: 'muted',
                text:
                  this.settings.profiles.find((profile) => profile.id === profileId)?.name ||
                  profileId,
              }),
            );
          const output = el('div', { class: 'result' });
          block.append(output);
          result.append(block);
          const unsubscribe = writing
            ? onProgress(id, (message) => {
                if (message.type === 'stream' && this.panelJobs.has(id))
                  output.textContent = message.text;
              })
            : () => {};
          try {
            let value;
            if (writing)
              value = await rpc('generate', {
                jobId: id,
                profileId,
                prompt: `${instruction.value}\n\n目标语言 ${targetLanguage}\n\n<source>\n${input.value}\n</source>`,
              });
            else
              value = (
                await translateItems([{ id: 'selection', text: input.value }], {
                  jobId: id,
                  profileId,
                  fallback: !comparison,
                  role,
                  targetLanguage,
                  sourceLanguage: this.settings.sourceLanguage,
                  context: document.title,
                  domain: location.hostname,
                })
              )[0].text;
            if (!this.panelJobs.has(id)) return;
            output.textContent = value;
            if (!finalText) finalText = value;
          } catch (error) {
            output.textContent = error.message;
            output.classList.add('error');
          } finally {
            unsubscribe();
            this.panelJobs.delete(id);
          }
        }),
      );
      status.textContent = '处理结束';
      start.disabled = false;
      input.disabled = false;
      instruction.disabled = false;
      profileSelect.disabled = false;
    };
    start.onclick = perform;
    const actions = el(
      'div',
      { class: 'tools' },
      el('button', {
        text: '复制结果',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(finalText);
            status.textContent = '已复制';
          } catch {
            status.textContent = '复制失败，请手动选择结果';
          }
        },
      }),
      el('button', {
        text: '朗读',
        onclick: () => {
          speechSynthesis.cancel();
          const speech = new SpeechSynthesisUtterance(finalText);
          speech.lang = this.settings.targetLanguage;
          speechSynthesis.speak(speech);
        },
      }),
      el('button', { text: '导出文本', onclick: () => textFile(finalText, 'O泡翻译.txt') }),
      el('button', {
        text: '生成分享图',
        onclick: () =>
          this.share(input.value, finalText).catch((error) => this.notify(error.message)),
      }),
    );
    if (apply)
      actions.append(
        el('button', {
          class: 'primary',
          text: '回填输入框',
          onclick: () => {
            if (finalText) {
              apply(finalText);
              this.close();
            }
          },
        }),
      );
    const body = el(
      'div',
      { class: 'panel-body' },
      input,
      writing && instruction,
      el('div', { class: 'tools' }, !comparison && profileSelect, start, stop),
      status,
      result,
      actions,
    );
    this.panel.replaceChildren(head, body);
    perform();
  }
  async share(source, translated) {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    const ctx = canvas.getContext('2d');
    ctx.font = '28px Microsoft YaHei';
    const originalLines = wrapText(ctx, source.slice(0, 10000), 872);
    const translatedLines = wrapText(ctx, translated.slice(0, 10000), 872);
    canvas.height = Math.min(16000, 190 + (originalLines.length + translatedLines.length) * 45);
    ctx.fillStyle = '#f7fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#086f83';
    ctx.font = '32px Microsoft YaHei';
    ctx.fillText('O泡翻译', 64, 65);
    ctx.font = '28px Microsoft YaHei';
    ctx.fillStyle = '#5a7184';
    originalLines.forEach((line, index) => ctx.fillText(line, 64, 130 + index * 45));
    const top = 165 + originalLines.length * 45;
    ctx.fillStyle = '#18354c';
    translatedLines.forEach((line, index) => ctx.fillText(line, 64, top + index * 45));
    download(await canvasBlob(canvas), 'O泡翻译-双语分享.png');
  }
}
