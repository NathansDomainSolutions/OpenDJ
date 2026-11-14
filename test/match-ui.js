// Boots the real app with a throwaway library of four synthetic tracks in known keys
// and tempos (one tuned 40 cents sharp), then drives the matching controls — Key Match,
// tempo match, Sync, the library's sort and match marks — plus a pass over the rest of the
// UI (settings, tabs, keyboard), and records what the UI shows.
// Run: electron --no-sandbox test/match-ui.js <output folder>
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-match-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const SR = 44100;
/** Chords over a kick and hat, `cents` away from concert pitch. */
function writeTrack(file, { bpm, chords, cents = 0, seconds = 40 }) {
  const n = SR * seconds;
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    chords[Math.floor(t / (4 * beat)) % chords.length].forEach((m, j) => {
      const f = 440 * 2 ** (((j === 0 ? m - 12 : m) - 69 + cents / 100) / 12);
      for (let h = 1; h <= 3; h++) x[i] += (Math.sin(2 * Math.PI * f * h * t) * 0.05) / h;
    });
  }
  for (let b = 0; b * beat < seconds; b++) {
    const i0 = Math.round(b * beat * SR);
    for (let i = 0; i < 0.2 * SR && i0 + i < n; i++) x[i0 + i] += Math.sin(2 * Math.PI * (50 + 90 * Math.exp((-i / SR) * 30)) * (i / SR)) * Math.exp((-i / SR) * 12) * 0.6;
    const h0 = Math.round((b + 0.5) * beat * SR);
    for (let i = 0; i < 0.04 * SR && h0 + i < n; i++) x[h0 + i] += rnd() * Math.exp((-i / SR) * 90) * 0.15;
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
const maj = (r) => [r, r + 12, r + 16, r + 19];
const min = (r) => [r, r + 12, r + 15, r + 19];
const TRACKS = [
  { id: 'am', title: 'A minor 124', bpm: 124, chords: [min(57), maj(53), maj(48), maj(55), min(57), min(50), maj(52), min(57)] }, // 8A
  { id: 'dm', title: 'D minor 120', bpm: 120, chords: [min(50), min(55), maj(57), min(50)] }, // 7A: one step from 8A
  { id: 'fs', title: 'F sharp major 128 sharp', bpm: 128, cents: 40, chords: [maj(54), maj(59), maj(61), maj(54)] }, // 2B: a clash with 8A, tuned 40 cents sharp
  { id: 'c', title: 'C major 90', bpm: 90, chords: [maj(48), maj(53), maj(55), maj(48)] }, // 8B: relative of 8A, a far tempo
];
for (const t of TRACKS) writeTrack((t.file = path.join(tmp, `${t.title}.wav`)), t);
fs.writeFileSync(
  path.join(tmp, 'library.json'),
  JSON.stringify({ version: 1, tracks: TRACKS.map((t) => ({ id: t.id, title: t.title, artist: 'Match Test', file: t.file, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } })) }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    const deck = (d) =>
      js(`(() => { const q = (s) => document.querySelector('#deck${d} ' + s); return {
        key: q('.key-read').textContent, fit: q('.key-read').dataset.fit, bpm: q('.bpm-eff').textContent, sync: q('.sync').classList.contains('on'),
        meter: q('.phase').hidden ? null : q('.phase-ms').textContent, locked: q('.phase').classList.contains('locked') }; })()`);
    const rows = () =>
      js(`[...document.querySelectorAll('#libBody tr')].map((tr) => tr.dataset.id + ' bpm:' + tr.children[3].textContent + (tr.children[3].classList.contains('fit') ? '*' : '') +
        ' key:' + tr.children[4].textContent.trim().split(' ')[0] + (tr.children[4].className.match(/fit-(\\w+)/)?.[1] ? '(' + tr.children[4].className.match(/fit-(\\w+)/)[1] + ')' : ''))`);
    const lastToast = () => js(`[...document.querySelectorAll('.toast')].pop()?.textContent || ''`);
    const click = (sel, shift = false) => js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shift} }))`);
    const key = (k, code, shift = false) => js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, shiftKey: ${shift}, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, bubbles: true }))`);
    const report = {};
    try {
      await sleep(1000);
      // Analyse every track (loading does it), ending with A minor on A and F sharp on B.
      for (const [id, d] of [['c', 'B'], ['dm', 'B'], ['fs', 'B'], ['am', 'A']]) {
        await click(`tr[data-id="${id}"] [data-load="${d}"]`);
        await sleep(4500);
      }
      report.saved = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).tracks.map((t) => ({ id: t.id, key: t.key, bpm: t.bpm, tuning: t.tuning }));
      report.loaded = { A: await deck('A'), B: await deck('B') };

      // Library: marks against deck A (nothing playing: the first loaded deck), sorting, Match order.
      report.rowsAsAdded = await rows();
      await click('.lib th[data-sort="bpm"]');
      report.rowsByBpm = await rows();
      await click('.lib th[data-sort="bpm"]');
      report.rowsByBpmDown = await rows();
      await click('.lib th[data-sort="key"]');
      report.rowsByKey = await rows();
      await click('#libMatch');
      report.rowsByMatch = await rows();
      report.matchTitle = await js(`document.querySelector('#libMatch').title`);
      await sleep(250);
      await shot('match-1-library.png');
      await click('#libMatch');
      report.rowsBack = await rows();

      // Key Match: F sharp (a clash, 40 cents sharp) onto A minor.
      await click('#deckB .key-match');
      await sleep(300);
      report.keyMatch = { B: await deck('B'), toast: await lastToast(), shift: await js(`cdjDebug.mixer.decks.B.keyShift`) };
      await click('#deckB .key-match', true); // Shift-click: the very same key
      await sleep(300);
      report.keyMatchExact = { B: await deck('B'), toast: await lastToast(), shift: await js(`cdjDebug.mixer.decks.B.keyShift`) };
      await click('#deckB .key-read'); // reset
      await sleep(200);

      // Tempo match (Shift + Sync): takes the tempo, doesn't lock. Then the beat-match meter with both playing.
      await click('#deckA .play');
      await sleep(300);
      await click('#deckB .sync', true);
      await sleep(300);
      report.tempoMatch = { B: await deck('B'), toast: await lastToast() };
      await click('#deckB .play');
      await sleep(1500);
      report.meterUnsynced = { A: await deck('A'), B: await deck('B') };
      // Sync: locks, and the meter settles on the beat.
      await click('#deckB .sync');
      await sleep(4000);
      report.synced = { A: await deck('A'), B: await deck('B') };
      await shot('match-2-synced.png');
      // Tempo move on synced A (no key lock): both follow, and both key readouts follow the new pitch.
      await js(`const s = document.querySelector('#deckA .tempo-slider'); s.value = 375; s.dispatchEvent(new Event('input'))`);
      await sleep(1500);
      report.afterTempoMove = { A: await deck('A'), B: await deck('B') };
      report.rowsWhilePlaying = await rows();

      // Keyboard: Shift+. = tempo match on B (leaves sync), . = sync again, space pauses all.
      await key('>', 'Period', true);
      await sleep(300);
      report.kbTempoMatch = { B: await deck('B') };
      await key('.', 'Period');
      await sleep(1500);
      report.kbSync = { B: await deck('B') };
      await key('ArrowRight', 'ArrowRight', true);
      report.kbSlam = await js(`document.querySelector('#crossfader').value`);
      await key(' ', 'Space');
      await sleep(300);
      report.kbSpace = await js(`['A','B'].map((n) => cdjDebug.mixer.decks[n].playing)`);

      // The rest of the UI still answers: tabs, settings (theme, font, 4 decks), dialogs.
      await click('.tab[data-tab="sfx"]');
      report.sfxPads = await js(`document.querySelectorAll('#sfxGrid button').length`);
      await click('.tab[data-tab="library"]');
      await click('#settingsBtn');
      await click('.theme-card[data-theme="mist"]');
      await click('.font-card[data-font="mono"]');
      await click('#deckCountSeg button[data-decks="4"]');
      await sleep(600);
      report.settings = await js(`({ theme: document.body.dataset.theme, font: document.body.dataset.font, four: document.body.classList.contains('decks-4'),
        themeChecked: document.querySelector('.theme-card[data-theme="mist"]').getAttribute('aria-checked'), saved: [localStorage.theme, localStorage.font, localStorage.deckCount] })`);
      await js(`document.querySelector('#settingsDialog').close()`);
      await sleep(400);
      await shot('match-3-four-decks.png');
      await click('#settingsBtn');
      await click('.theme-card[data-theme="dark"]');
      await click('.font-card[data-font="arial"]');
      await click('#deckCountSeg button[data-decks="2"]');
      await js(`document.querySelector('#settingsDialog').close()`);
      await click('#helpBtn');
      report.help = await js(`document.querySelector('#helpDialog').open`);
    } catch (err) {
      report.error = String((err && err.stack) || err);
    }
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'match-report.json'), JSON.stringify(report, null, 2));
    app.exit(0);
  });
});

require('../src/main.js');
