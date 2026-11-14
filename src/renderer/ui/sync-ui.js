// Sync, tempo match, key match and snap: what the decks' buttons do, on top of the sync
// clock (../sync.js), the key maths (../key.js) and tempo matching (../match.js).
import { beatGap } from '../sync.js';
import { keyName, camelot, hasKey, keyMatch } from '../key.js';
import { tempoMatch } from '../match.js';
import { $, mixer, group, DECKS, partnerDeck, heardKey, state, toast, ui, saveTrack } from './core.js';
import { renderLibrary } from './library.js';
import { renderTempo, renderKeys, syncTempoSlider, fmtSemis } from './deck.js';
import { secPerCssPx } from './waves.js';

// ---------------------------------------------------------------- snap

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

// ---------------------------------------------------------------- sync

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

export function setupSync() {
  group.onChange = onSyncChange;
}

/** Play / pause. A synced deck starts on the clock's beat. */
export function togglePlay(name) {
  const deck = mixer.decks[name];
  if (deck.playing || !group.has(deck)) return deck.toggle();
  deck.play(group.startPlan(deck) || {});
}

/** A synced deck's tempo was moved by hand: the others follow. */
export function followTempo(name) {
  for (const { deck } of group.setTempoFrom(mixer.decks[name])) syncTempoSlider(deck.name);
}

/** The deck to sync to: one already in the group (a playing one first), else the deck this one mixes against. */
function syncPartner(name) {
  const deck = mixer.decks[name];
  const members = [...group.members.keys()].filter((d) => d !== deck);
  return members.find((d) => d.playing) || members[0] || mixer.decks[partnerDeck(name)];
}

const pct = (rate) => `${rate >= 1 ? '+' : '−'}${(Math.abs(rate - 1) * 100).toFixed(1)}%`;

/** Say what Sync did, and when the tempo change is large, what to try if the beats don't line up. */
function tellSync(deck, other) {
  const k = group.members.get(deck).k / group.members.get(other).k;
  const how = k === 1 ? '' : k > 1 ? ', at double time' : ', at half time';
  let text = `Deck ${deck.name} synced to deck ${other.name}: ${deck.effectiveBpm.toFixed(1)} BPM (${pct(deck.rate)})${how}.`;
  if (Math.abs(deck.rate - 1) > 0.12) {
    // A big stretch often means one of the two tempos was read wrong. Never guess: say so.
    const alt = [deck, other].flatMap((d) => (d.track.bpmAlts || []).map((a) => ({ d, a }))).find(({ d, a }) => {
      const fit = tempoMatch(d === deck ? a.bpm : deck.bpm, d === deck ? other.effectiveBpm : (a.bpm * other.rate));
      return fit && Math.abs(fit.rate - 1) < 0.08;
    });
    text += alt
      ? ` That's a big change. If the beats don't line up, deck ${alt.d.name}'s tempo may be misread: press its Alt for the ${alt.a.bpm.toFixed(1)} BPM reading.`
      : ` That's a big change: these two tracks are far apart in tempo.`;
  }
  if (deck.grid.beatsPerBar !== other.grid.beatsPerBar) text += ` Deck ${deck.name} is in ${deck.grid.beatsPerBar}/4, deck ${other.name} in ${other.grid.beatsPerBar}/4.`;
  toast(text);
}

/** The Sync button: lock this deck's tempo and beats to the other deck. Press again to unlock (the tempo stays). */
export function doSync(name) {
  const deck = mixer.decks[name];
  if (group.has(deck)) return group.leave(deck);
  const other = syncPartner(name);
  if (!deck.track || !other.track) return toast('Load a track on another deck to sync to.');
  if (!deck.grid || !other.grid) return toast('Both tracks need a BPM — try Tap to set one.');
  const res = group.join(deck, other, { forcedK: deck.forcedK });
  if (!res.ok) return toast('Both tracks need a BPM — try Tap to set one.');
  tellSync(deck, other);
}

/**
 * Tempo match (Shift + Sync): take the other deck's tempo once, at ½×, 1× or 2×, without
 * locking to it — for beat-matching by hand with the tempo already right.
 */
export function matchTempo(name) {
  const deck = mixer.decks[name];
  const other = syncPartner(name);
  const fit = tempoMatch(deck.effectiveBpm / deck.rate, other.effectiveBpm);
  if (!fit) return toast('Both tracks need a BPM — try Tap to set one.');
  group.leave(deck);
  deck.setRate(fit.rate);
  syncTempoSlider(name);
  toast(`Deck ${name} set to ${deck.effectiveBpm.toFixed(1)} BPM to match deck ${other.name}${fit.k === 1 ? '' : ` at ${fit.k === 2 ? 'double' : 'half'} time`}. Not locked: press Sync to lock.`);
}

/** After a grid or ratio change on a synced deck (÷2, ×2, Beat 1, ½×/2×): sync again on the new grid. */
export function relink(name) {
  const deck = mixer.decks[name];
  if (!group.has(deck)) return;
  const others = [...group.members.keys()].filter((d) => d !== deck);
  group.leave(deck);
  group.join(deck, others.find((d) => d.playing) || others[0], { forcedK: deck.forcedK });
}

/**
 * Alt: switch a track to the next tempo reading the analyser kept (the usual wrong guesses
 * are ⅔, ¾, 4⁄3 and 5⁄4 of the right tempo). The reading left behind stays in the list, so
 * pressing on comes back round.
 */
export function nextReading(name) {
  const deck = mixer.decks[name];
  const t = deck.track;
  const alt = t?.bpmAlts?.[0];
  if (!alt) return toast(t ? `Deck ${name}: the analyser found no other tempo reading. Use ÷2, ×2 or Tap.` : 'Load a track first.');
  const was = t.bpm;
  const bpm = Math.round(alt.bpm * 1000) / 1000;
  const patch = { bpm, bpmAlts: [...t.bpmAlts.slice(1), { bpm: was, offset: t.beatOffset }] };
  if (alt.offset != null) {
    // The reading's own grid; the bar start moves to its nearest beat.
    const p = 60 / bpm;
    patch.beatOffset = alt.offset;
    patch.downbeat = alt.offset + Math.round(((t.downbeat ?? alt.offset) - alt.offset) / p) * p;
  }
  saveTrack(t, patch);
  renderTempo(name);
  renderLibrary();
  relink(name);
  toast(`Deck ${name}: reading the tempo as ${bpm.toFixed(1)} BPM (was ${Number(was).toFixed(1)}). Press Alt again for the next reading.`);
}

/**
 * For the beat-match meter: how far this deck's beats are from where they belong, in heard ms
 * (+ = ahead). A synced deck is measured against its place on the clock, any other against
 * the beats of the deck it mixes with. null when there is nothing to compare.
 */
export function beatGapMs(name) {
  const deck = mixer.decks[name];
  if (!deck.playing || !deck.grid) return null;
  if (group.has(deck)) return group.errorMs(deck);
  const other = mixer.decks[partnerDeck(name)];
  if (other === deck || !other.playing || !other.grid) return null;
  return beatGap(deck, other, mixer.ctx.currentTime) * 1000;
}

// ---------------------------------------------------------------- key match

/**
 * The Match button: shift this deck into a key that mixes with the other deck (the smallest
 * shift that does it), in tune with that deck. Shift-click (`exact`): the very same key.
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
  const share = (x) => `${Math.round(Math.max(0, x) * 100)}%`;
  const where = hasKey(deck.track.key) ? ` to ${camelot(heardKey(deck))} ${keyName(heardKey(deck))}` : '';
  const how = fit.steps === 1 ? `one step round the wheel from deck ${other.name}` : fit.steps === 0 ? `in key with deck ${other.name}` : `where its notes agree best with deck ${other.name}'s`;
  const cents = Math.round(Math.abs(fit.detune) * 100);
  toast(
    `Deck ${name} ${moved ? `shifted ${fmtSemis(fit.shift)} semitones${where}` : 'stays where it is'}: ${how} (notes agree ${share(fit.fit)}${moved ? `, were ${share(fit.fitNow)}` : ''})` +
      `${cents >= 5 ? `, with ${cents} cents of tuning difference taken out` : ''}.${fit.steps === 1 ? ' Shift-click Match for the very same key.' : ''}`,
  );
  ui[name].keyMatch.classList.add('on');
  setTimeout(() => ui[name].keyMatch.classList.remove('on'), 500);
}
