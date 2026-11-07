import { LANGUAGES } from './shared/config.js';
import { rpc, el, applyTheme, status, profileOptions } from './shared/client.js';

const root = document.getElementById('app');
async function initialize() {
  let settings = await rpc('get-public-settings');
  applyTheme(settings);
  const tab = await rpc('active-tab');
  const message = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const run = async (action, success = '操作已发送') => {
    try {
      await rpc('tab-action', { action });
      status(message, success);
    } catch (error) {
      status(message, error.message, true);
    }
  };
  const service = el(
    'select',
    { 'aria-label': '网页翻译服务' },
    profileOptions(settings, settings.roles.text),
  );
  service.onchange = async () => {
    try {
      settings.roles.text = service.value;
      settings = await rpc('patch-settings', { patch: { roles: { text: service.value } } });
      status(message, '服务已切换');
    } catch (error) {
      status(message, error.message, true);
    }
  };
  const language = el(
    'select',
    { 'aria-label': '翻译目标语言' },
    LANGUAGES.filter(([value]) => value !== 'auto').map(([value, label]) =>
      el('option', { value, selected: value === settings.targetLanguage }, label),
    ),
  );
  language.onchange = async () => {
    try {
      await rpc('patch-settings', { patch: { targetLanguage: language.value } });
      status(message, '目标语言已更新');
    } catch (error) {
      status(message, error.message, true);
    }
  };
  let domain = '';
  try {
    domain = new URL(tab.url).hostname || tab.title;
  } catch {
    domain = tab.title || '当前页面';
  }
  root.append(
    el(
      'header',
      { class: 'popup-header' },
      el(
        'div',
        { class: 'brand' },
        el('img', { src: 'logo.svg', alt: '' }),
        el('div', { class: 'brand-name', text: 'O泡翻译' }),
      ),
      el('button', { class: 'quiet', text: '设置', onclick: () => rpc('open-settings') }),
    ),
    el(
      'main',
      { class: 'popup-main' },
      el('div', { class: 'page-domain', text: domain }),
      el(
        'div',
        { class: 'grid-two' },
        el('label', { class: 'field' }, el('span', { text: '翻译服务' }), service),
        el('label', { class: 'field' }, el('span', { text: '目标语言' }), language),
      ),
      el('button', {
        class: 'primary translate-main',
        id: 'translate-page',
        text: '切换网页双语翻译',
        onclick: () => run('toggle-page'),
      }),
      el(
        'div',
        { class: 'popup-actions' },
        ...[
          ['whole-page', '整页翻译', '包含正文之外的文本'],
          ['restore', '恢复原文', '恢复页面与已翻译图片'],
          ['only-translation', '纯译文', '切换原文显示'],
          ['translate-images', '图片与漫画', '批量处理页面图片'],
          ['toggle-subtitles', '双语字幕', '使用网站已有字幕'],
          ['capture-audio', '音频识别', '使用自选语音服务'],
          ['download-subtitles', '导出字幕', '保存双语 SRT'],
          ['open-document', '文档翻译', '打开本地文档工作台'],
        ].map(([action, label, hint]) =>
          el('button', { onclick: () => run(action) }, label, el('small', { text: hint })),
        ),
      ),
      message,
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'quiet',
          text: '总是翻译此网站',
          onclick: async () => {
            try {
              await rpc('set-site-rule', { mode: 'auto' });
              status(message, '已加入自动翻译');
            } catch (error) {
              status(message, error.message, true);
            }
          },
        }),
        el('button', {
          class: 'quiet',
          text: '不翻译此网站',
          onclick: async () => {
            try {
              await rpc('set-site-rule', { mode: 'block' });
              status(message, '已加入排除列表');
            } catch (error) {
              status(message, error.message, true);
            }
          },
        }),
      ),
      el(
        'footer',
        { class: 'popup-footer' },
        el('button', { class: 'quiet', text: '打开工作台', onclick: () => rpc('open-workspace') }),
        el('button', { class: 'quiet', text: '打开侧栏', onclick: () => run('open-panel') }),
      ),
    ),
  );
}
initialize().catch((error) =>
  root.replaceChildren(el('div', { class: 'empty', text: error.message })),
);
