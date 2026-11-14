// Does Sync actually line two real songs up? Boots the app with two audio files of yours,
// plays both, presses Sync on deck B, then records what each deck really outputs and compares
// the two recordings by their hits (onset envelopes), without looking at the app's beat grids:
// where the cross-correlation peaks (0 ms = the beats land together) and how sharp it is.
// Run: electron --no-sandbox test/real-sync.js <output folder> <track A> <track B> [more pairs…]
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('real-sync.js')) + 1);
const outDir = path.resolve(args[0]);
const files = args.slice(1).map((f) => path.resolve(f));
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-real-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
for (const s of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(s);

const ids = files.map((_, i) => `t${i}`);
fs.writeFileSync(
  path.join(tmp, 'library.json'),
  JSON.stringify({ version: 1, tracks: files.map((file, i) => ({ id: ids[i], title: path.basename(file), artist: '', file, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } })) }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const SECONDS = Number(process.env.REAL_SYNC_SECONDS || 24);
const START_A = Number(process.env.REAL_SYNC_START_A || 30); // seconds into each track, past most intros
const START_B = Number(process.env.REAL_SYNC_START_B || 41.3);

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const click = (sel, shift = false) => js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shift} }))`);
    const toasts = () => js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
    const state = () =>
      js(`(() => { const { mixer, group } = cdjDebug; const d = (n) => { const k = mixer.decks[n]; const m = group.members?.get?.(k); return { track: k.track?.title, bpm: k.bpm, variable: !!k.track?.warp, rate: +k.rate.toFixed(5), heard: +k.effectiveBpm.toFixed(3), pos: +k.position.toFixed(3), playing: k.playing, synced: group.has(k), k: m?.k, errorMs: group.errorMs?.(k) }; }; return { A: d('A'), B: d('B') }; })()`);
    const report = { pairs: [] };
    try {
      await sleep(1000);
      // A tap on each deck's fader, both recorded in one callback so they stay sample-aligned.
      await js(`(() => { const { mixer } = cdjDebug; const ctx = mixer.ctx; const merge = ctx.createChannelMerger(2); const rec = ctx.createScriptProcessor(4096, 2, 1); const mute = ctx.createGain(); mute.gain.value = 0;
        const mono = (deck, ch) => { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; deck.fader.connect(g); g.connect(merge, 0, ch); };
        mono(mixer.decks.A, 0); mono(mixer.decks.B, 1); merge.connect(rec); rec.connect(mute); mute.connect(ctx.destination);
        window.__cap = null; rec.onaudioprocess = (e) => { const c = window.__cap; if (!c) return; c.a.push(new Float32Array(e.inputBuffer.getChannelData(0))); c.b.push(new Float32Array(e.inputBuffer.getChannelData(1))); }; })()`);
      for (let p = 0; p + 1 < ids.length; p += 2) {
        const pair = { a: path.basename(files[p]), b: path.basename(files[p + 1]) };
        report.pairs.push(pair);
        await js(`cdjDebug.group.clear?.(); for (const n of ['A', 'B']) if (cdjDebug.mixer.decks[n].playing) cdjDebug.mixer.decks[n].pause()`);
        await click(`tr[data-id="${ids[p]}"] [data-load="A"]`);
        await click(`tr[data-id="${ids[p + 1]}"] [data-load="B"]`);
        for (let i = 0; i < 120; i++) {
          await sleep(500);
          if (await js(`['A','B'].every((n) => cdjDebug.mixer.decks[n].bpm) && !document.querySelector('.deck.loading') && cdjDebug.mixer.decks.A.track?.id === ${JSON.stringify(ids[p])} && cdjDebug.mixer.decks.B.track?.id === ${JSON.stringify(ids[p + 1])}`)) break;
        }
        await sleep(500);
        pair.loaded = await state();
        await js(`if (cdjDebug.group.has(cdjDebug.mixer.decks.B)) document.querySelector('#deckB .sync').click(); cdjDebug.mixer.decks.A.seek(${START_A}); cdjDebug.mixer.decks.B.seek(${START_B})`);
        await click('#deckA .play');
        await sleep(700);
        await click('#deckB .play');
        await sleep(1500);
        const before = (await toasts()).length;
        await click('#deckB .sync');
        await sleep(3000); // settle, then record
        pair.afterSync = await state();
        await js(`window.__cap = { a: [], b: [] }`);
        await sleep(SECONDS * 1000);
        pair.end = await state();
        pair.toasts = (await toasts()).slice(before);
        pair.meter = await js(`document.querySelector('#deckB .phase-ms')?.textContent ?? null`);
        // Compare the two recordings by their hits.
        pair.heard = await js(`(async () => {
          const { onsetEnvelope } = await import('./analysis.js');
          const cap = window.__cap; window.__cap = null;
          const join = (chunks) => { const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };
          const sr = cdjDebug.mixer.ctx.sampleRate;
          const a = onsetEnvelope(join(cap.a), sr), b = onsetEnvelope(join(cap.b), sr);
          const env = (o) => Float32Array.from(o.env, (v, i) => Math.max(0, v) + 2 * Math.max(0, o.bass[i]));
          const x = env(a), y = env(b), n = Math.min(x.length, y.length), rate = a.rate;
          const dot = (p, q, lag) => { let s = 0; for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) s += p[i] * q[i + lag]; return s; };
          // Each recording's own pulse: the strongest repeat between 0.25 and 1 s (its beat, or a simple fraction of it).
          const pulse = (p) => { let best = 0, at = 0; for (let lag = Math.round(0.25 * rate); lag <= rate; lag++) { const v = dot(p, p, lag) / (n - lag); if (v > best) { best = v; at = lag; } } return at; };
          const pa = pulse(x), pb = pulse(y);
          // How the two line up, folded onto deck A's beat (its tempo as the app reads it; check that reading
          // against another beat tracker first): where the hits of B fall between the beats of A.
          const beat = (60 / cdjDebug.mixer.decks.A.effectiveBpm) * rate;
          const half = Math.floor(beat / 2), c = [];
          for (let lag = -half; lag <= half; lag++) { let s = 0; for (let k = -3; k <= 3; k++) s += dot(x, y, lag + Math.round(k * beat)); c.push(s); }
          const mean = c.reduce((p, v) => p + v, 0) / c.length, sd = Math.sqrt(c.reduce((p, v) => p + (v - mean) ** 2, 0) / c.length) || 1;
          let best = 0; for (let i = 0; i < c.length; i++) if (c[i] > c[best]) best = i;
          return { seconds: +(n / rate).toFixed(1), pulseMsA: +((pa / rate) * 1000).toFixed(1), pulseMsB: +((pb / rate) * 1000).toFixed(1), hitsApartMs: +(((best - half) / rate) * 1000).toFixed(1), sharpness: +((c[best] - mean) / sd).toFixed(2),
            silentA: !x.some((v) => v > 0), silentB: !y.some((v) => v > 0) };
        })()`);
        await click('#deckA .play');
        await click('#deckB .play');
        await js(`if (cdjDebug.group.has(cdjDebug.mixer.decks.B)) document.querySelector('#deckB .sync').click()`);
        await sleep(300);
      }
    } catch (err) {
      report.error = String((err && err.stack) || err);
    }
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'real-sync.json'), JSON.stringify(report, null, 2));
    app.exit(0);
  });
});

require('../src/main.js');
