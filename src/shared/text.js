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
const translationText = (item) => item?.text ?? item?.translation ?? item?.translated;
const translationId = (id) => (typeof id === 'string' || typeof id === 'number' ? String(id) : '');
function normalizeTranslationId(id) {
  const normalized = id.trim()
    .replace(/[\uFF10-\uFF19]/g, (digit) => digit.normalize('NFKC'))
    .replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-')
    .replace(/\s*-\s*/g, '-');
  return /^\d+-\d+$/.test(normalized) ? normalized : id.trim();
}

export function validateTranslationItems(results, items, allowAnonymous = false) {
  const translations = [];
  const failures = [];
  const actualIds = [];
  const issues = new Set();
  const expected = new Set(items.map((item) => String(item.id)));
  const aliases = new Map();
  const byId = new Map();
  for (const id of expected) {
    const alias = normalizeTranslationId(id);
    aliases.set(alias, aliases.has(alias) ? null : id);
  }
  if (!Array.isArray(results)) issues.add('invalid-format');
  for (const item of Array.isArray(results) ? results : []) {
    const object = item && typeof item === 'object' && !Array.isArray(item);
    const explicit = object && Object.hasOwn(item, 'id');
    const rawId = explicit ? translationId(item.id) : '';
    const text = typeof item === 'string' ? item : translationText(item);
    if (explicit) actualIds.push(rawId);
    let id = expected.has(rawId) ? rawId : aliases.get(normalizeTranslationId(rawId));
    if (!explicit) {
      issues.add('missing-id');
      if (allowAnonymous && items.length === 1 && results.length === 1)
        id = String(items[0].id);
    } else if (!id) issues.add(rawId ? 'unknown-id' : 'invalid-id');
    else if (id !== rawId) issues.add('normalized-id');
    if (!id) continue;
    const candidates = byId.get(id) || [];
    candidates.push(text);
    byId.set(id, candidates);
  }
  for (const item of items) {
    const id = String(item.id);
    const candidates = byId.get(id);
    const text = candidates?.[0];
    let reason;
    if (!candidates) reason = issues.has('invalid-format') ? 'invalid-format' : 'missing-id';
    else if (candidates.length > 1) reason = 'duplicate-id';
    else if (typeof text !== 'string') reason = 'invalid-translation';
    else if (item.text.trim() && !text.trim()) reason = 'empty-translation';
    else {
      try {
        validateTokens(item.text, text);
      } catch {
        reason = 'invalid-placeholders';
      }
    }
    if (reason) {
      issues.add(reason);
      failures.push({ id, reason });
    } else translations.push({ id, text });
  }
  return { translations, failures, actualIds, issues: [...issues] };
}

function containsTranslationId(value) {
  return /(?:^|[\n\r>])\s*[\d\uFF10-\uFF19]+\s*[-\u2010-\u2015\u2212\uFF0D]\s*[\d\uFF10-\uFF19]+\s*[:.=\uFF1A]|["']?\bid["']?\s*[:=\uFF1A]|<\s*\/?\s*id\b/i.test(value);
}

function countIdFields(value, limit = 2) {
  let count = 0;
  const pending = [value];
  while (pending.length && count < limit) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Object.hasOwn(item, 'id')) count++;
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return count;
}

export function parseTranslations(text, items) {
  let parsed;
  try {
    parsed = parseJsonText(text);
  } catch {
    if (items.length === 1) {
      const bare = text.trim()
        .replace(/^\x60{3}(?:text|txt)?[ \t]*\r?\n([\s\S]+)\r?\n\x60{3}$/, '$1')
        .replace(/^<(text|translation)>([\s\S]+)<\/\1>$/i, '$2').trim();
      if (!/^(?:[\["\x60<]|\{(?!\{OPAO))/u.test(bare) && !containsTranslationId(bare)) parsed = bare;
    }
  }
  let results = Array.isArray(parsed) ? parsed :
    parsed?.translations ?? parsed?.items ?? parsed?.results;
  if (items.length === 1 && results === undefined &&
      (typeof parsed === 'string' || typeof translationText(parsed) === 'string'))
    results = [parsed];
  let allowAnonymous = false;
  if (items.length === 1 && Array.isArray(results) && results.length === 1) {
    const item = results[0];
    const value = typeof item === 'string' ? item : translationText(item);
    allowAnonymous = typeof value === 'string' && !containsTranslationId(text) && countIdFields(parsed) === 0;
  }
  return validateTranslationItems(results, items, allowAnonymous);
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
