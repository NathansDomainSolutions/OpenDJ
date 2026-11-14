// A track's beat grid.
//
// Beats sit 60 / bpm apart in *musical time*. For a track with one steady tempo, musical
// time is simply track time. For one whose tempo wanders, it is track time plus a slowly
// changing correction, the warp ({ step, d }: every `step` seconds of track, the ms musical
// time is ahead), found by the analyser (warp.js). Everything that needs beats (sync, loops,
// snapping, the lines on the waveform) asks this class, so it all follows the music.

export class BeatGrid {
  /** `track` needs bpm and beatOffset; downbeat, beatsPerBar and warp are optional. */
  constructor({ bpm, beatOffset, downbeat, beatsPerBar, warp }) {
    this.bpm = bpm;
    this.period = 60 / bpm; // musical seconds per beat
    this.offset = beatOffset; // musical time of a beat
    this.downbeat = downbeat ?? beatOffset; // musical time of a bar's first beat
    this.beatsPerBar = beatsPerBar || 4;
    this.warp = warp?.d?.length > 1 && warp.step > 0 ? warp : null;
  }

  /** The grid of a library track, or null when it has no tempo. Rebuilt only when the track's grid changes. */
  static of(track) {
    if (!track?.bpm || track.beatOffset == null) return null;
    const c = track._grid;
    if (c && c.bpm === track.bpm && c.offset === track.beatOffset && c.downbeat === (track.downbeat ?? track.beatOffset) && c.beatsPerBar === (track.beatsPerBar || 4) && c.source === (track.warp || null)) return c;
    const g = new BeatGrid(track);
    g.source = track.warp || null;
    Object.defineProperty(track, '_grid', { value: g, writable: true, enumerable: false, configurable: true }); // never saved with the track
    return g;
  }

  /**
   * Seconds musical time is ahead of track time at `pos` (or, with `slope`, how fast that is
   * changing there). A smooth curve through the stored points, so the tempo it implies
   * changes gradually and not in steps; flat before the first and after the last point.
   */
  shift(pos, slope = false) {
    const w = this.warp;
    if (!w) return 0;
    const d = w.d;
    const last = d.length - 1;
    const x = pos / w.step;
    if (x <= 0 || x >= last) return slope ? 0 : d[x <= 0 ? 0 : last] / 1000;
    const i = Math.min(last - 1, Math.floor(x));
    const u = x - i;
    // Cubic Hermite: through d[i] and d[i + 1], leaving each with the slope of its neighbours (flat at the ends).
    const m0 = i > 0 ? (d[i + 1] - d[i - 1]) / 2 : 0;
    const m1 = i + 1 < last ? (d[i + 2] - d[i]) / 2 : 0;
    const a = 2 * (d[i] - d[i + 1]) + m0 + m1;
    const b = 3 * (d[i + 1] - d[i]) - 2 * m0 - m1;
    return slope ? (((3 * a * u + 2 * b) * u + m0) / w.step) / 1000 : (((a * u + b) * u + m0) * u + d[i]) / 1000;
  }

  /** Track seconds → musical seconds. */
  musical(pos) {
    return pos + this.shift(pos);
  }

  /** Musical seconds → track seconds. */
  trackTime(m) {
    if (!this.warp) return m;
    let pos = m;
    for (let i = 0; i < 8; i++) pos = m - this.shift(pos); // the warp is nearly flat, so this settles in a few steps
    return pos;
  }

  /** How fast musical time runs at `pos` (1 = the average tempo; 1.02 = the band is 2% fast here). */
  tempoAt(pos) {
    return 1 + this.shift(pos, true);
  }

  /** The track's own tempo at `pos`, in BPM. */
  bpmAt(pos) {
    return this.bpm * this.tempoAt(pos);
  }

  /** Beats since the first downbeat at track position `pos` (fractional, negative before it). */
  beatAt(pos) {
    return (this.musical(pos) - this.downbeat) / this.period;
  }

  /** Track position of a beat counted from the first downbeat. */
  posAt(beat) {
    return this.trackTime(this.downbeat + beat * this.period);
  }

  /** The nearest beat to `pos`, as a track position. */
  nearest(pos) {
    return this.posAt(Math.round(this.beatAt(pos)));
  }

  /** Track seconds one beat lasts around `pos`. */
  beatSeconds(pos) {
    return this.period / this.tempoAt(pos);
  }
}
