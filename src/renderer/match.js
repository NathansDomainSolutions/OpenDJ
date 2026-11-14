// How well two tracks go together: tempo match, and one score for the library (tempo + key fit).

import { keyRelation } from './key.js';

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
