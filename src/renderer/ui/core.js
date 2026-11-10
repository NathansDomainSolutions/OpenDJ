// Shared by every UI module: the audio engine, the page's state and small helpers.
// Imports no other UI module, so it is always ready first.
import { Mixer, XF_SIDE } from '../engine.js';
import { SyncGroup } from '../sync.js';
import { keyName, camelot, transposeKey } from '../analysis.js';

export const api = window.cdj;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export const mixer = new Mixer();
// Beat sync: every synced deck locks to one shared clock (see sync.js).
export const group = new SyncGroup(mixer);
window.cdjDebug = { mixer, group }; // for tests and the devtools console
export const DECKS = ['A', 'B', 'C', 'D']; // all built; C and D show in 4-deck mode (Settings)
export const fourDecks = () => document.body.classList.contains('decks-4');
export const activeDecks = () => (fourDecks() ? DECKS : ['A', 'B']);
const otherSide = (name) => (XF_SIDE[name] === 'L' ? 'R' : 'L');

/**
 * The deck to sync / key-match to: a playing deck on the other crossfader side,
 * then any other playing deck, then the other side's main deck (A ↔ B).
 */
export function partnerDeck(name) {
  const others = activeDecks().filter((n) => n !== name && mixer.decks[n].track);
  return (
    others.find((n) => XF_SIDE[n] === otherSide(name) && mixer.decks[n].playing) ||
    others.find((n) => mixer.decks[n].playing) ||
    others.find((n) => n === (otherSide(name) === 'R' ? 'B' : 'A')) ||
    others[0] ||
    (XF_SIDE[name] === 'L' ? 'B' : 'A')
  );
}

/** The deck the crowd is hearing most: playing, and favoured by the crossfader. */
export function leadDeck() {
  const playing = activeDecks().filter((n) => mixer.decks[n].playing && mixer.decks[n].bars);
  if (playing.length < 2) return playing[0] ? mixer.decks[playing[0]] : null;
  const side = mixer.crossfader > 0.5 ? 'R' : 'L';
  return mixer.decks[playing.find((n) => XF_SIDE[n] === side) || playing[0]];
}

/** Semitones a deck plays from concert pitch in its track's key: key shift, tempo (without key lock) and the record's own tuning. */
export const heardPitch = (deck) => deck.keyOffset + (deck.track?.tuning || 0);
/** The key a deck is heard in. */
export const heardKey = (deck) => transposeKey(deck.track?.key, heardPitch(deck));

// Canvas colours, set by the theme (see THEMES in settings.js).
export const ACCENT = {};
export const INK = {};
export const HOTCUE_COLORS = ['#ff5c6c', '#42d392', '#8b7bff', '#ffd24d'];

export const ui = {}; // per deck: its elements (see buildDeck)

export const state = {
  tracks: [],
  filter: '',
  sort: null, // library order: { by: 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'match', dir: 1 | -1 }, null = as added
  waves: { A: null, B: null, C: null, D: null },
  overviewImg: { A: null, B: null, C: null, D: null },
  span: 16, // seconds shown across the scrolling waveforms (the same for every deck)
  played: new Map(), // trackId -> track (web tracks played this session, for credits)
  results: [], // search results
  jobs: new Map(), // jobId -> { el, url }
  stemJobs: new Map(), // trackId -> { done, total } while AI stems are being made
};

// ------------------------------------------------------------------ helpers

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtTime(sec, tenths = false) {
  if (sec == null || !isFinite(sec)) return tenths ? '0:00.0' : '—';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '−' : ''}${m}:${ss}`;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 6000 : 3200);
}

// No-gate build: tracks aren't license-checked, so anything that isn't
// clearly CC shows as UNCHECKED rather than defaulting to "CC".
export function shortLicense(lic) {
  if (!lic) return 'UNCHECKED';
  if (/public\s*domain|cc0/i.test(lic)) return 'PUBLIC DOMAIN';
  if (/attribution/i.test(lic) || /cc[\s-]?by/i.test(lic)) {
    const m = lic.match(/cc[\s-]?by(?:[\s-](?:sa|nd|nc))*(?:[\s-]\d\.\d)?/i);
    return m ? m[0].toUpperCase().replace(/\s/g, '-') : 'CC BY';
  }
  if (/creative\s*commons/i.test(lic)) return 'CC';
  return 'UNCHECKED';
}

/** "8A Am" for a stored key (0–23); '' when unknown. */
export function keyLabel(key) {
  return key == null || key < 0 ? '' : `${camelot(key)} ${keyName(key)}`;
}

export function cleanErr(err) {
  let msg = String(err?.message || err || 'Something went wrong');
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  if (/unable to (download|connect)|getaddrinfo|timed out|network is unreachable|proxy/i.test(msg)) {
    return 'Couldn’t reach YouTube — check your internet connection and try again.';
  }
  return msg.replace(/;?\s*please report this issue.*$/i, '').slice(0, 300);
}

export function jobId() {
  return Math.random().toString(36).slice(2, 10);
}

/** Saved settings (localStorage; quietly does nothing where storage is unavailable). */
export const store = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

/** Light the chosen button(s) of a segmented control or card group. */
export function pick(buttons, isOn) {
  for (const b of buttons) {
    const on = !!isOn(b);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

/** Links marked class="open" data-url="…" inside `el` open in the system browser. */
export function openLinks(el) {
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a.open');
    if (a) api.openExternal(a.dataset.url);
  });
}

export async function saveTrack(track, patch) {
  Object.assign(track, patch);
  const updated = await api.library.update(track.id, patch);
  if (updated) {
    const i = state.tracks.findIndex((t) => t.id === track.id);
    if (i !== -1) state.tracks[i] = Object.assign(state.tracks[i], patch);
  }
}
