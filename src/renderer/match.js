// How well two tracks go together: tempo distance and harmonic (Camelot wheel) fit.
// Pure functions, shared by Sync, Key Match and the library.

import { bestKeyShift, keyShiftFits, transposeKey } from './analysis.js';

/** Tempo ratios a deck may sync at: half time, same, double time. */
export const RATIOS = [0.5, 1, 2];

/** Tempos within this much of each other (after ½× / 2×) mix without an audible stretch. */
export const TEMPO_NEAR = 0.06;

/**
 * The smallest speed change that puts `bpm` on `target` at ½×, 1× or 2×.
 * Returns { rate, k } — play at `rate` and the deck runs at k × target — or null without both tempos.
 */
export function tempoMatch(bpm, target) {
  if (!(bpm > 0) || !(target > 0)) return null;
  let best = null;
  for (const k of RATIOS) {
    const rate = (target * k) / bpm;
    if (!best || Math.abs(Math.log(rate)) < Math.abs(Math.log(best.rate))) best = { rate, k };
  }
  return best;
}

/** Whether a stored key is a real one (null = not analysed yet, -1 = no clear key). */
export const hasKey = (key) => key != null && key >= 0;

/** Camelot wheel place of a key (0–23, minor = +12): { n: 1–12, minor }, or null when unknown. */
export function wheel(key) {
  if (!hasKey(key)) return null;
  const minor = key >= 12;
  const relMajor = minor ? (key + 3) % 12 : key % 12; // A minor sits with C major
  return { n: ((relMajor * 7) % 12 + 7) % 12 + 1, minor };
}


const KEY_SCORE = { same: 1, relative: 0.9, adjacent: 0.75 };

/**
 * How well `track` would mix into what's playing: `ref` = { bpm, key } as heard.
 * Returns { rate, k, near, key, score }: the tempo change needed, whether it's small, the
 * key relation, and one 0…1 score (tempo counts a little more than key: a clash can be
 * fixed with Key Match, a 30% stretch can't).
 */
export function mixFit(track, ref) {
  const tempo = tempoMatch(track.bpm, ref.bpm);
  const key = keyRelation(track.key, ref.key);
  const gap = tempo ? Math.abs(tempo.rate - 1) : 1;
  const tempoScore = Math.max(0, 1 - gap / (TEMPO_NEAR * 3));
  return { rate: tempo?.rate ?? null, k: tempo?.k ?? null, near: gap <= TEMPO_NEAR, key, score: 0.6 * tempoScore + 0.4 * (KEY_SCORE[key] ?? 0) };
}

/**
 * Steps round the wheel between two keys (0–6), whatever their mode: 0 = the same seven
 * notes, 1 = one note apart. null when a key is unknown.
 */
export function wheelSteps(a, b) {
  const x = wheel(a);
  const y = wheel(b);
  if (!x || !y) return null;
  const d = Math.abs(x.n - y.n);
  return Math.min(d, 12 - d);
}

/**
 * How two keys mix: 'same', 'relative' (the same seven notes, major ↔ minor), 'adjacent'
 * (one step round the wheel: one note apart), or null (a clash, or a key unknown).
 * A step counts in either mode (8A next to 7B as well as 7A): the notes are what clash or
 * don't, and telling a major key from its relative minor is where key detection errs most.
 */
export function keyRelation(a, b) {
  const steps = wheelSteps(a, b);
  if (steps === 0) return a === b ? 'same' : 'relative';
  return steps === 1 ? 'adjacent' : null;
}

// Key Match looks for a key that mixes, not only the same key: landing one step round the
// wheel is fine when it saves more than a semitone of shifting (big shifts sound unnatural).
const STEP_COST = 1;
// …and the notes must back the key names up (names can be wrong): a candidate has to agree
// at least this well by ear. Keys a step apart score 0.24–0.59 on ideal note profiles, keys
// two steps apart 0.24 at most.
const EAR_MIN = 0.2;

/**
 * Key Match: the shift (semitones, may be fractional) that puts a deck in a key that mixes
 * with another deck, and in tune with it. Each side is { key, chroma, tuning, offset }: the
 * track's key and the notes it plays, how far it sits from concert pitch, and how far the
 * deck already plays from the track's own key.
 *
 * The smallest shift that lands on the same notes (same or relative key) wins, or one step
 * round the wheel when that saves more than a semitone, as long as the notes agree by ear
 * too. Without key names, or when the notes disagree with them, it goes by ear alone
 * (bestKeyShift). Two records a quarter-tone apart sound sour even in the "same" key, so the
 * tuning difference is always part of the shift. `exact` insists on the same notes (no
 * settling for a step away).
 * Returns { shift, fit, fitNow, steps, detune } (steps: see wheelSteps) or null.
 */
export function keyMatch(mine, theirs, { exact = false } = {}) {
  const detune = (theirs.tuning || 0) - (mine.tuning || 0);
  const target = (theirs.offset || 0) + detune; // where their notes sit, seen from my tuning
  const byEar = bestKeyShift(mine.chroma, theirs.chroma, target, mine.offset || 0);
  if (!byEar) return null;
  const whole = Math.round(target);
  const fine = target - whole;
  const stepsAt = (shift) => wheelSteps(transposeKey(mine.key, shift), transposeKey(theirs.key, whole));
  const cost = (c) => Math.abs(c.shift) + c.steps * STEP_COST;
  let pick = null;
  for (const c of keyShiftFits(mine.chroma, theirs.chroma, whole)) {
    c.steps = stepsAt(c.shift);
    if (c.steps == null || c.steps > (exact ? 0 : 1) || c.fit < EAR_MIN) continue;
    if (!pick || cost(c) < cost(pick) || (cost(c) === cost(pick) && c.fit > pick.fit)) pick = c;
  }
  if (!pick) return { ...byEar, steps: stepsAt(Math.round(byEar.shift - fine)), detune };
  return { shift: pick.shift + fine, fit: pick.fit, fitNow: byEar.fitNow, steps: pick.steps, detune };
}
