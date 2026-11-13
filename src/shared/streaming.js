// Incremental JSON string decoding for translation previews. Final output still
// goes through parseTranslations and validateTokens before becoming rich DOM.
export class TranslationStreamParser {
  constructor(ids) {
    this.ids = new Set(ids.map(String));
    this.stack = [];
    this.started = false;
    this.disabled = false;
    this.string = null;
    this.primitive = '';
    this.items = new Set();
    this.last = new Map();
  }
  value(value) {
    const context = this.stack.at(-1);
    if (!context || context.type !== 'object') return;
    if (context.state === 'key') {
      context.key = value;
      context.state = 'colon';
    } else if (context.state === 'value') {
      if (context.role === 'item') {
        if (context.key === 'id') context.id = String(value);
        if (['text', 'translation', 'translated'].includes(context.key) && typeof value === 'string')
          context.text = value;
      }
      context.state = 'comma';
    }
  }
  feed(delta) {
    if (this.disabled) return [];
    for (const character of delta) {
      if (this.string) {
        const token = this.string;
        if (token.unicode !== null) {
          if (!/[\da-f]/i.test(character)) { this.disabled = true; break; }
          token.unicode += character;
          if (token.unicode.length === 4) {
            token.value += String.fromCharCode(parseInt(token.unicode, 16));
            token.unicode = null;
          }
        } else if (token.escape) {
          token.escape = false;
          if (character === 'u') token.unicode = '';
          else if (Object.hasOwn({ '"':1, '\\':1, '/':1, b:1, f:1, n:1, r:1, t:1 }, character))
            token.value += ({ b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' })[character] ?? character;
          else { this.disabled = true; break; }
        } else if (character === '\\') token.escape = true;
        else if (character === '"') {
          this.string = null;
          this.value(token.value);
        } else token.value += character;
        if (token.preview) token.context.text = token.value;
        continue;
      }
      if (this.primitive) {
        if (!/[\s,\]}]/.test(character)) { this.primitive += character; continue; }
        try { this.value(JSON.parse(this.primitive)); } catch { this.disabled = true; break; }
        this.primitive = '';
      }
      if (!this.started) {
        if (character !== '{' && character !== '[') continue;
        this.started = true;
      }
      const context = this.stack.at(-1);
      if (character === '"') {
        this.string = { value:'', escape:false, unicode:null, context,
          preview:context?.role === 'item' && context.state === 'value' &&
            ['text', 'translation', 'translated'].includes(context.key) };
      } else if (character === '{' || character === '[') {
        const type = character === '{' ? 'object' : 'array';
        const role = !context ? (type === 'array' ? 'results' : 'root') :
          type === 'array' && context.role === 'root' && context.state === 'value' &&
          ['translations', 'items', 'results'].includes(context.key) ? 'results' :
          type === 'object' && context.role === 'results' ? 'item' : 'other';
        if (context?.type === 'object') context.state = 'comma';
        const entry = { type, role, state:type === 'object' ? 'key' : 'value' };
        this.stack.push(entry);
        if (role === 'item') this.items.add(entry);
      } else if (character === '}' || character === ']') this.stack.pop();
      else if (character === ':' && context?.type === 'object') context.state = 'value';
      else if (character === ',' && context?.type === 'object') context.state = 'key';
      else if (/[\d\-tfn]/.test(character) && context?.state === 'value') this.primitive = character;
    }
    const updates = [];
    for (const item of this.items) {
      if (!this.ids.has(item.id) || typeof item.text !== 'string') continue;
      if (this.last.get(item.id) === item.text) continue;
      this.last.set(item.id, item.text);
      updates.push({ id:item.id, text:item.text });
    }
    return updates;
  }
}

export function previewText(text) {
  let value = String(text).replace(/\{\{OPAO[^{}]*\}\}/g, '');
  const open = value.indexOf('{{OPAO');
  if (open >= 0) value = value.slice(0, open);
  // A marker's opening characters can themselves be split across SSE events.
  for (let length = 5; length > 0; length--)
    if (value.endsWith('{{OPAO'.slice(0, length))) {
      value = value.slice(0, -length);
      break;
    }
  return value.replace(/[\uD800-\uDBFF]$/, '');
}
