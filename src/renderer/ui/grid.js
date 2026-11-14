// Hot cues and beat-grid fixes (÷2, ×2, Tap, Beat 1, 4/4 ↔ 3/4).
import { mixToMono, detectMeter } from '../analysis.js';
import { mixer, group, fmtTime, toast, ui, saveTrack } from './core.js';
import { analyse } from './load.js';
import { relink } from './sync-ui.js';
import { renderLibrary } from './library.js';
import { renderTempo } from './deck.js';

export function renderHotcues(name) {
  const t = mixer.decks[name].track;
  ui[name].hotcues.forEach((btn, i) => {
    const set = t?.cues?.[i] != null;
    btn.classList.toggle('set', set);
    btn.textContent = set ? `${i + 1} · ${fmtTime(t.cues[i], true)}` : String(i + 1); // the marker's spot in the track
    btn.title = set ? `Hot cue ${i + 1} at ${fmtTime(t.cues[i], true)} (right-click to clear)` : `Set hot cue ${i + 1}`;
  });
}

export function hotcue(name, i) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t) return;
  const cues = Array.isArray(t.cues) ? [...t.cues] : [null, null, null, null];
  if (cues[i] == null) {
    cues[i] = deck.snapToBeat(deck.position);
    saveTrack(t, { cues });
    renderHotcues(name);
  } else {
    deck.seek(deck.playing ? group.quantizeSeek(deck, cues[i]) : cues[i]);
    if (!deck.playing) deck.cuePoint = cues[i];
  }
}

export function clearHotcue(name, i) {
  const t = mixer.decks[name].track;
  if (!t?.cues?.[i] && t?.cues?.[i] !== 0) return;
  const cues = [...t.cues];
  cues[i] = null;
  saveTrack(t, { cues });
  renderHotcues(name);
}

export async function scaleBpm(name, k) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm || !deck.buffer) return;
  const bpm = Math.round(t.bpm * k * 1000) / 1000;
  if (bpm < 40 || bpm > 300) return;
  const ch = [];
  for (let c = 0; c < deck.buffer.numberOfChannels; c++) ch.push(deck.buffer.getChannelData(c));
  const mono = mixToMono(ch);
  // A track with a tempo map keeps its beats where they are: only every other one counts (÷2), or the ones between too (×2).
  const fit = t.warp ? null : await analyse('fitAt', mono.slice(), deck.buffer.sampleRate, { bpm }).catch(() => null);
  if (deck.track !== t) return; // another track was loaded meanwhile
  const patch = { bpm: fit?.bpm ?? bpm, gridSource: 'user' };
  if (fit?.offset != null) {
    const meter = detectMeter(mono, deck.buffer.sampleRate, patch.bpm, fit.offset);
    Object.assign(patch, { beatOffset: fit.offset, beatsPerBar: meter?.beatsPerBar ?? 4, downbeat: meter ? meter.downbeat : fit.offset });
  }
  saveTrack(t, patch);
  renderTempo(name);
  renderLibrary();
  relink(name);
}

/** Track position you're hearing right now: what's rendered minus the fx node's and the device's delay. */
function heardPosition(deck) {
  const ctx = mixer.ctx;
  return Math.max(0, deck.position - (deck.fxDelay + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * deck.speed);
}

export function beatHere(name) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm) return toast('Set a BPM first (TAP along with the beat).');
  const period = 60 / t.bpm;
  const heard = deck.grid.musical(heardPosition(deck)); // the grid lives in musical time (see beatgrid.js)
  const offset = ((heard % period) + period) % period;
  saveTrack(t, { beatOffset: offset, downbeat: heard, gridSource: 'user' });
  toast(`Deck ${name}: the playhead is now beat 1 of the bar.`);
  relink(name);
}

export function cycleMeter(name) {
  const t = mixer.decks[name].track;
  if (!t?.bpm) return;
  saveTrack(t, { beatsPerBar: (t.beatsPerBar || 4) === 4 ? 3 : 4 });
  renderTempo(name);
}

export function setupTap(name) {
  const btn = ui[name].tap;
  let taps = [];
  let timer = null;
  const tap = () => {
    const deck = mixer.decks[name];
    if (!deck.track) return;
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    btn.classList.add('tapping');
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('tapping');
      taps = [];
    }, 2200);
    if (taps.length >= 4) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.slice(-8).reduce((a, b) => a + b, 0) / Math.min(8, intervals.length);
      const tapped = 60000 / avg; // tempo as heard (includes current pitch)
      const bpm = Math.round((tapped / deck.rate) * 1000) / 1000;
      const period = 60 / bpm;
      const heard = heardPosition(deck);
      const offset = ((heard % period) + period) % period;
      // Taps mark beats, not beat 1: keep the old bar start, moved onto the nearest new beat.
      const old = deck.track.downbeat ?? offset;
      // A tapped tempo is one steady tempo: it replaces any tempo map.
      saveTrack(deck.track, { bpm, beatOffset: offset, downbeat: offset + Math.round((old - offset) / period) * period, warp: null, variable: false, gridSource: 'user' });
      renderTempo(name);
      renderLibrary();
      relink(name);
    }
  };
  btn.addEventListener('pointerdown', tap);
  ui[name].tapFn = tap;
}
