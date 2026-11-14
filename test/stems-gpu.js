// Headless test of the keep-alive GPU stem separator: the real main process and the real
// src/stems-gpu.py, with a stand-in for the audio-separator package (no models, no GPU).
// Checks that several tracks go through ONE Python process that loads each model once,
// and that a failing track doesn't take the process down.
// Run: xvfb-run electron test/stems-gpu.js   (needs python3 with numpy and soundfile)
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-stems-gpu-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');

const log = path.join(tmp, 'loads.log');
process.env.CDJ_FAKE_SEPARATOR_LOG = log;
process.env.PYTHONPATH = path.join(__dirname, 'fake-separator');
const gpuDir = path.join(tmp, 'stems-gpu');
fs.mkdirSync(path.join(gpuDir, 'Scripts'), { recursive: true });
fs.writeFileSync(path.join(gpuDir, 'Scripts', 'python.exe'), '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(gpuDir, 'ready.json'), JSON.stringify({ vocalModel: 'vocal-model', splitModel: 'split-model', label: 'Fake GPU' }));
const track = (id) => ({ id, title: id, artist: 'Test', file: path.join(tmp, `${id}.wav`), duration: 2, bpm: 120, beatOffset: 0, cues: [null, null, null, null], source: { kind: 'local' } });
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: ['t1', 't2', 't3'].map(track) }));

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  app.exit(1);
};
setTimeout(() => fail('timed out'), 60000);

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const separate = (id, seconds) =>
      win.webContents.executeJavaScript(`(async () => {
        const n = Math.round(44100 * ${seconds});
        const left = new Float32Array(n).map((_, i) => Math.sin(i / 20) * 0.5);
        const events = [];
        const off = window.cdj.stems.onProgress((p) => events.push(p.done + '/' + p.total));
        try { return { ...(await window.cdj.stems.separate(${JSON.stringify(id)}, left, left.slice())), events }; }
        catch (err) { return { error: String(err.message || err) }; }
        finally { off && off(); }
      })()`);
    try {
      const a = await separate('t1', 2);
      const b = await separate('t2', 2);
      const bad = await separate('t3', 0.01); // the stand-in refuses this; there is no CPU model to fall back to
      const c = await separate('t3', 2); // ...and the same process must still be there for the next track
      const again = await separate('t1', 2);
      const loads = fs.readFileSync(log, 'utf8').trim().split('\n');
      const pids = new Set(loads.map((l) => l.split(' ')[0]));
      const files = ['vocals', 'drums', 'bass', 'other'].every((n) => ['t1', 't2', 't3'].every((id) => fs.statSync(path.join(tmp, 'stems', id, `${n}.wav`)).size === 44 + 88200 * 4));
      console.log(JSON.stringify({ a, b, bad, c, again, loads }, null, 1));
      if (a.device !== 'cuda' || b.device !== 'cuda' || c.device !== 'cuda') return fail('a track did not come back from the GPU path');
      if (!a.events.includes('3/3')) return fail('no progress events reached the window');
      if (!bad.error) return fail('the bad track should have failed');
      if (!again.cached) return fail('a finished track should come from the cache');
      if (loads.length !== 2 || pids.size !== 1) return fail(`expected one process loading two models, saw ${loads.length} loads in ${pids.size} processes`);
      if (!files) return fail('stem files are missing or the wrong length');
      console.log('stems-gpu: ok');
      app.exit(0);
    } catch (err) {
      fail(err.stack || err);
    }
  });
});

require('../src/main.js');
