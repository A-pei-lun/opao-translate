import { matchesUrl } from '../shared/config.js';
import { translateItems, rpc, jobId } from '../shared/client.js';
import { applyTranslationAppearance, translationCss } from '../shared/appearance.js';
import { paragraphElements, PARAGRAPH_SELECTOR } from './paragraphs.js';

const candidates = PARAGRAPH_SELECTOR;
const excluded =
  'script,style,noscript,pre,code,textarea,input,select,option,[contenteditable]:not([contenteditable=false]),[translate=no],.notranslate,svg,math,mjx-container,[data-opao-ui],.opao-target';
function safeQuery(root, selector) {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}
function sourceText(element) {
  const clone = element.cloneNode(true);
  for (const node of clone.querySelectorAll('.opao-target,[data-opao-ui]')) node.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim();
}
function safeClone(element, deep) {
  const clone = element.cloneNode(deep);
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        attribute.name === 'id' ||
        (/^(href|src|xlink:href)$/i.test(attribute.name) &&
          /^\s*(javascript|vbscript):/i.test(attribute.value))
      )
        node.removeAttribute(attribute.name);
    }
  }
  for (const node of clone.querySelectorAll('script,style,iframe,object,embed')) node.remove();
  return clone;
}
export function serializeRich(element) {
  const nonce = crypto.randomUUID().slice(0, 8);
  const nodes = new Map();
  let sequence = 0;
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('.opao-target,[data-opao-ui]'))
      return '';
    const id = sequence++;
    if (node.matches('code,pre,math,svg,mjx-container,img,br,kbd,[translate=no]')) {
      nodes.set(id, { node });
      return `{{OPAO${nonce}K${id}}}`;
    }
    const separator =
      node.isConnected && /flex|grid/.test(getComputedStyle(node).display) ? ' ' : '';
    const content = [...node.childNodes].map(walk).join(separator);
    if (node === element || node.classList.contains('opao-source')) return content;
    nodes.set(id, { node });
    return `{{OPAO${nonce}S${id}}}${content}{{OPAO${nonce}E${id}}}`;
  }
  const text = walk(element);
  function render(translated) {
    const fragment = document.createDocumentFragment();
    const stack = [{ node: fragment, id: -1 }];
    const token = new RegExp(`\\{\\{OPAO${nonce}([SEK])(\\d+)\\}\\}`, 'g');
    let cursor = 0,
      match,
      valid = true;
    while ((match = token.exec(translated))) {
      stack.at(-1).node.append(document.createTextNode(translated.slice(cursor, match.index)));
      const id = Number(match[2]),
        record = nodes.get(id);
      if (!record) {
        valid = false;
        break;
      }
      if (match[1] === 'S') {
        const clone = safeClone(record.node, false);
        stack.at(-1).node.append(clone);
        stack.push({ node: clone, id });
      } else if (match[1] === 'E') {
        if (stack.length < 2 || stack.at(-1).id !== id) {
          valid = false;
          break;
        }
        stack.pop();
      } else stack.at(-1).node.append(safeClone(record.node, true));
      cursor = token.lastIndex;
    }
    stack.at(-1).node.append(document.createTextNode(translated.slice(cursor)));
    if (!valid || stack.length !== 1) {
      const fallback = document.createDocumentFragment();
      let position = 0;
      token.lastIndex = 0;
      while ((match = token.exec(translated))) {
        fallback.append(document.createTextNode(translated.slice(position, match.index)));
        if (match[1] === 'K' && nodes.has(Number(match[2])))
          fallback.append(safeClone(nodes.get(Number(match[2])).node, true));
        position = token.lastIndex;
      }
      fallback.append(document.createTextNode(translated.slice(position)));
      return fallback;
    }
    return fragment;
  }
  return { text, render };
}

export class PageTranslator {
  constructor(settings, rules, notify) {
    this.settings = settings;
    this.rules = rules;
    this.notify = notify;
    this.records = new Map();
    this.generatedParagraphs = new Set();
    this.queue = [];
    this.jobs = new Set();
    this.active = false;
    this.busy = false;
    this.generation = 0;
    this.observedRoots = new WeakSet();
    this.styleRoots = new WeakSet();
    this.mutationTimer = null;
    this.viewport = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            const record = this.records.get(entry.target);
            if (record) this.enqueue(record);
            this.viewport.unobserve(entry.target);
          }
      },
      { rootMargin: '600px 0px' },
    );
    this.observe(document.documentElement);
    this.addStyle(document);
  }
  blocked() {
    return this.settings.blockSites.some((pattern) => matchesUrl(pattern, location.href));
  }
  addStyle(root) {
    if (this.styleRoots.has(root)) return;
    this.styleRoots.add(root);
    const style = document.createElement('style');
    style.dataset.opaoUi = 'true';
    style.textContent = translationCss;
    (root.head || root).append(style);
  }
  observe(root) {
    if (this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    const observer = new MutationObserver((mutations) => {
      if (!this.active) return;
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            mutation.target.closest('.opao-target,[data-opao-ui]'),
        )
      )
        return;
      clearTimeout(this.mutationTimer);
      this.mutationTimer = setTimeout(() => this.scan(), 350);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
  }
  applicableRules() {
    return [...this.rules, ...this.settings.siteRules].filter(
      (rule) =>
        rule.matches?.some((pattern) => matchesUrl(pattern, location.href)) &&
        !rule.excludeMatches?.some((pattern) => matchesUrl(pattern, location.href)),
    );
  }
  root(whole) {
    if (whole) return document.body;
    const configured = this.applicableRules().flatMap((rule) =>
      (rule.mainFrameSelector || []).flatMap((selector) => safeQuery(document, selector)),
    );
    if (configured.length)
      return configured.sort((a, b) => b.textContent.length - a.textContent.length)[0];
    const areas = [
      ...document.querySelectorAll('article,main,[role=main],.article-body,.post-content'),
    ];
    return areas.sort((a, b) => b.textContent.length - a.textContent.length)[0] || document.body;
  }
  collect(root) {
    if (!root) return [];
    this.addStyle(root instanceof ShadowRoot ? root : document);
    const rules = this.applicableRules();
    const extraExclude = rules.flatMap((rule) => [
      ...(rule.excludeSelectors || []),
      ...(rule.additionalExcludeSelectors || []),
      ...(rule.additionalStayOriginalSelectors || []),
    ]);
    const isExcluded = (element) => {
      if (element.closest(excluded)) return true;
      return extraExclude.some((selector) => {
        try {
          return Boolean(element.closest(selector));
        } catch {
          return false;
        }
      });
    };
    const preferred = rules.flatMap((rule) => rule.selectors || []);
    const elements = paragraphElements(root, {
      preferred,
      additional: rules.flatMap((rule) => rule.additionalSelectors || []),
      excluded: isExcluded,
      generated: this.generatedParagraphs,
      existing: this.records,
    });
    const result = [];
    const textMinimum = rules.reduce(
      (value, rule) =>
        typeof rule.paragraphMinTextCount === 'number' ? rule.paragraphMinTextCount : value,
      2,
    );
    const wordMinimum = rules.reduce(
      (value, rule) =>
        typeof rule.paragraphMinWordCount === 'number' ? rule.paragraphMinWordCount : value,
      1,
    );
    for (const element of new Set(elements)) {
      if (!(element instanceof HTMLElement) || isExcluded(element) || !element.isConnected)
        continue;
      if (element.querySelector(candidates) && !this.records.has(element)) continue;
      const value = sourceText(element);
      if (
        value.length < textMinimum ||
        !/[\p{L}\p{N}]/u.test(value) ||
        (
          value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) ||
          []
        ).length < wordMinimum
      )
        continue;
      const computed = getComputedStyle(element);
      if (computed.display === 'none' || computed.visibility === 'hidden') continue;
      if (value.length > 250000) continue;
      result.push(element);
    }
    for (const element of root.querySelectorAll('*'))
      if (element.shadowRoot?.mode === 'open' && !element.matches('[data-opao-ui]')) {
        this.observe(element.shadowRoot);
        this.addStyle(element.shadowRoot);
        result.push(...this.collect(element.shadowRoot));
      }
    return result;
  }
  updateStyle(record) {
    if (this.settings.mode === 'translation') {
      if (!record.source) {
        record.source = document.createElement('span');
        record.source.className = 'opao-source';
        for (const child of [...record.element.childNodes])
          if (child !== record.target) record.source.append(child);
        record.element.insertBefore(record.source, record.target);
      }
      record.source.classList.add('opao-source-hidden');
      record.source.style.setProperty('display', 'none', 'important');
    } else if (record.source) {
      while (record.source.firstChild) record.source.before(record.source.firstChild);
      record.source.remove();
      record.source = null;
    }
    applyTranslationAppearance(record.target, this.settings);
  }
  makeRecord(element) {
    const rich = serializeRich(element);
    const original = sourceText(element);
    const target = document.createElement('span');
    target.className = 'opao-target';
    target.dataset.state = 'pending';
    target.setAttribute('lang', this.settings.targetLanguage);
    target.setAttribute(
      'dir',
      /^(ar|he|fa|ur)/.test(this.settings.targetLanguage) ? 'rtl' : 'auto',
    );
    target.textContent = '正在翻译…';
    const computed = getComputedStyle(element);
    const layout =
      /flex/.test(computed.display) && computed.flexDirection.startsWith('row')
        ? {
            value: element.style.getPropertyValue('flex-wrap'),
            priority: element.style.getPropertyPriority('flex-wrap'),
          }
        : null;
    if (layout) element.style.setProperty('flex-wrap', 'wrap', 'important');
    element.append(target);
    if (element.hasAttribute('data-opao-paragraph')) element.dataset.opaoPaired = 'true';
    const record = {
      element,
      source: null,
      layout,
      target,
      rich,
      original,
      state: 'new',
      id: crypto.randomUUID(),
    };
    this.records.set(element, record);
    this.updateStyle(record);
    return record;
  }
  scan() {
    if (!this.active || this.blocked()) return;
    for (const [element, record] of this.records) {
      if (!element.isConnected) {
        this.records.delete(element);
        continue;
      }
      if (!record.target.isConnected || sourceText(record.element) !== record.original) {
        this.unwrap(record);
        this.records.delete(element);
      }
    }
    for (const element of this.collect(this.root(this.whole))) {
      if (this.records.has(element)) continue;
      const record = this.makeRecord(element);
      if (this.settings.lazy && !this.whole) this.viewport.observe(element);
      else this.enqueue(record);
    }
  }
  enqueue(record) {
    if (!['new', 'error'].includes(record.state)) return;
    record.state = 'queued';
    record.target.dataset.state = 'pending';
    record.target.textContent = '正在翻译…';
    this.queue.push(record);
    this.pump();
  }
  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const generation = this.generation;
    const records = this.queue
      .splice(0, 10)
      .filter(
        (record) => record.element.isConnected && this.records.get(record.element) === record,
      );
    const id = jobId();
    this.jobs.add(id);
    try {
      if (!records.length) return;
      const translations = await translateItems(
        records.map((record) => ({ id: record.id, text: record.rich.text })),
        {
          jobId: id,
          targetLanguage: this.settings.targetLanguage,
          sourceLanguage: this.settings.sourceLanguage,
          context: document.title,
          domain: location.hostname,
        },
      );
      if (generation !== this.generation) return;
      for (const translated of translations) {
        const record = records.find((item) => item.id === translated.id);
        if (!record || !record.target.isConnected || sourceText(record.element) !== record.original)
          continue;
        record.target.replaceChildren(record.rich.render(translated.text));
        record.target.dataset.state = 'done';
        record.state = 'done';
      }
    } catch (error) {
      if (generation !== this.generation) return;
      for (const record of records) {
        record.state = 'error';
        record.target.dataset.state = 'error';
        record.target.textContent = error.message;
        const retry = document.createElement('button');
        retry.textContent = '重试';
        retry.onclick = (event) => {
          event.preventDefault();
          this.enqueue(record);
        };
        record.target.append(retry);
      }
      this.notify(error.message);
    } finally {
      this.jobs.delete(id);
      this.busy = false;
      if (this.queue.length) this.pump();
    }
  }
  unwrap(record) {
    if (record.source?.parentNode) {
      while (record.source.firstChild) record.source.before(record.source.firstChild);
      record.source.remove();
    }
    record.target.remove();
    if (
      record.layout &&
      record.element.style.getPropertyValue('flex-wrap') === 'wrap' &&
      record.element.style.getPropertyPriority('flex-wrap') === 'important'
    ) {
      if (record.layout.value)
        record.element.style.setProperty('flex-wrap', record.layout.value, record.layout.priority);
      else record.element.style.removeProperty('flex-wrap');
    }
    delete record.element.dataset.opaoPaired;
  }
  restore() {
    this.active = false;
    this.generation++;
    this.queue = [];
    this.viewport.disconnect();
    for (const id of this.jobs) rpc('cancel', { jobId: id }).catch(() => {});
    for (const record of this.records.values()) this.unwrap(record);
    this.records.clear();
    for (const wrapper of [...this.generatedParagraphs].reverse()) {
      if (wrapper.parentNode) {
        while (wrapper.firstChild) wrapper.before(wrapper.firstChild);
        wrapper.remove();
      }
    }
    this.generatedParagraphs.clear();
    if (this.originalTitle !== undefined) {
      document.title = this.originalTitle;
      this.originalTitle = undefined;
    }
  }
  async start(whole = false) {
    if (this.blocked()) throw new Error('当前网站已加入不翻译列表，可在设置中移除');
    if (this.active) this.restore();
    this.active = true;
    this.whole = whole;
    this.scan();
    if (this.settings.translateTitle) {
      const title = document.title;
      this.originalTitle = title;
      const id = jobId();
      this.jobs.add(id);
      try {
        const result = await translateItems([{ id: 'title', text: title }], {
          jobId: id,
          targetLanguage: this.settings.targetLanguage,
        });
        if (this.active && this.originalTitle === title) document.title = result[0].text;
      } finally {
        this.jobs.delete(id);
      }
    }
  }
  async translateElement(element) {
    if (this.blocked() || element.closest(excluded)) return;
    const target =
      this.collect(this.root(this.whole)).find(
        (candidate) => candidate === element || candidate.contains(element),
      ) ||
      element.closest(candidates) ||
      element;
    const record = this.records.get(target) || this.makeRecord(target);
    this.viewport.unobserve(target);
    this.enqueue(record);
  }
  toggleMode() {
    this.settings.mode = this.settings.mode === 'bilingual' ? 'translation' : 'bilingual';
    for (const record of this.records.values()) this.updateStyle(record);
  }
  toggleMask() {
    for (const record of this.records.values()) record.target.classList.toggle('opao-masked');
  }
  update(settings, translationChanged = true) {
    if (!translationChanged) {
      this.settings = settings;
      for (const record of this.records.values()) this.updateStyle(record);
      return;
    }
    const active = this.active,
      whole = this.whole;
    this.restore();
    this.settings = settings;
    if (active && !this.blocked()) this.start(whole).catch((error) => this.notify(error.message));
  }
}
