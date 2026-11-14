// The sync clock (src/renderer/sync.js), driven with model decks on a model audio clock.
// Run: node test/sync.test.mjs
import { SyncGroup } from '../src/renderer/sync.js';
import { BeatGrid } from '../src/renderer/beatgrid.js';

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) fails++;
}

const ctx = { currentTime: 100 };
const TICK = 0.025;

/** A deck as the sync clock sees it: a playhead moving at its rate over a track with a beat grid. */
class ModelDeck {
  constructor(name, track) {
    Object.assign(this, { name, track, ctx, rate: 1, bendFactor: 1, scratching: false, busyUntil: 0, playing: false, pausedPos: 0, startPos: 0, startTime: 0, jumps: 0, forcedK: null });
  }
  get grid() { return BeatGrid.of(this.track); }
  get bpm() { return this.track.bpm; }
  get speed() { return this.rate * this.bendFactor; }
  get position() { return this.positionAt(ctx.currentTime); }
  get effectiveBpm() { return this.grid.bpmAt(this.position) * this.rate; }
  positionAt(t) { return this.playing ? this.startPos + Math.max(0, t - this.startTime) * this.speed : this.pausedPos; }
  anchor(pos, t) { this.startPos = pos; this.startTime = t; }
  setRate(rate) { this.anchor(this.positionAt(ctx.currentTime), ctx.currentTime); this.rate = rate; }
  bend(amount) { this.anchor(this.position, ctx.currentTime); this.bendFactor = 1 + amount; }
  play({ at = this.pausedPos, when = ctx.currentTime } = {}) { this.playing = true; this.anchor(at, when); }
  pause() { this.pausedPos = this.position; this.playing = false; }
  jumpTo(pos, when) { if (!this.playing) return void (this.pausedPos = pos); this.anchor(pos, when); this.jumps++; }
  trimPulse(eps, _when, dur) { this.startPos += eps * this.speed * dur; }
}

const steady = (bpm, beatOffset = 0) => ({ bpm, beatOffset });
/** A track whose tempo wanders ±`depth` around bpm (a band without a click), with its tempo map. */
function wandering(bpm, depth, seconds = 400) {
  const d = [];
  for (let pos = 0; pos <= seconds; pos += 2) d.push(Math.round(((depth * 47) / (2 * Math.PI)) * (1 - Math.cos((2 * Math.PI * pos) / 47)) * 1e4) / 10);
  return { bpm, beatOffset: 0.2, warp: { step: 2, d } };
}

function setup(...tracks) {
  ctx.currentTime = 100;
  const decks = tracks.map((t, i) => new ModelDeck('ABCD'[i], t));
  const group = new SyncGroup({ ctx });
  clearInterval(group.timer); // the test turns the clock by hand
  return { group, decks };
}
function run(group, seconds, each) {
  for (let t = 0; t < seconds; t += TICK) {
    ctx.currentTime += TICK;
    group.tick();
    each?.();
  }
}
/** Beats of `a` against beats of `b` right now, in heard ms, at tempo ratio k (a runs at k × b). */
function gapMs(a, b, k = 1) {
  // Compared on the faster deck's beats: a half-time deck may sit on either of the other's beats.
  const x = k < 1 ? a.grid.beatAt(a.position) / k - b.grid.beatAt(b.position) : a.grid.beatAt(a.position) - k * b.grid.beatAt(b.position);
  const fast = k < 1 ? b : a;
  return (x - Math.round(x)) * (fast.grid.beatSeconds(fast.position) / fast.speed) * 1000;
}
const worstGap = (group, a, b, seconds, k = 1) => {
  let worst = 0;
  run(group, seconds, () => (worst = Math.max(worst, Math.abs(gapMs(a, b, k)))));
  return worst;
};

// ---- pressing Sync with both playing: tempo and beats at once, and they stay
{
  const { group, decks: [a, b] } = setup(steady(126, 0.31), steady(120, 0.07));
  a.play({ at: 30 });
  b.play({ at: 41.3 });
  run(group, 1);
  const before = Math.abs(gapMs(b, a));
  const res = group.join(b, a);
  ctx.currentTime += 0.03;
  check('sync: joins', res.ok && group.has(a) && group.has(b));
  check('sync: the pressed deck takes the other deck\'s tempo, the other keeps its own', Math.abs(b.effectiveBpm - 126) < 1e-9 && a.rate === 1, `${b.effectiveBpm.toFixed(3)} BPM`);
  check('sync: beats land together at once', Math.abs(gapMs(b, a)) < 0.01, `${before.toFixed(0)} ms apart before, ${Math.abs(gapMs(b, a)).toFixed(3)} ms after`);
  check('sync: moved by half a beat at most, the other deck not at all', b.jumps === 1 && a.jumps === 0);
  const worst = worstGap(group, b, a, 120);
  check('sync: holds for two minutes without another jump', worst < 0.05 && b.jumps === 1 && a.jumps === 0, `worst ${worst.toFixed(3)} ms`);
}

// ---- half and double time
{
  const { group, decks: [a, b] } = setup(steady(174), steady(87.3, 0.1));
  a.play({ at: 10 });
  b.play({ at: 20 });
  const res = group.join(b, a);
  check('half time: an 87 BPM track syncs to 174 at half, not at +99%', res.k === 0.5 && Math.abs(b.effectiveBpm - 87) < 1e-9, `k ${res.k}, ${b.effectiveBpm.toFixed(2)} BPM`);
  ctx.currentTime += 0.03;
  check('half time: its beats land on every other beat', worstGap(group, b, a, 30, 0.5) < 0.05);
  const { group: g2, decks: [c, d] } = setup(steady(87), steady(174, 0.1));
  c.play({ at: 10 });
  d.play({ at: 20 });
  check('double time: a 174 BPM track syncs to 87 at double', g2.join(d, c).k === 2 && Math.abs(d.effectiveBpm - 174) < 1e-9);
  d.forcedK = 1;
  g2.leave(d);
  check('a forced ratio overrides', g2.join(d, c, { forcedK: 1 }).k === 1 && Math.abs(d.effectiveBpm - 87) < 1e-9);
}

// ---- the tempo slider on either deck moves both
{
  const { group, decks: [a, b] } = setup(steady(126), steady(120));
  a.play({ at: 30 });
  b.play({ at: 40 });
  group.join(b, a);
  run(group, 2);
  a.setRate(1.05);
  group.setTempoFrom(a);
  check('tempo: moving the lead deck moves the follower', Math.abs(b.effectiveBpm - 132.3) < 1e-6, `${b.effectiveBpm.toFixed(2)}`);
  check('tempo: beats stay together through it', worstGap(group, b, a, 10) < 0.05);
  b.setRate(b.rate * 0.97);
  const moved = group.setTempoFrom(b);
  check('tempo: moving the follower moves the lead deck', Math.abs(a.effectiveBpm - 132.3 * 0.97) < 1e-6 && moved.some((m) => m.deck === a));
  check('tempo: beats stay together through that too', worstGap(group, b, a, 10) < 0.05 && a.jumps === 0);
}

// ---- starting a synced deck: at once, and on the beat
{
  const { group, decks: [a, b] } = setup(steady(126, 0.31), steady(120, 0.07));
  a.play({ at: 30 });
  b.pausedPos = b.grid.posAt(64); // cued on a beat
  group.join(b, a);
  check('paused deck: Sync leaves its cue where it is', Math.abs(b.pausedPos - b.grid.posAt(64)) < 1e-12);
  run(group, 3.21);
  const plan = group.startPlan(b);
  b.play(plan);
  check('start: at once', plan.when - ctx.currentTime <= 0.03);
  check('start: within half a beat of the cue', Math.abs(b.grid.beatAt(plan.at) - 64) <= 0.5 + 1e-9, `${(b.grid.beatAt(plan.at) - 64).toFixed(3)} beats from it`);
  ctx.currentTime = plan.when;
  check('start: on the beat from its first sample', Math.abs(gapMs(b, a)) < 0.01);
  check('start: stays there, no jumps', worstGap(group, b, a, 20) < 0.05 && b.jumps === 0);
}

// ---- nothing else playing: the deck starts from its cue and carries the clock
{
  const { group, decks: [a, b] } = setup(steady(126), steady(120));
  a.pausedPos = 12.34;
  b.pausedPos = 50;
  group.join(b, a);
  check('both paused: the pressed deck still takes the tempo', Math.abs(b.effectiveBpm - 126) < 1e-9);
  const plan = group.startPlan(b);
  b.play(plan);
  check('first to start plays from its cue exactly', plan.at === 50);
  run(group, 2);
  a.play(group.startPlan(a));
  ctx.currentTime += 0.03;
  check('the second starts on the first one\'s beat', Math.abs(gapMs(a, b)) < 0.01 && worstGap(group, a, b, 10) < 0.05);
}

// ---- a band without a click: the follower's tempo wanders ±2.5%
{
  const { group, decks: [a, b] } = setup(steady(124), wandering(121, 0.025));
  a.play({ at: 5 });
  b.play({ at: 12 });
  group.join(b, a);
  ctx.currentTime += 0.03;
  let lo = Infinity, hi = 0;
  const worst = (() => { let w = 0; run(group, 150, () => { w = Math.max(w, Math.abs(gapMs(b, a))); lo = Math.min(lo, b.rate); hi = Math.max(hi, b.rate); }); return w; })();
  check('wandering follower: stays on the beat for 150 s', worst < 1, `worst ${worst.toFixed(2)} ms`);
  check('wandering follower: its speed is moved against the drift, not jumped', b.jumps === 1 && hi / lo > 1.04, `rate ${lo.toFixed(4)}…${hi.toFixed(4)}`);
  check('wandering follower: heard tempo is the steady deck\'s', Math.abs(b.effectiveBpm - 124) < 0.02);
}

// ---- …and the lead deck's tempo wanders: the steady deck follows the band
{
  const { group, decks: [a, b] } = setup(wandering(98, 0.025), steady(100, 0.4));
  a.play({ at: 8 });
  b.play({ at: 3 });
  group.join(b, a);
  ctx.currentTime += 0.03;
  const worst = worstGap(group, b, a, 150);
  check('wandering lead: the follower stays on its beats for 150 s', worst < 1, `worst ${worst.toFixed(2)} ms`);
  check('wandering lead: it plays untouched', a.rate === 1 && a.jumps === 0);
}

// ---- the lead deck stops or leaves: the other carries on undisturbed
{
  const { group, decks: [a, b, c] } = setup(steady(126), steady(120), steady(63));
  a.play({ at: 30 });
  b.play({ at: 40 });
  c.play({ at: 20 });
  group.join(b, a);
  group.join(c, a);
  ctx.currentTime += 0.03;
  run(group, 5);
  const jumps = [b.jumps, c.jumps];
  a.pause();
  const worst = worstGap(group, c, b, 20, 0.5);
  check('lead paused: the others keep their tempo and stay together', Math.abs(b.effectiveBpm - 126) < 1e-9 && worst < 0.05 && b.jumps === jumps[0] && c.jumps === jumps[1], `worst ${worst.toFixed(3)} ms`);
  a.play(group.startPlan(a));
  ctx.currentTime += 0.03;
  check('…and it comes back in on their beat', Math.abs(gapMs(a, b)) < 0.01);
  group.leave(b);
  run(group, 5);
  check('a deck leaving a group of three leaves the other two synced', group.has(a) && group.has(c) && !group.has(b) && worstGap(group, c, a, 10, 0.5) < 0.05);
  group.leave(a);
  check('a pair is the smallest group', !group.has(c) && group.members.size === 0);
}

// ---- nudges stick, seeks keep the beat
{
  const { group, decks: [a, b] } = setup(steady(126), steady(120));
  a.play({ at: 30 });
  b.play({ at: 40 });
  group.join(b, a);
  ctx.currentTime += 0.03;
  run(group, 2);
  b.bend(0.04);
  run(group, 0.5); // held for half a second: 20 ms ahead
  b.bend(0);
  group.keepOffset(b);
  const nudged = gapMs(b, a);
  const jumps = b.jumps;
  run(group, 20);
  check('nudge: the deck stays where it was nudged to', Math.abs(nudged - 20) < 1.5 && Math.abs(gapMs(b, a) - nudged) < 0.05 && b.jumps === jumps, `${gapMs(b, a).toFixed(2)} ms ahead`);
  const to = group.quantizeSeek(b, 95.123);
  check('seek on a synced deck lands in the same place in the beat', Math.abs(to - 95.123) <= b.grid.period / 2 + 1e-9);
  b.jumpTo(to, ctx.currentTime);
  check('…so it is still in sync afterwards', Math.abs(gapMs(b, a) - nudged) < 0.05);
  // The lead deck jumps to a hot cue (on the beat): the clock goes with it, the follower is left alone.
  const before = b.jumps;
  a.jumpTo(group.quantizeSeek(a, 140.77), ctx.currentTime);
  const worst = worstGap(group, b, a, 10);
  check('lead deck seeks: the follower is not moved', b.jumps === before && Math.abs(worst - Math.abs(nudged)) < 0.1, `worst ${worst.toFixed(2)} ms`);
}

// ---- thrown off (a scratch): put back by a jump, once
{
  const { group, decks: [a, b] } = setup(steady(126), steady(120));
  a.play({ at: 30 });
  b.play({ at: 40 });
  group.join(b, a);
  ctx.currentTime += 0.03;
  run(group, 2);
  const jumps = b.jumps;
  b.anchor(b.position + 0.1, ctx.currentTime); // 100 ms off
  run(group, 1);
  check('100 ms off: jumped back onto the beat, once', Math.abs(gapMs(b, a)) < 0.05 && b.jumps === jumps + 1);
  b.anchor(b.position + 0.006, ctx.currentTime); // 6 ms off
  run(group, 3);
  check('6 ms off: trimmed back without a jump', Math.abs(gapMs(b, a)) < 0.25 && b.jumps === jumps + 1, `${gapMs(b, a).toFixed(3)} ms left`);
}

// ---- no tempo, no sync
{
  const { group, decks: [a, b] } = setup(steady(126), { title: 'no grid' });
  check('a deck without a beat grid cannot join', group.join(b, a).ok === false && group.join(a, b).ok === false && group.members.size === 0);
}

console.log(fails ? `${fails} sync test(s) failed` : 'all sync tests passed');
process.exit(fails ? 1 : 0);
