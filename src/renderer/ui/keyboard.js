// Keyboard shortcuts (listed in the ? dialog).
import { $, $$, mixer, group, DECKS, activeDecks, state, clamp } from './core.js';
import { hotcue, clearHotcue } from './grid.js';
import { markPlayed } from './deck.js';
import { togglePlay, doSync, matchTempo } from './sync-ui.js';

// Per deck: keys by what they type; sync (with Shift) and hot cues also by where they sit, so Shift works with them.
const DECK_KEYS = {
  A: { play: 'x', cue: 'z', sync: 'c', syncCode: 'KeyC', back: 'q', fwd: 'w', hot: ['Digit1', 'Digit2', 'Digit3', 'Digit4'] },
  B: { play: ',', cue: 'm', sync: '.', syncCode: 'Period', back: 'o', fwd: 'p', hot: ['Digit7', 'Digit8', 'Digit9', 'Digit0'] },
};
const NUDGE = 0.04; // ±4% while the key is held

export function setupKeyboard() {
  const held = new Map(); // nudge key -> deck being bent
  // Any text box (inputs without a type attribute too, like the Spotify key fields).
  const typing = (e) => e.target.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select');
  let spacePaused = []; // decks the space bar stopped, so the next press brings back just those

  // Space: pause everything that's playing. Press again to start the decks it paused, plus
  // every synced deck, all in the same instant so they start in step.
  const pauseOrResume = () => {
    const playing = DECKS.filter((n) => mixer.decks[n].playing);
    if (playing.length) {
      playing.forEach((n) => mixer.decks[n].pause());
      spacePaused = playing;
      return;
    }
    // They're already in step: skip snap-on-play, which would nudge the first one before the rest start.
    // Synced decks start through the clock (the first one re-anchors it, the rest land on its beat).
    state.startingTogether = true;
    const synced = DECKS.filter((n) => group.has(mixer.decks[n]));
    const start = [...new Set([...spacePaused, ...synced])].filter((n) => mixer.decks[n].buffer && activeDecks().includes(n));
    start.sort((x, y) => spacePaused.includes(y) - spacePaused.includes(x)); // the decks that were playing lead
    start.forEach((n) => {
      togglePlay(n);
      markPlayed(n);
    });
    state.startingTogether = false;
    spacePaused = [];
  };

  /** A deck's own keys. Returns whether the key was one of them. */
  const deckKey = (name, e, k) => {
    const keys = DECK_KEYS[name];
    const deck = mixer.decks[name];
    const hot = keys.hot.indexOf(e.code);
    if (k === keys.play) {
      togglePlay(name);
      markPlayed(name);
    } else if (k === keys.cue) deck.cue();
    else if (k === keys.sync || (e.shiftKey && e.code === keys.syncCode)) (e.shiftKey ? matchTempo : doSync)(name);
    else if (hot !== -1) (e.shiftKey ? clearHotcue : hotcue)(name, hot);
    else if (k === keys.back || k === keys.fwd) {
      if (!held.has(k)) {
        held.set(k, deck);
        deck.bend(k === keys.back ? -NUDGE : NUDGE);
      }
    } else return false;
    return true;
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape' && typing(e)) e.target.blur();
      return;
    }
    if (e.code === 'Space') {
      if (!e.repeat) pauseOrResume();
      return e.preventDefault();
    }
    const k = e.key.toLowerCase();
    const xf = $('#crossfader');
    const setXf = (v) => {
      xf.value = clamp(v);
      xf.dispatchEvent(new Event('input')); // the mixer, the 4-deck puck and the library's match marks follow
    };
    if (deckKey('A', e, k) || deckKey('B', e, k)) e.preventDefault();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      setXf(e.shiftKey ? (dir + 1) / 2 : Number(xf.value) + dir * 0.05);
      e.preventDefault();
    } else if (e.key === '/') {
      $$('.tab')[0].click();
      $('#libFilter').focus();
      e.preventDefault();
    } else if (e.key === '?') {
      $('#helpDialog').showModal();
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    held.get(k)?.endBend();
    held.delete(k);
  });
}
