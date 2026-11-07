import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { drawRegion, translateImage, canvasBlob } from '../shared/images.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');
function check(signal) {
  if (signal?.aborted) throw new Error('已取消文档处理');
}
function groupText(items, viewport) {
  const words = items
    .filter((item) => item.str?.trim())
    .map((item) => {
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const h = Math.max(5, Math.hypot(transform[2], transform[3]));
      return {
        x: transform[4],
        y: transform[5] - h,
        w: Math.max(item.width * viewport.scale, 1),
        h,
        text: item.str,
      };
    })
    .sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.45 ? a.x - b.x : a.y - b.y));
  const lines = [];
  for (const word of words) {
    const line = lines.at(-1);
    const gap = line ? word.x - line.x - line.w : 0;
    if (
      line &&
      Math.abs(line.y - word.y) < Math.min(line.h, word.h) * 0.55 &&
      gap > -word.h &&
      gap < Math.max(word.h * 3, viewport.width * 0.035)
    ) {
      line.text += (gap > word.h * 0.16 ? ' ' : '') + word.text;
      line.w = Math.max(line.w, word.x + word.w - line.x);
      line.h = Math.max(line.h, word.h);
    } else lines.push({ ...word });
  }
  const paragraphs = [];
  for (const line of lines) {
    const previous = paragraphs.at(-1);
    const verticalGap = previous ? line.y - previous.y - previous.h : 0;
    if (
      previous &&
      Math.abs(previous.x - line.x) < line.h * 1.4 &&
      verticalGap > -line.h * 0.2 &&
      verticalGap < line.h * 0.75 &&
      Math.abs(previous.w - line.w) < Math.max(line.w * 0.35, line.h * 3) &&
      previous.h < line.h * 10
    ) {
      previous.text += '\n' + line.text;
      previous.h = line.y + line.h - previous.y;
      previous.w = Math.max(previous.w, line.w);
    } else paragraphs.push({ ...line });
  }
  return paragraphs
    .filter((block) => /\p{L}/u.test(block.text) && block.text.trim().length > 1)
    .map((block) => ({
      ...block,
      x: Math.max(0, Math.floor(block.x)),
      y: Math.max(0, Math.floor(block.y)),
      w: Math.min(viewport.width - block.x, Math.ceil(block.w)),
      h: Math.min(viewport.height - block.y, Math.ceil(block.h + 2)),
    }));
}
export class PdfBook {
  static async open(bytes, password = '') {
    const original = new Uint8Array(bytes);
    const loading = pdfjs.getDocument({
      data: original.slice(),
      password,
      cMapUrl: chrome.runtime.getURL('vendor/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('vendor/standard_fonts/'),
      wasmUrl: chrome.runtime.getURL('vendor/wasm/'),
      useSystemFonts: true,
      isEvalSupported: false,
      enableXfa: false,
    });
    const document = await loading.promise;
    return new PdfBook(document, original, loading);
  }
  constructor(document, bytes, loadingTask) {
    this.document = document;
    this.bytes = bytes;
    this.loadingTask = loadingTask;
    this.count = document.numPages;
    this.translations = new Map();
  }
  async render(index, scale = 1.5) {
    const page = await this.document.getPage(index + 1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const content = await page.getTextContent();
    return {
      canvas,
      blocks: groupText(content.items, viewport),
      width: viewport.width / scale,
      height: viewport.height / scale,
    };
  }
  async translatePage(index, options) {
    check(options.signal);
    const original = await this.render(index);
    check(options.signal);
    let canvas;
    if (!original.blocks.length || options.forceVision) {
      const image = await translateImage(
        original.canvas,
        options.settings,
        options.vision,
        options.progress,
      );
      canvas = image.canvas;
    } else {
      canvas = document.createElement('canvas');
      canvas.width = original.canvas.width;
      canvas.height = original.canvas.height;
      const context = canvas.getContext('2d');
      context.drawImage(original.canvas, 0, 0);
      for (let start = 0; start < original.blocks.length; start += 100) {
        check(options.signal);
        const blocks = original.blocks.slice(start, start + 100);
        const translated = await options.translate(
          blocks.map((block, index) => ({ id: String(index), text: block.text })),
          `PDF page ${index + 1}`,
        );
        check(options.signal);
        for (const item of translated)
          drawRegion(
            context,
            { ...blocks[Number(item.id)], translation: item.text },
            options.settings,
          );
        options.progress?.({
          stage: 'translating',
          completed: Math.min(start + blocks.length, original.blocks.length),
          total: original.blocks.length,
        });
      }
    }
    const result = {
      blob: await canvasBlob(canvas),
      width: original.width,
      height: original.height,
    };
    this.translations.set(index, result);
    return { ...result, canvas, original: original.canvas };
  }
  async export(mode, indices, signal) {
    const missing = indices.filter((index) => !this.translations.has(index));
    if (missing.length) throw new Error(`所选范围还有 ${missing.length} 页待翻译，请先完成翻译`);
    const output = await PDFDocument.create();
    let source;
    try {
      source = await PDFDocument.load(this.bytes.slice(), { updateMetadata: false });
    } catch {
      source = null;
    }
    for (const index of indices) {
      check(signal);
      const translated = this.translations.get(index);
      const target = output.addPage([
        translated.width * (mode === 'bilingual' ? 2 : 1),
        translated.height,
      ]);
      if (mode === 'bilingual') {
        if (source) {
          const embedded = await output.embedPage(source.getPage(index));
          target.drawPage(embedded, {
            x: 0,
            y: 0,
            width: translated.width,
            height: translated.height,
          });
        } else {
          const original = await this.render(index);
          const image = await output.embedPng(
            await (await canvasBlob(original.canvas)).arrayBuffer(),
          );
          target.drawImage(image, {
            x: 0,
            y: 0,
            width: translated.width,
            height: translated.height,
          });
        }
      }
      const png = await output.embedPng(await translated.blob.arrayBuffer());
      target.drawImage(png, {
        x: mode === 'bilingual' ? translated.width : 0,
        y: 0,
        width: translated.width,
        height: translated.height,
      });
    }
    output.setTitle('O泡翻译');
    output.setProducer('O泡翻译 ' + chrome.runtime.getManifest().version);
    return new Blob([await output.save()], { type: 'application/pdf' });
  }
  clearTranslations() {
    this.translations.clear();
  }
  destroy() {
    return this.loadingTask.destroy();
  }
}
