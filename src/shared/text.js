export function splitText(text, limit = 4000) {
  const parts = [];
  let remaining = String(text);
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    const boundary = Math.max(
      prefix.lastIndexOf('\n'),
      prefix.lastIndexOf('. '),
      prefix.lastIndexOf('。'),
      prefix.lastIndexOf('! '),
      prefix.lastIndexOf('? '),
    );
    let end = boundary > limit * 0.4 ? boundary + 1 : limit;
    const open = prefix.lastIndexOf('{{OPAO');
    if (open >= 0 && !prefix.slice(open, end).includes('}}')) end = open;
    if (end === 0) end = limit;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
export function parseJsonText(text) {
  const value = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(value);
  } catch {}
  const firstObject = value.indexOf('{');
  const firstArray = value.indexOf('[');
  const first =
    firstObject < 0 ? firstArray : firstArray < 0 ? firstObject : Math.min(firstObject, firstArray);
  const last = value[first] === '[' ? value.lastIndexOf(']') : value.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(value.slice(first, last + 1));
  throw new Error('模型返回的结构无法解析，可改用普通模式或检查提示词');
}
export function validateTokens(source, translated) {
  const tokens = (value) => {
    const counts = new Map();
    for (const token of value.match(/\{\{OPAO[^{}]+\}\}/g) || [])
      counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  };
  const expected = tokens(source);
  const actual = tokens(translated);
  if (
    expected.size !== actual.size ||
    [...expected].some(([token, count]) => actual.get(token) !== count)
  )
    throw new Error('接口改变了格式或隐私占位符，请重试或改用其他模型');
}
export function joinTranslatedParts(parts, language) {
  const useSpaces = !/^(zh|ja|ko|th|lo|km|my)(-|$)/i.test(language);
  return parts.reduce((result, part) => {
    const separator = useSpaces && /[.!?]$/.test(result) && /^[\p{L}\p{N}]/u.test(part) ? ' ' : '';
    return result + separator + part;
  }, '');
}
export function parseTranslations(text, items) {
  const parsed = parseJsonText(text);
  const results = Array.isArray(parsed)
    ? parsed
    : parsed.translations || parsed.items || parsed.results;
  if (!Array.isArray(results)) throw new Error('模型响应需要包含 translations 数组');
  const byId = new Map();
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const value = item.text ?? item.translation ?? item.translated;
    if (typeof value === 'string') byId.set(String(item.id), value);
  }
  return items.map((item) => {
    if (!byId.has(String(item.id)))
      throw new Error(`模型漏掉了段落 ${item.id}，请减小批量大小后重试`);
    if (item.text.trim() && !byId.get(String(item.id)).trim())
      throw new Error(`模型为段落 ${item.id} 返回了空译文，请重试`);
    return { id: String(item.id), text: byId.get(String(item.id)) };
  });
}
export function maskText(text, enabled, patterns = []) {
  const replacements = [];
  if (!enabled) return { text, restore: (value) => value };
  const rules = [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, /\b(?:\+?\d[\d ()-]{7,}\d)\b/g];
  for (const pattern of patterns) {
    try {
      rules.push(new RegExp(pattern, 'g'));
    } catch {
      throw new Error('隐私遮蔽表达式无效');
    }
  }
  let masked = text;
  for (const rule of rules)
    masked = masked.replace(rule, (match) => {
      const token = `{{OPAOPRIV${replacements.length}}}`;
      replacements.push({ token, match });
      return token;
    });
  return {
    text: masked,
    restore(value) {
      let restored = value;
      for (const { token, match } of replacements) restored = restored.replaceAll(token, match);
      return restored;
    },
  };
}
export function normalizeBoxes(blocks, width, height) {
  if (!Array.isArray(blocks)) throw new Error('视觉模型响应需要包含 blocks 数组');
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return null;
      const box = block.box || block.bbox;
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every((value) => Number.isFinite(Number(value)))
      )
        return null;
      let [x, y, w, h] = box.map(Number);
      const units = block.units || 'normalized';
      if (units === '1000') {
        x /= 1000;
        y /= 1000;
        w /= 1000;
        h /= 1000;
      } else if (units === 'pixels') {
        x /= width;
        w /= width;
        y /= height;
        h /= height;
      }
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x >= 1 || y >= 1 || w > 1.02 || h > 1.02)
        return null;
      return {
        x: Math.round(x * width),
        y: Math.round(y * height),
        w: Math.max(1, Math.round(Math.min(w, 1 - x) * width)),
        h: Math.max(1, Math.round(Math.min(h, 1 - y) * height)),
        text: String(block.text || ''),
        translation: String(block.translation || block.translated || ''),
        direction: block.direction === 'vertical' ? 'vertical' : 'horizontal',
      };
    })
    .filter((block) => block && block.translation.trim());
}
