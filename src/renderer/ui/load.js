// Loading a track onto a deck: decode, analyse (in a worker), and AI stems in the background.
import { AI_STEM_NAMES } from '../engine.js';
import { mixToMono, computeWaveform, analyzeTrack, fitGridAt, detectKey, onsetEnvelope, ANALYSIS_VERSION, KEY_VERSION } from '../analysis.js';
import { api, $, mixer, group, DECKS, state, toast, cleanErr, ui, saveTrack } from './core.js';
import { doSync, listenAndTell } from './sync-ui.js';
import { renderDeckState, renderStems } from './deck.js';
import { hideDropOverlay, importFiles } from './library.js';
import { loudness } from './video.js';

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
/** op 'analyze' (tempo, meter, key), 'key', 'onsets' or 'fitAt' (re-fit the grid at a given BPM). mono is copied, not consumed. */
export function analyse(op, mono, sampleRate, bpm) {
  if (!analysisWorker) {
    const run = { analyze: analyzeTrack, key: detectKey, onsets: onsetEnvelope, fitAt: fitGridAt }[op];
    return Promise.resolve(run(mono, sampleRate, bpm));
  }
  return new Promise((resolve, reject) => {
    const id = ++analysisSeq;
    analysisWaiting.set(id, { resolve, reject });
    const copy = mono.slice();
    analysisWorker.postMessage({ id, op, mono: copy, sampleRate, bpm }, [copy.buffer]);
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
    const mono = mixToMono(channels);
    const wave = computeWaveform(mono, buffer.sampleRate, 300);

    const patch = {};
    if (!track.duration) patch.duration = buffer.duration;
    if (needsAnalysis(track)) {
      d.artist.textContent = 'Finding the beat…';
      const { tempo, meter, key } = await analyse('analyze', mono, buffer.sampleRate);
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
          bpmAlts: tempo.alts,
        });
      } else {
        patch.bpm = 0; // analysed, no clear beat
      }
      if (needsKey(track)) Object.assign(patch, keyPatch(key));
    } else if (needsKey(track)) {
      d.artist.textContent = 'Finding the key…';
      Object.assign(patch, keyPatch(await analyse('key', mono, buffer.sampleRate)));
    }
    if (Object.keys(patch).length) await saveTrack(track, patch);
    if (track.bpm === 0) track.bpm = null;

    state.waves[name] = wave;
    state.overviewImg[name] = null;
    deck.load(buffer, track);
    deck.onsets = null;
    // The hits Sync listens to: in the background, ready a moment after the track.
    analyse('onsets', mono, buffer.sampleRate).then((o) => {
      if (deck.track !== track) return;
      deck.onsets = o;
      // Synced before its hits were ready (Sync stays on across loads): listen now, unless it's on air.
      if (group.has(deck) && loudness(name) < 0.1) listenAndTell(name);
    }).catch((err) => console.error('Onsets unavailable:', err));
    state.knobs[name].forEach((k) => k.set(k.reset)); // gain, EQ and filter back to 12 o'clock
    // A fresh load starts at normal speed; keep the slider in step.
    d.tempo.value = 0;
    deck.setRate(1);
    if (deck.resync && deck.bpm) doSync(name);
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
  const buffers = {};
  for (const n of AI_STEM_NAMES) {
    const data = await api.stems.read(trackId, n);
    buffers[n] = await mixer.ctx.decodeAudioData(data);
  }
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
