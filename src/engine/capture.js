import { resolveProfile } from '../shared/config.js';
import { parseSubtitle } from '../shared/subtitles.js';
import { runJob, cancelJob } from './service.js';

let current;
function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export function captureStatus() {
  return current
    ? { tabId: current.tabId, startedAt: current.startedAt, pending: current.pending.size }
    : null;
}
export async function startCapture(settings, payload, emit) {
  resolveProfile(settings, 'asr');
  if (current) throw new Error('已有页面正在识别音频，请先停止当前识别');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: payload.streamId } },
    video: false,
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);
  await audioContext.resume();
  const session = {
    tabId: payload.tabId,
    startedAt: Date.now(),
    pending: new Set(),
    stopped: false,
    stream,
    audioContext,
    source,
    timer: null,
    recorder: null,
    sequence: 0,
  };
  current = session;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  function record() {
    if (session.stopped) return;
    const chunks = [];
    const started = Date.now();
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    session.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      emit({ type: 'capture-error', error: '浏览器音频录制失败' });
      stopCapture();
    };
    recorder.onstop = async () => {
      clearTimeout(session.timer);
      const ended = Date.now();
      const blob = new Blob(chunks, { type: mime });
      if (!session.stopped) record();
      if (!blob.size) return;
      const id = crypto.randomUUID();
      session.pending.add(id);
      if (session.pending.size > 8) {
        emit({
          type: 'capture-error',
          error: '识别请求积压，录音已暂停，请检查接口速度后重新启动',
        });
        stopCapture();
      }
      try {
        const response = await runJob(
          settings,
          {
            kind: 'transcribe',
            jobId: id,
            dataUrl: await blobDataUrl(blob),
            filename: `capture-${session.sequence++}.webm`,
            language: settings.sourceLanguage,
          },
          'capture:' + payload.tabId,
        );
        const offset = (started - session.startedAt) / 1000;
        let cues =
          response.raw && ['srt', 'vtt'].includes(response.format)
            ? parseSubtitle(response.raw, response.format).cues
            : response.segments?.length
              ? response.segments
              : [{ start: 0, end: (ended - started) / 1000, text: response.text }];
        cues = cues
          .filter((cue) => cue.text?.trim())
          .map((cue) => ({
            start: Number(cue.start) + offset,
            end: Number(cue.end) + offset,
            text: cue.text.trim(),
          }));
        for (const cue of cues)
          emit({ type: 'capture-cue', cue, sessionStarted: session.startedAt });
      } catch (error) {
        if (!session.stopped) emit({ type: 'capture-error', error: error.message });
      } finally {
        session.pending.delete(id);
      }
    };
    recorder.start();
    session.timer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, settings.asrChunkSeconds * 1000);
  }
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    emit({ type: 'capture-stopped' });
    stopCapture();
  });
  record();
  return { started: true, tabId: payload.tabId };
}
export function stopCapture(discard = false) {
  const session = current;
  if (!session) return { stopped: true };
  current = null;
  session.stopped = true;
  clearTimeout(session.timer);
  if (session.recorder?.state === 'recording') session.recorder.stop();
  if (discard) for (const id of session.pending) cancelJob(id, 'capture:' + session.tabId);
  for (const track of session.stream.getTracks()) track.stop();
  session.source.disconnect();
  session.audioContext.close().catch(() => {});
  return { stopped: true, tabId: session.tabId };
}
