// Track analysis off the main thread (module Worker), so loading a track never stalls the decks.
// Message: { id, op, mono: Float32Array (transferred), sampleRate, bpm, want }
//   'prepare': everything a load needs in one go: the waveform, and with want.grid the
//              tempo, beat grid and meter, with want.key the key.
//   'fitAt':   re-fit the beat grid at a given BPM.
//   'read':    fetch the encoded audio file at `url`, so its bytes never pass through the UI thread's bridge.
// Reply:   { id, result } or { id, error }
import { analyzeTrack, fitGridAt, detectKey, computeWaveform } from './analysis.js';

self.onmessage = async ({ data: { id, op, mono, sampleRate, bpm, want, url } }) => {
  try {
    if (op === 'read') {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not read audio (HTTP ${response.status}).`);
      const result = await response.arrayBuffer();
      self.postMessage({ id, result }, [result]);
    } else if (op === 'prepare') {
      const result = { wave: computeWaveform(mono, sampleRate, 300) };
      if (want?.grid) Object.assign(result, analyzeTrack(mono, sampleRate, { key: !!want.key }));
      else if (want?.key) result.key = detectKey(mono, sampleRate);
      const w = result.wave;
      self.postMessage({ id, result }, [w.peak, w.low, w.mid, w.high].filter((a) => a?.buffer).map((a) => a.buffer));
    } else if (op === 'fitAt') self.postMessage({ id, result: fitGridAt(mono, sampleRate, bpm) });
    else throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
