import { parseCaptionPayload, subtitleText, serializeSubtitle } from '../shared/subtitles.js';
import { translateItems, rpc, jobId, textFile } from '../shared/client.js';

function ttmlTime(value, frameRate, tickRate) {
  if (!value) return NaN;
  const suffix = value.match(/^([\d.]+)(ms|s|m|h|f|t)$/);
  if (suffix)
    return (
      Number(suffix[1]) *
      { ms: 0.001, s: 1, m: 60, h: 3600, f: 1 / frameRate, t: 1 / tickRate }[suffix[2]]
    );
  const values = value.replace(',', '.').split(':').map(Number);
  if (values.length === 4)
    return values[0] * 3600 + values[1] * 60 + values[2] + values[3] / frameRate;
  return values.reduce((total, part) => total * 60 + part, 0);
}
function parseXml(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) return [];
  const root = document.documentElement;
  const frameRate = Number(root.getAttribute('ttp:frameRate')) || 30;
  const tickRate = Number(root.getAttribute('ttp:tickRate')) || 1000;
  const nodes = [
    ...document.getElementsByTagName('text'),
    ...document.getElementsByTagNameNS('*', 'p'),
  ];
  return nodes
    .map((node, index) => {
      let start, end;
      if (node.hasAttribute('t')) {
        start = Number(node.getAttribute('t')) / 1000;
        end = start + Number(node.getAttribute('d') || 3000) / 1000;
      } else if (node.hasAttribute('start')) {
        start = Number(node.getAttribute('start'));
        end = start + Number(node.getAttribute('dur') || 3);
      } else {
        start = ttmlTime(node.getAttribute('begin'), frameRate, tickRate);
        end = ttmlTime(node.getAttribute('end'), frameRate, tickRate);
        if (!Number.isFinite(end))
          end = start + (ttmlTime(node.getAttribute('dur'), frameRate, tickRate) || 3);
      }
      for (const br of [...node.getElementsByTagNameNS('*', 'br')])
        br.replaceWith(document.createTextNode('\n'));
      return { id: String(index), start, end, text: node.textContent.trim() };
    })
    .filter((cue) => Number.isFinite(cue.start) && cue.end > cue.start && cue.text);
}
const selectors =
  '.ytp-caption-segment,.player-timedtext-text-container,.dss-subtitle-renderer-line,.closed-caption-subtitle,[data-tid="closed-caption-text"],[jsname="dsyhDe"],[data-opao-caption],.vjs-text-track-cue';
export class CaptionController {
  constructor(settings, ui) {
    this.settings = settings;
    this.ui = ui;
    this.enabled = false;
    this.cues = [];
    this.cache = new Map();
    this.pending = new Map();
    this.jobs = new Set();
    this.tasks = new Set();
    this.trackModes = new Map();
    this.transcript = [];
    this.lastShown = '';
    this.lastErrorAt = 0;
    this.generation = 0;
    window.addEventListener('message', (event) => {
      if (
        event.source !== window ||
        event.data?.type !== 'opao-caption-source' ||
        typeof event.data.text !== 'string' ||
        event.data.text.length > 3000000
      )
        return;
      let cues = parseCaptionPayload(event.data.text);
      if (!cues.length && /^\s*</.test(event.data.text)) cues = parseXml(event.data.text);
      if (cues.length) {
        this.cues = cues;
        if (this.enabled) this.tick();
      }
    });
    this.timer = setInterval(() => {
      if (this.enabled) this.tick();
    }, 250);
  }
  update(settings) {
    this.generation++;
    this.stopJobs();
    this.settings = settings;
    this.cache.clear();
    this.lastErrorAt = 0;
    if (this.enabled) this.tick();
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.stopJobs();
      this.ui.showCaption('', '');
      for (const [track, mode] of this.trackModes) track.mode = mode;
      this.trackModes.clear();
    } else {
      this.ui.notify('双语字幕已开启，播放视频或启用网站原字幕');
      this.tick();
    }
    return { enabled: this.enabled };
  }
  stopJobs() {
    for (const id of this.jobs) rpc('cancel', { jobId: id }).catch(() => {});
    this.jobs.clear();
    this.pending.clear();
  }
  domText() {
    let nodes;
    try {
      nodes = document.querySelectorAll(this.settings.subtitleSelector || selectors);
    } catch {
      return '';
    }
    return [...nodes]
      .filter((node) => !node.closest('[data-opao-ui]') && node.getBoundingClientRect().height)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 10000);
  }
  ensure(cues) {
    const task = this.translateCues(cues);
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
    return task;
  }
  async translateCues(cues) {
    const needed = cues
      .filter((cue) => {
        const text = subtitleText(cue);
        return text && !this.cache.has(text) && !this.pending.has(text);
      })
      .slice(0, 30);
    if (!needed.length) return;
    const id = jobId();
    this.jobs.add(id);
    const generation = this.generation;
    for (const cue of needed) this.pending.set(subtitleText(cue), id);
    try {
      const translated = await translateItems(
        needed.map((cue, index) => ({ id: String(index), text: subtitleText(cue) })),
        {
          role: 'subtitle',
          jobId: id,
          sourceLanguage: this.settings.sourceLanguage,
          targetLanguage: this.settings.targetLanguage,
          domain: location.hostname,
        },
      );
      if (generation === this.generation)
        for (const item of translated)
          this.cache.set(subtitleText(needed[Number(item.id)]), item.text);
    } catch (error) {
      if (Date.now() - this.lastErrorAt > 15000) {
        this.ui.notify(error.message);
        this.lastErrorAt = Date.now();
      }
    } finally {
      this.jobs.delete(id);
      for (const cue of needed)
        if (this.pending.get(subtitleText(cue)) === id) this.pending.delete(subtitleText(cue));
    }
  }
  tick() {
    if (this.asrMode) return;
    const video =
      [...document.querySelectorAll('video,audio')].find((element) => !element.paused) ||
      document.querySelector('video');
    let current = '';
    if (video) {
      const tracks = [...video.textTracks].filter((track) =>
        ['captions', 'subtitles'].includes(track.kind),
      );
      const selected =
        tracks.find((track) => track.mode === 'showing') ||
        tracks.find((track) => track.language === this.settings.sourceLanguage) ||
        tracks[0];
      for (const track of selected ? [selected] : []) {
        if (!this.trackModes.has(track)) {
          this.trackModes.set(track, track.mode);
          if (track.mode === 'disabled') track.mode = 'hidden';
        }
        const active = [...(track.activeCues || [])];
        if (active.length) {
          current = active.map((cue) => cue.text).join('\n');
          break;
        }
      }
      if (!current && this.cues.length) {
        const active = this.cues.filter(
          (cue) => cue.start <= video.currentTime && cue.end > video.currentTime,
        );
        current = active.map(subtitleText).join('\n');
      }
      if (
        this.settings.subtitlePretranslate &&
        !video.paused &&
        Date.now() - this.lastErrorAt > 10000
      )
        this.ensure(
          this.cues.filter(
            (cue) => cue.start >= video.currentTime && cue.start < video.currentTime + 90,
          ),
        );
    }
    if (!current) current = this.domText();
    current = current.replace(/<[^>]+>/g, '').trim();
    if (!current) {
      this.ui.showCaption('', '');
      return;
    }
    if (current !== this.lastShown) {
      this.lastShown = current;
      if (!this.transcript.length || this.transcript.at(-1).text !== current)
        this.transcript.push({
          start: video?.currentTime || performance.now() / 1000,
          end: (video?.currentTime || performance.now() / 1000) + 3,
          text: current,
        });
    }
    this.ui.showCaption(current, this.cache.get(current) || '正在翻译…');
    if (!this.cache.has(current) && Date.now() - this.lastErrorAt > 10000)
      this.ensure([{ text: current }]);
  }
  async asrCue(cue) {
    this.asrMode = true;
    this.enabled = true;
    this.transcript.push(cue);
    this.ui.showCaption(cue.text, '正在翻译…');
    await this.ensure([cue]);
    if (this.asrMode) this.ui.showCaption(cue.text, this.cache.get(subtitleText(cue)) || '');
  }
  async export() {
    const cues = this.asrMode || !this.cues.length ? this.transcript : this.cues;
    if (!cues.length) throw new Error('当前尚未捕获字幕，请播放视频或开启页面字幕');
    this.ui.notify('正在整理字幕与译文…');
    await Promise.all([...this.tasks]);
    for (let index = 0; index < cues.length; index += 30)
      await this.ensure(cues.slice(index, index + 30));
    if (cues.some((cue) => subtitleText(cue) && !this.cache.has(subtitleText(cue))))
      throw new Error('部分字幕尚未翻译成功，请检查接口后重试导出');
    const output = cues.map((cue) => ({
      ...cue,
      translation: this.cache.get(subtitleText(cue)) || '',
    }));
    textFile(serializeSubtitle({ type: 'srt', cues: output }), 'O泡翻译-双语字幕.srt');
  }
}
