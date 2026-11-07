import { parseSubtitle } from '../shared/subtitles.js';

export async function decodeAudio(file) {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('浏览器无法解码该音视频文件，请转为 MP3、WAV、M4A 或 WebM 后重试');
  } finally {
    await context.close();
  }
}
export function wavChunk(audio, start, duration, sampleRate = 16000) {
  const length = Math.max(0, Math.floor(Math.min(duration, audio.duration - start) * sampleRate));
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (position, value) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(position + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  for (let index = 0; index < length; index++) {
    const position = (start + index / sampleRate) * audio.sampleRate;
    const lower = Math.min(audio.length - 1, Math.floor(position));
    const upper = Math.min(audio.length - 1, lower + 1);
    const fraction = position - lower;
    let value = 0;
    for (const channel of channels)
      value += channel[lower] * (1 - fraction) + channel[upper] * fraction;
    value = Math.max(-1, Math.min(1, value / channels.length));
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
export function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export function transcriptCues(result, start, duration) {
  let cues;
  if (result.raw && ['srt', 'vtt'].includes(result.format))
    cues = parseSubtitle(result.raw, result.format).cues;
  else if (result.segments?.length) cues = result.segments;
  else cues = result.text ? [{ start: 0, end: duration, text: result.text }] : [];
  return cues
    .map((cue, index) => ({
      id: `${start}-${index}`,
      start: Number(cue.start) + start,
      end: Number(cue.end) + start,
      text: (cue.speaker ? '[' + cue.speaker + '] ' : '') + cue.text,
    }))
    .filter((cue) => cue.text.trim() && Number.isFinite(cue.start) && cue.end > cue.start);
}
