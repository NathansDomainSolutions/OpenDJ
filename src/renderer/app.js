// OpenDJ — the page's entry point: builds the UI from the modules in ui/ and starts the frame loop.
import { api, mixer, DECKS, state, toast } from './ui/core.js';
import { buildDeck, renderTempo, renderKeys, renderStems } from './ui/deck.js';
import { buildMixer, setupSfx } from './ui/mixer-ui.js';
import { frame, setupZoom } from './ui/waves.js';
import { refreshLibrary, setupLibrary, setupWindowDrop } from './ui/library.js';
import { renderHotcues } from './ui/grid.js';
import { setupAiChip } from './ui/load.js';
import { setupCc, setupYtdlpChip } from './ui/search.js';
import { setupDialogs, setupTabs, setupLayout, setupSettings } from './ui/settings.js';
import { setupKeyboard } from './ui/keyboard.js';
import { setupVideoScreen } from './ui/video.js';
import { setupSync } from './ui/sync-ui.js';

setupSync();
DECKS.forEach(buildDeck);
buildMixer();
setupLibrary();
setupWindowDrop();
setupCc();
setupDialogs();
setupTabs();
setupZoom();
setupKeyboard();
setupYtdlpChip();
setupAiChip();
setupVideoScreen();
setupLayout();
setupSettings();
setupSfx();
DECKS.forEach((n) => {
  renderTempo(n);
  renderHotcues(n);
  renderStems(n);
});
renderKeys();
api.stems.onProgress(({ trackId, done, total }) => {
  if (!state.stemJobs.has(trackId)) return;
  state.stemJobs.set(trackId, { done, total });
  DECKS.forEach(renderStems);
  if (done === 1) state.renderAiChip?.(); // shows GPU / CPU once the model is running
});
mixer.fxReady.then((ok) => {
  if (!ok) toast('Key shift and stems couldn’t start on this computer — decks still play normally.', 'error');
});
refreshLibrary();
requestAnimationFrame(frame);

// Browsers start audio suspended until a user gesture.
window.addEventListener('pointerdown', () => mixer.resume(), { once: true });
window.addEventListener('keydown', () => mixer.resume(), { once: true });
