// A rotary knob: drag up / down, scroll, arrow keys; double-click resets.
import { $, escapeHtml } from './core.js';

export class Knob {
  constructor(el, { min, max, value, reset = value, bipolar = false, onChange }) {
    Object.assign(this, { el, min, max, value, reset, bipolar, onChange });
    el.innerHTML = `
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path class="k-track" d="${arc(-135, 135)}" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <path class="k-value" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <circle class="k-cap" cx="20" cy="20" r="11" stroke-width="1"/>
        <line class="k-ptr" x1="20" y1="20" x2="20" y2="11" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="k-label">${escapeHtml(el.dataset.label || '')}</span>`;
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', `${el.closest('[data-deck]')?.dataset.deck || ''} ${el.dataset.label || ''}`);
    this.valuePath = $('.k-value', el);
    this.ptr = $('.k-ptr', el);
    this.render();

    let startY = 0;
    let startT = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startT = this.toT(this.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(this.fromT(startT + ((startY - e.clientY) / 160) * fine));
    });
    el.addEventListener('dblclick', () => this.set(this.reset));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.set(this.fromT(this.toT(this.value) - Math.sign(e.deltaY) * 0.025));
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const nudge = (dir) => {
        this.set(this.fromT(this.toT(this.value) + dir * 0.025));
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-1);
    });
  }

  // Bipolar knobs put their reset value at 12 o'clock, even when the range is lopsided.
  toT(v) {
    if (!this.bipolar) return (v - this.min) / (this.max - this.min);
    return v <= this.reset ? 0.5 * ((v - this.min) / (this.reset - this.min)) : 0.5 + 0.5 * ((v - this.reset) / (this.max - this.reset));
  }

  fromT(t) {
    t = Math.min(1, Math.max(0, t));
    if (!this.bipolar) return this.min + t * (this.max - this.min);
    return t <= 0.5 ? this.min + (t / 0.5) * (this.reset - this.min) : this.reset + ((t - 0.5) / 0.5) * (this.max - this.reset);
  }

  set(v) {
    v = Math.min(this.max, Math.max(this.min, v));
    // Gentle detent at the reset point.
    if (Math.abs(this.toT(v) - this.toT(this.reset)) < 0.02) v = this.reset;
    this.value = v;
    this.render();
    this.onChange?.(v);
  }

  render() {
    const ang = -135 + this.toT(this.value) * 270;
    const from = this.bipolar ? 0 : -135;
    const [a0, a1] = ang < from ? [ang, from] : [from, ang];
    this.valuePath.setAttribute('d', a1 - a0 < 0.5 ? '' : arc(a0, a1));
    this.ptr.setAttribute('transform', `rotate(${ang} 20 20)`);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
    this.el.classList.toggle('kill', this.value <= this.min + 0.001 && this.min < -20);
  }
}

function arc(a0, a1, r = 16) {
  const p = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(20 + r * Math.cos(rad)).toFixed(2)} ${(20 + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}
