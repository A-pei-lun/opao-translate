// Owns only the generated target. Cancelling a task also cancels every delayed
// write, so restore/navigation cannot resurrect stale preview or final content.
export class StreamView {
  constructor(target) {
    this.target = target;
    this.animations = new Set();
    this.revision = 0;
  }
  clear() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = null;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.target.style.removeProperty('min-height');
  }
  reset() {
    this.clear();
    this.preview = null;
    this.latest = '';
    this.target.replaceChildren(document.createTextNode('正在翻译…'));
    this.target.dataset.state = 'pending';
  }
  show(text) {
    if (this.disposed || !this.target.isConnected) return;
    if (!text) { this.reset(); return; }
    this.latest = text;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 40);
  }
  flush() {
    if (this.disposed || !this.target.isConnected || !this.latest) return;
    if (!this.preview) {
      this.preview = document.createElement('span');
      this.preview.className = 'opao-stream-preview';
      this.target.replaceChildren(this.preview);
    }
    this.preview.textContent = this.latest;
    this.target.dataset.state = 'streaming';
  }
  async animate(node, frames, options) {
    const animation = node.animate(frames, options);
    this.animations.add(animation);
    try { await animation.finished; } catch { /* Cancellation belongs to the caller. */ }
    finally { this.animations.delete(animation); }
  }
  async finish(fragment) {
    if (this.disposed || !this.target.isConnected) return false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.preview || this.latest) this.latest = fragment.textContent;
    this.flush();
    const revision = this.revision;
    const current = () => !this.disposed && this.revision === revision && this.target.isConnected;
    const animate = this.preview && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = this.target.getBoundingClientRect().height;
    if (animate) {
      this.target.dataset.state = 'settling';
      this.target.style.minHeight = before + 'px';
      await this.animate(this.preview, [{ opacity:1 }, { opacity:0 }],
        { duration:120, easing:'ease-out', fill:'forwards' });
      if (!current()) return false;
    }
    this.target.replaceChildren(fragment);
    this.preview = null;
    this.target.style.removeProperty('min-height');
    this.target.dataset.state = 'rendering';
    if (animate) {
      const after = this.target.getBoundingClientRect().height;
      const opacity = getComputedStyle(this.target).opacity;
      await this.animate(this.target,
        [{ opacity:0, transform:'translateY(4px)', height:before + 'px' },
          { opacity, transform:'none', height:after + 'px' }],
        { duration:220, easing:'cubic-bezier(.2,.7,.2,1)' });
      if (!current()) return false;
    }
    this.target.dataset.state = 'done';
    return true;
  }
  dispose() {
    this.disposed = true;
    this.clear();
  }
}
