export function timeSeconds(value) {
  const parts = String(value).replace(',', '.').trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
export function timestamp(seconds, separator = ',') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}
export function parseSubtitle(source, extension = '') {
  const text = String(source)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (extension.toLowerCase() === 'ass' || /^\[Script Info\]/m.test(text)) return parseAss(text);
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const match = lines[index].match(
      /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})(.*)/,
    );
    if (!match) continue;
    const start = timeSeconds(match[1]),
      end = timeSeconds(match[2]);
    if (end <= start) continue;
    cues.push({
      id: String(cues.length),
      start,
      end,
      text: lines.slice(index + 1).join('\n'),
      settings: match[3].trim(),
      label: index ? lines[index - 1] : '',
    });
  }
  return {
    type: text.startsWith('WEBVTT') || extension === 'vtt' ? 'vtt' : 'srt',
    cues,
    source: text,
  };
}
function parseAss(text) {
  const lines = text.split('\n');
  let fields = [
    'Layer',
    'Start',
    'End',
    'Style',
    'Name',
    'MarginL',
    'MarginR',
    'MarginV',
    'Effect',
    'Text',
  ];
  let events = false;
  const cues = [];
  lines.forEach((line, lineIndex) => {
    if (line.startsWith('[')) events = line.trim().toLowerCase() === '[events]';
    if (!events) return;
    if (/^Format:/i.test(line))
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim());
    if (!/^Dialogue:/i.test(line)) return;
    const raw = line.slice(line.indexOf(':') + 1).trimStart();
    const pieces = raw.split(',');
    const values = pieces.slice(0, fields.length - 1);
    values.push(pieces.slice(fields.length - 1).join(','));
    const get = (key) =>
      values[fields.findIndex((field) => field.toLowerCase() === key.toLowerCase())];
    cues.push({
      id: String(cues.length),
      start: timeSeconds(get('Start')),
      end: timeSeconds(get('End')),
      text: (get('Text') || '').replace(/\\[Nn]/g, '\n'),
      ass: { lineIndex, fields: [...fields], values },
    });
  });
  return { type: 'ass', cues, source: text, lines };
}
export function subtitleText(cue) {
  return cue.text
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}
export function protectSubtitle(text) {
  const tags = [];
  const protectedText = text.replace(
    /\{[^}]*\}|<\/?(?:b|i|u|s|font|c|v|lang|ruby|rt)(?:\s[^>]*)?>/gi,
    (value) => {
      const token = `{{OPAOSUB${tags.length}}}`;
      tags.push(value);
      return token;
    },
  );
  return {
    text: protectedText,
    restore(value) {
      return value.replace(/\{\{OPAOSUB(\d+)\}\}/g, (match, index) => tags[Number(index)] ?? match);
    },
  };
}
export function serializeSubtitle(document, mode = 'bilingual', format = document.type) {
  const display = (cue) =>
    mode === 'original'
      ? cue.text
      : mode === 'translation'
        ? cue.translation || cue.text
        : cue.translation && cue.translation !== cue.text
          ? cue.text + '\n' + cue.translation
          : cue.text;
  if (format === 'ass' && document.type === 'ass') {
    const lines = [...document.lines];
    for (const cue of document.cues) {
      const values = [...cue.ass.values];
      const index = cue.ass.fields.findIndex((field) => field.toLowerCase() === 'text');
      values[index] = display(cue).replaceAll('\n', '\\N');
      lines[cue.ass.lineIndex] = 'Dialogue: ' + values.join(',');
    }
    return lines.join('\n');
  }
  const vtt = format === 'vtt';
  return (
    (vtt ? 'WEBVTT\n\n' : '') +
    document.cues
      .map(
        (cue, index) =>
          `${vtt ? cue.label || String(index + 1) : index + 1}\n${timestamp(cue.start, vtt ? '.' : ',')} --> ${timestamp(cue.end, vtt ? '.' : ',')}${vtt && cue.settings ? ' ' + cue.settings : ''}\n${display(cue)}`,
      )
      .join('\n\n') +
    '\n'
  );
}
export function parseCaptionPayload(source) {
  const text = String(source || '').trim();
  if (/WEBVTT|\d{2}:\d{2}.*-->/.test(text.slice(0, 2000))) return parseSubtitle(text).cues;
  if (!text.startsWith('{')) return [];
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload.events))
      return payload.events
        .filter((event) => event.segs && event.dDurationMs > 0)
        .map((event, index) => ({
          id: String(index),
          start: event.tStartMs / 1000,
          end: (event.tStartMs + event.dDurationMs) / 1000,
          text: event.segs.map((segment) => segment.utf8 || '').join(''),
        }))
        .filter((cue) => cue.text.trim());
    if (Array.isArray(payload.body))
      return payload.body.map((cue, index) => ({
        id: String(index),
        start: Number(cue.from),
        end: Number(cue.to),
        text: cue.content || '',
      }));
  } catch {}
  return [];
}
