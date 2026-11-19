import { rpc, jobId } from '../shared/client.js';
import { LAYOUT_BLOCK_LIMIT, LAYOUT_HTML_LIMIT } from '../shared/layout.js';

export function layoutKind(element) {
  const banner = element.closest('header,[role=banner]');
  if (banner && /fixed|sticky/.test(getComputedStyle(banner).position) &&
      banner.getBoundingClientRect().height <= 100) return 'navigation';
  if (element.closest('nav,[role=navigation],[role=menu],[role=menubar],[data-sidebar=menu]'))
    return 'navigation';
  if (element.closest('a,button,[role=button],[role=tab],[role=menuitem]')) return 'control';
  if (element.closest('h1,h2,h3,h4,h5,h6,[role=heading]')) return 'heading';
  return 'body';
}

export function pageHtml() {
  const clone = document.documentElement.cloneNode(true);
  for (const node of clone.querySelectorAll(
    'script,noscript,.opao-target,[data-opao-ui],opao-reader-ui,opao-floating-ui',
  )) node.remove();
  for (const node of clone.querySelectorAll('.opao-source,[data-opao-paragraph]'))
    node.replaceWith(...node.childNodes);
  for (const node of clone.querySelectorAll('input,textarea,select,[contenteditable]:not([contenteditable=false])')) {
    node.removeAttribute('value');
    if (!node.matches('input')) node.replaceChildren();
  }
  for (const node of [clone, ...clone.querySelectorAll('*')])
    for (const attribute of [...node.attributes])
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
  const html = '<!doctype html>\n' + clone.outerHTML;
  if (html.length > LAYOUT_HTML_LIMIT)
    throw new Error('整页HTML超过200万字符，请关闭“发送完整网页 HTML”');
  return html;
}

// This queue never participates in the translation pump's awaited work.
export class LayoutQueue {
  constructor(settings, current, apply, notify) {
    this.settings = settings;
    this.current = current;
    this.apply = apply;
    this.notify = notify;
    this.pending = new Set();
    this.revision = 0;
  }
  enqueue(record) {
    if (!this.settings().aiLayout) return;
    this.pending.add(record);
    record.target.dataset.aiLayout = 'pending';
    if (!this.busy && !this.timer)
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 50);
  }
  reset() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.warned = false;
    if (this.job) rpc('cancel', { jobId: this.job }).catch(() => {});
    this.job = null;
    this.busy = false;
  }
  async pump() {
    if (this.busy || !this.settings().aiLayout) return;
    const records = [...this.pending].slice(0, LAYOUT_BLOCK_LIMIT);
    for (const record of records) this.pending.delete(record);
    const selected = records.filter(this.current);
    if (!selected.length) {
      if (this.pending.size) this.pump();
      return;
    }
    this.busy = true;
    const revision = this.revision;
    const id = jobId();
    this.job = id;
    try {
      const blocks = selected.map((record) => {
        const box = record.element.getBoundingClientRect();
        const target = record.target;
        return { id: record.id, kind: layoutKind(record.element), source: record.original,
          translation: record.translation,
          display: getComputedStyle(record.element).display,
          box: { width: box.width, height: box.height, originalHeight: record.originalHeight,
            overflowX: Math.max(0, target.scrollWidth - target.clientWidth),
            overflowY: Math.max(0, target.scrollHeight - target.clientHeight) } };
      });
      const plan = await rpc('layout', { jobId: id, title: document.title,
        viewport: { width: innerWidth, height: innerHeight }, blocks,
        ...(this.settings().aiLayoutFullHtml ? { html: pageHtml() } : {}) });
      if (revision !== this.revision) return;
      const byId = new Map(selected.map((record) => [record.id, record]));
      for (const decision of plan) {
        const record = byId.get(decision.id);
        if (!this.current(record)) continue;
        this.apply(record, decision.mode);
        record.target.dataset.aiLayout = 'done';
      }
    } catch (error) {
      if (revision !== this.revision) return;
      for (const record of selected)
        if (this.current(record)) record.target.dataset.aiLayout = 'fallback';
      if (!this.warned) {
        this.warned = true;
        this.notify('AI排版未完成，已保留本地布局：' + error.message);
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false;
        this.job = null;
        if (this.pending.size) this.pump();
      }
    }
  }
}
