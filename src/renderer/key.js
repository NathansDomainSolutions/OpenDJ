// Musical keys: names, the Camelot wheel, how two keys mix, and Key Match.
// Everything about keys except finding one in audio (detectKey in analysis.js).
//
// A key is a number: 0–11 = C … B major, 12–23 = C … B minor. null = not analysed yet,
// -1 = analysed, no clear key.

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Whether a stored key is a real one. */
export const hasKey = (key) => key != null && key >= 0;

/** "Am", "F#"… ('' when unknown). */
export function keyName(key) {
  return hasKey(key) ? NAMES[key % 12] + (key >= 12 ? 'm' : '') : '';
}

/** Place on the Camelot wheel: { n: 1–12, minor }, or null when unknown. A minor key sits with its relative major. */
export function wheel(key) {
  if (!hasKey(key)) return null;
  const minor = key >= 12;
  const major = minor ? (key + 3) % 12 : key; // A minor ↔ C major
  return { n: ((major * 7 + 7) % 12) + 1, minor };
}

/** Camelot code: "8A" (A minor), "8B" (C major)… ('' when unknown). */
export function camelot(key) {
  const w = wheel(key);
  return w ? `${w.n}${w.minor ? 'A' : 'B'}` : '';
}

/** A key moved by a number of semitones (rounded); unknown keys stay unknown. */
export function transposeKey(key, semitones) {
  if (!hasKey(key)) return key;
  return (((key % 12) + Math.round(semitones)) % 12 + 12) % 12 + (key >= 12 ? 12 : 0);
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

// ---------------------------------------------------------------- Key Match

// A track's chroma is the share of each of the 12 notes in what it plays (C first). Two
// tracks sound in key when, after shifting one, their chromas rise and fall together.

/** How alike two chromas are, −1…1 (their correlation), with `a` moved up `shift` semitones. */
export function chromaFit(a, b, shift = 0) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i] / 12;
    mb += b[i] / 12;
  }
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(((i - shift) % 12) + 12) % 12] - ma; // the note that lands on i after the shift
    const y = b[i] - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

const SHIFTS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]; // smallest first, so ties go to the smaller move
const STEP_COST = 1; // landing a step away on the wheel is worth it only if it saves more than a semitone
const EAR_MIN = 0.2; // the notes must back the key names up at least this much (a step apart scores 0.24–0.59 on ideal profiles, two steps 0.24 at most)
const EAR_SHIFT_COST = 0.01; // going by ear alone: each semitone must buy this much more agreement

/**
 * Key Match: how many semitones (may be fractional) to shift a deck so it mixes with
 * another, in tune with it.
 *
 * Each side is { key, chroma, tuning, offset }: the track's key and chroma, how far the
 * record sits from concert pitch (semitones), and how far the deck already plays from the
 * track's own pitch (key shift, and tempo without key lock).
 *
 * 1. Where the other deck's notes are, seen from this record: its offset plus the tuning
 *    difference. The whole semitones of that decide the target key; the rest is fine tuning
 *    that is always applied, because two records a quarter-tone apart sound sour in any key.
 * 2. Of the 13 shifts within ±6 semitones, take the cheapest that lands on the same notes
 *    (same or relative key) or, when it saves more than a semitone, one step round the
 *    wheel, and that the chromas agree with too. `exact` allows only the same notes.
 * 3. No key names, or the chromas disagree with them everywhere: go by ear alone, to the
 *    shift where the chromas agree best.
 *
 * Returns { shift, fit, fitNow, steps, detune }: the shift, how well the notes agree there
 * and where the deck is now, the steps apart on the wheel afterwards (null if unknown), and
 * the tuning difference taken out. Null when either chroma is missing.
 */
export function keyMatch(mine, theirs, { exact = false } = {}) {
  if (!mine.chroma?.length || !theirs.chroma?.length) return null;
  const detune = (theirs.tuning || 0) - (mine.tuning || 0);
  const target = (theirs.offset || 0) + detune;
  const whole = Math.round(target);
  const theirKey = transposeKey(theirs.key, whole);
  const options = SHIFTS.map((shift) => ({
    shift,
    fit: chromaFit(mine.chroma, theirs.chroma, shift - whole), // both moved: only the difference counts
    steps: wheelSteps(transposeKey(mine.key, shift), theirKey),
  }));
  const cost = (o) => Math.abs(o.shift) + o.steps * STEP_COST;
  const byName = options
    .filter((o) => o.steps != null && o.steps <= (exact ? 0 : 1) && o.fit >= EAR_MIN)
    .reduce((best, o) => (!best || cost(o) < cost(best) || (cost(o) === cost(best) && o.fit > best.fit) ? o : best), null);
  const ear = (o) => o.fit - EAR_SHIFT_COST * Math.abs(o.shift);
  const pick = byName || options.reduce((best, o) => (ear(o) > ear(best) ? o : best));
  const now = options.find((o) => o.shift === Math.max(-6, Math.min(6, Math.round(mine.offset || 0))));
  return { shift: pick.shift + (target - whole), fit: pick.fit, fitNow: now.fit, steps: pick.steps, detune };
}
