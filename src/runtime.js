import { runJob, cancelJob, safeError } from './engine/service.js';
import { captureStatus, startCapture, stopCapture } from './engine/capture.js';

let active = 0;
setInterval(() => {
  if (active || captureStatus())
    chrome.runtime.sendMessage({ channel: 'opao-internal', kind: 'heartbeat' }).catch(() => {});
}, 20000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.channel !== 'opao-runtime') return false;
  const allowed =
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!allowed) {
    sendResponse({ ok: false, error: '运行时消息来源无效' });
    return false;
  }
  const emit = (data) =>
    chrome.runtime
      .sendMessage({
        channel: 'opao-internal',
        kind: 'progress',
        owner: message.owner,
        jobId: message.payload?.jobId,
        data,
        progressToken: message.payload?.progressToken,
      })
      .catch(() => {});
  active++;
  (async () => {
    const { payload, settings, owner } = message;
    if (payload.kind === 'ping') return 'pong';
    if (payload.kind === 'cancel') return cancelJob(payload.jobId, owner);
    if (payload.kind === 'capture-status') return captureStatus();
    if (payload.kind === 'stop-capture') return stopCapture(payload.discard);
    if (payload.kind === 'start-capture') return startCapture(settings, payload, emit);
    return runJob(settings, payload, owner, emit);
  })()
    .then(
      (data) => sendResponse({ ok: true, data }),
      (error) =>
        sendResponse({
          ok: false,
          error: safeError(error, message.settings || { profiles: [] }),
          code: error.code,
          status: error.status,
        }),
    )
    .finally(() => {
      active--;
    });
  return true;
});
