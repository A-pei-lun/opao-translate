import { el, rpc } from '../shared/client.js';
import { normalizeFloatingPosition } from '../shared/appearance.js';

export const floatingCss = `
.floating-dock {
  position: fixed;
  width: 46px;
  pointer-events: none;
  z-index: 3;
  transition:
    transform 0.16s ease,
    opacity 0.16s ease;
}
.floating-dock .floating {
  position: relative;
  inset: auto;
  display: block;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
}
.floating-dock .floating:hover {
  background: var(--brand);
  filter: brightness(1.07);
}
.floating-dock[data-side="right"].is-collapsed {
  transform: translateX(28px);
  opacity: 0.65;
}
.floating-dock[data-side="left"].is-collapsed {
  transform: translateX(-28px);
  opacity: 0.65;
}
.floating-dock.is-dragging {
  transition: none;
  opacity: 1;
}
.floating-dock:not(.is-pointer-focus):has(:focus-visible) {
  transform: none !important;
  opacity: 1;
}
.floating-actions {
  display: grid;
  margin-top: 8px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-5px);
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease,
    visibility 0s 0.16s;
}
.floating-dock.is-expanded .floating-actions {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition-delay: 0s;
  pointer-events: auto;
}
.floating-settings {
  width: 46px;
  min-height: 29px;
  padding: 2px 0;
  font-size: 12px;
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 2px 12px #0002;
}
.page-settings {
  position: fixed;
  z-index: 4;
  width: min(330px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 12px 42px #0003;
  pointer-events: auto;
}
.page-settings[hidden] {
  display: none;
}
.page-settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.page-settings-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
}
.page-settings label {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}
.page-settings select {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--paper);
  color: var(--ink);
  font-size: 14px;
}
.page-settings-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}
.page-settings .settings-result {
  min-height: 18px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.page-settings .settings-result.error {
  color: #b42335;
}
.page-settings .primary {
  width: 100%;
  min-height: 40px;
}
@media (prefers-reduced-motion: reduce) {
  .floating-dock,
  .floating-actions {
    transition: none !important;
  }
}
`;

export class FloatingDock {
  constructor(root, { translate, settings, move, notify }) {
    this.onTranslate = translate;
    this.onSettings = settings;
    this.onMove = move;
    this.notify = notify;
    this.position = { side: 'right', x: 1, y: 1 };
    this.revision = 0;
    this.saveSequence = 0;
    this.open = false;
    this.drag = null;
    this.destroyed = false;
    this.element = el('div', { class: 'floating-dock', 'data-side': 'right' });
    this.button = el('button', {
      class: 'floating',
      text: 'O',
      draggable: 'false',
      title: '点击切换双语，拖动调整位置，贴边自动收起',
      'aria-label': '切换网页双语翻译',
      'aria-describedby': 'opao-floating-help',
    });
    this.button.addEventListener('dragstart', (event) => event.preventDefault());
    this.help = el('span', {
      id: 'opao-floating-help',
      style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)',
      text: '可拖动到任意位置，靠近左右边缘后自动收起。键盘方向键可以移动。',
    });
    this.settingsButton = el('button', {
      class: 'floating-settings',
      text: '设置',
      'aria-label': '打开页内设置',
      'aria-expanded': 'false',
      'aria-controls': 'opao-page-settings',
    });
    this.element.append(
      this.button,
      el('div', { class: 'floating-actions' }, this.settingsButton),
      this.help,
    );
    root.append(this.element);
    this.element.addEventListener('pointerenter', () => this.expand());
    this.element.addEventListener('pointerleave', () => this.scheduleCollapse());
    this.element.addEventListener('focusin', () => this.expand());
    this.element.addEventListener('focusout', () => this.scheduleCollapse());
    this.element.addEventListener('pointerdown', () => this.setPointerMode(true), true);
    this.keyInput = () => this.setPointerMode(false);
    window.addEventListener('keydown', this.keyInput, true);
    this.settingsButton.onclick = () => {
      this.expand();
      this.onSettings();
    };
    this.button.addEventListener('click', (event) => {
      if (performance.now() < (this.suppressClickUntil || 0) && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.onTranslate();
    });
    this.button.addEventListener('pointerdown', (event) => this.startDrag(event));
    this.button.addEventListener('pointermove', (event) => this.moveDrag(event));
    this.button.addEventListener('pointerup', (event) => this.finishDrag(event, false));
    this.button.addEventListener('pointercancel', (event) => this.finishDrag(event, true));
    this.button.addEventListener('lostpointercapture', (event) => this.finishDrag(event, false));
    this.button.addEventListener('keydown', (event) => this.moveByKey(event));
    this.resize = () => this.place();
    window.addEventListener('resize', this.resize);
    this.place();
    this.scheduleCollapse(900);
    const revision = this.revision;
    rpc('get-floating-position')
      .then((value) => {
        const stored = normalizeFloatingPosition(value);
        if (stored && !this.destroyed && !this.drag && revision === this.revision) {
          this.position = stored;
          this.place();
          this.scheduleCollapse();
        }
      })
      .catch(() => {});
  }
  limits() {
    return {
      x: Math.max(0, (document.documentElement.clientWidth || innerWidth) - 46),
      y: Math.max(0, (document.documentElement.clientHeight || innerHeight) - 96),
    };
  }
  anchor() {
    return {
      x: parseFloat(this.element.style.left) || 0,
      y: parseFloat(this.element.style.top) || 0,
      size: 46,
    };
  }
  place() {
    const limits = this.limits();
    const left =
      this.position.side === 'left'
        ? 0
        : this.position.side === 'right'
          ? limits.x
          : this.position.x * limits.x;
    this.element.style.left = left + 'px';
    this.element.style.top = this.position.y * limits.y + 'px';
    this.element.dataset.side = this.position.side || 'free';
    if (!this.position.side) this.element.classList.remove('is-collapsed');
    this.onMove?.();
  }
  expand() {
    clearTimeout(this.collapseTimer);
    this.element.classList.remove('is-collapsed');
    this.element.classList.add('is-expanded');
  }
  setPointerMode(value) {
    this.pointerMode = value;
    this.element.classList.toggle('is-pointer-focus', value);
  }
  scheduleCollapse(delay = 550) {
    clearTimeout(this.collapseTimer);
    this.collapseTimer = setTimeout(() => {
      if (
        this.destroyed ||
        this.drag ||
        this.open ||
        this.element.matches(':hover') ||
        (!this.pointerMode && this.element.querySelector(':focus-visible'))
      )
        return;
      this.element.classList.remove('is-expanded');
      this.element.classList.toggle('is-collapsed', Boolean(this.position.side));
    }, delay);
  }
  setOpen(value) {
    this.open = value;
    this.settingsButton.setAttribute('aria-expanded', value);
    if (value) this.expand();
    else this.scheduleCollapse();
  }
  startDrag(event) {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    this.button.focus({ preventScroll: true });
    this.revision++;
    this.expand();
    const point = this.anchor();
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: point.x,
      top: point.y,
      initial: { ...this.position },
      moved: false,
    };
    this.button.setPointerCapture(event.pointerId);
  }
  moveDrag(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = event.clientX - this.drag.x,
      dy = event.clientY - this.drag.y;
    if (!this.drag.moved && Math.hypot(dx, dy) < 5) return;
    this.drag.moved = true;
    this.element.classList.add('is-dragging');
    const limits = this.limits();
    this.position = {
      side: null,
      x: limits.x ? Math.min(limits.x, Math.max(0, this.drag.left + dx)) / limits.x : 0,
      y: limits.y ? Math.min(limits.y, Math.max(0, this.drag.top + dy)) / limits.y : 0,
    };
    this.place();
    event.preventDefault();
  }
  snap() {
    const limits = this.limits(),
      point = this.anchor();
    if (point.x <= 26) {
      this.position.side = 'left';
      this.position.x = 0;
    } else if (point.x >= limits.x - 26) {
      this.position.side = 'right';
      this.position.x = 1;
    } else this.position.side = null;
    this.place();
  }
  finishDrag(event, cancelled) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    this.element.classList.remove('is-dragging');
    if (drag.moved) {
      this.suppressClickUntil = performance.now() + 400;
      if (cancelled) {
        this.position = drag.initial;
        this.place();
      } else {
        this.snap();
        this.persist();
      }
    }
    if (this.button.hasPointerCapture(event.pointerId))
      this.button.releasePointerCapture(event.pointerId);
    this.scheduleCollapse();
  }
  moveByKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    event.stopPropagation();
    this.revision++;
    this.expand();
    const limits = this.limits(),
      point = this.anchor(),
      step = event.shiftKey ? 20 : 8;
    if (event.key === 'Home' || event.key === 'End')
      this.position = {
        ...this.position,
        side: event.key === 'Home' ? 'left' : 'right',
        x: event.key === 'Home' ? 0 : 1,
      };
    else {
      const x =
        point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0);
      const y = point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      this.position = {
        side: null,
        x: limits.x ? Math.min(limits.x, Math.max(0, x)) / limits.x : 0,
        y: limits.y ? Math.min(limits.y, Math.max(0, y)) / limits.y : 0,
      };
    }
    this.place();
    clearTimeout(this.keyboardTimer);
    this.keyboardTimer = setTimeout(() => {
      this.snap();
      this.persist();
    }, 300);
  }
  persist() {
    const position = normalizeFloatingPosition(this.position),
      sequence = ++this.saveSequence;
    rpc('set-floating-position', { position })
      .then((value) => {
        if (!this.destroyed && !this.drag && sequence === this.saveSequence) {
          this.position = value;
          this.place();
        }
      })
      .catch((error) => this.notify(error.message));
  }
  destroy() {
    this.destroyed = true;
    clearTimeout(this.collapseTimer);
    clearTimeout(this.keyboardTimer);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.keyInput, true);
    this.element.remove();
  }
}
