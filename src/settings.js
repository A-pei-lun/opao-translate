import { createProfile, LANGUAGES, PROTOCOLS, TRADITIONAL_PROTOCOLS } from './shared/config.js';
import {
  rpc,
  el,
  applyTheme as applyClientTheme,
  status,
  jobId,
  textFile,
  profileOptions,
} from './shared/client.js';
import {
  TRANSLATION_STYLES,
  FONT_PRESETS,
  applyTranslationAppearance,
  translationCss,
} from './shared/appearance.js';

const root = document.getElementById('app');
document.head.append(el('style', { text: translationCss }));
let settings,
  selected,
  currentSection = 'services';
let hasChanges = false;
let fieldSequence = 0;
const sections = [
  ['services', '服务与模型'],
  ['reading', '阅读与交互'],
  ['media', '图片与字幕'],
  ['rules', '站点与术语'],
  ['data', '数据与诊断'],
];
const invalid = new Map();
const jsonDrafts = new Map();
const notice = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
const main = el('main', { class: 'settings-main', id: 'settings-main', tabindex: '-1' });
const nav = el('nav', { class: 'sidebar', 'aria-label': '设置分类' });
const rolesArea = el('div', { class: 'roles' });
const fallbackArea = el('section', { class: 'fallback-settings', 'aria-label': '超时自动切换' });
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(value) {
  applyClientTheme(value);
  const dark = value.theme === 'dark' || (value.theme === 'system' && systemTheme.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#121a22' : '#f4f7f9';
}
function dirty() {
  hasChanges = true;
  status(notice, '有未保存的修改');
}
function field(label, input, hint = '') {
  const control = input.matches('input,select,textarea')
    ? input
    : input.querySelector('input,select,textarea');
  const id = control.id || 'setting-' + ++fieldSequence;
  control.id = id;
  control.name ||= id;
  control.setAttribute('aria-label', label);
  if (hint) control.setAttribute('aria-describedby', id + '-hint');
  return el(
    'div',
    { class: 'field' },
    el(
      'div',
      { class: 'field-copy' },
      el('label', { for: id, text: label }),
      hint && el('p', { class: 'hint', id: id + '-hint', text: hint }),
    ),
    el('div', { class: 'field-control' }, input),
  );
}
function inputFor(object, key, type = 'text', attributes = {}) {
  const input = el('input', { type, name: key, autocomplete: 'off', ...attributes });
  input.value = object[key] ?? '';
  input.oninput = () => {
    object[key] = input.value;
    dirty();
  };
  return input;
}
function numberFor(object, key, min, max, step = 1) {
  const input = inputFor(object, key, 'number', { min, max, step });
  input.oninput = () => {
    if (input.value !== '') object[key] = Number(input.value);
    dirty();
  };
  return input;
}
function selectFor(object, key, options, extra) {
  const select = el(
    'select',
    { name: key },
    options.map(([value, label]) =>
      el('option', { value, selected: String(object[key]) === String(value) }, label),
    ),
  );
  select.onchange = () => {
    object[key] = select.value;
    dirty();
    extra?.();
  };
  return select;
}
function check(label, object, key, extra, hint = '') {
  const input = el('input', {
    type: 'checkbox',
    name: key,
    checked: object[key],
    'aria-label': label,
  });
  const description =
    hint &&
    el('span', {
      class: 'hint',
      id: 'setting-hint-' + ++fieldSequence,
      text: hint,
    });
  if (description) input.setAttribute('aria-describedby', description.id);
  input.onchange = () => {
    object[key] = input.checked;
    dirty();
    extra?.();
  };
  return el(
    'label',
    { class: 'check' },
    el('span', { class: 'check-copy' }, el('span', { text: label }), description),
    input,
  );
}
function group(title, description, ...children) {
  return el(
    'section',
    { class: 'settings-group', 'aria-label': title },
    el(
      'div',
      { class: 'group-heading' },
      el('h2', { text: title }),
      description && el('p', { class: 'hint', text: description }),
    ),
    el('div', { class: 'group-content' }, ...children),
  );
}
function disclosure(title, ...children) {
  return el(
    'details',
    { class: 'settings-details' },
    el('summary', { text: title }),
    el('div', { class: 'details-content' }, ...children),
  );
}
function jsonField(label, object, key, identity, hint = '') {
  const textarea = el('textarea', { rows: 5, name: key, spellcheck: 'false', autocomplete: 'off' });
  const id = identity + ':' + key;
  const error = el('p', { class: 'field-error', role: 'status', 'aria-live': 'polite' });
  textarea.value = jsonDrafts.get(id) ?? JSON.stringify(object[key], null, 2);
  textarea.oninput = () => {
    jsonDrafts.set(id, textarea.value);
    try {
      const value = JSON.parse(textarea.value || '{}');
      if (!value || typeof value !== 'object') throw new Error('需要 JSON 对象或数组');
      object[key] = value;
      invalid.delete(id);
      textarea.setCustomValidity('');
      error.textContent = '';
    } catch {
      invalid.set(id, label + ' 的 JSON 格式无效');
      textarea.setCustomValidity('JSON 格式无效');
      error.textContent = 'JSON 格式无效，请检查括号、引号和逗号。';
    }
    dirty();
  };
  const result = field(label, textarea, hint);
  error.id = textarea.id + '-error';
  textarea.setAttribute(
    'aria-describedby',
    [hint && textarea.id + '-hint', error.id].filter(Boolean).join(' '),
  );
  if (invalid.has(id)) {
    textarea.setCustomValidity('JSON 格式无效');
    error.textContent = 'JSON 格式无效，请检查括号、引号和逗号。';
  }
  result.querySelector('.field-control').append(error);
  return result;
}
function linesField(label, key, hint) {
  const area = el('textarea', { rows: 5, name: key, spellcheck: 'false', autocomplete: 'off' });
  area.value = settings[key].join('\n');
  area.oninput = () => {
    settings[key] = area.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    dirty();
  };
  return field(label, area, hint);
}
async function save() {
  const saveButton = document.getElementById('save-settings');
  const controls = [...main.querySelectorAll('input,select,textarea,button'), saveButton];
  const disabledBefore = controls.map((node) => node.disabled);
  try {
    const fields = [...main.querySelectorAll('input,textarea,select')];
    const firstInvalid = fields.find((input) => !input.validity.valid);
    if (firstInvalid) {
      for (let parent = firstInvalid.parentElement; parent !== main; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      firstInvalid.focus();
      firstInvalid.reportValidity();
      return false;
    }
    if (invalid.size) throw new Error([...invalid.values()][0]);
    controls.forEach((node) => {
      node.disabled = true;
    });
    saveButton.textContent = '保存中…';
    settings = await rpc('save-settings', { settings });
    hasChanges = false;
    applyTheme(settings);
    render();
    status(notice, '设置已保存');
    return true;
  } catch (error) {
    status(notice, error.message, true);
    return false;
  } finally {
    saveButton.textContent = '保存设置';
    controls.forEach((node, index) => {
      node.disabled = disabledBefore[index];
    });
  }
}
function header(title, description) {
  return el(
    'div',
    { class: 'section-heading' },
    el('div', {}, el('h1', { text: title, tabindex: '-1' }), el('p', { text: description })),
  );
}
function aiLayoutSettings() {
  const options = el('fieldset', { class: 'ai-layout-options', disabled: !settings.aiLayout });
  const profiles = settings.profiles.filter(
    (profile) =>
      profile.enabled &&
      profile.capabilities.text &&
      ['chat', 'responses', 'claude', 'gemini'].includes(profile.protocol),
  );
  options.append(
    el('legend', { text: 'AI排版选项' }),
    field(
      '排版服务',
      selectFor(settings.roles, 'layout', [
        ['', '跟随网页与文本服务'],
        ...profiles.map((profile) => [profile.id, profile.name]),
      ]),
    ),
    check(
      '发送完整网页 HTML',
      settings,
      'aiLayoutFullHtml',
      undefined,
      '默认只发送页面结构和待排版区域。开启后发送清理过的整页 HTML，可能增加耗时和用量。',
    ),
  );
  const section = group(
    'AI 排版',
    '实验功能，需要支持文本生成的模型服务。',
    check(
      'AI排版',
      settings,
      'aiLayout',
      () => {
        options.disabled = !settings.aiLayout;
      },
      '为已翻译区域选择显示方式，翻译继续进行；排版失败时保留本地布局。默认关闭。',
    ),
    options,
  );
  section.classList.add('ai-layout-settings');
  section.querySelector('.group-heading').append(el('span', { class: 'tag', text: '实验性' }));
  return section;
}
function renderRoles() {
  rolesArea.replaceChildren(
    el(
      'div',
      { class: 'group-heading' },
      el('h2', { text: '把模型分配给翻译场景' }),
      el('p', {
        class: 'hint',
        text: '不同场景可以分别选择服务；更换服务名称后，这里会同步更新。',
      }),
    ),
    el(
      'div',
      { class: 'grid-three group-content' },
      ...[
        ['text', '网页与文本', 'text'],
        ['input', '输入与写作', 'text'],
        ['vision', '图片识别与翻译', 'vision'],
        ['subtitle', '字幕翻译', 'text'],
        ['asr', '语音识别', 'asr'],
      ].map(([role, label, capability]) => {
        const select = el(
          'select',
          {},
          profileOptions(settings, settings.roles[role], capability, role !== 'text'),
        );
        select.onchange = () => {
          settings.roles[role] = select.value;
          dirty();
        };
        return field(label, select);
      }),
    ),
  );
  renderFallback();
}
function renderFallback() {
  const fallback = settings.serviceFallback;
  const ordered = fallback.order
    .map((id) => settings.profiles.find((profile) => profile.id === id))
    .filter(
      (profile) =>
        profile &&
        profile.protocol !== 'asr' &&
        (profile.capabilities.text || profile.capabilities.vision),
    );
  const state = el('span', {
    class: 'tag',
    text: fallback.enabled ? '已开启，仅记忆当前页面' : '未启用',
  });
  const toggle = check(
    '服务超时后自动切换',
    fallback,
    'enabled',
    () => {
      state.textContent = fallback.enabled ? '已开启，仅记忆当前页面' : '未启用';
    },
    '当前服务超时后，按下面的顺序尝试其他服务。默认关闭。',
  );
  const move = (profile, offset) => {
    const index = ordered.indexOf(profile);
    const other = ordered[index + offset];
    if (!other) return;
    const a = fallback.order.indexOf(profile.id);
    const b = fallback.order.indexOf(other.id);
    [fallback.order[a], fallback.order[b]] = [fallback.order[b], fallback.order[a]];
    dirty();
    renderFallback();
    const buttons = [...fallbackArea.querySelectorAll('button')];
    buttons
      .find(
        (button) =>
          button.dataset.profileId === profile.id &&
          button.dataset.direction === String(offset) &&
          !button.disabled,
      )
      ?.focus();
  };
  fallbackArea.replaceChildren(
    el(
      'div',
      { class: 'fallback-heading group-heading' },
      el('h2', { text: '超时自动切换' }),
      state,
    ),
    toggle,
    el(
      'ol',
      { class: 'fallback-order', 'aria-label': '备用服务顺序' },
      ...ordered.map((profile, index) => {
        const ready =
          profile.enabled &&
          profile.baseUrl &&
          (profile.model || TRADITIONAL_PROTOCOLS.includes(profile.protocol));
        return el(
          'li',
          { 'data-profile-id': profile.id },
          el('span', { class: 'fallback-rank', 'aria-hidden': 'true', text: String(index + 1) }),
          el(
            'div',
            { class: 'fallback-label' },
            el('strong', { text: profile.name.trim() || '未命名服务' }),
            el('span', {
              class: 'hint',
              text:
                (profile.model || '模型待填写') +
                (!profile.enabled ? '（未启用，自动跳过）' : !ready ? '（未配置，自动跳过）' : ''),
            }),
          ),
          el(
            'div',
            { class: 'fallback-actions' },
            ...[
              [-1, '上移'],
              [1, '下移'],
            ].map(([offset, text]) =>
              el('button', {
                text,
                'aria-label': `${text} ${profile.name}`,
                'data-profile-id': profile.id,
                'data-direction': String(offset),
                disabled: index + offset < 0 || index + offset >= ordered.length,
                onclick: () => move(profile, offset),
              }),
            ),
          ),
        );
      }),
    ),
    ...(!ordered.length
      ? [el('p', { class: 'hint', text: '添加文本或视觉服务后，可在这里安排备用顺序。' })]
      : []),
    el('p', {
      class: 'hint',
      text: '只在超时时切换，跳过停用、未配置及能力不匹配的服务。成功服务仅用于当前页面，刷新后重置。关闭后按原服务的重试设置执行；图片只使用视觉服务。',
    }),
  );
}
function renderServices() {
  renderRoles();
  const list = el('div', { class: 'service-list', 'aria-label': '已添加的服务' });
  const form = el('div', { class: 'form-block' });
  const board = el('div', { class: 'service-board' }, list, form);
  function draw() {
    if (!settings.profiles.some((profile) => profile.id === selected))
      selected = settings.profiles[0]?.id;
    list.replaceChildren(
      el(
        'div',
        { class: 'service-list-heading' },
        el('h2', { text: '我的服务' }),
        el('span', { class: 'hint', text: String(settings.profiles.length) + ' 个' }),
      ),
      ...settings.profiles.map((profile) =>
        el(
          'button',
          {
            class: 'service-item',
            title: profile.name,
            'aria-pressed': profile.id === selected,
            onclick: () => {
              selected = profile.id;
              draw();
              list.querySelector('[aria-pressed="true"]').focus();
            },
          },
          el('strong', { text: profile.name }),
          el('small', { text: profile.model || '模型待填写' }),
          el('span', { class: 'hint', text: profile.baseUrl ? '接口已填写' : '接口待配置' }),
        ),
      ),
      el('button', {
        class: 'add-service',
        text: '添加服务',
        onclick: () => {
          const profile = createProfile();
          profile.name = `新服务 ${settings.profiles.length + 1}`;
          settings.profiles.push(profile);
          settings.serviceFallback.order.push(profile.id);
          selected = profile.id;
          if (!settings.roles.text) settings.roles.text = profile.id;
          dirty();
          renderRoles();
          draw();
          form.querySelector('input[name="name"]').focus();
        },
      }),
    );
    const profile = settings.profiles.find((value) => value.id === selected);
    if (!profile) {
      form.replaceChildren(
        el('div', { class: 'empty', text: '添加一个翻译服务，开始配置你的模型。' }),
      );
      return;
    }
    const testStatus = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const modelList = el('datalist', { id: 'available-models' });
    const model = inputFor(profile, 'model', 'text', {
      list: 'available-models',
      placeholder: '例如 gpt-4.1-mini…',
    });
    model.oninput = () => {
      profile.model = model.value;
      dirty();
      const currentModel = list.querySelector('[aria-pressed=true] small');
      if (currentModel) currentModel.textContent = profile.model || '模型待填写';
      renderRoles();
    };
    const apiKey = inputFor(profile, 'apiKey', 'password', {
      autocomplete: 'off',
      'aria-label': 'API Key',
      placeholder: '支持留空，多把密钥用逗号分隔…',
    });
    const test = async (kind) => {
      status(testStatus, '正在请求接口…');
      try {
        if (!profile.baseUrl) throw new Error('先填写接口地址');
        if (
          kind === 'test-profile' &&
          !profile.model &&
          !TRADITIONAL_PROTOCOLS.includes(profile.protocol)
        )
          throw new Error('先填写模型 ID');
        const result = await rpc(kind, { profile, jobId: jobId() });
        if (kind === 'models') {
          modelList.replaceChildren(...result.map((id) => el('option', { value: id })));
          status(testStatus, `获取到 ${result.length} 个模型，可在模型输入框中选择或手填`);
        } else status(testStatus, '文本连通性通过。视觉与语音能力需用相应样例验证。');
      } catch (error) {
        status(testStatus, error.message, true);
      }
    };
    const templates = [
      ['', '选择服务模板'],
      ['openai', 'OpenAI 兼容'],
      ['deepseek', 'DeepSeek'],
      ['openrouter', 'OpenRouter'],
      ['siliconflow', 'SiliconFlow'],
      ['ollama', 'Ollama'],
      ['lmstudio', 'LM Studio'],
      ['gemini', 'Gemini'],
      ['claude', 'Claude'],
      ['deepl', 'DeepL'],
      ['microsoft', 'Microsoft Translator'],
      ['google', 'Google Cloud Translation'],
      ['google-free', 'Google 网页翻译'],
      ['bing-free', 'Bing 网页翻译'],
    ];
    const template = el(
      'select',
      { name: 'service-template' },
      templates.map(([value, label]) => el('option', { value }, label)),
    );
    template.onchange = () => {
      const presets = {
        openai: ['chat', 'https://api.openai.com/v1'],
        deepseek: ['chat', 'https://api.deepseek.com'],
        openrouter: ['chat', 'https://openrouter.ai/api/v1'],
        siliconflow: ['chat', 'https://api.siliconflow.cn/v1'],
        ollama: ['chat', 'http://localhost:11434/v1'],
        lmstudio: ['chat', 'http://localhost:1234/v1'],
        gemini: ['gemini', 'https://generativelanguage.googleapis.com/v1beta'],
        claude: ['claude', 'https://api.anthropic.com/v1'],
        deepl: ['deepl', 'https://api-free.deepl.com/v2/translate'],
        microsoft: ['microsoft', 'https://api.cognitive.microsofttranslator.com/translate'],
        google: ['google', 'https://translation.googleapis.com/language/translate/v2'],
        'google-free': ['google-free', 'https://translate.googleapis.com/translate_a/t'],
        'bing-free': ['bing-free', 'https://edge.microsoft.com/translate/translatetext'],
      };
      if (!presets[template.value]) return;
      [profile.protocol, profile.baseUrl] = presets[template.value];
      if (
        !profile.name.trim() ||
        profile.name === '自定义接口' ||
        /^新服务(?: \d+)?$/.test(profile.name)
      )
        profile.name = templates.find((item) => item[0] === template.value)[1];
      dirty();
      renderRoles();
      draw();
    };
    const nameInput = inputFor(profile, 'name', 'text', {
      required: true,
      maxlength: 100,
      placeholder: '例如 主力中转站…',
    });
    nameInput.oninput = () => {
      profile.name = nameInput.value;
      nameInput.setCustomValidity(profile.name.trim() ? '' : '请填写可辨识的服务名称');
      dirty();
      const selectedButton = list.querySelector('[aria-pressed=true] strong');
      if (selectedButton) selectedButton.textContent = profile.name.trim() || '未命名服务';
      renderRoles();
    };
    form.replaceChildren(
      el(
        'div',
        { class: 'row service-editor-heading' },
        el('h2', { text: '服务配置' }),
        el('span', { class: 'tag', text: PROTOCOLS[profile.protocol] }),
      ),
      field('快速填入接口模板', template),
      el(
        'div',
        { class: 'grid-two' },
        field('自定义服务名称', nameInput, '填写中转站或用途，列表和服务选择框都会显示这个名称。'),
        field(
          '接口协议',
          selectFor(profile, 'protocol', Object.entries(PROTOCOLS), () => {
            if (profile.protocol === 'asr') {
              profile.capabilities.asr = true;
              profile.capabilities.text = false;
            }
            renderRoles();
            draw();
          }),
        ),
      ),
      field(
        'API 地址',
        inputFor(profile, 'baseUrl', 'url', {
          placeholder: 'https://your-api.example/v1…',
        }),
        '支持根地址、版本路径和标准完整接口路径。自定义 HTTP JSON 协议按地址原样请求。',
      ),
      field(
        'API Key',
        el(
          'div',
          { class: 'row secret-control' },
          apiKey,
          el('button', {
            text: '显示',
            onclick: (event) => {
              apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
              event.currentTarget.textContent = apiKey.type === 'password' ? '显示' : '隐藏';
            },
          }),
        ),
        '密钥保存在扩展本地。无鉴权接口可以留空。',
      ),
      field('模型 ID', model),
      modelList,
      el(
        'div',
        { class: 'button-row' },
        el('button', { text: '获取模型列表', onclick: () => test('models') }),
        el('button', { text: '测试文字连通', onclick: () => test('test-profile') }),
      ),
      testStatus,
      el('h3', { text: '接口能力' }),
      el(
        'div',
        { class: 'row choice-set' },
        check('文本翻译', profile.capabilities, 'text', renderRoles),
        check('视觉输入', profile.capabilities, 'vision', renderRoles),
        check('语音识别', profile.capabilities, 'asr', renderRoles),
      ),
      el('div', {
        class: 'hint',
        text: '图片场景需要视觉能力。语音场景使用转录协议及对应模型。勾选能力用于明确分派，实际兼容性通过样例检查。',
      }),
      disclosure(
        '请求参数与性能',
        el(
          'div',
          { class: 'grid-three' },
          field('超时，秒', numberFor(profile, 'timeout', 5, 600)),
          field('并发数', numberFor(profile, 'concurrency', 1, 20)),
          field('失败重试次数', numberFor(profile, 'retries', 0, 5)),
          field('每批段落数', numberFor(profile, 'batchSize', 1, 30)),
          field('每批字符上限', numberFor(profile, 'maxChars', 200, 30000)),
          field(
            '温度，留空跟随接口',
            inputFor(profile, 'temperature', 'number', { step: '.1', min: 0, max: 2 }),
          ),
        ),
        el(
          'div',
          { class: 'grid-two' },
          field('输出 token 上限，选填', inputFor(profile, 'maxTokens', 'number', { min: 1 })),
          field(
            'Chat token 字段',
            selectFor(profile, 'tokenField', [
              ['max_completion_tokens', 'max_completion_tokens'],
              ['max_tokens', 'max_tokens'],
            ]),
          ),
        ),
        check('使用流式输出', profile, 'stream'),
      ),
      disclosure(
        '高级接口与翻译指令',
        field(
          '端点路径处理',
          selectFor(profile, 'endpointMode', [
            ['auto', '自动补全标准协议路径'],
            ['exact', '按完整地址原样请求'],
          ]),
          '非标准路径或网关别名可选择原样请求，查询参数会保留。',
        ),
        field(
          '转录响应格式',
          selectFor(profile, 'responseFormat', [
            ['json', 'JSON'],
            ['verbose_json', '含时间戳的 JSON'],
            ['srt', 'SRT 字幕'],
            ['vtt', 'VTT 字幕'],
            ['text', '纯文本'],
            ['diarized_json', '说话人分段 JSON'],
          ]),
          '响应格式由语音模型决定。缺少精确时间戳时使用录音片段时间。',
        ),
        field(
          '模型列表地址，选填',
          inputFor(profile, 'modelsUrl', 'url', {
            placeholder: '例如 https://your-api.example/v1/models…',
          }),
        ),
        jsonField(
          '自定义请求头',
          profile,
          'headers',
          profile.id,
          '例如 Microsoft 的区域字段，或兼容接口要求的请求头。',
        ),
        jsonField(
          '自定义请求体',
          profile,
          'body',
          profile.id,
          '字段会覆盖默认参数。自定义 HTTP JSON 支持 {{text}}、{{from}}、{{to}}、{{model}}、{{key}}。',
        ),
        field(
          '自定义 HTTP 译文字段路径',
          inputFor(profile, 'responsePath', 'text', { placeholder: '例如 data.translation…' }),
        ),
        (() => {
          const area = el('textarea', { rows: 4, name: 'profile-prompt', autocomplete: 'off' });
          area.value = profile.prompt;
          area.oninput = () => {
            profile.prompt = area.value;
            dirty();
          };
          return field('该服务的补充翻译指令', area);
        })(),
      ),
      el(
        'div',
        { class: 'button-row service-actions' },
        check('启用此服务', profile, 'enabled', renderRoles),
        el('button', {
          class: 'quiet danger',
          text: '移除此服务',
          onclick: () => {
            if (!confirm('移除“' + (profile.name.trim() || '未命名服务') + '”？保存设置后生效。'))
              return;
            settings.profiles = settings.profiles.filter((value) => value !== profile);
            settings.serviceFallback.order = settings.serviceFallback.order.filter(
              (id) => id !== profile.id,
            );
            for (const key of Object.keys(settings.roles))
              if (settings.roles[key] === profile.id) settings.roles[key] = '';
            for (const key of [...invalid.keys()])
              if (key.startsWith(profile.id + ':')) invalid.delete(key);
            selected = settings.profiles[0]?.id;
            dirty();
            renderRoles();
            draw();
          },
        }),
      ),
    );
  }
  draw();
  main.replaceChildren(
    header('服务与模型', '管理翻译接口，再把合适的服务分配给网页、图片和语音。'),
    el('div', { class: 'settings-sections' }, board, rolesArea, fallbackArea),
  );
}
function renderReading() {
  const previewSource = el('p', {
    class: 'preview-source',
    text: 'Read a complete paragraph in its original context. The translation follows as a paragraph of its own, keeping the meaning and rhythm together.',
  });
  const previewTarget = el('p', {
    class: 'opao-target',
    text: '在原有语境中阅读完整段落。译文随后独立成段，让含义与节奏连贯呈现。',
    lang: 'zh-CN',
  });
  const preview = el(
    'article',
    { class: 'preview reading-preview', 'aria-label': '段落样式实时预览' },
    previewSource,
    previewTarget,
  );
  const samples = [];
  const refresh = () => {
    applyTranslationAppearance(previewTarget, settings);
    previewSource.hidden = settings.mode === 'translation';
    for (const { target, id, radio } of samples) {
      applyTranslationAppearance(target, { ...settings, translationStyle: id });
      radio.checked = settings.translationStyle === id;
    }
  };
  const styles = selectFor(settings, 'translationStyle', TRANSLATION_STYLES, refresh);
  const mode = selectFor(
    settings,
    'mode',
    [
      ['bilingual', '双语对照'],
      ['translation', '纯译文'],
    ],
    refresh,
  );
  const theme = selectFor(
    settings,
    'theme',
    [
      ['system', '跟随系统'],
      ['light', '浅色'],
      ['dark', '深色'],
    ],
    () => applyTheme(settings),
  );
  const size = inputFor(settings, 'textSize', 'range', {
    min: 70,
    max: 180,
    'aria-label': '译文字号比例',
  });
  const sizeValue = el('span', { class: 'hint', text: settings.textSize + '%' });
  size.oninput = () => {
    settings.textSize = Number(size.value);
    sizeValue.textContent = settings.textSize + '%';
    dirty();
    refresh();
  };
  const color = inputFor(settings, 'translationColor', 'text', {
    placeholder: '例如 #086F83，留空跟随网页…',
  });
  color.oninput = () => {
    settings.translationColor = color.value;
    dirty();
    refresh();
  };
  const gallery = el('div', { class: 'style-grid' });
  for (const [id, name] of TRANSLATION_STYLES) {
    const radio = el('input', {
      type: 'radio',
      name: 'translation-style-preview',
      value: id,
      checked: settings.translationStyle === id,
      'aria-label': name + '译文样式',
    });
    const target = el('p', { class: 'opao-target', text: '每个段落完整呈现，阅读更连贯。' });
    radio.onchange = () => {
      if (radio.checked) {
        settings.translationStyle = id;
        styles.value = id;
        dirty();
        refresh();
      }
    };
    samples.push({ target, id, radio });
    gallery.append(
      el(
        'label',
        { class: 'style-choice' },
        el('span', { class: 'check' }, radio, name),
        el(
          'div',
          { class: 'style-choice-preview' },
          el('p', { text: 'Keep each paragraph together.' }),
          target,
        ),
      ),
    );
  }
  const preset = el(
    'select',
    { name: 'translation-font', 'aria-label': '译文字体' },
    ...FONT_PRESETS.map(([value, label]) => el('option', { value }, label)),
    el('option', { value: '__custom' }, '自定义字体'),
  );
  preset.value = FONT_PRESETS.some(([value]) => value === settings.translationFont)
    ? settings.translationFont
    : '__custom';
  const customFont = el('input', {
    type: 'text',
    name: 'custom-translation-font',
    autocomplete: 'off',
    maxlength: 180,
    placeholder: '例如 Noto Serif SC, SimSun, serif…',
    'aria-label': '自定义译文字体',
  });
  customFont.value = settings.translationFont;
  const customField = field(
    '自定义译文字体',
    customFont,
    '填写本机已经安装的字体名称，也可用逗号填写回退字体。',
  );
  customField.hidden = preset.value !== '__custom';
  preset.onchange = () => {
    customField.hidden = preset.value !== '__custom';
    settings.translationFont = preset.value === '__custom' ? customFont.value : preset.value;
    dirty();
    refresh();
  };
  customFont.oninput = () => {
    settings.translationFont = customFont.value;
    dirty();
    refresh();
  };
  const lineHeight = numberFor(settings, 'translationLineHeight', 1.2, 2.8, 0.1);
  const gap = numberFor(settings, 'translationParagraphGap', 0, 2, 0.05);
  for (const [input, key] of [
    [lineHeight, 'translationLineHeight'],
    [gap, 'translationParagraphGap'],
  ])
    input.oninput = () => {
      if (Number.isFinite(input.valueAsNumber)) settings[key] = input.valueAsNumber;
      dirty();
      refresh();
    };
  const fontSettings = el(
    'details',
    { class: 'reading-details settings-details' },
    el('summary', { text: '设置字体、字重和段落间距' }),
    el(
      'div',
      { class: 'details-content' },
      el(
        'div',
        { class: 'grid-two' },
        field('译文字体', preset),
        field(
          '译文字重',
          selectFor(
            settings,
            'translationFontWeight',
            [
              ['inherit', '跟随原文'],
              ['400', '常规'],
              ['500', '中等'],
              ['600', '半粗'],
              ['700', '粗体'],
            ],
            refresh,
          ),
        ),
      ),
      customField,
      el(
        'div',
        { class: 'grid-two' },
        field('译文行距', lineHeight),
        field('原文与译文间距，em', gap),
      ),
    ),
  );
  const hoverModifier = selectFor(settings, 'hoverModifier', [
    ['Alt', 'Alt'],
    ['Control', 'Ctrl'],
    ['Shift', 'Shift'],
  ]);
  hoverModifier.disabled = !settings.hover;
  const comparisonProfiles = settings.profiles.filter(
    (profile) => profile.enabled && profile.capabilities.text,
  );
  main.replaceChildren(
    header('阅读与交互', '调整语言、译文外观和操作方式，找到舒服的阅读节奏。'),
    el(
      'div',
      { class: 'settings-sections' },
      group(
        '语言偏好',
        '网页阅读与输入翻译可以使用不同的目标语言。',
        el(
          'div',
          { class: 'grid-three' },
          field('源语言', selectFor(settings, 'sourceLanguage', LANGUAGES)),
          field(
            '目标语言',
            selectFor(
              settings,
              'targetLanguage',
              LANGUAGES.filter(([id]) => id !== 'auto'),
            ),
          ),
          field(
            '输入框目标语言',
            selectFor(
              settings,
              'inputTargetLanguage',
              LANGUAGES.filter(([id]) => id !== 'auto'),
            ),
          ),
        ),
        check(
          '繁体中文转简体后替换原文',
          settings,
          'replaceTraditionalChinese',
          undefined,
          '目标为简体中文时生效。繁体段落在本地转换并替换，保留链接与格式，可恢复原文；简体段落自动跳过。关闭后，繁体按默认阅读模式翻译。',
        ),
      ),
      group(
        '译文外观',
        '修改后立即预览，保存后应用到网页。',
        el(
          'div',
          { class: 'grid-three' },
          field('界面主题', theme),
          field('默认阅读模式', mode),
          field('译文样式', styles),
        ),
        el(
          'div',
          { class: 'preview-frame' },
          el('span', { class: 'preview-label', text: '阅读效果' }),
          preview,
        ),
        el(
          'div',
          { class: 'grid-two' },
          field('译文字号比例', el('div', { class: 'compact-stack' }, size, sizeValue)),
          field('译文颜色，留空跟随网页', color),
        ),
        fontSettings,
        el(
          'details',
          { class: 'reading-details settings-details' },
          el('summary', { text: '预览全部译文样式' }),
          el('div', { class: 'details-content' }, gallery),
        ),
      ),
      group(
        '翻译与交互',
        '设置翻译范围，以及页面上显示的操作入口。',
        check(
          '按可见范围逐段翻译',
          settings,
          'lazy',
          undefined,
          '只翻译当前阅读范围，向下滚动时继续翻译。',
        ),
        check(
          '翻译页面标题',
          settings,
          'translateTitle',
          undefined,
          '同时翻译浏览器标签页中的页面标题。',
        ),
        check(
          '显示页面浮动按钮',
          settings,
          'floatingButton',
          undefined,
          '浮动 O 按钮可拖动，贴边后自动收起；悬停可打开页内设置。',
        ),
        check('显示划词翻译按钮', settings, 'selection', undefined, '选中文字后显示翻译入口。'),
        check(
          '启用修饰键悬停翻译',
          settings,
          'hover',
          () => {
            hoverModifier.disabled = !settings.hover;
          },
          '按住下方修饰键，将鼠标移到文字上即可翻译。',
        ),
        el('div', { class: 'dependent-setting' }, field('悬停修饰键', hoverModifier)),
        el(
          'div',
          { class: 'shortcut-list', 'aria-label': '翻译快捷键' },
          ...[
            ['Alt+A', '双语'],
            ['Alt+W', '整页'],
            ['Alt+I', '输入框'],
            ['Alt+S', '工作台'],
          ].map(([key, label]) => el('span', {}, el('kbd', { text: key }), label)),
        ),
        el('p', { class: 'hint', text: '快捷键可在 Edge 扩展快捷键页调整。' }),
      ),
      aiLayoutSettings(),
      group(
        '划词对照服务',
        '划词翻译时，同时查看所选服务的译文。',
        el(
          'div',
          { class: 'choice-set comparison-services' },
          ...comparisonProfiles.map((profile) => {
            const input = el('input', {
              type: 'checkbox',
              name: 'comparison-' + profile.id,
              'aria-label': profile.name,
              checked: settings.comparisonProfiles.includes(profile.id),
            });
            input.onchange = () => {
              settings.comparisonProfiles = input.checked
                ? [...new Set([...settings.comparisonProfiles, profile.id])]
                : settings.comparisonProfiles.filter((id) => id !== profile.id);
              dirty();
            };
            return el(
              'label',
              { class: 'check', title: profile.name },
              input,
              el('span', { text: profile.name }),
            );
          }),
        ),
        !comparisonProfiles.length &&
          el('p', {
            class: 'hint',
            text: '先在“服务与模型”中添加并启用文本服务，再选择对照服务。',
          }),
      ),
    ),
  );
  refresh();
}

function renderMedia() {
  main.replaceChildren(
    header('图片与字幕', '分别调整图片处理、视频字幕和实时语音的显示方式。'),
    el(
      'div',
      { class: 'settings-sections' },
      group(
        '图片翻译',
        '控制输入尺寸、处理速度与译文绘制效果。',
        el(
          'div',
          { class: 'grid-two' },
          field('图片最长输入边', numberFor(settings, 'imageMaxEdge', 600, 4096)),
          field('长图分片高度', numberFor(settings, 'imageTileHeight', 600, 4096)),
          field('批量图片并发', numberFor(settings, 'imageConcurrency', 1, 5)),
          field(
            '图片文字绘制',
            selectFor(settings, 'imageRender', [
              ['cover', '采样底色覆盖'],
              ['overlay', '半透明底色覆盖'],
            ]),
          ),
          field('图片译文字体', inputFor(settings, 'imageFont')),
        ),
        el('p', {
          class: 'hint',
          text: '图片输出根据模型返回的区域坐标覆盖译文。复杂纹理去字、竖排与漫画气泡效果需要按实际模型验证。',
        }),
      ),
      group(
        '视频字幕',
        '调整已有字幕的翻译与显示。',
        field('字幕字号', numberFor(settings, 'subtitleFontSize', 12, 48)),
        check(
          '提前翻译未来 90 秒字幕',
          settings,
          'subtitlePretranslate',
          undefined,
          '提前处理字幕轨道中后续 90 秒的内容，减少播放时的等待。',
        ),
        field(
          '网站字幕 CSS 选择器，选填',
          inputFor(settings, 'subtitleSelector'),
          '用于网站已有的可见字幕，例如会议平台。留空使用随包适配和字幕轨道。',
        ),
      ),
      group(
        '实时语音',
        '识别页面音频，再使用字幕服务翻译。',
        field(
          '实时语音识别片段长度，秒',
          numberFor(settings, 'asrChunkSeconds', 5, 60),
          '较短片段可减少等待，较长片段可以提供更多上下文。',
        ),
        el('div', {
          class: 'notice',
          text: '网页右键可以启动页面音频识别。浏览器会显示音频捕获状态。识别使用你配置的语音服务，文本翻译使用字幕服务。',
        }),
      ),
    ),
  );
}
function renderRules() {
  const terms = el('textarea', {
    rows: 9,
    name: 'glossary',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '例如 API<Tab>接口<Tab>example.com…',
  });
  terms.value = settings.glossary
    .map((term) => [term.source, term.target, term.domain || ''].join('\t'))
    .join('\n');
  terms.oninput = () => {
    settings.glossary = terms.value
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [source, target = '', domain = ''] = line.split('\t');
        return { source: source.trim(), target: target.trim(), domain: domain.trim() };
      });
    dirty();
  };
  const prompt = el('textarea', { rows: 5, name: 'global-prompt', autocomplete: 'off' });
  prompt.value = settings.prompt;
  prompt.oninput = () => {
    settings.prompt = prompt.value;
    dirty();
  };
  main.replaceChildren(
    header('站点与术语', '自动翻译规则、术语和补充指令保存在本地，按你的阅读习惯调整。'),
    el(
      'div',
      { class: 'settings-sections' },
      group(
        '网站翻译规则',
        '按网站决定是否自动翻译，排除规则优先。',
        el(
          'div',
          { class: 'grid-two' },
          linesField('总是翻译的网站', 'autoSites', '每行一个域名或 URL 通配模式。'),
          linesField('不翻译的网站', 'blockSites', '排除规则优先于自动翻译。'),
        ),
      ),
      group(
        '术语与翻译指令',
        '统一专有名词的译法，并补充你的翻译要求。',
        field('术语表', terms, '每行一条，字段之间用 Tab 分隔。可限定生效域名。'),
        field('全局补充翻译指令', prompt),
      ),
      group(
        '隐私遮蔽',
        '在内容发送给模型前替换敏感片段，译文返回后恢复。',
        check('发送模型前遮蔽邮箱和长数字', settings, 'maskPrivacy'),
        linesField(
          '额外遮蔽表达式',
          'privacyPatterns',
          '每行一个正则表达式。译文返回后恢复对应内容。',
        ),
      ),
      group(
        '高级站点适配',
        '仅在需要调整网页内容提取范围时修改。',
        disclosure(
          '编辑自定义站点提取规则',
          jsonField(
            '自定义站点提取规则',
            settings,
            'siteRules',
            'global',
            '数组项支持 matches、selectors 和 excludeSelectors。',
          ),
        ),
      ),
    ),
  );
}
async function renderData() {
  const output = el('pre', {
    class: 'code-output',
    tabindex: '0',
    'aria-label': '诊断记录内容',
    text: '读取诊断后可按页面筛选，记录包含请求、切换、提醒和扫描统计。',
  });
  const localStatus = el('div', {
    class: 'status data-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const logPage = el(
    'select',
    { name: 'diagnostic-page', 'aria-label': '诊断页面' },
    el('option', { value: '' }, '全部页面'),
  );
  let diagnosticRecords = [];
  const selectedLogs = () =>
    diagnosticRecords.filter((entry) => !logPage.value || entry.page === logPage.value);
  const readLogs = async () => {
    diagnosticRecords = await rpc('logs');
    const selectedPage = logPage.value;
    const pages = new Map(
      diagnosticRecords
        .filter((entry) => entry.page)
        .map((entry) => [entry.page, `${entry.site || '扩展内部'} / ${entry.page.slice(0, 12)}`]),
    );
    logPage.replaceChildren(
      el('option', { value: '' }, '全部页面'),
      ...[...pages].map(([value, label]) => el('option', { value }, label)),
    );
    logPage.value = pages.has(selectedPage) ? selectedPage : '';
    output.textContent = JSON.stringify(selectedLogs(), null, 2);
    status(localStatus, `显示 ${selectedLogs().length} 条，已保存 ${diagnosticRecords.length} 条`);
  };
  logPage.onchange = () => {
    output.textContent = JSON.stringify(selectedLogs(), null, 2);
    status(localStatus, `显示 ${selectedLogs().length} 条，已保存 ${diagnosticRecords.length} 条`);
  };
  const secrets = el('input', {
    type: 'checkbox',
    name: 'include-secrets',
    'aria-label': '导出配置时包含密钥',
    'aria-describedby': 'export-secrets-hint',
  });
  const file = el('input', {
    type: 'file',
    name: 'import-settings',
    accept: '.json,application/json',
  });
  file.onchange = async () => {
    try {
      if (!file.files[0]) return;
      const raw = JSON.parse(await file.files[0].text());
      settings = await rpc('import-settings', { settings: raw.config || raw });
      selected = settings.profiles[0]?.id;
      invalid.clear();
      jsonDrafts.clear();
      hasChanges = false;
      applyTheme(settings);
      render();
      status(notice, '配置已导入并保存');
    } catch (error) {
      status(localStatus, error.message, true);
    }
  };
  main.replaceChildren(
    header('数据与诊断', '随时带走配置、清理缓存，按操作记录定位接口问题。'),
    el(
      'div',
      { class: 'settings-sections' },
      localStatus,
      group(
        '翻译缓存与并发',
        '复用已有译文，并控制扩展同时发出的请求数。',
        check(
          '启用本地翻译缓存',
          settings,
          'cache',
          undefined,
          '相同内容优先使用本机保存的译文，减少重复请求。',
        ),
        el(
          'div',
          { class: 'grid-three' },
          field('缓存有效天数，0 为持续保留', numberFor(settings, 'cacheDays', 0, 365)),
          field('缓存条目上限', numberFor(settings, 'cacheEntries', 100, 50000)),
          field('总体请求并发', numberFor(settings, 'maxConcurrent', 1, 12)),
        ),
        el(
          'div',
          { class: 'button-row' },
          el('button', {
            text: '查看缓存数量',
            onclick: async () => {
              try {
                status(localStatus, `缓存 ${(await rpc('cache-stats')).entries} 条`);
              } catch (error) {
                status(localStatus, error.message, true);
              }
            },
          }),
          el('button', {
            text: '清空翻译缓存',
            onclick: async () => {
              if (!confirm('清空全部翻译缓存？之后遇到相同内容会重新请求翻译。')) return;
              try {
                await rpc('clear-cache');
                status(localStatus, '缓存已清空');
              } catch (error) {
                status(localStatus, error.message, true);
              }
            },
          }),
        ),
      ),
      group(
        '配置备份与迁移',
        '导出配置备份，或从本项目和旧扩展导入 JSON。',
        el(
          'label',
          { class: 'check' },
          el(
            'span',
            { class: 'check-copy' },
            el('span', { text: '导出配置时包含密钥' }),
            el('span', {
              class: 'hint',
              id: 'export-secrets-hint',
              text: '默认隐藏密钥。包含密钥的配置文件请妥善保管。',
            }),
          ),
          secrets,
        ),
        el('button', {
          text: '导出配置',
          onclick: async () => {
            try {
              if (!(await save())) return;
              const data = await rpc('export-settings', { includeSecrets: secrets.checked });
              textFile(JSON.stringify(data, null, 2), 'O泡翻译-配置.json', 'application/json');
            } catch (error) {
              status(notice, error.message, true);
            }
          },
        }),
        field(
          '导入本项目或旧扩展 JSON 配置',
          file,
          '默认导出隐藏密钥，导入此类文件时保留同 ID 服务的现有凭据。旧版加密密钥需要重新填写。',
        ),
      ),
      group(
        '运行日志',
        '读取本地记录，按页面定位接口和翻译问题。',
        el('p', {
          class: 'hint',
          text: '日志保存在扩展本地，最多1000条、保留7天。自动记录服务ID、耗时、错误状态、切换和扫描原因统计。页面用站点和文档编号区分，正文、密钥、请求头及完整网址不写入日志。',
        }),
        field('诊断页面', logPage),
        el(
          'div',
          { class: 'button-row' },
          el('button', {
            text: '读取诊断记录',
            onclick: async () => {
              try {
                await readLogs();
              } catch (error) {
                output.textContent = error.message;
              }
            },
          }),
          el('button', {
            text: '导出诊断',
            onclick: async () => {
              try {
                await readLogs();
                textFile(
                  JSON.stringify(
                    {
                      version: chrome.runtime.getManifest().version,
                      exportedAt: new Date().toISOString(),
                      page: logPage.value,
                      entries: selectedLogs(),
                    },
                    null,
                    2,
                  ),
                  'O泡翻译-诊断.json',
                  'application/json',
                );
              } catch (error) {
                status(localStatus, error.message, true);
              }
            },
          }),
          el('button', {
            text: '清空全部诊断',
            onclick: async () => {
              if (!confirm('清空全部诊断记录？此操作无法撤销。')) return;
              try {
                await rpc('clear-logs');
                await readLogs();
                status(localStatus, '诊断记录已清空');
              } catch (error) {
                status(localStatus, error.message, true);
              }
            },
          }),
        ),
        output,
      ),
    ),
  );
}
function render() {
  main.dataset.section = currentSection;
  document.title = sections.find(([id]) => id === currentSection)[1] + ' · O泡翻译';
  for (const link of nav.querySelectorAll('[data-section]'))
    link.setAttribute('aria-current', link.dataset.section === currentSection ? 'page' : 'false');
  ({
    services: renderServices,
    reading: renderReading,
    media: renderMedia,
    rules: renderRules,
    data: renderData,
  })[currentSection]();
}
async function initialize() {
  settings = await rpc('get-settings');
  selected = settings.profiles[0]?.id;
  applyTheme(settings);
  const selectSection = () => {
    const hash = location.hash.slice(1);
    currentSection = sections.some(([id]) => id === hash) ? hash : 'services';
    render();
  };
  window.addEventListener('hashchange', () => {
    selectSection();
    window.scrollTo(0, 0);
    main.querySelector('h1').focus({ preventScroll: true });
  });
  window.addEventListener('beforeunload', (event) => {
    if (hasChanges) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  systemTheme.addEventListener('change', () => applyTheme(settings));
  nav.append(
    el('p', { class: 'nav-caption', text: '设置' }),
    ...sections.map(([section, label]) =>
      el('a', {
        'data-section': section,
        href: '#' + section,
        text: label,
      }),
    ),
    el('p', {
      class: 'sidebar-footer hint',
      text: 'O泡翻译 ' + chrome.runtime.getManifest().version + '\n配置保存在本机',
    }),
  );
  root.append(
    el('a', {
      class: 'skip-link',
      href: '#settings-main',
      text: '跳到设置内容',
      onclick: (event) => {
        event.preventDefault();
        main.focus();
      },
    }),
    el(
      'header',
      { class: 'app-header' },
      el(
        'a',
        { class: 'brand', href: 'settings.html' },
        el('img', { src: 'logo.svg', alt: '', width: 42, height: 42 }),
        el(
          'div',
          {},
          el('div', { class: 'brand-name', text: 'O泡翻译', translate: 'no' }),
          el('small', { text: '翻译偏好，按你的习惯' }),
        ),
      ),
      el(
        'div',
        { class: 'header-actions' },
        notice,
        el(
          'div',
          { class: 'row' },
          el('button', { text: '打开工作台', onclick: () => rpc('open-workspace') }),
          el('button', { class: 'primary', text: '保存设置', id: 'save-settings', onclick: save }),
        ),
      ),
    ),
    el('div', { class: 'settings-layout' }, nav, main),
  );
  selectSection();
}
initialize().catch((error) =>
  root.replaceChildren(el('div', { class: 'empty', text: error.message })),
);
