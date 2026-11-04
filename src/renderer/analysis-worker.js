// Track analysis off the main thread (module Worker), so loading a track never stalls the decks.
// Message: { id, op, mono or channels (transferred), sampleRate, bpm, options }
// Reply:   { id, result } or { id, error }
import { analyzeTrack, fitGridAt, detectMeter, detectKey, onsetEnvelope, mixToMono, computeWaveform } from './analysis.js';

self.onmessage = async ({ data: { id, op, mono, channels, sampleRate, bpm, options, url } }) => {
  try {
    if (op === 'read') {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not read audio (HTTP ${response.status}).`);
      const result = await response.arrayBuffer();
      self.postMessage({ id, result }, [result]);
    }
    else if (op === 'prepare') {
      const samples = mixToMono(channels);
      const onsets = onsetEnvelope(samples, sampleRate);
      const analysis = options.analyze ? analyzeTrack(samples, sampleRate, { onsets, key: options.key }) : { key: options.key ? detectKey(samples, sampleRate) : null };
      const result = { ...analysis, wave: computeWaveform(samples, sampleRate, 300), onsets, channels };
      // Reuse these copies for scratching instead of copying a whole song again on the UI thread.
      self.postMessage({ id, result }, [...channels, result.wave.peak, result.wave.low, result.wave.mid, result.wave.high, onsets.env, onsets.bass].map((ch) => ch.buffer));
    }
    else if (op === 'grid') {
      const samples = mixToMono(channels);
      const fit = fitGridAt(samples, sampleRate, bpm);
      const meter = fit ? detectMeter(samples, sampleRate, fit.bpm, fit.offset) : null;
      self.postMessage({ id, result: fit ? { ...fit, meter } : null });
    }
    else if (op === 'analyze') self.postMessage({ id, result: analyzeTrack(mono, sampleRate) });
    else if (op === 'key') self.postMessage({ id, result: detectKey(mono, sampleRate) });
    else if (op === 'onsets') self.postMessage({ id, result: onsetEnvelope(mono, sampleRate) });
    else if (op === 'fitAt') self.postMessage({ id, result: fitGridAt(mono, sampleRate, bpm) });
    else throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
