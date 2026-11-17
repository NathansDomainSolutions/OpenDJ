// Loading a track onto a deck: decode, analyse (in a worker), and AI stems in the background.
import { AI_STEM_NAMES } from '../engine.js';
import { mixToMono, ANALYSIS_VERSION, KEY_VERSION } from '../analysis.js';
import { api, $, mixer, DECKS, activeDecks, state, toast, cleanErr, ui, saveTrack } from './core.js';
import { doSync } from './sync-ui.js';
import { renderDeckState, renderStems } from './deck.js';
import { hideDropOverlay, importFiles } from './library.js';

// Reading and analysis run in a worker so loading never stalls the decks. A worker that
// fails or hangs is stopped, its jobs fail, and the next job starts a fresh one.
let analysisWorker = null;
let analysisSeq = 0;
const analysisWaiting = new Map();
const ANALYSIS_TIMEOUT = 120000; // a job that takes this long is stuck: don't leave the deck loading forever
function stopAnalysisWorker(error) {
  analysisWorker?.terminate();
  analysisWorker = null;
  for (const job of analysisWaiting.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  analysisWaiting.clear();
}
function startAnalysisWorker() {
  analysisWorker = new Worker(new URL('../analysis-worker.js', import.meta.url), { type: 'module' });
  analysisWorker.onmessage = ({ data }) => {
    const job = analysisWaiting.get(data.id);
    analysisWaiting.delete(data.id);
    if (job) clearTimeout(job.timer);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(data.result);
  };
  analysisWorker.onerror = (event) => {
    event.preventDefault();
    stopAnalysisWorker(new Error('Track analysis stopped. Try loading the track again.'));
  };
  analysisWorker.onmessageerror = () => stopAnalysisWorker(new Error('Track analysis could not be read. Try loading the track again.'));
}
/**
 * Run a job in the worker (see analysis-worker.js): 'prepare' (waveform, and as `want` asks
 * the beat grid and key), 'fitAt' (re-fit the grid at `bpm`) or 'read' (`mono` is then the
 * file's URL; resolves to its bytes). Samples are handed over to the worker: `mono` is empty
 * here afterwards.
 */
export function analyse(op, mono, sampleRate, { bpm, want } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++analysisSeq;
    try {
      if (!analysisWorker) startAnalysisWorker();
      const timer = setTimeout(() => stopAnalysisWorker(new Error('Track preparation timed out. Try loading the track again.')), ANALYSIS_TIMEOUT);
      analysisWaiting.set(id, { resolve, reject, timer });
      if (op === 'read') analysisWorker.postMessage({ id, op, url: mono });
      else analysisWorker.postMessage({ id, op, mono, sampleRate, bpm, want }, [mono.buffer]);
    } catch (err) {
      clearTimeout(analysisWaiting.get(id)?.timer);
      analysisWaiting.delete(id);
      reject(err);
    }
  });
}

// Decoding a whole song allocates its samples on the UI thread: one at a time, tracks and
// stems alike, so several never land together. `current()` false = the load was superseded.
let trackDecodeQueue = Promise.resolve();
function decodeTrack(url, current) {
  const decoding = trackDecodeQueue.then(async () => {
    if (!current()) return null;
    const data = await analyse('read', url);
    if (!current()) return null;
    const buffer = await mixer.ctx.decodeAudioData(data);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return buffer;
  });
  trackDecodeQueue = decoding.then(() => {}, () => {});
  return decoding;
}
// Grids made by an older analyser are redone on load, unless you set them by hand (TAP, Beat 1, ÷2, ×2 ...).
const needsAnalysis = (t) => t.bpm == null || (t.gridVersion !== ANALYSIS_VERSION && t.gridSource !== 'user');
// Keys found by an older detector are found again.
const needsKey = (t) => t.key == null || t.keyVersion !== KEY_VERSION;
// What's stored of a key reading: key (-1 = analysed, no clear key), the notes played, and the tuning.
const keyPatch = (key) => ({ key: key ? key.key : -1, chroma: key?.chroma ?? null, tuning: key?.tuning ?? 0, keyVersion: KEY_VERSION });

export async function loadToDeck(name, trackId) {
  const deck = mixer.decks[name];
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (track.missing) return toast('That file is missing — it may have been moved or deleted.', 'error');

  const d = ui[name];
  // A newer load onto this deck supersedes this one at its next step.
  const request = Symbol();
  deck.loadRequest = request;
  const current = () => deck.loadRequest === request;
  d.root.classList.add('loading');
  d.title.textContent = track.title;
  d.artist.textContent = 'Loading…';
  try {
    await mixer.resume();
    const url = await api.library.audioUrl(track.id);
    if (!current()) return;
    const buffer = await decodeTrack(url, current);
    if (!current()) return;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    // The waveform, beat grid and key are all worked out in the worker, in one pass.
    const want = { grid: needsAnalysis(track), key: needsKey(track) };
    if (want.grid || want.key) d.artist.textContent = want.grid ? 'Finding the beat…' : 'Finding the key…';
    // The mono mix is handed over to the worker. A mono file's mix is the track itself: send a copy of that.
    const mono = channels.length === 1 ? channels[0].slice() : mixToMono(channels);
    const { wave, tempo, meter, key } = await analyse('prepare', mono, buffer.sampleRate, { want });
    if (!current()) return;

    const patch = {};
    if (!track.duration) patch.duration = buffer.duration;
    if (want.grid) {
      if (track.bpm) patch.gridPrev = { bpm: track.bpm, beatOffset: track.beatOffset, beatsPerBar: track.beatsPerBar, downbeat: track.downbeat };
      Object.assign(patch, { gridVersion: ANALYSIS_VERSION, gridSource: 'auto' });
      if (tempo) {
        Object.assign(patch, {
          bpm: tempo.bpm,
          beatOffset: tempo.offset,
          beatsPerBar: meter?.beatsPerBar ?? 4,
          downbeat: meter ? meter.downbeat : tempo.offset,
          bpmConfidence: tempo.confidence,
          gridRms: tempo.gridRms,
          variable: tempo.variable,
          warp: tempo.warp,
          bpmAlts: tempo.alts,
        });
      } else {
        patch.bpm = 0; // analysed, no clear beat
      }
    }
    if (want.key) Object.assign(patch, keyPatch(key));
    if (Object.keys(patch).length) await saveTrack(track, patch);
    if (track.bpm === 0) track.bpm = null;
    if (!current()) return;

    state.waves[name] = wave;
    state.overviewImg[name] = null;
    deck.load(buffer, track);
    state.knobs[name].forEach((k) => k.set(k.reset)); // gain, EQ and filter back to 12 o'clock
    // A fresh load starts at normal speed; keep the slider in step.
    d.tempo.value = 0;
    deck.setRate(1);
    if (deck.resync && deck.grid) doSync(name);
    prepareAiStems(name, track, buffer, { cachedOnly: true }); // cached AI stems only; DSP stems work meanwhile
  } catch (err) {
    if (!current()) return;
    console.error(err);
    toast(`Couldn't load “${track.title}”: ${cleanErr(err)}`, 'error');
    d.title.textContent = deck.track?.title || 'No track loaded';
    d.artist.textContent = deck.track?.artist || '';
  } finally {
    if (current()) {
      d.root.classList.remove('loading');
      renderDeckState(name);
    }
  }
}

export function setupDeckDrop(el, name) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/x-cdj-track') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/x-cdj-track');
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      loadToDeck(name, id);
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();
      const added = await importFiles(e.dataTransfer.files);
      if (added[0]) loadToDeck(name, added[0].id);
    }
  });
}

// ------------------------------------------------------------------ AI stems (prototype)

async function loadAiStems(name, trackId) {
  const deck = mixer.decks[name];
  const track = deck.track;
  const current = () => deck.track === track && track?.id === trackId; // another track was loaded meanwhile
  const buffers = {};
  for (const n of AI_STEM_NAMES) {
    if (!current()) return;
    buffers[n] = await decodeTrack(await api.stems.audioUrl(trackId, n), current);
  }
  if (current()) deck.setAiStems(buffers);
}

/** Resample to 44.1 kHz stereo for the model. */
async function toModelPcm(buffer) {
  const len = Math.ceil(buffer.duration * 44100);
  const off = new OfflineAudioContext(2, len, 44100);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return [r.getChannelData(0), r.getChannelData(1)];
}

/** Use a track's cached AI stems, or (unless `cachedOnly`: a plain load never starts one) separate it once. */
async function prepareAiStems(name, track, buffer, { cachedOnly = false } = {}) {
  try {
    const st = await api.stems.status(track.id);
    if (!st.available) return; // not installed: DSP stems only
    if (st.ready) return await loadAiStems(name, track.id);
    if (cachedOnly) return;
    if (state.stemJobs.has(track.id)) return;
    state.stemJobs.set(track.id, { done: 0, total: 0 });
    state.renderAiChip?.();
    DECKS.forEach(renderStems);
    const [left, right] = await toModelPcm(buffer);
    await api.stems.separate(track.id, left, right);
    state.stemJobs.delete(track.id);
    for (const n of DECKS) if (mixer.decks[n].track?.id === track.id) await loadAiStems(n, track.id);
    toast(`AI stems ready for “${track.title}”.`);
  } catch (err) {
    state.stemJobs.delete(track.id);
    console.error(err);
    toast(`AI stems failed: ${cleanErr(err)} — using DSP stems.`, 'error');
  } finally {
    DECKS.forEach(renderStems);
    state.renderAiChip?.();
  }
}

// AI stems: cached stems load with the track; separating a new track starts only when
// asked for here (the first click also downloads the separation model).
export async function setupAiChip() {
  const chip = $('#aiChip');
  let preparing = false;
  const render = async () => {
    const s = await api.stems.setup();
    chip.hidden = !s.runtime;
    chip.disabled = preparing || s.downloading || state.stemJobs.size > 0;
    if (s.model) {
      chip.className = 'chip ok';
      chip.textContent = preparing || state.stemJobs.size ? 'Preparing AI stems…' : 'Prepare AI stems';
      chip.title = `Prepare AI stems for the loaded decks, one track at a time${s.gpuModel ? ` (on your graphics card: ${s.gpuModel})` : ''}. Cached stems load automatically; dropping a track never starts new separation.`;
    } else if (!s.downloading) {
      chip.className = 'chip warn';
      chip.textContent = 'Get AI stems';
      chip.title = 'Download the HT-Demucs separation model (158 MB, from Hugging Face) for much cleaner vocals / drums / instruments.';
    }
    return s;
  };
  api.stems.onModelProgress(({ got, total }) => {
    chip.textContent = `AI stems ${Math.round((got / total) * 100)}%`;
  });
  chip.addEventListener('click', async () => {
    if (preparing) return;
    preparing = true;
    chip.disabled = true;
    try {
      const s = await render();
      if (s.downloading || state.stemJobs.size) return;
      if (!s.model) {
        chip.disabled = true;
        chip.className = 'chip';
        chip.textContent = 'AI stems 0%';
        await api.stems.downloadModel();
        toast('AI stems model installed — preparing the loaded tracks.');
      }
      for (const n of activeDecks()) {
        const deck = mixer.decks[n];
        if (deck.track && deck.buffer) await prepareAiStems(n, deck.track, deck.buffer);
      }
    } catch (err) {
      toast(`Couldn't get the AI stems model: ${cleanErr(err)}`, 'error');
    } finally {
      preparing = false;
      render();
    }
  });
  state.renderAiChip = render;
  render();
}
