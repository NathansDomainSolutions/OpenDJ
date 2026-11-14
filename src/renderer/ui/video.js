// Music video screen in the middle of the console.
import { api, $, mixer, DECKS, activeDecks, toast, cleanErr, ui } from './core.js';

// One screen in the middle shows the music video of the loudest deck: playing, with
// its fader × crossfader the highest. A tie rolls a die, then sticks (no flicker);
// it only switches when another deck is clearly louder.

export const mvScreen = { el: null, video: null, get: null, tag: null, deck: null };

/** After a load: fetch the cached video in the background, or remember one can be fetched. */
export async function prepareVideo(name) {
  const d = ui[name];
  const t = mixer.decks[name].track;
  if (d.mvUrl) URL.revokeObjectURL(d.mvUrl);
  d.mvUrl = null;
  d.mvAvailable = false;
  if (!t) return;
  const s = await api.video.status(t.id);
  if (mixer.decks[name].track?.id !== t.id) return;
  d.mvAvailable = s.available;
  if (s.cached) getVideo(name);
}

async function getVideo(name) {
  const d = ui[name];
  const id = mixer.decks[name].track?.id;
  if (!id || d.mvFetching) return;
  d.mvFetching = true;
  try {
    const data = await api.video.get(id);
    if (mixer.decks[name].track?.id === id) d.mvUrl = URL.createObjectURL(new Blob([data]));
  } catch (err) {
    toast(`Couldn't get the music video: ${cleanErr(err)}`, 'error');
  } finally {
    d.mvFetching = false;
  }
}

/** How loud a deck is in the mix right now (0…1): fader × crossfader, 0 when stopped. */
const loudness = (n) => {
  const deck = mixer.decks[n];
  return deck.playing ? deck.fader.gain.value * deck.xfade.gain.value : 0;
};

/** Which deck the screen shows: the loudest with a video (or a fetchable one), tie → a die roll. */
function pickVideoDeck() {
  const options = activeDecks().filter((n) => ui[n].mvUrl || ui[n].mvAvailable);
  if (!options.length) return null;
  const cur = options.includes(mvScreen.deck) ? mvScreen.deck : null;
  const best = Math.max(...options.map(loudness));
  if (best <= 0.01) return cur || options[0]; // nothing audible: keep what's showing
  if (cur && loudness(cur) >= best - 0.08) return cur; // stay unless another is clearly louder
  const loudest = options.filter((n) => loudness(n) >= best - 0.02);
  return loudest[Math.floor(Math.random() * loudest.length)]; // equally loud: roll the die
}

/** Show the chosen deck's video and keep it with that deck: play/pause, tempo, position. */
export function syncVideos() {
  const s = mvScreen;
  if (!s.el) return;
  const name = document.body.classList.contains('no-mv') ? null : pickVideoDeck();
  s.el.hidden = !name;
  if (!name) {
    if (!s.video.paused) s.video.pause();
    s.deck = null;
    return;
  }
  const d = ui[name];
  if (s.deck !== name) {
    s.deck = name;
    s.tag.textContent = name;
    s.el.dataset.deck = name;
  }
  s.el.classList.toggle('has-video', !!d.mvUrl);
  s.get.disabled = !!d.mvFetching;
  s.get.textContent = d.mvFetching ? (d.mvProgress != null ? `Getting video… ${d.mvProgress}%` : 'Getting video…') : `▶ Music video (deck ${name})`;
  if (!d.mvUrl) {
    if (s.video.getAttribute('src')) s.video.removeAttribute('src');
    return;
  }
  if (s.video.getAttribute('src') !== d.mvUrl) s.video.src = d.mvUrl;
  const v = s.video;
  if (!v.duration) return;
  const deck = mixer.decks[name];
  const target = Math.min(deck.position, v.duration - 0.05);
  v.playbackRate = Math.min(4, Math.max(0.25, deck.rate));
  if (deck.playing) {
    if (v.paused) v.play().catch(() => {});
    if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target; // scratching / dragging moves it
  }
}

export function setupVideoScreen() {
  const el = $('#mvCenter');
  Object.assign(mvScreen, { el, video: $('.mv-video', el), get: $('.mv-get', el), tag: $('.mv-tag', el) });
  mvScreen.get.addEventListener('click', () => mvScreen.deck && getVideo(mvScreen.deck));
  api.video.onProgress(({ trackId, percent }) => {
    for (const name of DECKS) if (mixer.decks[name].track?.id === trackId) ui[name].mvProgress = Math.round(percent);
  });
}
