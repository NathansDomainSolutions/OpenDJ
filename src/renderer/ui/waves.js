// Waveforms: drawing (scrolling waveform, overview, meters), the frame loop, zoom and scratching.
import { overview } from '../analysis.js';
import { peakDb } from '../engine.js';
import { $, $$, mixer, DECKS, activeDecks, partnerDeck, ACCENT, INK, HOTCUE_COLORS, state, fmtTime, ui, clamp, store, pick } from './core.js';
import { snapOn, snapDiv, snapDeck, beatGapMs } from './sync-ui.js';
import { syncVideos } from './video.js';

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

// Three-colour waveforms (as in djay / Serato): bass, mids and highs each in their own
// colour over a faint full-signal outline. In each pixel column the loudest band is drawn
// at the back and the quietest in front (judged over a few pixels, so the order doesn't
// flicker where two bands are close), so all three always show: a kick reads as a red
// burst, a snare or voice as amber, hats as a bright core.
const BANDS = ['low', 'mid', 'high'];

/**
 * Draw a waveform across W device pixels. span(x) gives the wave columns under pixel x as
 * fractional [from, to); zoomed in past one column per pixel, levels are interpolated.
 */
function drawBands(ctx, wave, W, mid, half, span) {
  const n = wave.peak.length;
  const peak = new Path2D();
  const layers = [0, 1, 2].map(() => ({ low: new Path2D(), mid: new Path2D(), high: new Path2D() })); // back to front
  const lv = { peak: new Float32Array(W), low: new Float32Array(W), mid: new Float32Array(W), high: new Float32Array(W) };
  const v = { peak: 0, low: 0, mid: 0, high: 0 };
  for (let x = 0; x < W; x++) {
    const r = span(x);
    if (!r || r[1] <= 0 || r[0] >= n - 1) continue;
    if (r[1] - r[0] < 1) {
      const p = Math.max(0, (r[0] + r[1]) / 2 - 0.5);
      const i = Math.min(n - 2, Math.floor(p));
      const f = p - i;
      for (const k in v) v[k] = wave[k][i] + (wave[k][i + 1] - wave[k][i]) * f;
    } else {
      for (const k in v) v[k] = 0;
      for (let c = Math.max(0, Math.floor(r[0])); c < Math.min(n, Math.ceil(r[1])); c++) {
        for (const k in v) if (wave[k][c] > v[k]) v[k] = wave[k][c];
      }
    }
    for (const k in v) lv[k][x] = v[k];
  }
  const R = 4; // ordering window: ±4 px
  const sum = { low: 0, mid: 0, high: 0 };
  for (let x = -R; x < W; x++) {
    for (const b of BANDS) sum[b] += (lv[b][x + R] || 0) - (lv[b][x - R - 1] || 0);
    if (x < 0) continue;
    const hp = lv.peak[x] * half;
    if (hp >= 0.5) peak.rect(x, mid - hp, 1, hp * 2);
    BANDS.slice().sort((a, b) => sum[b] - sum[a]).forEach((band, rank) => {
      const h = lv[band][x] * half;
      if (h >= 0.5) layers[rank][band].rect(x, mid - h, 1, h * 2);
    });
  }
  ctx.fillStyle = `rgba(${INK.ink},0.1)`;
  ctx.fill(peak);
  for (const layer of layers) {
    for (const band of BANDS) {
      ctx.fillStyle = `rgb(${INK.bands[band].join(',')})`;
      ctx.fill(layer[band]);
    }
  }
}

function drawScrolling(name) {
  const canvas = $(`#wave${name}`);
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const deck = mixer.decks[name];
  const wave = state.waves[name];
  const mid = H / 2;
  const cx = Math.round(W / 2);

  if (wave && deck.buffer) {
    const pos = deck.position;
    const pps = dpr / secPerCssPx(deck, canvas.clientWidth); // device pixels per track-second
    const t0 = pos - cx / pps;

    // Loop region
    if (deck.loop) {
      const x0 = cx + (deck.loop.start - pos) * pps;
      const x1 = cx + (deck.loop.end - pos) * pps;
      ctx.fillStyle = 'rgba(66,211,146,0.12)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    }

    drawBands(ctx, wave, W, mid, H / 2 - 3 * dpr, (x) => [(t0 + x / pps) * wave.rate, (t0 + (x + 1) / pps) * wave.rate]);

    // Beat grid
    const t = deck.track;
    if (t?.bpm && t.beatOffset != null) {
      // Ruler: [length px, opacity] for bar, beat, ½, ¼, ⅛, ⅟₁₆ lines.
      const LEVELS = [[14, 0.6], [10, 0.38], [7, 0.26], [5, 0.19], [3.5, 0.14], [2.5, 0.1]];
      const period = 60 / t.bpm;
      const step = period / 16;
      const tEnd = t0 + W / pps;
      const bars = deck.bars;
      const minGap = 5 * dpr; // hide a level when its lines would crowd closer than this
      let n = Math.ceil((t0 - t.beatOffset) / step);
      for (; t.beatOffset + n * step < tEnd; n++) {
        const st = t.beatOffset + n * step;
        if (st < 0) continue;
        const sub = ((n % 16) + 16) % 16;
        let level = sub === 0 ? 1 : sub % 8 === 0 ? 2 : sub % 4 === 0 ? 3 : sub % 2 === 0 ? 4 : 5;
        if (level === 1 && Math.round((st - bars.downbeat) / period) % bars.beatsPerBar === 0) level = 0;
        if (level > 1 && pps * period * [0, 0, 0.5, 0.25, 0.125, 0.0625][level] < minGap) continue;
        const [len, alpha] = LEVELS[level];
        const x = Math.round(cx + (st - pos) * pps) + 0.5;
        ctx.fillStyle = `rgba(${INK.ink},${alpha})`;
        ctx.fillRect(x, 0, dpr, len * dpr);
        ctx.fillRect(x, H - len * dpr, dpr, len * dpr);
      }
    }

    // Cue + hot cues
    const marker = (time, color) => {
      const x = Math.round(cx + (time - pos) * pps);
      if (x < -10 || x > W + 10) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.moveTo(x - 5 * dpr, 0);
      ctx.lineTo(x + 7 * dpr, 0);
      ctx.lineTo(x + dpr, 7 * dpr);
      ctx.fill();
    };
    (t?.cues || []).forEach((c, i) => c != null && marker(c, HOTCUE_COLORS[i]));
    marker(deck.cuePoint, `rgb(${INK.ink})`);

    // Shade the past.
    ctx.fillStyle = INK.light ? `rgba(${INK.ink},0.14)` : `rgba(${INK.shade},0.45)`;
    ctx.fillRect(0, 0, cx, H);
  } else {
    ctx.fillStyle = `rgba(${INK.ink},0.2)`;
    ctx.fillRect(0, mid, W, 1);
  }

  // Playhead: the deck's colour and thicker while you're dragging the track.
  const grabbed = canvas.classList.contains('grabbing');
  ctx.fillStyle = grabbed ? `rgb(${ACCENT[name].join(',')})` : `rgb(${INK.ink})`;
  ctx.fillRect(cx - (grabbed ? 2 : 1) * dpr, 0, (grabbed ? 4 : 2) * dpr, H);
}

function buildOverviewImage(name) {
  const canvas = ui[name].overview;
  const wave = state.waves[name];
  if (!wave) return null;
  const W = canvas.width;
  const H = canvas.height;
  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ctx = img.getContext('2d');
  drawBands(ctx, overview(wave, W), W, H / 2, H / 2 - 2, (x) => [x, x + 1]);
  return img;
}

function drawOverview(name) {
  const canvas = ui[name].overview;
  const resized = fitCanvas(canvas);
  const deck = mixer.decks[name];
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!deck.buffer || !state.waves[name]) return;
  if (resized || !state.overviewImg[name]) state.overviewImg[name] = buildOverviewImage(name);
  ctx.drawImage(state.overviewImg[name], 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const px = (t) => (t / deck.duration) * W;
  const x = px(deck.position);
  ctx.fillStyle = INK.light ? `rgba(${INK.ink},0.18)` : `rgba(${INK.shade},0.55)`;
  ctx.fillRect(0, 0, x, H);
  if (deck.loop) {
    ctx.fillStyle = 'rgba(66,211,146,0.25)';
    ctx.fillRect(px(deck.loop.start), 0, Math.max(2, px(deck.loop.end) - px(deck.loop.start)), H);
  }
  (deck.track?.cues || []).forEach((c, i) => {
    if (c == null) return;
    ctx.fillStyle = HOTCUE_COLORS[i];
    ctx.fillRect(px(c), 0, 2 * dpr, H);
  });
  ctx.fillStyle = `rgb(${INK.ink})`;
  ctx.fillRect(px(deck.cuePoint), 0, dpr, 6 * dpr);
  const grabbed = canvas.classList.contains('grabbing');
  if (grabbed) ctx.fillStyle = `rgb(${ACCENT[name].join(',')})`;
  ctx.fillRect(x - (grabbed ? 1.5 : 0.5) * dpr, 0, (grabbed ? 3 : 2) * dpr, H);
}

const meterScratch = new Float32Array(1024);
const meterPeaks = { A: -60, B: -60, M: -60 };

function setMeter(el, db, key) {
  const pct = Math.max(0, Math.min(1, (db + 48) / 48));
  meterPeaks[key] = Math.max(db, meterPeaks[key] - 0.6);
  const peakPct = Math.max(0, Math.min(1, (meterPeaks[key] + 48) / 48));
  const fill = $('.meter-fill', el);
  const peak = $('.meter-peak', el);
  if (el.classList.contains('meter-h')) {
    fill.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
    peak.style.left = `calc(${peakPct * 100}% - 2px)`;
  } else {
    fill.style.clipPath = `inset(${(1 - pct) * 100}% 0 0 0)`;
    peak.style.bottom = `calc(${peakPct * 100}% - 2px)`;
  }
}

const SECONDS_PER_TURN = 60 / (100 / 3);

/**
 * Beat-match meter under the BPM: a dot that sits in the middle when this deck's beats land
 * with the other deck's, left when it's behind, right when it's ahead. The scale is stretched
 * near the middle (square root), so the last few milliseconds are easy to see.
 */
function drawBeatGap(name) {
  const d = ui[name];
  const ms = beatGapMs(name);
  d.phase.hidden = ms == null;
  if (ms == null) return;
  const halfBeat = 30000 / mixer.decks[name].effectiveBpm;
  const x = Math.sign(ms) * Math.sqrt(Math.min(1, Math.abs(ms) / halfBeat));
  d.phaseDot.style.left = `${50 + 46 * x}%`;
  d.phase.classList.toggle('locked', Math.abs(ms) < 5);
  const text = Math.abs(ms) < 1 ? 'on beat' : `${ms > 0 ? '+' : '−'}${Math.round(Math.abs(ms))} ms`;
  if (d.phaseMs.textContent !== text) d.phaseMs.textContent = text;
}

export function frame() {
  for (const name of activeDecks()) {
    const deck = mixer.decks[name];
    const d = ui[name];
    drawScrolling(name);
    drawOverview(name);
    if (deck.buffer) {
      const pos = deck.position;
      const remain = (deck.duration - pos) / deck.rate;
      d.elapsed.textContent = fmtTime(pos, true);
      d.remain.textContent = fmtTime(-remain, true);
      d.remain.classList.toggle('ending', deck.playing && remain < 30);
      // 33⅓ rpm: one turn of the record is 1.8 s of track, so it spins with the tempo.
      d.vinyl.style.transform = `rotate(${((pos / SECONDS_PER_TURN) % 1) * 360}deg)`;
      const bars = deck.bars;
      if (bars) {
        const beats = Math.floor((pos - bars.downbeat) / (60 / deck.bpm) + 1e-6);
        const n = bars.beatsPerBar;
        d.barpos.textContent = `bar ${Math.floor(beats / n) + 1} · ${'●'.repeat(((beats % n) + n) % n + 1)}${'○'.repeat(n - 1 - (((beats % n) + n) % n))}`;
      } else d.barpos.textContent = '';
      drawBeatGap(name);
    } else {
      d.phase.hidden = true;
      d.elapsed.textContent = '0:00.0';
      d.remain.textContent = '−0:00.0';
      d.remain.classList.remove('ending');
    }
    d.cue.classList.toggle('on', !deck.playing && deck.buffer && Math.abs(deck.position - deck.cuePoint) < 0.02);
    setMeter($(`.strip[data-deck="${name}"] .meter`), peakDb(deck.analyser, meterScratch), name);
  }
  setMeter($('#masterMeter'), peakDb(mixer.masterAnalyser, meterScratch), 'M');
  syncVideos();
  requestAnimationFrame(frame);
}

/**
 * Track-seconds per CSS pixel of a scrolling waveform. With a BPM, each deck shows
 * the same number of its own beats, so synced decks line up beat for beat.
 */
export function secPerCssPx(deck, cssWidth) {
  return (state.span * deck.rate) / Math.max(1, cssWidth); // real time is the same for every deck: same scroll speed
}

export function setupZoom() {
  // Zoom = seconds shown across the waveforms (same for every deck); eases instead of jumping.
  let target = state.span;
  const ease = () => {
    state.span += (target - state.span) * 0.25;
    if (Math.abs(target - state.span) > 0.02) requestAnimationFrame(ease);
    else state.span = target;
  };
  const setSpan = (s) => {
    const settled = Math.abs(target - state.span) <= 0.02;
    target = clamp(s, 2, 64);
    pick($$('#beatsSeg button'), (x) => Number(x.dataset.span) === target);
    store.set('secondsShown', target);
    if (settled) requestAnimationFrame(ease);
  };
  const zoomBy = (f) => setSpan(Math.round(target / f));
  $$('#beatsSeg button').forEach((b) => b.addEventListener('click', () => setSpan(Number(b.dataset.span))));
  const saved = Number(store.get('secondsShown'));
  if (saved) setSpan(saved);
  $('#zoomIn').addEventListener('click', () => zoomBy(2)); // half the time across
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 2));

  // Grab a waveform or a record to scratch: playback stops under your hand, the
  // track plays at the speed and direction you move it, and picks up where you
  // let go. A paused deck keeps gliding after a flick.
  // Wheel / trackpad scrolls the track; Ctrl + wheel zooms.
  DECKS.forEach((name) => {
    const canvas = $(`#wave${name}`);
    const deck = mixer.decks[name];
    const secPerPx = () => secPerCssPx(deck, canvas.clientWidth);

    // Shared hand: `toPos(e)` maps a pointer event to a track position.
    const grabbable = (el, start, toPos) => {
      let drag = null;
      let glide = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!deck.buffer || e.button !== 0) return;
        cancelAnimationFrame(glide);
        el.setPointerCapture(e.pointerId);
        mixer.resume();
        drag = { ...start(e), wasPlaying: deck.scratchStart(), v: 0, t: e.timeStamp, last: deck.position };
        el.classList.add('grabbing');
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const pos = toPos(e, drag);
        const dt = Math.max(1, e.timeStamp - drag.t);
        drag.v = 0.7 * drag.v + 0.3 * ((pos - drag.last) / dt); // track-seconds per ms, smoothed
        drag.t = e.timeStamp;
        drag.last = pos;
        deck.scratchTo(pos);
      });
      const release = (e) => {
        if (!drag) return;
        const { wasPlaying, v, t } = drag;
        drag = null;
        el.classList.remove('grabbing');
        // Flick on a paused deck: keep moving with friction. Holding still before letting go means no glide.
        let vel = wasPlaying || e.timeStamp - t > 80 ? 0 : v * 16; // track-seconds per frame
        const step = () => {
          vel *= 0.92;
          if (Math.abs(vel) < 0.002 || deck.playing || !deck.scratching) {
            deck.scratchEnd(false);
            return snapDeck(name);
          }
          deck.scratchTo(deck.position + vel);
          glide = requestAnimationFrame(step);
        };
        if (vel) glide = requestAnimationFrame(step);
        else {
          // Snap while still held, so a playing deck comes back in on the beat with no extra jump.
          if (snapOn()) deck.scratchTo(deck.pausedPos + deck.beatSnap(deck.pausedPos, mixer.decks[partnerDeck(name)], snapDiv(name)));
          deck.scratchEnd(wasPlaying);
        }
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    };

    // Waveform: the track moves with your hand, left = forwards.
    grabbable(canvas, (e) => ({ x: e.clientX, pos: deck.position }), (e, d) => d.pos - (e.clientX - d.x) * secPerPx());

    // Record: turning it clockwise plays forwards, one turn = 1.8 s of track (33⅓ rpm).
    const platter = $(`#deck${name} .platter`);
    const angle = (e) => {
      const r = platter.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    };
    grabbable(
      platter,
      (e) => ({ a: angle(e), turned: 0, pos: deck.position }),
      (e, d) => {
        const a = angle(e);
        let da = a - d.a;
        if (da > Math.PI) da -= 2 * Math.PI; // unwrap across ±180°
        if (da < -Math.PI) da += 2 * Math.PI;
        d.a = a;
        d.turned += da;
        return d.pos + (d.turned / (2 * Math.PI)) * SECONDS_PER_TURN;
      },
    );

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) return zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25);
      if (!deck.buffer) return;
      const px = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      deck.seek(deck.position + px * secPerPx());
    }, { passive: false });
  });
}
