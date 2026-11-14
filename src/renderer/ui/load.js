// Loading a track onto a deck: decode, analyse (in a worker), and AI stems in the background.
import { AI_STEM_NAMES } from '../engine.js';
import { mixToMono, computeWaveform, analyzeTrack, fitGridAt, detectKey, ANALYSIS_VERSION, KEY_VERSION } from '../analysis.js';
import { api, $, mixer, DECKS, state, toast, cleanErr, ui, saveTrack } from './core.js';
import { doSync } from './sync-ui.js';
import { renderDeckState, renderStems } from './deck.js';
import { hideDropOverlay, importFiles } from './library.js';

// Analysis runs in a worker so loading never stalls the decks; the main thread is the fallback.
let analysisWorker = null;
let analysisSeq = 0;
const analysisWaiting = new Map();
try {
  analysisWorker = new Worker(new URL('../analysis-worker.js', import.meta.url), { type: 'module' });
  analysisWorker.onmessage = ({ data }) => {
    const job = analysisWaiting.get(data.id);
    analysisWaiting.delete(data.id);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(data.result);
  };
} catch (err) {
  console.error('Analysis worker unavailable, analysing on the main thread:', err);
}
/**
 * Run an analysis job in the worker (see analysis-worker.js): 'prepare' (waveform, and as
 * `want` asks the beat grid and key) or 'fitAt' (re-fit the grid at `bpm`).
 * `mono` is handed over to the worker: it is empty here afterwards.
 */
export function analyse(op, mono, sampleRate, { bpm, want } = {}) {
  if (!analysisWorker) {
    if (op === 'fitAt') return Promise.resolve(fitGridAt(mono, sampleRate, bpm));
    const result = { wave: computeWaveform(mono, sampleRate, 300) };
    if (want?.grid) Object.assign(result, analyzeTrack(mono, sampleRate, { key: !!want.key }));
    else if (want?.key) result.key = detectKey(mono, sampleRate);
    return Promise.resolve(result);
  }
  return new Promise((resolve, reject) => {
    const id = ++analysisSeq;
    analysisWaiting.set(id, { resolve, reject });
    analysisWorker.postMessage({ id, op, mono, sampleRate, bpm, want }, [mono.buffer]);
  });
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
  d.root.classList.add('loading');
  d.title.textContent = track.title;
  d.artist.textContent = 'Loading…';
  try {
    await mixer.resume();
    const data = await api.library.readAudio(track.id);
    const buffer = await mixer.ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    // The waveform, beat grid and key are all worked out in the worker, in one pass.
    const want = { grid: needsAnalysis(track), key: needsKey(track) };
    if (want.grid || want.key) d.artist.textContent = want.grid ? 'Finding the beat…' : 'Finding the key…';
    // The mono mix is handed over to the worker. A mono file's mix is the track itself: send a copy of that.
    const mono = channels.length === 1 ? channels[0].slice() : mixToMono(channels);
    const { wave, tempo, meter, key } = await analyse('prepare', mono, buffer.sampleRate, { want });

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

    state.waves[name] = wave;
    state.overviewImg[name] = null;
    deck.load(buffer, track);
    state.knobs[name].forEach((k) => k.set(k.reset)); // gain, EQ and filter back to 12 o'clock
    // A fresh load starts at normal speed; keep the slider in step.
    d.tempo.value = 0;
    deck.setRate(1);
    if (deck.resync && deck.grid) doSync(name);
    prepareAiStems(name, track, buffer); // background; DSP stems work meanwhile
  } catch (err) {
    console.error(err);
    toast(`Couldn't load “${track.title}”: ${cleanErr(err)}`, 'error');
    d.title.textContent = deck.track?.title || 'No track loaded';
    d.artist.textContent = deck.track?.artist || '';
  } finally {
    d.root.classList.remove('loading');
    renderDeckState(name);
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
  // All four at once: reading and decoding run off the main thread, side by side.
  const decoded = await Promise.all(AI_STEM_NAMES.map(async (n) => mixer.ctx.decodeAudioData(await api.stems.read(trackId, n))));
  const buffers = Object.fromEntries(AI_STEM_NAMES.map((n, i) => [n, decoded[i]]));
  if (deck.track?.id === trackId) deck.setAiStems(buffers);
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

/** After a track loads: use cached AI stems, or separate it once in the background. */
async function prepareAiStems(name, track, buffer) {
  try {
    const st = await api.stems.status(track.id);
    if (!st.available) return; // not installed: DSP stems only
    if (st.ready) return await loadAiStems(name, track.id);
    if (state.stemJobs.has(track.id)) return;
    state.stemJobs.set(track.id, { done: 0, total: 0 });
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
  }
}

// AI stems: one click downloads the separation model; after that every track
// is separated once in the background and the stem buttons switch to it.
export async function setupAiChip() {
  const chip = $('#aiChip');
  const render = async () => {
    const s = await api.stems.setup();
    chip.hidden = !s.runtime;
    if (s.model) {
      chip.className = 'chip ok';
      chip.textContent = `AI stems${s.provider === 'cuda' || s.provider === 'dml' ? ' · GPU' : s.provider === 'cpu' ? ' · CPU' : ''}`;
      chip.title = s.gpuModel
        ? `Studio-grade AI stems on your graphics card: ${s.gpuModel}. Each track is separated once, in the background, then cached.`
        : 'Clean AI stem separation is on. Each track is separated once, in the background, then cached.';
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
    const s = await render();
    if (s.model || s.downloading) return;
    chip.className = 'chip';
    chip.textContent = 'AI stems 0%';
    try {
      await api.stems.downloadModel();
      toast('AI stems model installed — separating the loaded tracks.');
      for (const n of DECKS) {
        const deck = mixer.decks[n];
        if (deck.track && deck.buffer) prepareAiStems(n, deck.track, deck.buffer);
      }
    } catch (err) {
      toast(`Couldn't get the AI stems model: ${cleanErr(err)}`, 'error');
    }
    render();
  });
  state.renderAiChip = render;
  render();
}
