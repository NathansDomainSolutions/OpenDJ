// Compare hot-loop CPU time with a Git revision; timings are informational, never CI thresholds.
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const baseline = process.argv[2] || '245e00b';
const read = (file, old) => old ? execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8');
function medianMs(run) {
  run();
  const times = Array.from({ length: 5 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  });
  return times.sort((a, b) => a - b)[2];
}
function waveform(old) {
  const source = read('src/renderer/app.js', old);
  const context = vm.createContext({ Path2D: class { rect() {} }, INK: { ink: '0,0,0', bands: { low: [1], mid: [2], high: [3] } } });
  vm.runInContext(source.slice(source.indexOf('const BANDS ='), source.indexOf('function drawScrolling')), context);
  const wave = Object.fromEntries(['peak', 'low', 'mid', 'high'].map((key, band) => [key,
    Float32Array.from({ length: 30000 }, (_, i) => Math.abs(Math.sin(i * (band + 1) / 17)))]));
  const ctx = { fill() {} };
  return medianMs(() => {
    for (let frame = 0; frame < 40; frame++) {
      const from = 1500 + frame * 5;
      const args = old ? [x => [from + x * 4, from + (x + 1) * 4]] : [from, 4];
      context.drawBands(ctx, wave, 1200, 60, 50, ...args);
    }
  });
}
function worklet(old, active) {
  let Processor;
  vm.runInNewContext(read('src/renderer/deck-fx.worklet.js', old), {
    sampleRate: 48000, AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor: (_name, ctor) => { Processor = ctor; },
  });
  const processors = Array.from({ length: 4 }, () => new Processor());
  const tone = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10) * 0.5);
  const input = [active ? [tone, tone] : []];
  const output = [[new Float32Array(128), new Float32Array(128)]];
  return medianMs(() => { for (let i = 0; i < 1000; i++) for (const p of processors) p.process(input, output); });
}
const results = {};
for (const [name, run] of Object.entries({ waveform, idleAudio: old => worklet(old, false), bypassAudio: old => worklet(old, true) })) {
  const before = run(true), after = run(false);
  results[name] = { beforeMs: +before.toFixed(2), afterMs: +after.toFixed(2), reductionPercent: +((1 - after / before) * 100).toFixed(1) };
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/benchmark.json', JSON.stringify({ baseline, node: process.version, arch: process.arch, results }, null, 2));
for (const result of Object.values(results)) if (!(result.beforeMs > 0 && result.afterMs > 0)) throw new Error('Invalid timing');
console.log(JSON.stringify(results, null, 2));
