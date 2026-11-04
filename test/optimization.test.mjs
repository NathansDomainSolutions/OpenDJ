import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FxChain } from '../src/renderer/engine.js';
import { analyzeTrack, detectTempo, onsetEnvelope } from '../src/renderer/analysis.js';

// The audio-thread processor must preserve delay, tails and quiet transients.
let Processor;
vm.runInNewContext(fs.readFileSync('src/renderer/deck-fx.worklet.js', 'utf8'), {
  sampleRate: 48000,
  AudioWorkletProcessor: class { port = { postMessage() {} }; },
  registerProcessor: (_name, ctor) => { Processor = ctor; },
});
function render(processor, left, right = left) {
  const out = [new Float32Array(left.length + 4096), new Float32Array(left.length + 4096)];
  const block = [new Float32Array(128), new Float32Array(128)];
  for (let offset = 0; offset < out[0].length; offset += 128) {
    processor.process([offset < left.length ? [left.subarray(offset, offset + 128), right.subarray(offset, offset + 128)] : []], [block]);
    out[0].set(block[0], offset);
    out[1].set(block[1], offset);
  }
  return out;
}
const tone = Float32Array.from({ length: 16384 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000));
const right = Float32Array.from(tone, v => -v * 0.7);
const bypass = render(new Processor(), tone, right);
for (let ch = 0; ch < 2; ch++) {
  const input = ch ? right : tone;
  for (let i = 0; i < bypass[ch].length; i++) {
    assert.ok(Math.abs(bypass[ch][i] - (input[i - 2048] || 0)) < 1e-6, 'bypass stays sample-aligned, including its tail');
  }
}
const impulse = new Float32Array(4096);
impulse[1001] = 1; // Not on a multiple of four: the old silence shortcut missed this.
const muted = render(new Processor({ processorOptions: { stems: { vocals: 0, drums: 0, instruments: 0 } } }), impulse);
assert.ok(muted.every(ch => ch.every(v => Math.abs(v) < 1e-8)), 'muted stems cannot leak sparse transients');
const processor = new Processor();
processor.configure({ stems: { vocals: NaN, drums: Infinity }, pitch: NaN });
assert.equal(processor.stems.vocals, 1);
assert.equal(processor.stems.drums, 1);
assert.equal(processor.pitch, 1);

// Reusing an envelope must not change tempo analysis or force a cached key to be recomputed.
const clicks = new Float32Array(48000 * 60);
for (let at = 4800; at < clicks.length - 2400; at += 24000) {
  for (let i = 0; i < 2400; i++) clicks[at + i] = Math.sin(2 * Math.PI * 65 * i / 48000) * Math.exp(-i / 500);
}
const onsets = onsetEnvelope(clicks, 48000);
const analyzed = analyzeTrack(clicks, 48000, { onsets, key: false });
assert.deepEqual(analyzed.tempo, detectTempo(clicks, 48000));
assert.equal(analyzed.key, null);
assert.ok(analyzed.tempo?.bpm > 0);

// Changing gate division reschedules it; switching off releases the oscillator.
const stopped = [], disconnected = [];
const fx = Object.assign(Object.create(FxChain.prototype), {
  ctx: { currentTime: 2, sampleRate: 48000, createOscillator: () => ({
    frequency: {}, setPeriodicWave() {}, connect() {}, start(t) { this.when = t; },
    stop(t) { stopped.push(t); this.onended(); }, disconnect() { disconnected.push(true); },
  }) },
  deck: { playing: true, bpm: 120, rate: 1, position: 4, track: { beatOffset: 0 } },
  state: { gate: { on: true, div: 2 } }, apply() {},
});
fx.syncGate();
assert.equal(fx.gateOsc.frequency.value, 4);
fx.set('gate', { div: 4 });
assert.equal(fx.gateOsc.frequency.value, 8);
fx.set('gate', { on: false });
assert.equal(fx.gateOsc, null);
assert.equal(stopped.length, 2);
assert.equal(disconnected.length, 2);

const engineSource = fs.readFileSync('src/renderer/engine.js', 'utf8');
const node = () => ({ gain: {}, threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect(target) { this.target = target; } });
const mixerContext = vm.createContext({ console, URL, XF_SIDE: { A: 'L', B: 'R', C: 'L', D: 'R' },
  AudioContext: class { createGain = node; createDynamicsCompressor = node; createAnalyser = node;
    audioWorklet = { addModule: async () => {} }; },
  Deck: class { constructor(_m, name) { this.name = name; this.xfade = { gain: { setTargetAtTime() {} } }; } attachFx() {} attachScratch() {} },
});
vm.runInContext(engineSource.slice(engineSource.indexOf('export class Mixer'), engineSource.indexOf('export class Deck')).replace('export ', '').replaceAll('import.meta.url', "'file:///engine.js'") + '\nglobalThis.mixer = new Mixer();', mixerContext);
assert.equal(mixerContext.mixer.sfx.target, mixerContext.mixer.master, 'master volume controls the sound pads');

// Bulk imports deduplicate within a batch and preserve the newest-first library order.
const main = fs.readFileSync('src/main.js', 'utf8');
let nextId = 0, saves = 0;
const context = vm.createContext({ path, pathToFileURL, paths: { root: path.resolve('test-data') },
  library: { tracks: [{ id: 'existing', file: 'old.wav' }] }, AUDIO_EXTENSIONS: ['wav'],
  newId: () => String(++nextId), publicTrack: t => t, saveLibrary: () => saves++,
});
vm.runInContext(main.slice(main.indexOf('async function importLocalFiles'), main.indexOf('// ---------------------------------------------------------------- AI stems')), context);
const imported = await context.importLocalFiles(['old.wav', 'A - first.wav', 'second.wav', 'second.wav', null, {}, 'ignore.txt']);
assert.deepEqual(Array.from(imported, t => t.file), ['A - first.wav', 'second.wav']);
assert.deepEqual(Array.from(context.library.tracks, t => t.file), ['second.wav', 'A - first.wav', 'old.wav']);
assert.equal(imported[0].artist, 'A');
assert.equal(saves, 1);
vm.runInContext(main.slice(main.indexOf('function safeId'), main.indexOf('function cachedVideo')), context);
for (const id of ['', '..', '../other', 'a/b', null, 1]) assert.throws(() => context.safeId(id), /Invalid track ID/);
assert.equal(context.safeId('valid-id_1'), 'valid-id_1');
context.findTrack = () => ({ source: { kind: 'web', url: 'https://example.com/video' } });
context.cachedVideo = () => path.resolve('cached video.mp4');
vm.runInContext(main.slice(main.indexOf('async function fetchVideo'), main.indexOf('// ---------------------------------------------------------------- IPC')), context);
assert.equal(await context.fetchVideo('valid-id_1'), pathToFileURL(path.resolve('cached video.mp4')).href, 'cached videos stream from disk');

// Waveform layers still draw larger bands behind smaller ones, including ties and the final column.
const app = fs.readFileSync('src/renderer/app.js', 'utf8');
{
  let decoding = 0, peak = 0;
  const reads = [];
  const ctx = vm.createContext({ setTimeout,
    analyse: async (_op, url) => { reads.push(url); return url; },
    mixer: { ctx: { decodeAudioData: async data => {
      decoding++; peak = Math.max(peak, decoding);
      await new Promise(resolve => setTimeout(resolve, 1));
      decoding--;
      if (data === 'broken') throw new Error('bad audio');
      return data;
    } } },
  });
  vm.runInContext(app.slice(app.indexOf('let trackDecodeQueue'), app.indexOf('const analysisWaiting')), ctx);
  const jobs = [ctx.decodeTrack('broken', () => true), ctx.decodeTrack('obsolete', () => false), ctx.decodeTrack('stem', () => true)];
  await assert.rejects(jobs[0], /bad audio/);
  assert.equal(await jobs[1], null);
  assert.equal(await jobs[2], 'stem');
  assert.deepEqual(reads, ['broken', 'stem']);
  assert.equal(peak, 1, 'stems and tracks share one decode queue, which recovers from failures');
}
class TestPath { rects = []; rect(...args) { this.rects.push(args); } }
const drawing = vm.createContext({ Path2D: TestPath, INK: { ink: '0,0,0', bands: { low: [1], mid: [2], high: [3] } } });
vm.runInContext(app.slice(app.indexOf('const BANDS ='), app.indexOf('function drawScrolling')), drawing);
for (const values of [[0.8, 0.5, 0.2], [0.2, 0.8, 0.5], [0.5, 0.2, 0.8], [0.5, 0.5, 0.5]]) {
  const fills = [];
  const ctx = { fill(p) { fills.push({ color: this.fillStyle, rects: p.rects }); } };
  const wave = { peak: Float32Array.of(1), low: Float32Array.of(values[0]), mid: Float32Array.of(values[1]), high: Float32Array.of(values[2]) };
  drawing.drawBands(ctx, wave, 1, 50, 40);
  const colors = fills.slice(1).filter(p => p.rects.length).map(p => p.color);
  assert.deepEqual(colors, [0, 1, 2].sort((a, b) => values[b] - values[a]).map(i => `rgb(${i + 1})`));
  assert.equal(fills[0].rects.length, 1, 'a one-column waveform is visible');
}
console.log('all audio, waveform, analysis, media and import optimization checks passed');
