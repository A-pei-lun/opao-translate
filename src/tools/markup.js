import DOMPurify from 'dompurify';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { serializeRich } from '../content/dom.js';

export function decodeText(bytes, encoding = 'utf-8') {
  const data = new Uint8Array(bytes);
  const format =
    data[0] === 255 && data[1] === 254
      ? 'utf-16le'
      : data[0] === 254 && data[1] === 255
        ? 'utf-16be'
        : encoding;
  return new TextDecoder(format).decode(data).replace(/^\uFEFF/, '');
}
function parseMarkup(text) {
  let document = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (document.querySelector('parsererror'))
    document = new DOMParser().parseFromString(text, 'text/html');
  return document;
}
function cleanForExport(document) {
  for (const node of document.querySelectorAll('script,iframe,object,embed')) node.remove();
  for (const node of document.querySelectorAll('*'))
    for (const attribute of [...node.attributes])
      if (
        /^on/i.test(attribute.name) ||
        (['href', 'src'].includes(attribute.name) && /^\s*javascript:/i.test(attribute.value))
      )
        node.removeAttribute(attribute.name);
  return document;
}
function paragraphNodes(document) {
  const root = document.body || document.documentElement;
  const selectors = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,dd,dt,figcaption';
  const nodes = [...root.querySelectorAll(selectors)].filter(
    (node) =>
      !node.closest('code,pre,script,style,nav,.opao-file-target') &&
      !node.querySelector(selectors) &&
      node.textContent.trim(),
  );
  if (!nodes.length)
    nodes.push(
      ...[...root.children].filter(
        (node) => !node.matches('script,style,nav') && node.textContent.trim(),
      ),
    );
  return nodes;
}
async function translateMarkup(source, options) {
  const document = cleanForExport(parseMarkup(source));
  const nodes = paragraphNodes(document);
  const records = nodes.map((node, index) => ({
    id: String(index),
    node,
    rich: serializeRich(node),
  }));
  for (let start = 0; start < records.length; start += 100) {
    if (options.signal?.aborted) throw new Error('已取消文档翻译');
    const batch = records.slice(start, start + 100);
    const output = await options.translate(
      batch.map((record) => ({ id: record.id, text: record.rich.text })),
      document.title || options.title || 'Document',
    );
    if (options.signal?.aborted) throw new Error('已取消文档翻译');
    for (const item of output) {
      const record = batch.find((value) => value.id === item.id);
      const target = document.createElementNS(
        record.node.namespaceURI || 'http://www.w3.org/1999/xhtml',
        'span',
      );
      target.setAttribute('class', 'opao-file-target');
      target.setAttribute('lang', options.targetLanguage);
      target.append(record.rich.render(item.text));
      if (options.mode === 'translation') record.node.replaceChildren(target);
      else record.node.append(target);
    }
    options.progress?.({
      completed: Math.min(start + batch.length, records.length),
      total: records.length,
    });
  }
  const style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.textContent =
    '.opao-file-target{display:block;margin:.5em 0 1em;padding-inline-start:.8em;border-inline-start:2px solid #086f83;line-height:1.8}';
  (document.head || document.documentElement).append(style);
  return new XMLSerializer().serializeToString(document);
}
export function safePreview(text) {
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  const clean = DOMPurify.sanitize(parsed.body, {
    RETURN_DOM: true,
    FORBID_TAGS: [
      'script',
      'style',
      'link',
      'meta',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'audio',
      'video',
    ],
    FORBID_ATTR: ['style', 'srcset'],
  });
  for (const image of clean.querySelectorAll('img')) image.removeAttribute('src');
  for (const link of clean.querySelectorAll('a')) {
    if (/^https?:/i.test(link.getAttribute('href') || '')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  return clean;
}
function resourcePath(href, base) {
  const url = new URL(href, 'https://epub.invalid/' + base);
  if (url.origin !== 'https://epub.invalid') return null;
  return decodeURIComponent(url.pathname.slice(1));
}
export class HtmlDocument {
  constructor(text) {
    this.original = text;
    this.translated = '';
  }
  async translate(options) {
    this.translated = await translateMarkup(this.original, options);
    return this.translated;
  }
  preview() {
    return safePreview(this.translated || this.original);
  }
  export() {
    return new Blob(
      [
        this.translated ||
          new XMLSerializer().serializeToString(cleanForExport(parseMarkup(this.original))),
      ],
      { type: 'text/html;charset=utf-8' },
    );
  }
}
export class EpubBook {
  static open(bytes) {
    let total = 0;
    const entries = unzipSync(new Uint8Array(bytes), {
      filter(file) {
        if (
          file.name.startsWith('/') ||
          file.name.includes('\\') ||
          file.name.split('/').includes('..') ||
          ['__proto__', 'constructor', 'prototype'].includes(file.name)
        )
          throw new Error('EPUB 内含无效文件路径');
        total += file.originalSize;
        if (file.originalSize > 50000000 || total > 200000000)
          throw new Error('EPUB 解压大小超过浏览器处理上限');
        return true;
      },
    });
    const container = entries['META-INF/container.xml'];
    if (!container) throw new Error('EPUB 缺少 META-INF/container.xml');
    const xml = new DOMParser().parseFromString(strFromU8(container), 'application/xml');
    const packagePath = xml.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
    if (!packagePath || !entries[packagePath]) throw new Error('EPUB 缺少内容清单');
    const packageDocument = new DOMParser().parseFromString(
      strFromU8(entries[packagePath]),
      'application/xml',
    );
    const items = new Map(
      [...packageDocument.getElementsByTagNameNS('*', 'item')].map((item) => [
        item.getAttribute('id'),
        { href: item.getAttribute('href'), type: item.getAttribute('media-type') },
      ]),
    );
    const chapters = [...packageDocument.getElementsByTagNameNS('*', 'itemref')]
      .map((item) => items.get(item.getAttribute('idref')))
      .filter((item) => item?.href)
      .map((item, index) => ({
        path: resourcePath(item.href, packagePath),
        title: `章节 ${index + 1}`,
      }))
      .filter((item) => item.path && entries[item.path]);
    if (!chapters.length) throw new Error('EPUB 没有可读取章节');
    return new EpubBook(entries, chapters);
  }
  constructor(entries, chapters) {
    this.entries = entries;
    this.chapters = chapters;
    this.translations = new Map();
    this.urls = new Map();
  }
  async translateChapter(index, options) {
    const chapter = this.chapters[index];
    const text = await translateMarkup(strFromU8(this.entries[chapter.path]), {
      ...options,
      title: chapter.title,
    });
    this.translations.set(chapter.path, text);
    return text;
  }
  preview(index) {
    const chapter = this.chapters[index];
    const source = this.translations.get(chapter.path) || strFromU8(this.entries[chapter.path]);
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const originals = [...parsed.body.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    const clean = safePreview(source);
    [...clean.querySelectorAll('img')].forEach((image, imageIndex) => {
      const resource = originals[imageIndex] && resourcePath(originals[imageIndex], chapter.path);
      if (!resource || !this.entries[resource]) return;
      if (!this.urls.has(resource)) {
        const extension = resource.split('.').at(-1).toLowerCase();
        const type = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          gif: 'image/gif',
          svg: 'image/svg+xml',
        }[extension];
        if (!type) return;
        this.urls.set(resource, URL.createObjectURL(new Blob([this.entries[resource]], { type })));
      }
      image.src = this.urls.get(resource);
    });
    return clean;
  }
  export() {
    const files = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
    for (const [name, value] of Object.entries(this.entries))
      if (name !== 'mimetype')
        files[name] = this.translations.has(name) ? strToU8(this.translations.get(name)) : value;
    return new Blob([zipSync(files, { level: 6 })], { type: 'application/epub+zip' });
  }
  clearTranslations() {
    this.translations.clear();
  }
  destroy() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
