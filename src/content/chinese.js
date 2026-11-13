import { Converter } from 'opencc-js/t2cn';

let converter;
export function simplifyChinese(text) {
  converter ||= Converter({ from: 'tw', to: 'cn' });
  return converter(text);
}

export function simplifyChineseParts(parts) {
  const original = parts.join('');
  const converted = Array.from(simplifyChinese(original));
  let sourcePrefix = '', offset = 0;
  const sameLength = Array.from(original).length === converted.length;
  return parts.map((part, index) => {
    sourcePrefix += part;
    const end = index === parts.length - 1 ? converted.length :
      sameLength ? offset + Array.from(part).length :
        Math.min(converted.length, Math.max(offset, Array.from(simplifyChinese(sourcePrefix)).length));
    const result = converted.slice(offset, end).join('');
    offset = end;
    return result;
  });
}

// Language/script detection is deliberately local. It does not decide whether
// a product name or a UI label is worth translating.
export function chineseAction(text, settings, language = '') {
  const target = String(settings.targetLanguage || '').toLowerCase();
  if (!['zh', 'zh-cn', 'zh-sg', 'zh-hans', 'zh-hans-cn', 'zh-hans-sg'].includes(target))
    return 'translate';
  const source = settings.sourceLanguage === 'auto' ? language : settings.sourceLanguage;
  if (/^(ja|ko)(-|$)/i.test(source) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
    return 'translate';
  const content = text
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]+/gi, '')
    .replace(/\{\{OPAO[^}]*\}\}/g, '');
  const han = (content.match(/\p{Script=Han}/gu) || []).length;
  const words = (content.replace(/\p{Script=Han}/gu, ' ').match(/\p{L}+/gu) || []).length;
  if (!han || han < words) return 'translate';
  if (simplifyChinese(content) === content) return 'skip';
  return settings.replaceTraditionalChinese ? 'replace' : 'translate';
}
