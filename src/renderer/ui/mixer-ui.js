// The mixer: channel strips, crossfader / 4-deck XY pad, master volume, and the SFX pads.
import { SOUNDS } from '../sfx.js';
import { $, $$, mixer, DECKS, state, escapeHtml, leadDeck, fourDecks, clamp, store, pick } from './core.js';
import { Knob } from './knob.js';
import { snapOn } from './sync-ui.js';
import { renderLibrarySoon } from './library.js';

export function buildMixer() {
  state.knobs = {};
  for (const name of DECKS) {
    const deck = mixer.decks[name];
    const strip = $(`.strip[data-deck="${name}"]`);
    $(`#deck${name} .deck-body`).append(strip); // each deck carries its own channel strip, facing the centre
    state.knobs[name] = [];
    for (const el of $$('.knob', strip)) {
      const p = el.dataset.param;
      if (p === 'trim') state.knobs[name].push(new Knob(el, { min: -12, max: 12, value: 0, bipolar: true, onChange: (v) => deck.setTrim(v) }));
      else if (p === 'filter') state.knobs[name].push(new Knob(el, { min: -1, max: 1, value: 0, bipolar: true, onChange: (v) => deck.setFilter(v) }));
      else state.knobs[name].push(new Knob(el, { min: -26, max: 6, value: 0, bipolar: true, onChange: (v) => deck.setEq(p, v) }));
    }
    const fader = $('.channel-fader', strip);
    fader.addEventListener('input', () => deck.setFader(Number(fader.value)));
  }
  const xf = $('#crossfader');
  xf.addEventListener('input', () => {
    mixer.setCrossfader(Number(xf.value));
    renderLibrarySoon(); // the side it favours is the deck the library matches against
  });
  xf.addEventListener('dblclick', () => {
    xf.value = 0.5;
    xf.dispatchEvent(new Event('input'));
  });
  const snap = $('#snapBtn');
  const setSnap = (on) => {
    snap.classList.toggle('on', on);
    snap.setAttribute('aria-pressed', String(on));
    store.set('snap', on ? 'on' : 'off');
  };
  snap.addEventListener('click', () => setSnap(!snapOn()));
  setSnap(!['off', '0'].includes(store.get('snap')));

  // 4-deck XY pad: x = left (A, C) to right (B, D), y = top (A, B) to bottom (C, D).
  const pad = $('#xyPad');
  const puck = $('.xy-puck', pad);
  let padY = 0.5;
  const placePuck = () => {
    puck.style.left = `${Number(xf.value) * 100}%`;
    puck.style.top = `${padY * 100}%`;
  };
  const setPad = (x, y) => {
    xf.value = x;
    padY = clamp(y);
    mixer.setCrossfader(Number(xf.value));
    mixer.setCrossfaderY(fourDecks() ? padY : null);
    placePuck();
  };
  const fromPointer = (e) => {
    const r = pad.getBoundingClientRect();
    setPad(clamp((e.clientX - r.left) / r.width), (e.clientY - r.top) / r.height);
  };
  let padDrag = false;
  pad.addEventListener('pointerdown', (e) => {
    padDrag = true;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('grabbing');
    fromPointer(e);
  });
  pad.addEventListener('pointermove', (e) => padDrag && fromPointer(e));
  const endPad = () => {
    padDrag = false;
    pad.classList.remove('grabbing');
  };
  pad.addEventListener('pointerup', endPad);
  pad.addEventListener('pointercancel', endPad);
  pad.addEventListener('dblclick', () => setPad(0.5, 0.5));
  xf.addEventListener('input', placePuck); // the arrow keys move x; keep the puck with it
  state.applyXY = () => setPad(Number(xf.value), padY);
  placePuck();

  const mv = $('#masterVol');
  mv.addEventListener('input', () => mixer.setMasterVolume(Number(mv.value)));
  mixer.setMasterVolume(Number(mv.value));

  const curves = $$('#curveSeg button');
  curves.forEach((b) =>
    b.addEventListener('click', () => {
      pick(curves, (x) => x === b);
      mixer.setCurve(b.dataset.curve);
    }),
  );
}

function playSfx(sound, pad) {
  mixer.resume();
  const ctx = mixer.ctx;
  const deck = leadDeck();
  const beat = deck ? 60 / deck.effectiveBpm : 0.5;
  let t = ctx.currentTime + 0.01;
  if (deck && $('#sfxQuantize').checked) {
    // Next beat of the lead deck, on the audio clock.
    const p = deck.position;
    const off = deck.track.beatOffset;
    const period = 60 / deck.bpm;
    const next = off + Math.ceil((p - off) / period + 0.02) * period;
    // Decks reach the speakers through the fx node, a moment later; SFX don't, so wait that out too.
    t = ctx.currentTime + (next - p) / deck.speed + deck.fxDelay;
  }
  sound.play(ctx, mixer.sfx, t, beat);
  pad.classList.remove('hit');
  setTimeout(() => {
    void pad.offsetWidth;
    pad.classList.add('hit');
  }, Math.max(0, (t - ctx.currentTime) * 1000));
}

export function setupSfx() {
  $('#sfxGrid').innerHTML = SOUNDS.map((s, i) => `<button class="sfx-pad" data-i="${i}">${escapeHtml(s.label)}</button>`).join('');
  $('#sfxGrid').addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('.sfx-pad');
    if (pad) playSfx(SOUNDS[pad.dataset.i], pad);
  });
  $('#sfxLevel').addEventListener('input', (e) => mixer.sfx.gain.setTargetAtTime(Number(e.target.value), mixer.ctx.currentTime, 0.01));
}
