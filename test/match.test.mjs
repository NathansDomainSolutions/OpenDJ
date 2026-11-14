// Tempo match, key fit, Key Match tuning and the beat-match meter. Run: node test/match.test.mjs
import { tempoMatch, mixFit } from '../src/renderer/match.js';
import { wheel, wheelSteps, keyRelation, keyMatch, camelot, transposeKey } from '../src/renderer/key.js';
import { BeatGrid } from '../src/renderer/beatgrid.js';
import { beatGap } from '../src/renderer/sync.js';
import { detectKey } from '../src/renderer/analysis.js';

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) fails++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- tempo match: the smallest stretch at ½×, 1× or 2×
{
  const same = tempoMatch(120, 124);
  check('tempo match 120 → 124', same.k === 1 && near(same.rate, 124 / 120, 1e-9), `rate ${same.rate.toFixed(4)}`);
  const half = tempoMatch(87, 174);
  check('tempo match 87 → 174 runs at half time', half.k === 0.5 && near(half.rate, 1, 1e-9));
  const dbl = tempoMatch(170, 86);
  check('tempo match 170 → 86 runs at double time', dbl.k === 2 && near(dbl.rate, 172 / 170, 1e-9));
  check('tempo match needs both tempos', tempoMatch(null, 120) === null && tempoMatch(120, 0) === null);
}

// ---- Camelot wheel and key fit (keys: 0–11 major from C, 12–23 minor from C)
{
  const C = 0, G = 7, F = 5, Fs = 6, Am = 21, Em = 16, Dm = 14;
  const all = Array.from({ length: 24 }, (_, k) => k);
  check('wheel agrees with camelot() for all 24 keys', all.every((k) => `${wheel(k).n}${wheel(k).minor ? 'A' : 'B'}` === camelot(k)));
  check('same key', keyRelation(Am, Am) === 'same');
  check('relative major / minor', keyRelation(C, Am) === 'relative' && keyRelation(Am, C) === 'relative');
  check('a fifth up or down is adjacent', keyRelation(C, G) === 'adjacent' && keyRelation(C, F) === 'adjacent' && keyRelation(Am, Em) === 'adjacent' && keyRelation(Am, Dm) === 'adjacent');
  check('12 wraps round to 1', all.some((a) => all.some((b) => wheel(a).n === 12 && wheel(b).n === 1 && keyRelation(a, b) === 'adjacent')));
  check('a tritone clashes', keyRelation(C, Fs) === null);
  check('a step away counts in either mode (same notes as its relative)', keyRelation(C, Em) === 'adjacent' && keyRelation(Am, G) === 'adjacent');
  check('two steps away clashes', keyRelation(C, 2) === null && keyRelation(C, 23) === null);
  check('unknown keys never match', keyRelation(null, C) === null && keyRelation(-1, C) === null && keyRelation(C, undefined) === null);
  check('every key has 6 matches: itself, its relative, and 4 a step away', all.every((a) => all.filter((b) => keyRelation(a, b)).length === 6));
}

// ---- library order: what mixes best with the deck on air comes first
{
  const ref = { bpm: 124, key: 21 }; // A minor
  const fit = (bpm, key) => mixFit({ bpm, key }, ref);
  const perfect = fit(124, 21);
  check('same tempo and key scores 1', near(perfect.score, 1, 1e-9) && perfect.near && perfect.key === 'same');
  check('a near tempo in key beats a far tempo in key', fit(126, 21).score > fit(140, 21).score);
  check('in key beats a clash at the same tempo', fit(124, 0).score > fit(124, 6).score);
  check('half-time tracks count as near', fit(62, 21).near && fit(62, 21).k === 0.5);
  check('6% is near, 12% is not', fit(124 / 1.05, 21).near && !fit(124 / 1.12, 21).near);
  check('no BPM, no key: score 0', fit(null, null).score === 0 && !fit(null, null).near);
  const order = [fit(140, 6), fit(125, 16), fit(124, 21), fit(131, 0)].map((f) => f.score);
  check('scores order a small crate sensibly', order[2] > order[1] && order[1] > order[3] && order[3] > order[0], order.map((s) => s.toFixed(2)).join(' '));
}

// ---- tuning: detected per track, and taken out by Key Match
const sr = 44100;
function drums(seconds, bpm = 124) {
  const d = new Float32Array(sr * seconds);
  const beat = 60 / bpm;
  for (let b = 0; 0.1 + b * beat < seconds; b++) {
    const i0 = Math.round((0.1 + b * beat) * sr);
    for (let i = 0; i < 0.25 * sr && i0 + i < d.length; i++) {
      const t = i / sr;
      d[i0 + i] += Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.8;
    }
  }
  return d;
}
/** A chord progression over drums, tuned `cents` away from concert pitch. */
function progression(chords, cents, seconds = 40) {
  const buf = drums(seconds);
  const bar = 240 / 124;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    let s = 0;
    chords[Math.floor(t / bar) % chords.length].forEach((m, j) => {
      const f = 440 * 2 ** (((j === 0 ? m - 12 : m) - 69 + cents / 100) / 12);
      for (let h = 1; h <= 4; h++) s += (Math.sin(2 * Math.PI * f * h * t) * 0.06) / h;
    });
    buf[i] += s;
  }
  return buf;
}
const maj = (r) => [r, r + 12, r + 16, r + 19];
const min = (r) => [r, r + 12, r + 15, r + 19];
{
  const inC = [maj(48), maj(53), maj(55), maj(48)]; // C F G C
  const inD = [maj(50), maj(55), maj(57), maj(50)]; // D G A D
  const sharp = detectKey(progression(inC, 30), sr);
  const flat = detectKey(progression(inD, -20), sr);
  const tuned = detectKey(progression(inC, 0), sr);
  check('tuning: +30 cents measured', near(sharp.tuning, 0.3, 0.04), `${sharp.tuning}`);
  check('tuning: −20 cents measured', near(flat.tuning, -0.2, 0.04), `${flat.tuning}`);
  check('tuning: concert pitch reads 0', near(tuned.tuning, 0, 0.03), `${tuned.tuning}`);
  check('tuning: drums alone read 0', (detectKey(drums(20), sr)?.tuning ?? 0) === 0);
  check('tuning does not change the key found', sharp.key === 0 && flat.key === 2 && tuned.key === 0);

  const side = (k, offset = 0) => ({ key: k.key, chroma: k.chroma, tuning: k.tuning, offset });
  // D (20 cents flat) onto C (30 cents sharp): down two semitones, then up the 50 cents between them.
  const m = keyMatch(side(flat), side(sharp));
  check('key match takes the tuning difference out', near(m.shift, -1.5, 0.06) && near(m.detune, 0.5, 0.06), `shift ${m.shift.toFixed(2)}, detune ${m.detune.toFixed(2)}`);
  const same = keyMatch(side(tuned), side(sharp));
  check('same key, 30 cents apart: a 0.3 semitone shift', near(same.shift, 0.3, 0.04), `shift ${same.shift.toFixed(2)}`);
  const none = keyMatch(side(tuned), side(tuned));
  check('same key, same tuning: no shift', near(none.shift, 0, 1e-9));
  // The other deck already plays +1 semitone (key shift or tempo): follow that too.
  const moved = keyMatch(side(tuned), side(tuned, 1));
  check('follows the other deck\'s own shift', near(moved.shift, 1, 1e-9));
  check('no chroma: no match', keyMatch({ chroma: null }, side(tuned)) === null);
  const am = detectKey(progression([min(57), min(50), min(52), min(57)], 0), sr);
  check('relative keys need no shift', near(keyMatch(side(am), side(tuned)).shift, 0, 1e-9), `A minor onto C: ${keyMatch(side(am), side(tuned)).shift}`);
}

// ---- Key Match picks the nearest key that mixes (ideal note profiles for each key)
{
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const chroma = (key) => Array.from({ length: 12 }, (_, i) => (key >= 12 ? KK_MINOR : KK_MAJOR)[(i - (key % 12) + 12) % 12]);
  const track = (key, read = key) => ({ key: read, chroma: chroma(key) });
  const C = 0, D = 2, E = 4, Fs = 6, G = 7;
  const shift = (a, b) => keyMatch(a, b).shift;
  check('same key: stays', shift(track(C), track(C)) === 0);
  check('a fifth apart already mixes: stays', shift(track(C), track(G)) === 0 && keyMatch(track(C), track(G)).steps === 1);
  check('exact: a fifth apart moves to the very same key', keyMatch(track(C), track(G), { exact: true }).shift === -5 && keyMatch(track(C), track(G), { exact: true }).steps === 0);
  check('a tone apart: 2 semitones to the same key', shift(track(D), track(C)) === -2 && keyMatch(track(D), track(C)).steps === 0);
  check('a tritone apart: 1 semitone, not 6', Math.abs(shift(track(Fs), track(C))) === 1);
  check('a major third apart: 1 semitone, not 4', shift(track(E), track(C)) === 1); // E → F, next to C
  const all = Array.from({ length: 24 }, (_, k) => k);
  const pairs = all.flatMap((a) => all.map((b) => [a, b]));
  const landed = pairs.map(([a, b]) => ({ a, b, s: shift(track(a), track(b)) }));
  check('all 576 pairs: never more than 3 semitones', landed.every((p) => Math.abs(p.s) <= 3), `mean ${(landed.reduce((n, p) => n + Math.abs(p.s), 0) / 576).toFixed(2)}`);
  check('all 576 pairs: lands on the same notes or one step away', landed.every((p) => wheelSteps(transposeKey(p.a, p.s), p.b) <= 1));
  // Key names can be wrong; the notes have the last word.
  check('a track misread as its relative key matches the same', pairs.every(([a, b]) => shift(track(a, a < 12 ? ((a + 9) % 12) + 12 : (a + 3) % 12), track(b)) === shift(track(a), track(b))));
  check('names that say "same key" over clashing notes: goes by ear', shift(track(Fs, C), track(C)) === 6 || shift(track(Fs, C), track(C)) === -6);
  check('no key names: goes by ear to the same key', shift(track(D, -1), track(C, -1)) === -2 && keyMatch(track(D, -1), track(C, -1)).steps === null);
  check('follows the other deck\'s shift and tuning together', near(keyMatch(track(C), { ...track(C), offset: 2, tuning: 0.25 }).shift, 2.25, 1e-9));
}

// ---- beat-match meter: how far one deck's beats are from another's
{
  const deck = (bpm, speed, pos, offset = 0) => {
    const grid = new BeatGrid({ bpm, beatOffset: offset });
    return { grid, speed, effectiveBpm: bpm * speed, positionAt: (t) => pos + t * speed };
  };
  const a = deck(120, 1, 10); // on a beat at t = 0
  check('together: 0', near(beatGap(deck(120, 1, 4), a, 0), 0, 1e-9));
  check('20 ms ahead', near(beatGap(deck(120, 1, 4.02), a, 0), 0.02, 1e-9));
  check('20 ms behind', near(beatGap(deck(120, 1, 3.98), a, 0), -0.02, 1e-9));
  check('stays put while both run at one tempo', near(beatGap(deck(120, 1, 4.02), a, 7.3), 0.02, 1e-9));
  check('heard time, not track time', near(beatGap(deck(100, 1.2, 6.024), a, 0), 0.02, 1e-9)); // 24 ms of track at 1.2× = 20 ms
  check('double time lines up with every beat', near(beatGap(deck(240, 1, 4), a, 0), 0, 1e-9) && near(beatGap(deck(240, 1, 4.01), a, 0), 0.01, 1e-9));
  check('half time lines up on the other deck\'s beats', near(beatGap(deck(60, 1, 4), a, 0), 0, 1e-9) && near(beatGap(deck(60, 1, 4.03), a, 0), 0.03, 1e-9));
  check('never more than half a beat', Math.abs(beatGap(deck(120, 1, 4.3), a, 0)) <= 0.25 + 1e-9);
}

// ---- beat grid with a tempo map: beats where the music is, and maths that round-trips
{
  // A track that runs 2% fast for its first 40 s, then 2% slow: musical time gains 0.8 s, then loses it.
  const d = [];
  for (let pos = 0; pos <= 82; pos += 2) d.push(Math.round((pos <= 40 ? 0.02 * pos : 0.8 - 0.02 * (pos - 40)) * 1e4) / 10);
  const g = new BeatGrid({ bpm: 120, beatOffset: 0, warp: { step: 2, d } });
  check('no warp: beats are evenly spaced in track time', near(new BeatGrid({ bpm: 120, beatOffset: 0.25 }).posAt(7), 3.75, 1e-12));
  check('fast section: beats come sooner', near(g.posAt(40), 20 / 1.02, 1e-6), `beat 40 at ${g.posAt(40).toFixed(4)} s`);
  check('local tempo follows the map', near(g.bpmAt(10), 122.4, 1e-6) && near(g.bpmAt(60), 117.6, 1e-6));
  check('the map ends where it began: last beats back on the steady pulse', near(g.posAt(160), 80, 1e-6));
  let worst = 0;
  for (let p = 0.1; p < 80; p += 0.37) worst = Math.max(worst, Math.abs(g.posAt(g.beatAt(p)) - p));
  check('position → beat → position round-trips', worst < 1e-9, `${worst.toExponential(1)} s`);
  check('nearest beat', near(g.nearest(g.posAt(12) + 0.1), g.posAt(12), 1e-9));
  const t = { bpm: 120, beatOffset: 0 };
  check('one grid object per track until its grid changes', BeatGrid.of(t) === BeatGrid.of(t) && BeatGrid.of(Object.assign(t, { bpm: 60 })).bpm === 60 && BeatGrid.of({ title: 'no tempo' }) === null && !Object.keys(t).includes('_grid'));
}

console.log(fails ? `${fails} match test(s) failed` : 'all match tests passed');
process.exit(fails ? 1 : 0);
