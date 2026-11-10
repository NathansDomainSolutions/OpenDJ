// One deck's controls: transport, tempo, hot cues, loops, key, stems and effects.
import { STEMS } from '../engine.js';
import { keyName, camelot } from '../analysis.js';
import { keyRelation, hasKey } from '../match.js';
import { $, $$, mixer, group, DECKS, state, ui, escapeHtml, shortLicense, heardKey, heardPitch, partnerDeck } from './core.js';
import { prepareVideo } from './video.js';
import { renderHotcues, hotcue, clearHotcue, scaleBpm, beatHere, cycleMeter, setupTap } from './grid.js';
import { renderLibrary, renderLibrarySoon } from './library.js';
import { setupDeckDrop } from './load.js';
import { snapDeck, togglePlay, followTempo, doSync, matchTempo, relink, matchKey } from './sync-ui.js';

export function buildDeck(name) {
  const root = $(`#deck${name}`);
  root.append($('#deckTemplate').content.cloneNode(true));
  $('.deck-badge', root).textContent = name;
  const deck = mixer.decks[name];
  const d = {
    root,
    title: $('.t-title', root),
    artist: $('.t-artist', root),
    lic: $('.lic', root),
    elapsed: $('.elapsed', root),
    remain: $('.remain', root),
    bpmEff: $('.bpm-eff', root),
    bpmTrack: $('.bpm-track', root),
    rate: $('.rate', root),
    overview: $('.overview', root),
    play: $('.play', root),
    cue: $('.cue', root),
    sync: $('.sync', root),
    tempo: $('.tempo-slider', root),
    range: $('.tempo-range', root),
    hotcues: $$('.hc', root),
    loops: $$('.lp', root),
    tap: $('.tap', root),
    keyRead: $('.key-read', root),
    keyLock: $('.key-lock', root),
    keyMatch: $('.key-match', root),
    stems: $$('.stem', root),
    stemLabel: $('.stemrow .label', root),
    phase: $('.phase', root),
    phaseDot: $('.phase i', root),
    phaseMs: $('.phase-ms', root),
    meter: $('.meter', root),
    badge: $('.deck-badge', root),
    barpos: $('.barpos', root),
    vinyl: $('.vinyl', root),
    mvUrl: null, // this deck's music video (blob URL), once fetched
    mvAvailable: false, // a web track, so a video can be fetched
  };
  $('.vinyl-label', root).textContent = name;
  ui[name] = d;

  d.play.addEventListener('click', () => {
    togglePlay(name);
    markPlayed(name);
  });
  d.cue.addEventListener('click', () => deck.cue());
  d.sync.addEventListener('click', (e) => (e.shiftKey ? matchTempo(name) : doSync(name)));
  // Sync ratio: Auto (nearest ½ / 1 / 2) → ½× → 1× → 2×. A synced deck re-joins straight away.
  const multBtn = $('.sync-mult', root);
  multBtn.textContent = 'Auto';
  multBtn.addEventListener('click', () => {
    deck.forcedK = { null: 0.5, 0.5: 1, 1: 2, 2: null }[deck.forcedK ?? null];
    multBtn.textContent = { null: 'Auto', 0.5: '½×', 1: '1×', 2: '2×' }[deck.forcedK ?? null];
    multBtn.classList.toggle('on', deck.forcedK != null);
    if (group.has(deck)) relink(name);
  });

  const applyTempo = () => {
    const pct = (Number(d.tempo.value) / 1000) * Number(d.range.value);
    deck.setRate(1 + pct / 100);
  };
  d.tempo.addEventListener('input', applyTempo);
  d.tempo.addEventListener('dblclick', () => {
    d.tempo.value = 0;
    applyTempo();
  });
  d.range.addEventListener('change', () => {
    // Keep the current tempo when switching range: widen instead of clamping a synced deck.
    if (group.has(deck)) return syncTempoSlider(name);
    const pct = (deck.rate - 1) * 100;
    const range = Number(d.range.value);
    d.tempo.value = Math.round(Math.max(-1, Math.min(1, pct / range)) * 1000);
    applyTempo();
  });

  // Nudge buttons (hold).
  const holdBend = (btn, amt) => {
    btn.addEventListener('pointerdown', () => deck.bend(amt));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => deck.endBend());
  };
  holdBend($('.nudge-back', root), -0.04);
  holdBend($('.nudge-fwd', root), 0.04);

  d.hotcues.forEach((btn) => {
    const i = Number(btn.dataset.i);
    btn.addEventListener('click', () => hotcue(name, i));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHotcue(name, i);
    });
  });

  d.loops.forEach((btn) => btn.addEventListener('click', () => deck.setLoop(Number(btn.dataset.beats))));

  $('.half', root).addEventListener('click', () => scaleBpm(name, 0.5));
  $('.double', root).addEventListener('click', () => scaleBpm(name, 2));
  $('.beat-here', root).addEventListener('click', () => beatHere(name));
  d.meter.addEventListener('click', () => cycleMeter(name));
  setupTap(name);

  // Key: shift in semitones without touching tempo, key lock, match the other deck.
  $('.key-down', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) - 1));
  $('.key-up', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) + 1));
  d.keyRead.addEventListener('click', () => deck.setKeyShift(0));
  d.keyLock.addEventListener('click', () => deck.setKeyLock(!deck.keyLock));
  d.keyMatch.addEventListener('click', (e) => matchKey(name, e.shiftKey));

  // Stems: click toggles, Shift-click solos, right-click turns everything back on.
  d.stems.forEach((btn) => {
    const stem = btn.dataset.stem;
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        const solo = STEMS.every((s) => (s === stem ? deck.stems[s] > 0 : deck.stems[s] === 0));
        STEMS.forEach((s) => deck.setStem(s, solo || s === stem ? 1 : 0));
      } else {
        deck.setStem(stem, deck.stems[stem] > 0 ? 0 : 1);
      }
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      deck.resetStems();
    });
  });

  d.overview.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    const seekTo = (ev) => {
      const r = d.overview.getBoundingClientRect();
      deck.seek(group.quantizeSeek(deck, ((ev.clientX - r.left) / r.width) * deck.duration));
    };
    seekTo(e);
    d.overview.setPointerCapture(e.pointerId);
    d.overview.classList.add('grabbing');
    const move = (ev) => seekTo(ev);
    d.overview.addEventListener('pointermove', move);
    d.overview.addEventListener('pointerup', () => {
      d.overview.removeEventListener('pointermove', move);
      d.overview.classList.remove('grabbing');
      snapDeck(name);
    }, { once: true });
  });

  let wasPlaying = false;
  deck.on((type) => {
    if (type === 'state' || type === 'load') renderDeckState(name);
    // Starting play with Snap on lands on the other deck's beat, whichever control started it.
    if (type === 'state') {
      if (deck.playing && !wasPlaying && !group.has(deck)) snapDeck(name); // synced decks start on the clock instead
      wasPlaying = deck.playing;
    }
    if (type === 'bendEnd') group.keepOffset(deck); // a nudge on a synced deck sticks
    if (type === 'load') prepareVideo(name);
    if (type === 'load') {
      root.classList.remove('just-loaded');
      void root.offsetWidth; // restart the animation
      root.classList.add('just-loaded');
    }
    if (type === 'loop' || type === 'load') d.loops.forEach((b) => b.classList.toggle('on', deck.loop?.beats === Number(b.dataset.beats)));
    if (type === 'rate' || type === 'load') renderTempo(name);
    if (type === 'rate') followTempo(name);
    if (type === 'load') {
      // Like djay, Sync stays on across loads: the new track re-joins once it's ready (see loadTrack).
      deck.resync = group.has(deck);
      group.leave(deck);
    }
    if (['key', 'rate', 'load', 'fx'].includes(type)) renderKeys();
    if (type === 'key' || type === 'rate') renderLibrarySoon(); // the library marks what mixes with the deck on air
    if (type === 'stems' || type === 'load' || type === 'fx') renderStems(name);
  });

  // Effects, djay-style: each pill is an intensity bar. Tap to switch it on or off;
  // drag across it to set the intensity (dragging switches it on). Keyboard: Enter or
  // Space toggles, arrow keys move the intensity.
  const GATE_RATES = { 1: '¼', 2: '⅛', 4: '⅟₁₆' };
  for (const box of $$('.fx', root)) {
    const fx = box.dataset.fx;
    const render = () => {
      const s = deck.fxChain.state[fx];
      const pct = Math.round(s.amount * 100);
      box.classList.toggle('on', s.on);
      box.style.setProperty('--fill', `${pct}%`);
      $('.fx-val', box).textContent = `${pct}%`;
      box.setAttribute('aria-valuenow', String(pct));
      box.setAttribute('aria-valuetext', `${pct}%, ${s.on ? 'on' : 'off'}`);
    };
    const setAmount = (v) => {
      deck.fxChain.set(fx, { amount: Math.min(1, Math.max(0, v)), on: true });
      render();
    };
    const toggle = () => {
      deck.fxChain.set(fx, { on: !deck.fxChain.state[fx].on });
      render();
    };
    let press = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fx-rate') || e.button !== 0) return;
      try {
        box.setPointerCapture(e.pointerId);
      } catch {}
      press = { x: e.clientX, dragging: false };
    });
    box.addEventListener('pointermove', (e) => {
      if (!press) return;
      if (!press.dragging && Math.abs(e.clientX - press.x) < 4) return; // a tap, so far
      press.dragging = true;
      box.classList.add('dragging');
      const r = box.getBoundingClientRect();
      setAmount((e.clientX - r.left) / r.width);
    });
    const release = () => {
      if (!press) return;
      if (!press.dragging) toggle();
      press = null;
      box.classList.remove('dragging');
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', () => {
      press = null;
      box.classList.remove('dragging');
    });
    box.addEventListener('keydown', (e) => {
      const s = deck.fxChain.state[fx];
      if (e.key === 'Enter' || e.key === ' ') toggle();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setAmount(s.amount + 0.05);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setAmount(s.amount - 0.05);
      else return;
      e.preventDefault();
      e.stopPropagation(); // don't also move the crossfader or toggle playback
    });
    const rate = $('.fx-rate', box);
    rate?.addEventListener('click', () => {
      const div = { 1: 2, 2: 4, 4: 1 }[deck.fxChain.state.gate.div];
      deck.fxChain.set('gate', { div });
      deck.fxChain.syncGate();
      rate.textContent = GATE_RATES[div];
    });
    render();
  }

  setupDeckDrop(root, name);
  setupDeckDrop($(`.wave-row[data-deck="${name}"]`), name);
}

export function renderDeckState(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  d.play.classList.toggle('on', deck.playing);
  d.play.textContent = deck.playing ? '❚❚' : '▶';
  const t = deck.track;
  d.root.classList.toggle('has-track', !!t);
  if (t) {
    d.title.textContent = t.title || 'Untitled';
    d.artist.textContent = t.artist || (t.source?.uploader ?? '');
    const web = t.source?.kind === 'web';
    d.lic.hidden = false;
    d.lic.className = web ? 'lic' : 'lic local';
    d.lic.textContent = web ? shortLicense(t.source.license) : 'LOCAL';
    d.lic.title = web ? t.source.license || '' : t.file;
  }
  renderHotcues(name);
  renderLibrary();
}

export function renderTempo(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  d.rate.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  d.meter.textContent = `${deck.bars?.beatsPerBar || 4}/4`;
  if (deck.bpm) {
    d.bpmEff.textContent = deck.effectiveBpm.toFixed(1);
    d.bpmTrack.textContent = `${Number(deck.bpm).toFixed(1)} track`;
  } else {
    d.bpmEff.textContent = '—.—';
    d.bpmTrack.textContent = deck.track ? 'no grid' : '';
  }
}

export function syncTempoSlider(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  let range = Number(d.range.value);
  if (Math.abs(pct) > range) {
    range = [8, 16, 50].find((r) => r >= Math.abs(pct)) || 50;
    d.range.value = String(range);
  }
  d.tempo.value = Math.round((pct / range) * 1000);
}

export const fmtSemis = (s) => {
  const r = Math.round(s * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r) % 1 ? Math.abs(r).toFixed(1) : Math.abs(r)}`;
};

function renderKey(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const key = deck.track?.key;
  const offset = deck.keyOffset;
  const shifted = Math.abs(offset) >= 0.05;
  d.keyLock.classList.toggle('on', deck.keyLock);
  d.keyRead.classList.toggle('shifted', shifted);
  d.keyRead.classList.toggle('unknown', !hasKey(key));
  if (!hasKey(key)) {
    d.keyRead.textContent = deck.track ? (shifted ? `? ${fmtSemis(offset)}` : 'no key') : '—';
    d.keyRead.title = deck.track ? 'No clear key found in this track.' : '';
  } else if (!shifted) {
    d.keyRead.innerHTML = `${escapeHtml(camelot(key))} <span class="dim">${escapeHtml(keyName(key))}</span>`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}).`;
  } else {
    // The key you hear: rounded to the nearest semitone, with the exact shift alongside.
    const heard = heardKey(deck);
    const pitch = heardPitch(deck); // "~": it sits between two keys (a deck tuned to another by Match doesn't)
    const off = Math.abs(pitch - Math.round(pitch)) >= 0.25 ? '~' : '';
    d.keyRead.textContent = `${off}${camelot(heard)} ${keyName(heard)} ${fmtSemis(offset)}`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}), playing ${fmtSemis(offset)} semitones → ${keyName(heard)} (${camelot(heard)}).` +
      (deck.keyLock ? '' : ' Includes the pitch change from the tempo slider (key lock is off).') + ' Click to reset the key shift.';
  }

  // How this deck sits with the one it mixes against: in key, a neighbour on the wheel, or a clash.
  const other = mixer.decks[partnerDeck(name)];
  const fit = other !== deck && hasKey(key) && hasKey(other.track?.key) ? keyRelation(heardKey(deck), heardKey(other)) || 'clash' : '';
  d.keyRead.dataset.fit = fit;
  if (fit) d.keyRead.title += ` ${KEY_FIT[fit]} deck ${other.name} (${camelot(heardKey(other))}).`;
  const cents = Math.round((deck.track?.tuning || 0) * 100);
  if (cents) d.keyRead.title += ` This track is tuned ${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'}; Match corrects that too.`;
  if (!deck.fx) d.keyRead.title = 'Key shift is still loading…';
}

const KEY_FIT = { same: 'In key with', relative: 'Relative key of', adjacent: 'One step round the wheel from', clash: 'Clashes with' };

/** Every deck's key readout (each also shows how it sits with the others). */
export function renderKeys() {
  for (const n of DECKS) if (ui[n]) renderKey(n);
}

export function renderStems(name) {
  const deck = mixer.decks[name];
  ui[name].stems.forEach((btn) => {
    btn.classList.toggle('off', deck.stems[btn.dataset.stem] === 0);
    btn.disabled = !deck.fx;
  });
  const label = ui[name].stemLabel;
  const job = state.stemJobs.get(deck.track?.id);
  label.classList.toggle('ai', !!deck.aiStems);
  if (deck.aiStems) {
    label.textContent = 'Stems · AI';
    label.title = 'Using AI-separated stems for this track (HT-Demucs).';
  } else if (job) {
    label.textContent = job.total ? `AI ${Math.round((100 * job.done) / job.total)}%` : 'AI …';
    label.title = 'Separating this track with AI in the background — the quick DSP stems work meanwhile.';
  } else {
    label.textContent = 'Stems';
    label.title = 'Real-time DSP stems.';
  }
}

export function markPlayed(name) {
  const t = mixer.decks[name].track;
  if (t?.source?.kind === 'web' && mixer.decks[name].playing) {
    state.played.set(t.id, t);
    $('#creditsCount').textContent = state.played.size;
  }
}
