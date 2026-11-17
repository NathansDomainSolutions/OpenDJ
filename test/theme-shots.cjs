// Screenshots of the real UI in every theme, for looking at a design change before shipping it.
// Boots the app with a disposable library of synthetic tracks (never the user's library),
// loads and plays two decks, then saves PNGs to out/shots/.
//
//   npm run shots [-- --only aero,cherry --size 1360x860]
'use strict';
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const ONLY = arg('only', '').split(',').filter(Boolean);
const [W, H] = arg('size', '1360x860').split('x').map(Number);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oscardj-shots-'));
const out = path.resolve(__dirname, '../out/shots');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', tmp);
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'headless'); // no window on the desktop
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// A minute of something that looks like music: kick, off-beat hats, a bass line and a pad,
// so the three waveform colours all show.
const SR = 44100;
function beatWav(bpm, seconds, root) {
  const n = Math.round(seconds * SR), x = new Float32Array(n), beat = 60 / bpm;
  let seed = 12345 + bpm;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, b = t / beat, inBeat = (b % 1) * beat, bar = Math.floor(b / 4);
    const section = Math.floor(bar / 8) % 4; // intro, full, break, full
    let v = 0;
    if (section !== 2) v += 0.8 * Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-inBeat * 30)) * inBeat) * Math.exp(-inBeat * 9); // kick
    const off = ((b + 0.5) % 1) * beat;
    if (section !== 0) v += 0.22 * noise() * Math.exp(-off * 45); // hat
    const step = Math.floor(b * 2) % 8;
    const f = root * [1, 1, 1.5, 1, 1.2, 1, 1.5, 2][step];
    if (section !== 0) v += 0.28 * Math.sign(Math.sin(2 * Math.PI * f * t)) * Math.exp(-((b * 2) % 1) * 2.5); // bass
    v += 0.1 * (Math.sin(2 * Math.PI * root * 4 * t) + Math.sin(2 * Math.PI * root * 5 * t) + Math.sin(2 * Math.PI * root * 6 * t)) * (0.6 + 0.4 * Math.sin(t / 3)); // pad
    x[i] = v * 0.8;
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return buf;
}

const TRACKS = [
  ['t1', 'Glass Horizon', 'Aqua Module', 126, 55, 8], ['t2', 'Skyline Bubbles', 'Vista Kids', 128, 65.4, 3],
  ['t3', 'Dew on Chrome', 'Lumen', 124, 49, 15], ['t4', 'Lagoon Loader', 'Bliss.exe', 140, 61.7, 20],
  ['t5', 'Cherry Soda Skies', 'Y2Kay', 132, 58.3, 5], ['t6', 'Sunday Aurora', 'Glossworks', 100, 43.6, 12],
];
const rows = TRACKS.map(([id, title, artist, bpm, root, key], i) => {
  const file = path.join(tmp, `${id}.wav`);
  fs.writeFileSync(file, beatWav(bpm, 70, root));
  return { id, file, title, artist, duration: 70, bpm, beatOffset: 0, beatsPerBar: 4, downbeat: 0, gridSource: 'user', gridVersion: 99,
    key, chroma: [1, 0, 0.1, 0, 0.8, 0.2, 0, 0.7, 0, 0.2, 0, 0.1], tuning: 0, keyVersion: 99,
    cues: i < 2 ? [8, 16, null, 32] : [null, null, null, null], source: { kind: 'local' } };
});
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: rows }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => (channel === 'ytdlp:status' ? { installed: false } : fn(...args)));
const watchdog = setTimeout(() => { console.error('theme shots timed out'); app.exit(1); }, 120000);

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = async (code) => {
      for (let i = 0; i < 200; i++) { if (await js(code)) return; await sleep(50); }
      throw new Error(`Timed out: ${code}`);
    };
    const shot = async (name) => {
      await sleep(350);
      fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      console.log('saved', name);
    };
    try {
      win.setContentSize(W, H);
      await wait(`!!document.querySelector('tr[data-id="t2"]') && !!window.cdjDebug`);
      const loaded = (n) => `!!window.cdjDebug.mixer.decks.${n}.buffer && !document.querySelector('#deck${n}').classList.contains('loading')`;
      await click('tr[data-id="t1"] [data-load="A"]');
      await wait(loaded('A'));
      await click('tr[data-id="t2"] [data-load="B"]');
      await wait(loaded('B'));
      await js(`window.cdjDebug.mixer.decks.A.seek(21); window.cdjDebug.mixer.decks.B.seek(9); void 0`);
      await click('#deckA .play');
      await click('#deckB .sync');
      await click('#deckB .play');
      await click('#deckA .lp[data-beats="4"]');
      await click('#deckB .fx[data-fx="reverb"] .fx-name');
      await sleep(1500);
      const themes = (await js(`[...document.querySelectorAll('.theme-card')].map((c) => c.dataset.theme)`)).filter((t) => !ONLY.length || ONLY.includes(t));
      for (const theme of themes) {
        await click(`.theme-card[data-theme="${theme}"]`);
        await shot(theme);
      }
      const first = themes[0];
      await click(`.theme-card[data-theme="${first}"]`);
      await click('#settingsBtn');
      await shot(`${first}-settings`);
      await js(`document.querySelector('#settingsDialog').close()`);
      await click('#helpBtn');
      await shot(`${first}-help`);
      await js(`document.querySelector('#helpDialog').close()`);
      await click('.tab[data-tab="cc"]');
      await shot(`${first}-search`);
      await click('.tab[data-tab="sfx"]');
      await shot(`${first}-sfx`);
      await click('.tab[data-tab="library"]');
      await click('#deckCountSeg [data-decks="4"]');
      await click('tr[data-id="t3"] [data-load="C"]');
      await wait(loaded('C'));
      await click('tr[data-id="t4"] [data-load="D"]');
      await wait(loaded('D'));
      await sleep(600);
      await shot(`${first}-4decks`);
      const h = (sel) => `Math.round(document.querySelector('${sel}').getBoundingClientRect().height)`;
      console.log('heights 4 decks', await js(`({ waves: ${h('.waves')}, console: ${h('.console')}, zoom: window.cdj.zoom.get() })`));
      await click('#deckCountSeg [data-decks="2"]');
      await sleep(400);
      console.log('rows', await js(`[document.querySelector('#deckA .deck-head'), document.querySelector('#deckA .deck-body'), document.querySelector('#deckA .strip'), ...document.querySelector('#deckA .deck-main').children].map((e) => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height * 10) / 10).join(' | ')`));
      console.log('heights 2 decks', await js(`({ waves: ${h('.waves')}, console: ${h('.console')}, zoom: window.cdj.zoom.get() })`));
      clearTimeout(watchdog);
      app.exit(0);
    } catch (err) {
      console.error(err);
      clearTimeout(watchdog);
      app.exit(1);
    }
  });
});
require(path.resolve(__dirname, '../src/main.js'));
