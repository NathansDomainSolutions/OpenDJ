// Sync, tempo match, key match and snap: the glue between the decks' buttons and the
// sync clock (../sync.js) and matching maths (../match.js).
import { beatSalience, keyName, camelot } from '../analysis.js';
import { beatGap } from '../sync.js';
import { tempoMatch, keyMatch, hasKey } from '../match.js';
import { $, mixer, group, DECKS, partnerDeck, heardKey, state, toast, ui, saveTrack } from './core.js';
import { renderLibrary } from './library.js';
import { renderTempo, renderKeys, syncTempoSlider, fmtSemis } from './deck.js';
import { secPerCssPx } from './waves.js';

// Snap to beat (top-bar toggle): when you let go of a dragged waveform, record or
// overview, the deck lands on the nearest beat lined up with the deck it plays against.
export const snapOn = () => $('#snapBtn').classList.contains('on');
// Snap lands on the nearest line of the finest grid drawn on the waveform at this zoom
// (lines closer than 5 px aren't drawn), so every line you can see is a place to land.
export function snapDiv(name) {
  const deck = mixer.decks[name];
  if (!deck.bpm) return 1;
  const px = 60 / deck.bpm / secPerCssPx(deck, $(`#wave${name}`).clientWidth); // px per beat
  return [16, 8, 4, 2].find((d) => px / d >= 5) || 1;
}
export function snapDeck(name) {
  const deck = mixer.decks[name];
  if (!snapOn() || !deck.buffer || state.startingTogether) return;
  const shift = deck.beatSnap(deck.position, mixer.decks[partnerDeck(name)], snapDiv(name));
  if (Math.abs(shift) < 0.002) return;
  if (deck.playing) deck.fadeSwap(() => deck.seek(deck.position + shift));
  else deck.seek(deck.pausedPos + shift);
}

// The SYNC lights, tempo sliders and readouts follow the group.
function onSyncChange() {
  for (const n of DECKS) {
    const deck = mixer.decks[n];
    ui[n].sync.classList.toggle('on', group.has(deck));
    if (group.has(deck)) {
      syncTempoSlider(n);
      renderTempo(n);
    }
  }
  renderKeys(); // without key lock a new tempo is a new pitch
}

/**
 * For the beat-match meter: how far this deck's beats are from where they belong, in heard ms
 * (+ = ahead). A synced deck is measured against its place on the clock, any other against
 * the beats of the deck it mixes with. null when there is nothing to compare.
 */
export function beatGapMs(name) {
  const deck = mixer.decks[name];
  if (!deck.playing || !deck.bars) return null;
  if (group.has(deck)) return group.errorMs(deck);
  const other = mixer.decks[partnerDeck(name)];
  if (other === deck || !other.playing || !other.bars) return null;
  return beatGap(deck, other, mixer.ctx.currentTime) * 1000;
}

export function setupSync() {
  group.onChange = onSyncChange;
}

/** Play / pause. A synced deck starts on the clock: at its cue point, on the next matching beat. */
export function togglePlay(name) {
  const deck = mixer.decks[name];
  if (deck.playing || !group.has(deck)) return deck.toggle();
  deck.play(group.startPlan(deck) || {});
}

// A tempo move on a synced deck moves the clock; the other members follow.
export function followTempo(name) {
  for (const { deck } of group.setTempoFrom(mixer.decks[name])) {
    syncTempoSlider(deck.name);
  }
}

// Which tempo reading to sync on. Besides its tempo, the analyser keeps the other readings it
// found (bpmAlts: ×4⁄3, ×¾, ×5⁄4 … of it, each with its own fitted grid and how well the audio
// supports it). A triplet or half-time feel read at the wrong level shows up as a large stretch
// against the other deck, so Sync weighs every reading by how far it would have to stretch
// the track against how firmly its grid sits on the track's actual hits (beatSalience), and
// switches only when another reading saves a clear amount. Grids set by hand stay.
const ALT_COST = Math.log(1.04); // an alternative reading must save over ~4% of stretch ...
const FIT_COST = 0.5; // ... plus half its loss in fit (log of main / alternative salience)
const WEAK_ALT_COST = Math.log(1.08); // without onsets yet: up to 8% more the weaker the analyser found it
const stretchTo = (bpm, target) => Math.abs(Math.log(tempoMatch(bpm, target).rate));
function pickReading(deck, other) {
  const groupBpm = group.members.size ? group.bpm : null;
  // With a group running only the joining deck can change; a new pair may switch either track.
  const sides = groupBpm ? [[deck, groupBpm]] : [[deck, other.bpm * other.rate], [other, deck.bpm * deck.rate]];
  let best = { cost: stretchTo(deck.bpm, sides[0][1]) };
  for (const [d, target] of sides) {
    if (d.track.gridSource === 'user') continue;
    const main = d.onsets && beatSalience(d.onsets, d.bpm, d.track.beatOffset);
    for (const alt of d.track.bpmAlts || []) {
      const fit = main && alt.offset != null ? FIT_COST * Math.log(main / Math.max(beatSalience(d.onsets, alt.bpm, alt.offset), 1e-9)) : WEAK_ALT_COST * Math.max(0, 1 - (alt.rel ?? 0));
      const cost = stretchTo(alt.bpm, target) + ALT_COST + Math.max(0, fit);
      if (cost < best.cost) best = { cost, d, alt };
    }
  }
  if (best.alt) useReading(best.d, best.alt);
}

function useReading(d, alt) {
  const was = d.bpm;
  const t = d.track;
  const patch = { bpm: Math.round(alt.bpm * 1000) / 1000 };
  if (alt.offset != null) {
    // The alternative's own grid: keep the bar start on its nearest new beat.
    const p = 60 / patch.bpm;
    const old = t.downbeat ?? alt.offset;
    patch.beatOffset = alt.offset;
    patch.downbeat = alt.offset + Math.round((old - alt.offset) / p) * p;
  }
  if (t.beatsPerBar === 3 && alt.bpm / was > 1.2) patch.beatsPerBar = 4; // 3 slow beats were one 4/4 bar
  // Keep the other readings, with the old one among them, so a later sync can switch back.
  const r = Math.max(alt.rel ?? 1, 0.01); // supports were relative to the old reading
  patch.bpmAlts = [{ bpm: was, offset: t.beatOffset, rel: 1 / r }, ...(t.bpmAlts || []).filter((x) => x !== alt).map((x) => ({ ...x, rel: (x.rel ?? 0) / r }))];
  saveTrack(t, patch);
  renderTempo(d.name);
  renderLibrary();
  toast(`Deck ${d.name}: using its ${patch.bpm} BPM reading instead of ${was} — the beats fit the other deck with far less stretching.`);
}

/** The deck a new sync should lock to: a group member if there is a group, else the partner. */
function syncPartner(name) {
  const deck = mixer.decks[name];
  const members = [...group.members.keys()].filter((d) => d !== deck);
  return members.find((d) => d.playing) || members[0] || mixer.decks[partnerDeck(name)];
}

export function doSync(name) {
  const deck = mixer.decks[name];
  if (group.has(deck)) return group.leave(deck); // pressed again: unlink, keeping the current tempo
  const other = syncPartner(name);
  if (!deck.track || !other.track) return toast('Load a track on another deck to sync to.');
  if (!deck.bpm || !other.bpm) return toast('Both tracks need a BPM — try TAP to set one.');
  if (deck.forcedK == null) pickReading(deck, other); // a forced ratio means you've chosen the reading yourself
  const res = group.join(deck, other, { forcedK: deck.forcedK });
  if (!res.ok) return toast(res.reason);
  listenAndTell(name);
  if (deck.bars && other.bars && deck.bars.beatsPerBar !== other.bars.beatsPerBar)
    toast(`Synced beats only — deck ${name} is in ${deck.bars.beatsPerBar}/4, deck ${other.name} in ${other.bars.beatsPerBar}/4.`);
}

/**
 * Tempo match (Shift + Sync): take the other deck's tempo once, at ½×, 1× or 2×, without
 * locking to it — for beat-matching by hand with the tempo already right.
 */
export function matchTempo(name) {
  const deck = mixer.decks[name];
  const other = syncPartner(name);
  const fit = tempoMatch(deck.bpm, other.effectiveBpm);
  if (!fit) return toast('Both tracks need a BPM — try TAP to set one.');
  group.leave(deck);
  deck.setRate(fit.rate);
  syncTempoSlider(name);
  toast(`Deck ${name} set to ${deck.effectiveBpm.toFixed(1)} BPM to match deck ${other.name}${fit.k === 1 ? '' : ` at ${fit.k === 2 ? 'double' : 'half'} time`}. Not locked: press Sync to lock.`);
}

/** After a grid or ratio change on a synced deck: join again so tempo and phase use the new grid. */
export function relink(name) {
  const deck = mixer.decks[name];
  if (!group.has(deck)) return;
  const others = [...group.members.keys()].filter((d) => d !== deck);
  group.leave(deck);
  const res = group.join(deck, others.find((d) => d.playing) || others[0], { forcedK: deck.forcedK });
  if (!res.ok) return toast(res.reason, 'error');
  listenAndTell(name);
}

/** After a join: check by ear that the beats really meet, and say so if Sync had to move them. */
export function listenAndTell(name) {
  const r = group.listen(mixer.decks[name]);
  if (r) toast(`Deck ${name}: moved ${Math.round(Math.abs(r.sec) * 1000)} ms ${r.sec > 0 ? 'later' : 'earlier'} so its beats land on the other deck's — its grid sat off the music.`);
}

/**
 * Key Match: shift this deck into a key that mixes with the other deck (the smallest shift
 * that does it), in tune with that deck. `exact` (Shift-click) insists on the very same key.
 * See keyMatch in ../match.js.
 */
export function matchKey(name, exact = false) {
  const deck = mixer.decks[name];
  const other = mixer.decks[partnerDeck(name)];
  if (!deck.track || !other.track) return toast('Load a track on another deck to match keys with.');
  const side = (d) => ({ key: d.track.key, chroma: d.track.chroma, tuning: d.track.tuning, offset: d.keyOffset });
  const fit = keyMatch(side(deck), side(other), { exact });
  if (!fit) return toast('Both tracks need a detected key to match.');
  const moved = Math.abs(fit.shift - deck.keyOffset) >= 0.05;
  deck.setKeyLock(true);
  deck.setKeyShift(fit.shift);
  const pct = (x) => `${Math.round(Math.max(0, x) * 100)}%`;
  const where = hasKey(deck.track.key) ? ` to ${camelot(heardKey(deck))} ${keyName(heardKey(deck))}` : '';
  const how = fit.steps === 1 ? `one step round the wheel from deck ${other.name}` : fit.steps === 0 ? `in key with deck ${other.name}` : `where its notes agree best with deck ${other.name}'s`;
  const cents = Math.round(Math.abs(fit.detune) * 100);
  toast(
    `Deck ${name} ${moved ? `shifted ${fmtSemis(fit.shift)} semitones${where}` : 'stays where it is'}: ${how} (notes agree ${pct(fit.fit)}${moved ? `, were ${pct(fit.fitNow)}` : ''})` +
      `${cents >= 5 ? `, with ${cents} cents of tuning difference taken out` : ''}.${fit.steps === 1 ? ' Shift-click Match for the very same key.' : ''}`,
  );
  ui[name].keyMatch.classList.add('on');
  setTimeout(() => ui[name].keyMatch.classList.remove('on'), 500);
}
