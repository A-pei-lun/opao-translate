import {
  el,
  rpc,
  applyTheme,
  status,
  jobId,
  onProgress,
  profileOptions,
  download,
  textFile,
} from './shared/client.js';
import { LANGUAGES } from './shared/config.js';
import { imageCanvas, translateImage, canvasBlob } from './shared/images.js';
import { splitText } from './shared/text.js';
import {
  parseSubtitle,
  serializeSubtitle,
  subtitleText,
  protectSubtitle,
  timestamp,
} from './shared/subtitles.js';
import { PdfBook } from './tools/pdf.js';
import { HtmlDocument, EpubBook, decodeText } from './tools/markup.js';
import { decodeAudio, wavChunk, blobDataUrl, transcriptCues } from './tools/audio.js';
import { ContentUI } from './content/ui.js';
import { zipSync } from 'fflate';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const jobs = new Set();
const main = el('main', { class: 'workspace-shell' });
const nav = el('nav', { class: 'workspace-nav', role: 'tablist', 'aria-label': '工作台工具' });
const content = el('section', { class: 'stack', id: 'workspace-content', role: 'tabpanel' });
const message = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
let settings,
  selectedTool = params.get('tool') || 'text',
  operation,
  dispose = () => {},
  invalidateTool = () => {};
let textProfile, targetLanguage, sourceLanguage;
const urls = new Set();
function nameOf(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'O泡翻译';
}
function field(label, input, hint = '') {
  if (input.matches('input,select,textarea')) input.setAttribute('aria-label', label);
  return el(
    'label',
    { class: 'field' },
    el('span', { text: label }),
    input,
    hint && el('span', { class: 'hint', text: hint }),
  );
}
function addUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}
function revokeUrl(url) {
  if (urls.delete(url)) URL.revokeObjectURL(url);
}
function cancelled() {
  if (operation?.signal.aborted) throw new Error('已取消');
}
async function call(kind, payload = {}, progress) {
  cancelled();
  const signal = operation?.signal;
  const id = jobId();
  jobs.add(id);
  const unsubscribe = onProgress(id, (event) => progress?.(event));
  try {
    const result = await rpc(kind, { ...payload, jobId: id });
    if (signal?.aborted) throw new Error('已取消');
    return result;
  } finally {
    jobs.delete(id);
    unsubscribe();
  }
}
async function translate(items, context = '', role = 'text') {
  return call(
    'translate',
    {
      items,
      context,
      role,
      profileId: role === 'text' ? textProfile.value : settings.roles[role] || textProfile.value,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
    },
    (event) => {
      if (event.type === 'batch') status(message, `翻译段落 ${event.completed}/${event.total}`);
    },
  );
}
function stop() {
  operation?.abort();
  for (const id of jobs) rpc('cancel', { jobId: id }).catch(() => {});
}
async function run(button, label, work) {
  stop();
  operation = new AbortController();
  const controller = operation;
  const controls = [
    ...content.querySelectorAll('button,input,select,textarea'),
    textProfile,
    targetLanguage,
    sourceLanguage,
  ].filter((node) => !node.dataset.cancel);
  const previous = controls.map((node) => node.disabled);
  controls.forEach((node) => {
    node.disabled = true;
  });
  status(message, label);
  try {
    await work(controller.signal);
    if (!controller.signal.aborted) status(message, '处理完成');
  } catch (error) {
    if (operation === controller) status(message, error.message, true);
  } finally {
    controls.forEach((node, index) => {
      node.disabled = previous[index];
    });
    if (operation === controller) operation = null;
  }
}
function actionButton(label, work) {
  const button = el('button', { text: label });
  button.onclick = () => run(button, label + '…', work);
  return button;
}
function filePicker(accept, onFile, multiple = false) {
  const input = el('input', { type: 'file', accept, multiple: multiple ? '' : undefined });
  input.onchange = () => {
    if (input.files.length)
      onFile(multiple ? [...input.files] : input.files[0]).catch((error) =>
        status(message, error.message, true),
      );
  };
  return input;
}
function imageService() {
  return el(
    'select',
    { 'aria-label': '图片视觉服务' },
    profileOptions(settings, settings.roles.vision, 'vision', true),
  );
}
async function vision(image, select) {
  return call('vision', { image, profileId: select.value, targetLanguage: targetLanguage.value });
}
function heading(title, description) {
  return el(
    'div',
    { class: 'section-heading' },
    el('div', {}, el('h2', { text: title }), el('p', { text: description })),
  );
}

function textTool(writing = false) {
  const input = el('textarea', {
    class: 'editor-input',
    'aria-label': writing ? '写作素材' : '待翻译文本',
    placeholder: writing ? '输入素材、草稿或需要改写的文字' : '粘贴外文，保留段落即可',
    maxlength: 250000,
  });
  const output = el('div', { class: 'editor-result', 'aria-label': '处理结果' });
  let result = '';
  invalidateTool = () => {
    result = '';
    output.replaceChildren();
  };
  const instruction = el('textarea', {
    rows: 3,
    'aria-label': '写作指令',
    placeholder: '自定义写作或解释指令',
  });
  instruction.value = '保留原意，改善表达的准确性、流畅度和简洁度。只输出处理后的文本。';
  const presets = el(
    'select',
    { 'aria-label': '写作任务' },
    ...[
      ['润色', '保留原意，改善表达的准确性、流畅度和简洁度。只输出处理后的文本。'],
      ['改写', '用不同但自然的表达改写原文，保留原意。只输出改写结果。'],
      ['解释', '解释原文的含义、术语和语境。'],
      ['写作', '根据提供的素材和目标语言写成结构清楚的文字。'],
    ].map(([label, value]) => el('option', { value }, label)),
  );
  presets.onchange = () => {
    instruction.value = presets.value;
  };
  const generate = actionButton(writing ? '生成文本' : '翻译文本', async () => {
    if (!input.value.trim()) throw new Error('请先填写文本');
    output.replaceChildren();
    if (writing)
      result = await call(
        'generate',
        {
          profileId: textProfile.value,
          prompt: `${instruction.value}\n目标语言 ${targetLanguage.value}\n<source>\n${input.value}\n</source>`,
        },
        (event) => {
          if (event.type === 'stream') output.textContent = event.text;
        },
      );
    else
      result = (await translate([{ id: 'text', text: input.value }]))
        .map((item) => item.text)
        .join('');
    output.textContent = result;
  });
  generate.classList.add('primary');
  const compare = actionButton('多模型对照', async () => {
    if (!input.value.trim()) throw new Error('请先填写文本');
    output.replaceChildren();
    const ids = settings.comparisonProfiles.length
      ? settings.comparisonProfiles
      : settings.profiles
          .filter((profile) => profile.enabled && profile.capabilities.text && profile.configured)
          .slice(0, 3)
          .map((profile) => profile.id);
    if (!ids.length) throw new Error('请先配置至少一个文本服务');
    await Promise.all(
      ids.map(async (id) => {
        const resultNode = el(
          'div',
          { class: 'compact-stack' },
          el('strong', {
            text: settings.profiles.find((profile) => profile.id === id)?.name || id,
          }),
        );
        const text = el('div', { class: 'file-text' });
        resultNode.append(text);
        output.append(resultNode);
        try {
          const results = await call('translate', {
            items: [{ id: 'text', text: input.value }],
            profileId: id,
            targetLanguage: targetLanguage.value,
            sourceLanguage: sourceLanguage.value,
          });
          text.textContent = results[0].text;
        } catch (error) {
          text.textContent = error.message;
          text.classList.add('error-text');
        }
      }),
    );
    result = output.textContent;
  });
  const copy = el('button', {
    text: '复制结果',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(result);
        status(message, '已复制');
      } catch {
        status(message, '复制失败，请手动选择结果', true);
      }
    },
  });
  const share = el('button', {
    text: '导出分享图',
    onclick: () =>
      ContentUI.prototype
        .share(input.value, result)
        .catch((error) => status(message, error.message, true)),
  });
  content.replaceChildren(
    heading(
      writing ? '写作与解释' : '双语文本',
      writing ? '按自己的提示词润色、改写和解释文本。' : '同一段文字，在原文和译文之间自由对照。',
    ),
    writing &&
      el('div', { class: 'stack' }, field('写作任务', presets), field('补充指令', instruction)),
    el(
      'div',
      { class: 'editor-grid' },
      el('div', { class: 'editor-column' }, el('h3', { text: '原文' }), input),
      el('div', { class: 'editor-column' }, el('h3', { text: '译文与结果' }), output),
    ),
    el(
      'div',
      { class: 'button-row' },
      generate,
      !writing && compare,
      copy,
      el('button', { text: '导出文本', onclick: () => textFile(result, 'O泡翻译-结果.txt') }),
      share,
      el('button', {
        text: '朗读',
        onclick: () => {
          speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(result);
          utterance.lang = targetLanguage.value;
          speechSynthesis.speak(utterance);
        },
      }),
    ),
  );
}
function imagesTool() {
  let images = [];
  let index = 0;
  let loadGeneration = 0;
  const select = imageService();
  const source = el('div');
  const target = el('div');
  const count = el('span', { class: 'hint' });
  const url = el('input', {
    type: 'url',
    placeholder: 'https://example.com/image.png',
    'aria-label': '图片地址',
  });
  const render = () => {
    source.replaceChildren(
      images[index]?.canvas || el('div', { class: 'empty', text: '选择或粘贴图片' }),
    );
    target.replaceChildren(
      images[index]?.translated || el('div', { class: 'empty', text: '翻译结果显示在这里' }),
    );
    count.textContent = images.length
      ? `${index + 1} / ${images.length}，${images.filter((image) => image.translated).length} 张已有译图`
      : '';
  };
  invalidateTool = () => {
    for (const item of images) {
      delete item.translated;
      delete item.boxes;
    }
    select.replaceChildren(...profileOptions(settings, settings.roles.vision, 'vision', true));
    render();
  };
  select.onchange = () => {
    stop();
    for (const item of images) {
      delete item.translated;
      delete item.boxes;
    }
    render();
  };
  const load = async (files) => {
    stop();
    const generation = ++loadGeneration;
    const loaded = [];
    images = [];
    index = 0;
    render();
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024) throw new Error('单张图片超过 32MB');
      const canvas = await imageCanvas(file);
      if (generation !== loadGeneration) return;
      loaded.push({ name: file.name, canvas });
    }
    images = loaded;
    index = 0;
    render();
    status(message, `已读取 ${images.length} 张图片`);
  };
  const fromUrl = async () => {
    if (!url.value.trim()) throw new Error('请填写图片地址');
    const response = await rpc('fetch-image', { url: url.value.trim() });
    const blob = await fetch(response.dataUrl).then((value) => value.blob());
    await load([new File([blob], '网页图片.png', { type: blob.type })]);
  };
  const translateOne = async (item) => {
    const result = await translateImage(
      item.canvas,
      settings,
      (image) => vision(image, select),
      (progress) => status(message, `图片分片 ${progress.completed}/${progress.total}`),
    );
    cancelled();
    item.translated = result.canvas;
    item.boxes = result.boxes;
    render();
  };
  const picker = filePicker('image/*', load, true);
  const drop = el(
    'div',
    { class: 'file-picker' },
    el('strong', { text: '打开图片或漫画长图' }),
    el('p', { class: 'hint', text: '支持多选、拖放和粘贴图片，长图按分片发送给视觉模型。' }),
    picker,
  );
  drop.ondragover = (event) => event.preventDefault();
  drop.ondrop = (event) => {
    event.preventDefault();
    load([...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))).catch(
      (error) => status(message, error.message, true),
    );
  };
  const paste = (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile());
    if (files.length) {
      event.preventDefault();
      load(files).catch((error) => status(message, error.message, true));
    }
  };
  document.addEventListener('paste', paste);
  dispose = () => {
    loadGeneration++;
    document.removeEventListener('paste', paste);
  };
  content.replaceChildren(
    heading('图片与漫画', '用你的视觉模型识别区域、翻译文字，再生成可保存的译图。'),
    drop,
    el('div', { class: 'row' }, url, actionButton('读取图片地址', fromUrl)),
    field('视觉服务', select),
    el(
      'div',
      { class: 'file-controls' },
      el('button', {
        text: '上一张',
        onclick: () => {
          if (index > 0) {
            index--;
            render();
          }
        },
      }),
      count,
      el('button', {
        text: '下一张',
        onclick: () => {
          if (index + 1 < images.length) {
            index++;
            render();
          }
        },
      }),
    ),
    el(
      'div',
      { class: 'image-pair' },
      el('figure', {}, el('figcaption', { text: '原图' }), source),
      el('figure', {}, el('figcaption', { text: '译图' }), target),
    ),
    el(
      'div',
      { class: 'button-row' },
      actionButton('翻译当前图片', async () => {
        if (!images[index]) throw new Error('先选择图片');
        await translateOne(images[index]);
      }),
      actionButton('翻译全部图片', async () => {
        if (!images.length) throw new Error('先选择图片');
        for (const item of images) {
          cancelled();
          if (!item.translated) await translateOne(item);
        }
      }),
      el('button', {
        text: '保存当前译图',
        onclick: async () => {
          try {
            if (!images[index]?.translated) throw new Error('当前图片还没有译图');
            download(
              await canvasBlob(images[index].translated),
              nameOf(images[index].name) + '-译图.png',
            );
          } catch (error) {
            status(message, error.message, true);
          }
        },
      }),
      actionButton('打包已有译图', async () => {
        const files = {};
        for (const [number, item] of images.entries())
          if (item.translated)
            files[`${number + 1}-${nameOf(item.name)}.png`] = new Uint8Array(
              await (await canvasBlob(item.translated)).arrayBuffer(),
            );
        if (!Object.keys(files).length) throw new Error('请先翻译图片');
        download(new Blob([zipSync(files)], { type: 'application/zip' }), 'O泡翻译-图片.zip');
      }),
    ),
    el('p', {
      class: 'hint',
      text: '当前使用区域底色覆盖绘制。视觉识别精度和复杂背景效果由实际图片与模型能力决定。',
    }),
  );
  render();
  if (params.get('url') && selectedTool === 'images') {
    url.value = params.get('url');
    fromUrl().catch((error) => status(message, error.message, true));
  }
}
function documentsTool() {
  let document,
    type,
    filename = '',
    index = 0,
    renderToken = 0,
    plain = '',
    translated = '';
  let loadGeneration = 0;
  let previewUrl;
  const original = el('div');
  const target = el('div');
  const reader = el('div', { class: 'reader-body' });
  const display = el('div');
  const info = el('span', { class: 'hint' });
  const encoding = el(
    'select',
    { 'aria-label': '文件编码' },
    ...['utf-8', 'gb18030', 'utf-16le', 'big5', 'shift_jis'].map((value) =>
      el('option', { value }, value),
    ),
  );
  const password = el('input', {
    type: 'password',
    placeholder: 'PDF 密码，选填',
    'aria-label': 'PDF 密码',
  });
  const pageInput = el('input', { type: 'number', min: 1, value: 1, 'aria-label': '页码或章节' });
  const mode = el(
    'select',
    { 'aria-label': '导出显示模式' },
    el('option', { value: 'bilingual' }, '双语对照'),
    el('option', { value: 'translation' }, '纯译文'),
  );
  const forceVision = el('input', { type: 'checkbox' });
  const select = imageService();
  const url = el('input', {
    type: 'text',
    placeholder: '在线 PDF、EPUB、TXT 或 HTML 地址',
    'aria-label': '文档地址',
  });
  function total() {
    return type === 'pdf' ? document.count : type === 'epub' ? document.chapters.length : 1;
  }
  async function show() {
    if (!document && !plain) return;
    const token = ++renderToken;
    pageInput.value = index + 1;
    pageInput.max = total();
    info.textContent = `${filename}，${index + 1}/${total()}${type === 'pdf' ? `，${document.translations.size} 页已有译文` : type === 'epub' ? `，${document.translations.size} 章已有译文` : ''}`;
    if (type === 'pdf') {
      const result = await document.render(index);
      if (token !== renderToken) return;
      original.replaceChildren(result.canvas);
      const translatedPage = document.translations.get(index);
      revokeUrl(previewUrl);
      previewUrl = translatedPage ? addUrl(translatedPage.blob) : undefined;
      target.replaceChildren(
        translatedPage
          ? el('img', { src: previewUrl, alt: 'PDF 译文页', style: 'max-width:100%;height:auto' })
          : el('div', { class: 'empty', text: '此页尚待翻译' }),
      );
      display.replaceChildren(
        el(
          'div',
          { class: 'pdf-pair' },
          el('figure', {}, el('figcaption', { text: '原页' }), original),
          el('figure', {}, el('figcaption', { text: '译页' }), target),
        ),
      );
    } else if (type === 'epub' || type === 'html') {
      reader.replaceChildren(type === 'epub' ? document.preview(index) : document.preview());
      display.replaceChildren(reader);
    } else {
      original.textContent = plain;
      target.textContent = translated;
      original.className = target.className = 'editor-result';
      display.replaceChildren(el('div', { class: 'editor-grid' }, original, target));
    }
  }
  const clearResults = () => {
    renderToken++;
    document?.clearTranslations?.();
    if (type === 'html') document.translated = '';
    translated = '';
    show().catch((error) => status(message, error.message, true));
  };
  invalidateTool = () => {
    select.replaceChildren(...profileOptions(settings, settings.roles.vision, 'vision', true));
    clearResults();
  };
  mode.onchange = () => {
    if (type === 'epub' || type === 'html') clearResults();
  };
  forceVision.onchange = clearResults;
  select.onchange = clearResults;
  const load = async (file) => {
    const generation = ++loadGeneration;
    stop();
    renderToken++;
    await document?.destroy?.();
    document = null;
    plain = '';
    translated = '';
    index = 0;
    if (generation !== loadGeneration) return;
    display.replaceChildren();
    if (file.size > 150 * 1024 * 1024) throw new Error('文件超过 150MB，请拆分后在浏览器中处理');
    filename = file.name;
    type =
      filename.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
        ? 'pdf'
        : filename.toLowerCase().endsWith('.epub') || file.type === 'application/epub+zip'
          ? 'epub'
          : /\.x?html?$/i.test(filename) || file.type.includes('html')
            ? 'html'
            : 'txt';
    const bytes = await file.arrayBuffer();
    if (generation !== loadGeneration) return;
    if (type === 'pdf') {
      const loaded = await PdfBook.open(bytes, password.value);
      if (generation !== loadGeneration) {
        await loaded.destroy();
        return;
      }
      document = loaded;
    } else if (type === 'epub') document = EpubBook.open(bytes);
    else if (type === 'html') document = new HtmlDocument(decodeText(bytes, encoding.value));
    else plain = decodeText(bytes, encoding.value);
    await show();
    status(message, '文件已读取');
  };
  const options = (signal) => ({
    settings,
    signal,
    mode: mode.value,
    targetLanguage: targetLanguage.value,
    translate,
    forceVision: forceVision.checked,
    vision: (image) => vision(image, select),
    progress: (progress) => status(message, `当前页或章节 ${progress.completed}/${progress.total}`),
  });
  async function current(signal) {
    if (!document && !plain) throw new Error('请先选择文件');
    if (type === 'pdf') await document.translatePage(index, options(signal));
    else if (type === 'epub') await document.translateChapter(index, options(signal));
    else if (type === 'html') await document.translate(options(signal));
    else
      translated = (
        await translate(
          splitText(plain, 5000).map((text, number) => ({ id: String(number), text })),
        )
      )
        .map((item) => item.text)
        .join('');
    await show();
  }
  async function exportFile(all = false) {
    if (!filename) throw new Error('请先选择文件');
    let blob, extension;
    if (type === 'pdf') {
      const indices = all ? Array.from({ length: document.count }, (_, i) => i) : [index];
      blob = await document.export(mode.value, indices, operation?.signal);
      extension = 'pdf';
    } else if (type === 'epub') {
      if (!document.translations.size) throw new Error('请先翻译章节');
      blob = document.export();
      extension = 'epub';
    } else if (type === 'html') {
      if (!document.translated) throw new Error('请先翻译文件');
      blob = document.export();
      extension = 'html';
    } else {
      if (!translated) throw new Error('请先翻译文件');
      blob = new Blob([mode.value === 'bilingual' ? plain + '\n\n' + translated : translated], {
        type: 'text/plain;charset=utf-8',
      });
      extension = 'txt';
    }
    download(
      blob,
      `${nameOf(filename)}-${mode.value === 'bilingual' ? '双语' : '译文'}.${extension}`,
    );
  }
  pageInput.onchange = () => {
    index = Math.min(total() - 1, Math.max(0, Number(pageInput.value) - 1));
    show().catch((error) => status(message, error.message, true));
  };
  const loadUrl = async () => {
    const response = await fetch(url.value.trim(), {
      credentials: 'omit',
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('文档读取失败 HTTP ' + response.status);
    const blob = await response.blob();
    const path = new URL(url.value.trim()).pathname;
    await load(
      new File([blob], decodeURIComponent(path.split('/').at(-1)) || '文档.pdf', {
        type: blob.type,
      }),
    );
  };
  dispose = () => {
    loadGeneration++;
    renderToken++;
    document?.destroy?.()?.catch?.(() => {});
  };
  content.replaceChildren(
    heading('文档阅读与翻译', '在浏览器内打开 PDF、EPUB、TXT 和 HTML，翻译后带走双语文件。'),
    el(
      'div',
      { class: 'file-picker' },
      el('strong', { text: '选择本地文档' }),
      filePicker('.pdf,.epub,.txt,.html,.htm,.xhtml', load),
    ),
    el('div', { class: 'row' }, url, actionButton('读取地址', loadUrl)),
    el(
      'div',
      { class: 'grid-three' },
      field('文本文件编码', encoding),
      field('PDF 密码', password),
      field('显示与导出模式', mode),
    ),
    el(
      'div',
      { class: 'file-controls' },
      el('button', {
        text: '上一页或章',
        onclick: () => {
          if (index > 0) {
            index--;
            show().catch((error) => status(message, error.message, true));
          }
        },
      }),
      pageInput,
      el('button', {
        text: '下一页或章',
        onclick: () => {
          if (index + 1 < total()) {
            index++;
            show().catch((error) => status(message, error.message, true));
          }
        },
      }),
      info,
    ),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'check' }, forceVision, '当前 PDF 强制使用视觉识别'),
      field('扫描页视觉服务', select),
    ),
    el(
      'div',
      { class: 'button-row' },
      actionButton('翻译当前页或章', current),
      actionButton('翻译全部', async (signal) => {
        if (!document && !plain) throw new Error('请先选择文件');
        if (['txt', 'html'].includes(type)) return current(signal);
        const initial = index;
        try {
          for (let i = 0; i < total(); i++) {
            cancelled();
            index = i;
            if (
              type === 'pdf'
                ? !document.translations.has(i)
                : !document.translations.has(document.chapters[i].path)
            )
              await current(signal);
            status(message, `整本文档 ${i + 1}/${total()}`);
          }
        } finally {
          index = initial;
          await show();
        }
      }),
      actionButton('导出当前结果', () => exportFile(false)),
      actionButton('导出整本文档', () => exportFile(true)),
    ),
    el('p', {
      class: 'hint',
      text: '扫描页使用视觉模型。PDF 译页以图像保存，普通 PDF 的双语导出保留原页文字层。EPUB 导出保留未翻译章节及书内资源。',
    }),
    display,
  );
  if (params.get('url') && selectedTool === 'documents') {
    url.value = params.get('url');
    loadUrl().catch((error) => status(message, error.message, true));
  }
}
function subtitlesTool() {
  let document,
    filename = '',
    offset = 0;
  let loadGeneration = 0;
  const table = el('div', { class: 'scroll-x' });
  const info = el('span', { class: 'hint' });
  const mode = el(
    'select',
    { 'aria-label': '字幕导出模式' },
    el('option', { value: 'bilingual' }, '双语'),
    el('option', { value: 'translation' }, '纯译文'),
    el('option', { value: 'original' }, '原文'),
  );
  const encoding = el(
    'select',
    { 'aria-label': '字幕编码' },
    ...['utf-8', 'gb18030', 'utf-16le', 'big5', 'shift_jis'].map((value) =>
      el('option', { value }, value),
    ),
  );
  const render = () => {
    if (!document) return;
    info.textContent = `${filename}，${document.cues.filter((cue) => cue.translation).length}/${document.cues.length} 条已有译文`;
    const body = el('tbody');
    for (const cue of document.cues.slice(offset, offset + 100)) {
      const translation = el('textarea', { rows: 2, 'aria-label': '字幕译文 ' + cue.id });
      translation.value = cue.translation || '';
      translation.oninput = () => {
        cue.translation = translation.value;
        info.textContent = `${filename}，${document.cues.filter((cue) => cue.translation).length}/${document.cues.length} 条已有译文`;
      };
      body.append(
        el(
          'tr',
          {},
          el('td', { text: timestamp(cue.start) }),
          el('td', { class: 'file-text', text: cue.text }),
          el('td', {}, translation),
        ),
      );
    }
    table.replaceChildren(
      el(
        'table',
        { class: 'cue-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: '时间' }),
            el('th', { text: '原文' }),
            el('th', { text: '译文' }),
          ),
        ),
        body,
      ),
    );
  };
  invalidateTool = () => {
    if (document) for (const cue of document.cues) delete cue.translation;
    render();
  };
  const load = async (file) => {
    stop();
    const generation = ++loadGeneration;
    if (file.size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB');
    document = undefined;
    filename = '';
    table.replaceChildren();
    info.textContent = '正在读取字幕…';
    const parsed = parseSubtitle(
      decodeText(await file.arrayBuffer(), encoding.value),
      file.name.split('.').at(-1).toLowerCase(),
    );
    if (generation !== loadGeneration) return;
    if (!parsed.cues.length) throw new Error('没有解析到有效字幕时间轴');
    document = parsed;
    filename = file.name;
    offset = 0;
    render();
  };
  dispose = () => {
    loadGeneration++;
  };
  content.replaceChildren(
    heading('字幕文件', '保留时间轴与 ASS 样式，翻译后可以逐条修订并导出。'),
    el('div', { class: 'file-picker' }, filePicker('.srt,.vtt,.ass,.ssa', load)),
    el('div', { class: 'row' }, field('源文件编码', encoding), field('导出内容', mode)),
    el(
      'div',
      { class: 'button-row' },
      actionButton('翻译字幕', async () => {
        if (!document) throw new Error('先选择字幕文件');
        const needed = document.cues.filter((cue) => !cue.translation && subtitleText(cue));
        for (let index = 0; index < needed.length; index += 100) {
          cancelled();
          const cues = needed.slice(index, index + 100);
          const protectedCues = cues.map((cue) => protectSubtitle(cue.text));
          const result = await translate(
            protectedCues.map((cue, number) => ({ id: String(number), text: cue.text })),
            filename,
            'subtitle',
          );
          for (const item of result)
            cues[Number(item.id)].translation = protectedCues[Number(item.id)].restore(item.text);
          render();
        }
      }),
      el('button', {
        text: '导出原格式',
        onclick: () => {
          try {
            if (!document) throw new Error('先选择字幕文件');
            textFile(
              serializeSubtitle(document, mode.value),
              nameOf(filename) + '-O泡.' + document.type,
            );
          } catch (error) {
            status(message, error.message, true);
          }
        },
      }),
      el('button', {
        text: '导出 SRT',
        onclick: () => {
          if (document)
            textFile(serializeSubtitle(document, mode.value, 'srt'), nameOf(filename) + '-O泡.srt');
        },
      }),
    ),
    el(
      'div',
      { class: 'file-controls' },
      el('button', {
        text: '上一组',
        onclick: () => {
          offset = Math.max(0, offset - 100);
          render();
        },
      }),
      info,
      el('button', {
        text: '下一组',
        onclick: () => {
          if (document && offset + 100 < document.cues.length) {
            offset += 100;
            render();
          }
        },
      }),
    ),
    table,
  );
}
function audioTool() {
  let audio,
    filename = '',
    cues = [],
    decoded;
  let loadGeneration = 0;
  const chunks = new Map();
  const select = el(
    'select',
    { 'aria-label': '语音识别服务' },
    profileOptions(settings, settings.roles.asr, 'asr', true),
  );
  const seconds = el('input', { type: 'number', min: 10, max: 600, value: 30 });
  const player = el('audio', { controls: '', class: 'audio-player' });
  const info = el('span', { class: 'hint' });
  const output = el('div', { class: 'editor-result' });
  const draw = () => {
    output.replaceChildren(
      ...cues.map((cue) =>
        el(
          'div',
          { class: 'compact-stack' },
          el('small', { class: 'muted', text: timestamp(cue.start) }),
          el('div', { text: cue.text }),
          cue.translation && el('div', { text: cue.translation }),
        ),
      ),
    );
  };
  invalidateTool = () => {
    chunks.clear();
    cues = [];
    select.replaceChildren(...profileOptions(settings, settings.roles.asr, 'asr', true));
    draw();
  };
  select.onchange = () => {
    stop();
    chunks.clear();
    cues = [];
    draw();
  };
  seconds.onchange = () => {
    chunks.clear();
    cues = [];
    draw();
  };
  const load = async (file) => {
    const generation = ++loadGeneration;
    stop();
    if (file.size > 200 * 1024 * 1024) throw new Error('音视频文件超过 200MB，请拆分后处理');
    audio = file;
    filename = file.name;
    chunks.clear();
    cues = [];
    decoded = undefined;
    output.replaceChildren();
    revokeUrl(player.src);
    player.src = addUrl(file);
    status(message, '正在读取音轨…');
    const loaded = await decodeAudio(file);
    if (generation !== loadGeneration) return;
    decoded = loaded;
    info.textContent = `${filename}，${Math.round(decoded.duration)} 秒`;
    status(message, '音轨已读取，可以开始识别');
  };
  dispose = () => {
    loadGeneration++;
    player.pause();
  };
  const recognize = async () => {
    if (!audio || !decoded) throw new Error('先选择可解码的音视频文件');
    const chunkSeconds = Math.min(600, Math.max(10, Number(seconds.value) || 30));
    for (let start = 0; start < decoded.duration; start += chunkSeconds) {
      cancelled();
      if (!chunks.has(start)) {
        const duration = Math.min(chunkSeconds, decoded.duration - start);
        const blob = wavChunk(decoded, start, duration);
        const response = await call('transcribe', {
          profileId: select.value,
          dataUrl: await blobDataUrl(blob),
          filename: 'audio.wav',
          language: sourceLanguage.value,
        });
        chunks.set(start, transcriptCues(response, start, duration));
      }
      cues = [...chunks.entries()].sort((a, b) => a[0] - b[0]).flatMap((entry) => entry[1]);
      draw();
      status(
        message,
        `识别 ${Math.min(decoded.duration, start + chunkSeconds).toFixed(0)}/${decoded.duration.toFixed(0)} 秒`,
      );
    }
  };
  content.replaceChildren(
    heading('音视频识别', '浏览器解码音轨并按片段提交给你的语音服务，转录后可以翻译和导出字幕。'),
    el(
      'div',
      { class: 'file-picker' },
      filePicker('audio/*,video/*,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.flac', load),
    ),
    el('div', { class: 'grid-two' }, field('语音识别服务', select), field('每段时长，秒', seconds)),
    player,
    info,
    el(
      'div',
      { class: 'button-row' },
      actionButton('识别音轨', recognize),
      actionButton('识别并翻译', async () => {
        await recognize();
        for (let index = 0; index < cues.length; index += 100) {
          const batch = cues.slice(index, index + 100);
          const results = await translate(
            batch.map((cue, number) => ({ id: String(number), text: cue.text })),
            filename,
            'subtitle',
          );
          for (const item of results) batch[Number(item.id)].translation = item.text;
          draw();
        }
      }),
      el('button', {
        text: '导出双语 SRT',
        onclick: () => {
          if (cues.length)
            textFile(serializeSubtitle({ type: 'srt', cues }), nameOf(filename) + '-双语.srt');
          else status(message, '请先完成识别', true);
        },
      }),
      el('button', {
        text: '导出转录文本',
        onclick: () =>
          textFile(cues.map((cue) => cue.text).join('\n'), nameOf(filename) + '-转录.txt'),
      }),
    ),
    el('p', {
      class: 'hint',
      text: '模型返回分段时间戳时保留其时间轴，返回纯文字时按音频片段定位。实时页面音频识别可从扩展弹窗或网页右键启动。',
    }),
    output,
  );
}
function render() {
  stop();
  dispose();
  dispose = () => {};
  invalidateTool = () => {};
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  status(message, '');
  for (const button of nav.querySelectorAll('button')) {
    button.setAttribute('aria-selected', button.dataset.tool === selectedTool);
    button.tabIndex = button.dataset.tool === selectedTool ? 0 : -1;
  }
  content.setAttribute('aria-labelledby', 'tool-' + selectedTool);
  (
    ({
      text: () => textTool(),
      writing: () => textTool(true),
      images: imagesTool,
      documents: documentsTool,
      subtitles: subtitlesTool,
      audio: audioTool,
    })[selectedTool] || textTool
  )();
}
async function initialize() {
  settings = await rpc('get-public-settings');
  applyTheme(settings);
  textProfile = el(
    'select',
    { 'aria-label': '文本服务' },
    profileOptions(settings, settings.roles.text),
  );
  targetLanguage = el(
    'select',
    { 'aria-label': '目标语言' },
    LANGUAGES.filter(([value]) => value !== 'auto').map(([value, label]) =>
      el('option', { value, selected: value === settings.targetLanguage }, label),
    ),
  );
  sourceLanguage = el(
    'select',
    { 'aria-label': '源语言' },
    LANGUAGES.map(([value, label]) =>
      el('option', { value, selected: value === settings.sourceLanguage }, label),
    ),
  );
  for (const select of [textProfile, targetLanguage, sourceLanguage])
    select.onchange = () => {
      stop();
      invalidateTool();
      status(message, '翻译配置已切换，旧结果已清理，可按当前选择重新处理');
    };
  nav.append(
    ...[
      ['text', '文本'],
      ['images', '图片'],
      ['documents', '文档'],
      ['subtitles', '字幕文件'],
      ['audio', '音视频'],
      ['writing', '写作'],
    ].map(([tool, label]) =>
      el('button', {
        id: 'tool-' + tool,
        'data-tool': tool,
        role: 'tab',
        'aria-controls': 'workspace-content',
        'aria-selected': tool === selectedTool,
        onclick: () => {
          selectedTool = tool;
          render();
        },
        text: label,
      }),
    ),
  );
  nav.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...nav.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  };
  const cancel = el('button', {
    'data-cancel': 'true',
    text: '取消当前任务',
    onclick: () => {
      stop();
      status(message, '已发送取消请求');
    },
  });
  main.append(
    nav,
    el(
      'div',
      { class: 'workspace-settings' },
      field('文本服务', textProfile),
      field('源语言', sourceLanguage),
      field('目标语言', targetLanguage),
      cancel,
    ),
    message,
    content,
  );
  root.append(
    el(
      'header',
      { class: 'app-header' },
      el(
        'div',
        { class: 'brand' },
        el('img', { src: 'logo.svg', alt: '' }),
        el(
          'div',
          {},
          el('div', { class: 'brand-name', text: 'O泡翻译' }),
          el('small', { text: '翻译工作台' }),
        ),
      ),
      el('button', { text: '设置', onclick: () => rpc('open-settings') }),
    ),
    main,
  );
  render();
  if (params.get('error')) status(message, params.get('error'), true);
  chrome.runtime.onMessage.addListener((event) => {
    if (event.channel !== 'opao-settings') return false;
    if (event.translationChanged === false) {
      settings = event.settings;
      applyTheme(settings);
      return false;
    }
    stop();
    settings = event.settings;
    applyTheme(settings);
    textProfile.replaceChildren(...profileOptions(settings, settings.roles.text));
    invalidateTool();
    status(message, '设置已更新，旧结果已清理，可按新配置重新处理');
    return false;
  });
}
initialize().catch((error) =>
  root.replaceChildren(el('div', { class: 'empty', text: error.message })),
);
