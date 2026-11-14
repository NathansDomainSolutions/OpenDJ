// Tempo maps for tracks that don't keep one tempo (a band playing without a click).
//
// A constant grid (BPM + first beat) can only sit on such a track for a few bars; the rest
// drifts off by a large part of a beat, and nothing can sync to it. So the analyser checks
// whether the constant grid holds across the whole track (gridHolds) and, when it doesn't,
// follows the beats one by one (trackBeats) and stores how far the track runs ahead of or
// behind a steady pulse: the warp. Beat maths everywhere else then works in "musical time"
// (track time + warp, see beatgrid.js), where the beats are evenly spaced again.

const TIGHT_FIRST = 100; // how strongly a beat is held to the expected spacing: first pass, global tempo
const TIGHT_LOCAL = 600; // second pass, around the local tempo found by the first
const WARP_STEP = 2; // seconds between stored warp points

/** Beat strength per envelope frame: kicks count double, both bands scaled to their own spread. */
function beatStrength(c) {
  const { env, bass } = c;
  const n = env.length;
  const sd = (x) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] > 0 ? x[i] * x[i] : 0;
    return Math.sqrt(s / n) || 1;
  };
  const se = sd(env);
  const sb = sd(bass);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = (bass[i] > 0 ? bass[i] / sb : 0) + 0.5 * (env[i] > 0 ? env[i] / se : 0);
  return e;
}

/**
 * Does a constant grid (period P frames, a beat at frame a) hold over the whole track?
 * Every 8 beats, find where the hits fall within a quarter beat (so syncopation, which moves
 * hits by whole quarters, doesn't count) and see whether those places agree along the track.
 * Returns 0…1: near 1 = one steady tempo; a drifting track scatters and scores low.
 */
export function gridHolds(c, P, a) {
  const e = c.strength || (c.strength = beatStrength(c));
  const q = P / 4;
  const nb = Math.max(8, Math.round(q));
  const hist = new Float64Array(nb);
  let mean = 0;
  for (let i = 0; i < e.length; i++) mean += e[i];
  mean /= e.length || 1;
  let sx = 0, sy = 0, sw = 0;
  for (let s = Math.max(0, a - Math.floor(a / P) * P); s + 8 * P < e.length; s += 4 * P) {
    hist.fill(0);
    let tot = 0;
    const i1 = Math.floor(s + 8 * P);
    for (let i = Math.floor(s); i < i1; i++) {
      if (!(e[i] > 0)) continue;
      const ph = (((i - a) / q) % 1 + 1) % 1;
      hist[Math.min(nb - 1, Math.floor(ph * nb))] += e[i];
      tot += e[i];
    }
    if (tot < 0.3 * mean * (i1 - Math.floor(s))) continue; // a breakdown: no vote
    let best = 0, bv = -1;
    for (let b = 0; b < nb; b++) {
      const v = hist[(b + nb - 1) % nb] + 2 * hist[b] + hist[(b + 1) % nb];
      if (v > bv) { bv = v; best = b; }
    }
    const w = bv / 4 - tot / nb; // how far the peak stands above a flat spread
    if (!(w > 0)) continue;
    const th = (2 * Math.PI * (best + 0.5)) / nb;
    sx += w * Math.cos(th);
    sy += w * Math.sin(th);
    sw += w;
  }
  return sw > 0 ? Math.hypot(sx, sy) / sw : 1;
}

/**
 * One pass of beat tracking (dynamic programming, after Ellis 2007): choose the beat frames
 * that collect the most strength while keeping each step close to the expected spacing
 * `period(i)` (frames). Returns the beat frames in order.
 */
function beatPath(e, period, tight) {
  const n = e.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = period(i);
    let best = 0; // starting here costs nothing
    let from = -1;
    const lo = Math.max(0, Math.round(i - 2 * p));
    const hi = Math.round(i - p / 2);
    for (let j = lo; j <= hi; j++) {
      const l = Math.log((i - j) / p);
      const v = score[j] - tight * l * l;
      if (v > best) { best = v; from = j; }
    }
    score[i] = e[i] + best;
    back[i] = from;
  }
  // End on the best frame within the last beat, then walk back.
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(period(n - 1))); i < n; i++) if (score[i] > score[end]) end = i;
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

/** Running median of x over ±half entries. */
function medianFilter(x, half) {
  return x.map((_, i) => {
    const w = x.slice(Math.max(0, i - half), i + half + 1).sort((p, q) => p - q);
    return w[w.length >> 1];
  });
}

const SUB = 4; // beats are followed in quarter-beat steps

/**
 * Follow a wandering tempo. P = the track's overall beat period in frames (from the constant
 * fit). Returns a Pulse (the beats it found, and musical time), or null when there are too
 * few beats to follow. Which hit is "the beat" is only settled between stretches here; the
 * caller fits the usual constant grid in musical time for the final answer.
 *
 * The pulse is followed in quarter beats, not whole ones: hits on off-beats and sixteenths
 * all sit on that finer pulse, so there is only one way to lay it over the music, where a
 * whole-beat tracker can slide half a beat whenever the off-beats are louder.
 */
export function followPulse(c, P) {
  const e = c.strength || (c.strength = beatStrength(c));
  // First pass around the overall tempo, then twice around the local tempo that pass found:
  // those can hold every step firmly, so the pulse bends only where the music does.
  let steps = beatPath(e, () => P / SUB, TIGHT_FIRST);
  if (steps.length < 16 * SUB) return null;
  for (let pass = 0; pass < 2; pass++) {
    const gaps = steps.slice(1).map((b, i) => b - steps[i]);
    // Local spacing: the average over ±2 beats (single gaps are whole frames), then its running median.
    const mean = gaps.map((_, i) => {
      const lo = Math.max(0, i - 2 * SUB), hi = Math.min(gaps.length, i + 2 * SUB + 1);
      return (steps[hi] - steps[lo]) / (hi - lo);
    });
    const local = medianFilter(mean, 4 * SUB);
    const at = steps.slice(1);
    let k = 0;
    steps = beatPath(e, (i) => {
      while (k + 1 < at.length && at[k + 1] <= i) k++;
      while (k > 0 && at[k] > i) k--;
      return local[k];
    }, TIGHT_LOCAL);
    if (steps.length < 16 * SUB) return null;
  }

  // Sub-frame times: the peak of the strength curve around each chosen frame.
  const t = steps.map((b) => {
    if (b < 1 || b + 1 >= e.length) return b;
    const y0 = e[b - 1], y1 = e[b], y2 = e[b + 1];
    const d = y0 - 2 * y1 + y2;
    return d < 0 && y1 >= y0 && y1 >= y2 ? b + (0.5 * (y0 - y2)) / d : b;
  });
  const n = t.length;

  // Breakdowns: long stretches with little to follow (under 40% of the usual strength).
  // The pulse coasts through them and can come out a quarter beat off.
  const loud = steps.map((_, i) => {
    let sum = 0;
    for (let k = Math.max(0, i - SUB); k <= Math.min(n - 1, i + SUB); k++) sum += e[steps[k]];
    return sum;
  });
  const usual = [...loud].sort((x, y) => x - y)[n >> 1];
  const weak = loud.map((v) => v < 0.4 * usual);
  // Only a long one counts (8 beats or more): shorter gaps can't shake the pulse off.
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && weak[j] === weak[i]) j++;
    if (weak[i] && j - i < 8 * SUB) weak.fill(false, i, j);
    i = j;
  }

  // Which quarter is the beat? The one that carries the kick, decided on the longest
  // stretch between breakdowns; another
  // stretch keeps that answer unless its own kick clearly says otherwise (the pulse came
  // out of the breakdown before it a quarter off). A louder off-beat alone is syncopation.
  const at = (x, v) => {
    const i = Math.floor(x);
    return i >= 0 && i + 1 < v.length ? Math.max(0, v[i] + (v[i + 1] - v[i]) * (x - i)) : 0;
  };
  const choose = (from, to) => {
    const kick = new Float64Array(SUB);
    for (let i = from; i < to; i++) kick[i % SUB] += at(t[i], c.bass);
    return { r: kick.indexOf(Math.max(...kick)), kick };
  };
  const stretches = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && weak[j] === weak[i]) j++;
    if (!weak[i]) stretches.push({ from: i, to: j });
    i = j;
  }
  if (!stretches.length) return null;
  const main = stretches.reduce((x, y) => (y.to - y.from > x.to - x.from ? y : x));
  main.r = choose(main.from, main.to).r;
  const settle = (st, near) => {
    const own = choose(st.from, st.to);
    st.r = st.to - st.from >= 16 * SUB && own.kick[own.r] > 1.5 * own.kick[near.r] ? own.r : near.r;
  };
  const m = stretches.indexOf(main);
  for (let k = m + 1; k < stretches.length; k++) settle(stretches[k], stretches[k - 1]);
  for (let k = m - 1; k >= 0; k--) settle(stretches[k], stretches[k + 1]);
  const quarter = new Int8Array(n);
  for (let k = 0, i = 0; k < stretches.length; k++) {
    const end = k + 1 < stretches.length ? stretches[k + 1].from : n; // a breakdown takes the label before it; it has no say anyway
    for (; i < end; i++) quarter[i] = stretches[k].r;
  }

  // Count beats along the pulse. Where the beat's quarter changed, the count jumps by a
  // fraction; that jump belongs to the whole breakdown around it, so those steps get no say
  // and the curve below bridges them.
  const beat = new Float64Array(n);
  const say = steps.map((b, i) => (weak[i] ? 0 : 0.1 + e[b]));
  beat[0] = -quarter[0] / SUB; // so the steps that are beats get whole numbers
  for (let i = 1; i < n; i++) {
    let jump = (quarter[i - 1] - quarter[i]) / SUB;
    if (jump > 0.5) jump -= 1;
    if (jump < -0.5) jump += 1;
    beat[i] = beat[i - 1] + 1 / SUB + jump;
  }

  // A drummer's tempo moves over bars, not from one hit to the next: each beat's time comes
  // from a line through the steps around it (about ±6 beats, nearer and stronger ones
  // counting more; wider where a breakdown leaves too few).
  const firstBeat = Math.ceil(beat[0] - 1e-9);
  const lastBeat = Math.floor(beat[n - 1] + 1e-9);
  const heardFrom = beat[say.findIndex((v) => v > 0)]; // the first and last steps with something to go by
  const heardTo = beat[say.findLastIndex((v) => v > 0)];
  const frames = [];
  for (let b = firstBeat, lo = 0; b <= lastBeat; b++) {
    let fit = null;
    while (lo < n - 1 && beat[lo] < b - 6) lo++;
    for (let reach = 6, start = lo; fit == null && reach <= 400; reach *= 2) {
      while (start > 0 && beat[start - 1] >= b - reach) start--;
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, sides = 0;
      for (let i = start; i < n && beat[i] <= b + reach; i++) {
        const g = say[i] * Math.exp(-0.5 * ((beat[i] - b) / (reach / 2)) ** 2);
        if (!(g > 0)) continue;
        sides |= beat[i] < b ? 1 : 2;
        sw += g; sx += g * beat[i]; sy += g * t[i]; sxx += g * beat[i] * beat[i]; sxy += g * beat[i] * t[i];
      }
      const den = sw * sxx - sx * sx;
      // Needs steps on both sides, so a gap is bridged rather than extended from one side
      // (a quiet intro or outro has only one side: the line simply carries on).
      if (den > 1e-9 && (sides === 3 || b <= heardFrom || b >= heardTo)) {
        const slope = (sw * sxy - sx * sy) / den;
        fit = (sy - slope * sx) / sw + slope * b;
      }
    }
    if (fit == null) return null;
    frames.push(fit);
  }
  if (frames.length < 16) return null;
  // No band changes tempo by a tenth from one beat to the next: where the pulse says so
  // (a ragged outro, a fill), hold the spacing to within 10% of the beats around it.
  const gaps = frames.slice(1).map((x, i) => x - frames[i]);
  const usualGap = medianFilter(gaps, 8);
  const kept = gaps.map((g, i) => Math.max(0.9 * usualGap[i], Math.min(1.1 * usualGap[i], g)));
  const centre = frames.length >> 1; // rebuilt outwards from the middle, which stays put
  for (let i = centre + 1; i < frames.length; i++) frames[i] = frames[i - 1] + kept[i - 1];
  for (let i = centre - 1; i >= 0; i--) frames[i] = frames[i + 1] - kept[i];
  return new Pulse(frames, e.length);
}

/**
 * A followed pulse: the frame of every beat it found, and from that "musical time", in which
 * those beats are evenly spaced at the track's average tempo. Before the first and after the
 * last beat the track is taken to keep that average tempo.
 */
class Pulse {
  constructor(frames, length) {
    this.frames = frames;
    this.length = length;
    this.period = (frames[frames.length - 1] - frames[0]) / (frames.length - 1); // average frames per beat
  }

  /** Frame → musical frame. */
  musical(x) {
    const f = this.frames;
    const N = f.length;
    if (x <= f[0] || x >= f[N - 1]) return x; // the two ends agree with track time by the choice of period
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid] <= x) lo = mid;
      else hi = mid;
    }
    return f[0] + (lo + (x - f[lo]) / (f[lo + 1] - f[lo])) * this.period;
  }

  /** Musical frame → frame. */
  track(m) {
    const f = this.frames;
    const N = f.length;
    if (m <= f[0] || m >= f[N - 1]) return m;
    const b = (m - f[0]) / this.period;
    const i = Math.min(N - 2, Math.floor(b));
    return f[i] + (b - i) * (f[i + 1] - f[i]);
  }

  /** An envelope resampled onto musical time, where its beats are evenly spaced. */
  unwarp(v) {
    const out = new Float32Array(v.length);
    for (let m = 0; m < out.length; m++) {
      const x = this.track(m);
      const i = Math.floor(x);
      out[m] = i >= 0 && i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * (x - i) : 0;
    }
    return out;
  }

  /** The stored tempo map: every WARP_STEP seconds of track, the ms musical time is ahead. R = frames per second. */
  warp(R) {
    const d = [];
    for (let pos = 0; pos <= this.length / R + WARP_STEP; pos += WARP_STEP) d.push(Math.round((this.musical(pos * R) - pos * R) * (1e4 / R)) / 10);
    return { step: WARP_STEP, d };
  }
}
