export const TRANSLATION_STYLES = [
  ['muted', '弱化'],
  ['plain', '跟随原文'],
  ['line', '侧边细线'],
  ['soft', '浅底色'],
  ['underline', '下划线'],
  ['dashed', '虚线下划线'],
  ['highlight', '高亮'],
  ['italic', '斜体'],
];
export const FONT_PRESETS = [
  ['', '跟随网页字体'],
  ['Microsoft YaHei', '微软雅黑'],
  ['DengXian', '等线'],
  ['SimSun', '宋体'],
  ['KaiTi', '楷体'],
  ['FangSong', '仿宋'],
  ['Arial', 'Arial'],
  ['Georgia', 'Georgia'],
  ['system-ui', '系统界面字体'],
  ['serif', '系统衬线字体'],
];
export function cleanFontFamily(value) {
  if (typeof value !== 'string' || /[;{}<>\r\n\\]/.test(value)) return '';
  return value.trim().slice(0, 180);
}
export function normalizeFloatingPosition(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.y))
    return null;
  return {
    side: ['left', 'right'].includes(value.side) ? value.side : null,
    x: Math.min(1, Math.max(0, value.x)),
    y: Math.min(1, Math.max(0, value.y)),
  };
}
export const translationCss = `
.opao-target {
  display: block !important;
  position: static !important;
  float: none !important;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  flex: 0 0 100%;
  grid-column: 1/-1;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-align: inherit;
  text-indent: inherit;
  line-height: var(--opao-line-height, 1.8);
  margin: var(--opao-gap, 0.65em) 0 0.75em;
  color: var(--opao-color, inherit);
  font-size: var(--opao-size, 100%);
  font-family: var(--opao-font, inherit);
  font-weight: var(--opao-weight, inherit);
  font-style: inherit;
  text-decoration: none;
  opacity: 1;
}
.opao-target[data-style="muted"]:not([data-custom-color]) {
  opacity: 0.76;
}
.opao-target[data-style="line"] {
  border-inline-start: 2px solid #278b98;
  padding-inline-start: 0.8em;
}
.opao-target[data-style="soft"] {
  background: color-mix(in srgb, currentColor 6%, transparent);
  padding: 0.5em 0.7em;
  border-radius: 6px;
}
.opao-target[data-style="underline"] {
  text-decoration: underline;
  text-underline-offset: 0.25em;
  text-decoration-thickness: 1px;
  text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
}
.opao-target[data-style="dashed"] {
  text-decoration: underline dashed;
  text-underline-offset: 0.3em;
  text-decoration-thickness: 1px;
  text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
}
.opao-target[data-style="highlight"] {
  background: color-mix(in srgb, #d9aa35 18%, transparent);
  padding: 0.2em 0.4em;
  box-decoration-break: clone;
  border-radius: 3px;
}
.opao-target[data-style="italic"] {
  font-style: italic;
}
.opao-target[data-custom-font]
  :is(a, b, strong, em, i, u, s, span, small, mark, sub, sup, ruby, rt):not(
    code *,
    kbd *,
    pre *,
    math *,
    svg *,
    mjx-container *
  ) {
  font-family: var(--opao-font) !important;
}
.opao-target[data-state="pending"] {
  opacity: 0.6;
}
.opao-target[data-layout="navigation"] {
  margin: min(var(--opao-gap, 0.65em), 0.25em) 0 0;
}
.opao-target[data-state="error"] {
  color: #b42335;
}
.opao-target.opao-masked:not(:hover) {
  filter: blur(5px);
  user-select: none;
}
.opao-target button {
  font: inherit;
  padding: 0.1em 0.5em;
  margin-inline-start: 0.6em;
  cursor: pointer;
}
.opao-target[dir="rtl"] {
  text-align: right;
}
.opao-source {
  display: contents;
}
.opao-source.opao-source-hidden {
  display: none !important;
}
[data-opao-paragraph] {
  display: block;
}
[data-opao-paragraph][data-opao-paired] + br:has(+ br),
[data-opao-paragraph][data-opao-paired] + br + br {
  display: none;
}
`;
export function applyTranslationAppearance(target, settings) {
  target.dataset.style = TRANSLATION_STYLES.some(([id]) => id === settings.translationStyle)
    ? settings.translationStyle
    : 'muted';
  target.style.setProperty('--opao-size', (settings.textSize || 100) + '%');
  target.style.setProperty('font-size', (settings.textSize || 100) + '%', 'important');
  target.style.setProperty(
    'line-height',
    String(settings.translationLineHeight || 1.8),
    'important',
  );
  target.style.setProperty('--opao-line-height', String(settings.translationLineHeight || 1.8));
  target.style.setProperty('--opao-gap', (settings.translationParagraphGap ?? 0.65) + 'em');
  const font = cleanFontFamily(settings.translationFont);
  target.style.setProperty('font-family', font || 'inherit', 'important');
  if (font) {
    target.style.setProperty('--opao-font', font);
    target.dataset.customFont = 'true';
  } else {
    target.style.removeProperty('--opao-font');
    delete target.dataset.customFont;
  }
  if (settings.translationColor) {
    target.style.setProperty('--opao-color', settings.translationColor);
    target.dataset.customColor = 'true';
  } else {
    target.style.removeProperty('--opao-color');
    delete target.dataset.customColor;
  }
  if (settings.translationFontWeight && settings.translationFontWeight !== 'inherit')
    target.style.setProperty('--opao-weight', settings.translationFontWeight);
  else target.style.removeProperty('--opao-weight');
}
