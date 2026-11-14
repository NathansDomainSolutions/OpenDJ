// Beat sync.
//
// Pressing Sync does what a DJ expects: the deck takes the other deck's tempo (at ½×, 1× or
// 2×, whichever is nearest its own) and its beats are put on the other deck's beats, now.
// Then it stays that way.
//
// How: the synced decks share one clock. The clock is the beat count of one of them, the
// reference, read off that deck's beat grid along a playhead that moves at its tempo. Every
// other deck is told where it should be (its own beat for the clock's beat) and how fast to
// go, and is kept there: errors under 15 ms are trimmed away without a sound, larger ones
// (after a scratch, say) are jumped. Because the clock reads the reference's beat grid, a
// reference whose tempo wanders (a band without a click) is followed bar by bar, and a
// follower that wanders is sped up and slowed down to stay on it.
//
// The grids are trusted: the tempo and beats shown on a deck are what it syncs by. Nothing
// here re-reads a track's tempo or moves a deck by ear. If a grid is wrong, fix the grid
// (÷2, ×2, Alt, Tap, Beat 1) and sync follows.

import { LOOKAHEAD } from './engine.js';

const TICK = 0.025; // seconds between corrections
const HOLD = 0.0002; // closer than this (heard seconds) is left alone
const TRIM = 0.004; // largest speed trim: 0.4%, about 7 cents, below what anyone hears
const JUMP = 0.015; // further out than this is jumped back in place instead
const JUMP_GAP = 0.4; // seconds between two jumps of one deck at least

const wrap = (x) => x - Math.round(x); // into [-0.5, 0.5)

/** The tempo ratios a deck can sync at, nearest first for a deck `r` times the clock's tempo. */
function nearestRatio(r) {
  return r > Math.SQRT2 ? 2 : r < Math.SQRT1_2 ? 0.5 : 1;
}

/**
 * How far `deck`'s beats are from `other`'s at context time t, in heard seconds (+ = ahead; at
 * most half a beat of the faster deck). Needs no sync: it's what a DJ lines up by ear. A deck
 * at about double or half the other's tempo is compared at that ratio.
 */
export function beatGap(deck, other, t) {
  const pos = deck.positionAt(t);
  const mine = deck.grid.beatAt(pos);
  const theirs = other.grid.beatAt(other.positionAt(t));
  const k = nearestRatio(deck.effectiveBpm / other.effectiveBpm);
  const beat = deck.grid.beatSeconds(pos) / deck.speed; // heard seconds
  return k === 0.5 ? wrap(2 * mine - theirs) * (beat / 2) : wrap(mine - k * theirs) * beat;
}

export class SyncGroup {
  constructor(mixer, { onChange = () => {} } = {}) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.onChange = onChange;
    // deck -> { k, offset }: the deck runs at k beats per clock beat, `offset` of its own beats
    // ahead of the clock (0 unless nudged).
    this.members = new Map();
    this.ref = null; // the deck whose grid the clock reads
    this.refPos = 0; // the clock's playhead: reference track position…
    this.refTime = 0; // …at this context time…
    this.refRate = 1; // …moving at this rate
    this.parked = true; // no member playing: the clock waits for the next one to start
    this.told = 0;
    this.timer = setInterval(() => this.tick(), TICK * 1000);
  }

  has(deck) {
    return this.members.has(deck);
  }

  // ---------------------------------------------------------------- the clock

  /** Where the clock's playhead is on the reference track at context time t. */
  playhead(t) {
    return this.refPos + (t - this.refTime) * this.refRate;
  }

  /** The clock's beat at context time t (in reference beats). */
  beat(t) {
    return this.ref.grid.beatAt(this.playhead(t));
  }

  /** Clock beats per second at context time t. */
  beatRate(t) {
    return this.refRate / this.ref.grid.beatSeconds(this.playhead(t));
  }

  /** The clock's tempo as heard, in BPM. */
  get bpm() {
    return this.ref ? this.beatRate(this.ctx.currentTime) * 60 : null;
  }

  /** The beat (of its own grid) a member should be on at context time t. */
  target(deck, t) {
    const m = this.members.get(deck);
    return m.k * this.beat(t) + m.offset;
  }

  /** The playback rate that keeps a member with the clock at context time t. */
  rateFor(deck, t) {
    return this.members.get(deck).k * this.beatRate(t) * deck.grid.beatSeconds(deck.positionAt(t));
  }

  /**
   * Make `deck` the reference, with the clock's playhead at `pos` on it at context time `t`.
   * Every member keeps the beat it was due on, so nothing moves.
   */
  setRef(deck, pos, t) {
    const due = new Map();
    if (this.ref) for (const d of this.members.keys()) due.set(d, this.target(d, t));
    const base = this.members.get(deck).k;
    this.ref = deck;
    this.refPos = pos;
    this.refTime = t;
    this.refRate = deck.rate;
    const now = this.beat(t);
    for (const [d, m] of this.members) {
      m.k /= base;
      m.offset = due.has(d) ? wrap(due.get(d) - m.k * now) : 0;
    }
  }

  // ---------------------------------------------------------------- joining and leaving

  /**
   * Sync `deck` with `partner`. A new pair takes its tempo and beat from whichever of the
   * two is playing (the partner if both or neither); a deck joining a group takes the
   * group's. `forcedK` (0.5 or 2) overrides the tempo ratio.
   * Returns { ok, reason?, k?, bpm? }.
   */
  join(deck, partner, { forcedK } = {}) {
    if (!deck.grid) return { ok: false, reason: 'no-bpm' };
    if (!this.members.size) {
      if (!partner?.grid) return { ok: false, reason: 'no-partner' };
      const lead = deck.playing && !partner.playing ? deck : partner;
      const t = this.ctx.currentTime + LOOKAHEAD;
      this.members.set(lead, { k: 1, offset: 0 });
      this.ref = null;
      this.setRef(lead, lead.positionAt(t), t);
      this.parked = !lead.playing;
      this.add(lead === deck ? partner : deck, lead === deck ? partner.forcedK : forcedK);
    } else {
      if (partner?.grid && !this.has(partner)) this.add(partner, partner.forcedK);
      this.add(deck, forcedK);
    }
    this.onChange();
    return { ok: true, k: this.members.get(deck).k / this.members.get(this.ref).k, bpm: this.bpm };
  }

  /** Bring a deck onto the clock: tempo now, and if it is playing, its beats onto the clock's beats. */
  add(deck, forcedK) {
    const t = this.ctx.currentTime + LOOKAHEAD;
    const k = forcedK || nearestRatio(deck.bpm / (this.beatRate(t) * 60));
    this.members.set(deck, { k, offset: 0 });
    deck.setRate(this.rateFor(deck, t), { silent: true });
    if (deck.playing && !this.parked) this.place(deck, t);
  }

  /** Put a playing member's beats on the clock's at context time `t`: the nearest beat, so it moves half a beat at most. */
  place(deck, t) {
    const g = deck.grid;
    const beat = g.beatAt(deck.positionAt(t));
    let to = beat - wrap(beat - this.target(deck, t));
    if (g.posAt(to) < 0) to += 1;
    deck.jumpTo(g.posAt(to), t);
    this.members.get(deck).jumped = t;
  }

  leave(deck) {
    if (!this.members.delete(deck)) return;
    if (this.members.size < 2) {
      this.members.clear(); // a pair is the smallest group: the last deck goes free too
      this.ref = null;
      this.parked = true;
    } else if (deck === this.ref) this.handOver();
    this.onChange();
  }

  clear() {
    if (!this.members.size) return;
    this.members.clear();
    this.ref = null;
    this.parked = true;
    this.onChange();
  }

  /** The reference left the group: another member carries the clock on, and everyone stays where they are. */
  handOver() {
    const t = this.ctx.currentTime;
    const next = [...this.members.keys()].find((d) => d.playing) || this.members.keys().next().value;
    const base = this.members.get(next).k;
    this.ref = next;
    this.refPos = next.positionAt(t);
    this.refTime = t;
    this.refRate = next.rate;
    const beat = this.beat(t);
    for (const [d, m] of this.members) {
      m.k /= base;
      m.offset = d.playing ? wrap(d.grid.beatAt(d.positionAt(t)) - m.k * beat) : 0;
    }
  }

  // ---------------------------------------------------------------- the DJ's hands

  /**
   * A member's tempo was moved by hand (it is already at its new rate): the clock takes that
   * change and every other member follows. Returns the decks that moved, for the UI.
   */
  setTempoFrom(deck) {
    if (!this.has(deck) || !this.ref) return [];
    const t = this.ctx.currentTime;
    const pos = this.playhead(t);
    if (deck !== this.ref) {
      const was = this.rateFor(deck, t);
      if (!(was > 0)) return [];
      this.refRate *= deck.rate / was;
      this.ref.setRate(this.refRate, { silent: true });
    } else this.refRate = deck.rate;
    this.refPos = pos;
    this.refTime = t;
    const moved = [];
    for (const d of this.members.keys()) {
      if (d === deck) continue;
      if (d !== this.ref) d.setRate(this.rateFor(d, t), { silent: true });
      moved.push({ deck: d });
    }
    this.onChange();
    return moved;
  }

  /** A nudge on a member sticks: it keeps the place it was nudged to. */
  keepOffset(deck) {
    const m = this.members.get(deck);
    if (!m || !deck.playing || this.parked) return;
    const t = this.ctx.currentTime;
    m.offset = wrap(deck.grid.beatAt(deck.positionAt(t)) - m.k * this.beat(t));
  }

  /** Where a seek to `pos` should land so the deck stays on the beat: the same place in the beat as now. */
  quantizeSeek(deck, pos) {
    if (!this.has(deck) || !deck.playing) return pos;
    const g = deck.grid;
    const to = g.beatAt(pos);
    let beat = to + wrap(g.beatAt(deck.position) - to);
    if (g.posAt(beat) < 0) beat += 1;
    return g.posAt(beat);
  }

  /**
   * A member is about to start: where and when. It starts at once, at the place nearest its
   * cue that is on the clock's beat right now (so up to half a beat before or after the cue).
   * If nothing else is playing it simply starts from its cue and carries the clock.
   */
  startPlan(deck) {
    if (!this.has(deck)) return null;
    const when = this.ctx.currentTime + LOOKAHEAD;
    const others = [...this.members.keys()].some((d) => d !== deck && d.playing);
    if (!others) {
      this.setRef(deck, deck.pausedPos, when);
      this.parked = false;
      return { at: deck.pausedPos, when };
    }
    deck.setRate(this.rateFor(deck, when), { silent: true });
    const g = deck.grid;
    const cue = g.beatAt(deck.pausedPos);
    let beat = cue - wrap(cue - this.target(deck, when));
    if (g.posAt(beat) < 0) beat += 1;
    return { at: g.posAt(beat), when };
  }

  /** How far a playing member is from its place on the clock, in heard ms (+ = ahead); null when it has none. */
  errorMs(deck) {
    if (!this.has(deck) || !deck.playing || this.parked || !this.ref) return null;
    const t = this.ctx.currentTime;
    const pos = deck.positionAt(t);
    return ((wrap(deck.grid.beatAt(pos) - this.target(deck, t)) * deck.grid.beatSeconds(pos)) / deck.speed) * 1000;
  }

  // ---------------------------------------------------------------- holding it together

  tick() {
    if (this.members.size < 2 || !this.ref) return;
    const now = this.ctx.currentTime;
    const playing = [...this.members.keys()].filter((d) => d.playing);
    if (!playing.length) {
      this.parked = true;
      return;
    }
    if (this.parked || !this.ref.playing) {
      // The clock is carried by a deck that is playing.
      const next = playing[0];
      const pos = this.parked ? next.positionAt(now) : next.grid.posAt(this.target(next, now));
      this.setRef(next, pos, now);
      this.parked = false;
    }
    const ref = this.ref;
    const free = (d) => !d.scratching && d.bendFactor === 1 && now >= d.busyUntil;
    // The playhead goes where the reference goes: after a seek, a hot cue or a loop wrapping,
    // the clock reads the grid there (everyone keeps their place in the beat).
    if (free(ref) && Math.abs(ref.positionAt(now) - this.playhead(now)) > 0.05) this.setRef(ref, ref.positionAt(now), now);

    const w = now + LOOKAHEAD;
    let retuned = false;
    for (const deck of playing) {
      if (!free(deck)) continue;
      const m = this.members.get(deck);
      // Tempo: a grid that wanders (the reference's or this deck's) means a rate that moves with it.
      if (deck !== ref) {
        const want = this.rateFor(deck, w);
        if (Math.abs(want / deck.rate - 1) > 2e-5) {
          deck.setRate(want, { silent: true });
          retuned = true;
        }
      }
      // Beat: trim small errors, jump large ones.
      const pos = deck.positionAt(w);
      const g = deck.grid;
      const off = wrap(g.beatAt(pos) - this.target(deck, w)); // beats ahead
      const sec = (off * g.beatSeconds(pos)) / deck.speed; // heard seconds ahead
      if (Math.abs(sec) < HOLD) continue;
      if (Math.abs(sec) <= JUMP) {
        const eps = Math.max(-TRIM, Math.min(TRIM, -sec / TICK));
        deck.trimPulse(eps, w, TICK);
      } else if (!(now - (m.jumped ?? -1) < JUMP_GAP)) {
        deck.jumpTo(g.posAt(g.beatAt(pos) - off), w);
        m.jumped = now;
      }
    }
    // Tempo readouts follow a wandering clock, a few times a second.
    if (retuned && now - this.told > 0.25) {
      this.told = now;
      this.onChange();
    }
  }
}
