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

// ---------------------------------------------------------------- a steady clock for drawing

// The audio clock (ctx.currentTime) moves in steps of a whole audio buffer, up to 10 ms or
// more at a time, so positions read from it once per frame land unevenly and a scrolling
// waveform judders. Drawing uses this instead: the audio clock carried forward by the
// frame clock, and steered gently back to it so the two never drift apart.
const clock = { perf: 0, audio: 0 };
function drawTime() {
  const perf = performance.now() / 1000;
  const audio = mixer.ctx.currentTime;
  const guess = clock.audio + (perf - clock.perf);
  // Stopped, or far off (start-up, a suspended context, a long stall): take the audio clock as it is.
  clock.audio = mixer.ctx.state !== 'running' || Math.abs(guess - audio) > 0.05 ? audio : guess + (audio - guess) * 0.02;
  clock.perf = perf;
  return clock.audio;
}

// ---------------------------------------------------------------- the three-colour waveform

// Bass, mids and highs each in their own colour over a faint full-signal outline (as in
// djay / Serato). In each pixel column the loudest band is drawn at the back and the
// quietest in front (judged over a few pixels, so the order doesn't flicker where two bands
// are close), so all three always show: a kick reads as a red burst, a snare or voice as
// amber, hats as a bright core.
const BANDS = ['low', 'mid', 'high'];
const KEYS = ['peak', 'low', 'mid', 'high'];
let levels = { size: 0 }; // per-pixel levels, reused between draws

/**
 * Draw a waveform across W device pixels. `from` and `per` say which wave columns lie under
 * pixel x: [from + x × per, from + (x + 1) × per). Zoomed in past one column per pixel,
 * levels are interpolated.
 */
function drawBands(ctx, wave, W, mid, half, from, per) {
  const n = wave.peak.length;
  if (levels.size < W) levels = { size: W, peak: new Float32Array(W), low: new Float32Array(W), mid: new Float32Array(W), high: new Float32Array(W) };
  for (const k of KEYS) {
    const src = wave[k];
    const out = levels[k];
    for (let x = 0; x < W; x++) {
      const a = from + x * per;
      const b = a + per;
      let v = 0;
      if (b > 0 && a < n - 1) {
        if (per < 1) {
          const p = Math.max(0, (a + b) / 2 - 0.5);
          const i = Math.min(n - 2, Math.floor(p));
          v = src[i] + (src[i + 1] - src[i]) * (p - i);
        } else {
          const end = Math.min(n, Math.ceil(b));
          for (let c = Math.max(0, Math.floor(a)); c < end; c++) if (src[c] > v) v = src[c];
        }
      }
      out[x] = v;
    }
  }
  const peak = new Path2D();
  const layers = [0, 1, 2].map(() => [new Path2D(), new Path2D(), new Path2D()]); // back to front, one path per band
  const R = 4; // ordering window: ±4 px
  const sum = [0, 0, 0];
  const lv = BANDS.map((b) => levels[b]);
  for (let x = -R; x < W; x++) {
    for (let b = 0; b < 3; b++) sum[b] += (x + R < W ? lv[b][x + R] : 0) - (x - R - 1 >= 0 ? lv[b][x - R - 1] : 0);
    if (x < 0) continue;
    const hp = levels.peak[x] * half;
    if (hp >= 0.5) peak.rect(x, mid - hp, 1, hp * 2);
    for (let b = 0; b < 3; b++) {
      const h = lv[b][x] * half;
      if (h < 0.5) continue;
      let rank = 0; // how many bands are louder around here: those go behind this one
      for (let o = 0; o < 3; o++) if (o !== b && (sum[o] > sum[b] || (sum[o] === sum[b] && o < b))) rank++;
      layers[rank][b].rect(x, mid - h, 1, h * 2);
    }
  }
  ctx.fillStyle = `rgba(${INK.ink},0.1)`;
  ctx.fill(peak);
  for (const layer of layers) {
    for (let b = 0; b < 3; b++) {
      ctx.fillStyle = `rgb(${INK.bands[BANDS[b]].join(',')})`;
      ctx.fill(layer[b]);
    }
  }
}

// The scrolling waveform is drawn once onto a long strip (three views wide) and then only
// slid along each frame: the picture stays the same from frame to frame instead of being
// re-sampled at every position (which shimmered), and a frame costs one image copy.
const strips = {};
function stripFor(name, wave, pps, left, W, H) {
  let s = strips[name];
  const right = left + W / pps;
  const now = performance.now();
  const fits = s && s.wave === wave && s.H === H && s.bands === INK.bands && left >= s.t0 && right <= s.t1;
  const scale = s ? pps / s.pps : 1;
  // A small change of scale (a tempo move, sync following a drummer) just stretches the strip;
  // a zoom redraws it, at most 12 times a second while the zoom is moving.
  if (fits && (Math.abs(scale - 1) < 0.03 || (now - s.made < 80 && scale > 0.5 && scale < 2))) return s;
  if (!s) s = strips[name] = { canvas: document.createElement('canvas') };
  const width = Math.min(16384, W * 3);
  if (s.canvas.width !== width || s.canvas.height !== H) {
    s.canvas.width = width;
    s.canvas.height = H;
  }
  const span = width / pps;
  Object.assign(s, { wave, H, bands: INK.bands, pps, made: now, t0: (left + right) / 2 - span / 2, t1: (left + right) / 2 + span / 2 });
  const ctx = s.canvas.getContext('2d');
  ctx.clearRect(0, 0, width, H);
  const dpr = window.devicePixelRatio || 1;
  drawBands(ctx, wave, width, H / 2, H / 2 - 3 * dpr, s.t0 * wave.rate, wave.rate / pps);
  return s;
}

// Ruler: [length px, opacity] for bar, beat, ½, ¼, ⅛, ⅟₁₆ lines, and each level's share of a beat.
const RULER = [[14, 0.6], [10, 0.38], [7, 0.26], [5, 0.19], [3.5, 0.14], [2.5, 0.1]];
const RULER_BEATS = [1, 1, 0.5, 0.25, 0.125, 0.0625];

function drawScrolling(name, pos) {
  const canvas = ui[name].wave;
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
    const pps = dpr / secPerCssPx(deck, canvas.clientWidth); // device pixels per track-second
    const t0 = pos - cx / pps;
    const x = (time) => cx + (time - pos) * pps;

    // Loop region
    if (deck.loop) {
      ctx.fillStyle = 'rgba(66,211,146,0.12)';
      ctx.fillRect(x(deck.loop.start), 0, (deck.loop.end - deck.loop.start) * pps, H);
    }

    const s = stripFor(name, wave, pps, t0, W, H);
    ctx.drawImage(s.canvas, (t0 - s.t0) * s.pps, 0, (W / pps) * s.pps, H, 0, 0, W, H);

    // Beat grid: lines where the beats are (they follow the tempo map of a track that wanders).
    const grid = deck.grid;
    if (grid) {
      const beatPx = pps * grid.beatSeconds(pos);
      const minGap = 5 * dpr; // hide a level when its lines would crowd closer than this
      const finest = RULER_BEATS.findLast((b) => beatPx * b >= minGap) ?? 1;
      const step = Math.round(16 * finest); // sixteenths between lines
      const last = Math.floor(grid.beatAt(t0 + W / pps) * 16);
      for (let n = Math.ceil((grid.beatAt(Math.max(0, t0)) * 16) / step) * step; n <= last; n += step) {
        const sub = ((n % 16) + 16) % 16;
        const level = sub !== 0 ? (sub % 8 === 0 ? 2 : sub % 4 === 0 ? 3 : sub % 2 === 0 ? 4 : 5) : (((n / 16) % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0 ? 0 : 1;
        const [len, alpha] = RULER[level];
        const lx = Math.round(x(grid.posAt(n / 16))) + 0.5;
        ctx.fillStyle = `rgba(${INK.ink},${alpha})`;
        ctx.fillRect(lx, 0, dpr, len * dpr);
        ctx.fillRect(lx, H - len * dpr, dpr, len * dpr);
      }
    }

    // Cue + hot cues
    const marker = (time, color) => {
      const mx = Math.round(x(time));
      if (mx < -10 || mx > W + 10) return;
      ctx.fillStyle = color;
      ctx.fillRect(mx, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.moveTo(mx - 5 * dpr, 0);
      ctx.lineTo(mx + 7 * dpr, 0);
      ctx.lineTo(mx + dpr, 7 * dpr);
      ctx.fill();
    };
    (deck.track?.cues || []).forEach((c, i) => c != null && marker(c, HOTCUE_COLORS[i]));
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
  drawBands(img.getContext('2d'), overview(wave, W), W, H / 2, H / 2 - 2, 0, 1);
  return img;
}

function drawOverview(name, pos) {
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
  const x = px(pos);
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

// ---------------------------------------------------------------- meters and readouts

const meterScratch = new Float32Array(1024);
const meters = new Map(); // meter element -> { fill, peak, horizontal, hold, shown }

function setMeter(el, db) {
  let m = meters.get(el);
  if (!m) meters.set(el, (m = { fill: $('.meter-fill', el), peak: $('.meter-peak', el), horizontal: el.classList.contains('meter-h'), hold: -60, shown: '' }));
  m.hold = Math.max(db, m.hold - 0.6);
  const level = Math.round(clamp((db + 48) / 48) * 200) / 2; // percent, in half steps
  const held = Math.round(clamp((m.hold + 48) / 48) * 200) / 2;
  const key = `${level}/${held}`;
  if (key === m.shown) return; // nothing moved: leave the page alone
  m.shown = key;
  if (m.horizontal) {
    m.fill.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
    m.peak.style.left = `calc(${held}% - 2px)`;
  } else {
    m.fill.style.clipPath = `inset(${100 - level}% 0 0 0)`;
    m.peak.style.bottom = `calc(${held}% - 2px)`;
  }
}

/** Set an element's text only when it changes (the frame loop runs 60 times a second). */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
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
  d.phaseDot.style.left = `${(50 + 46 * x).toFixed(1)}%`;
  d.phase.classList.toggle('locked', Math.abs(ms) < 5);
  setText(d.phaseMs, Math.abs(ms) < 1 ? 'on beat' : `${ms > 0 ? '+' : '−'}${Math.round(Math.abs(ms))} ms`);
}

export function frame() {
  const now = drawTime();
  for (const name of activeDecks()) {
    const deck = mixer.decks[name];
    const d = ui[name];
    const pos = deck.playing ? deck.positionAt(now) : deck.position;
    drawScrolling(name, pos);
    drawOverview(name, pos);
    if (deck.buffer) {
      const remain = (deck.duration - pos) / deck.rate;
      setText(d.elapsed, fmtTime(pos, true));
      setText(d.remain, fmtTime(-remain, true));
      d.remain.classList.toggle('ending', deck.playing && remain < 30);
      // 33⅓ rpm: one turn of the record is 1.8 s of track, so it spins with the tempo.
      d.vinyl.style.transform = `rotate(${(((pos / SECONDS_PER_TURN) % 1) * 360).toFixed(1)}deg)`;
      const grid = deck.grid;
      if (grid) {
        const beats = Math.floor(grid.beatAt(pos) + 1e-6);
        const n = grid.beatsPerBar;
        const beat = ((beats % n) + n) % n;
        setText(d.barpos, `bar ${Math.floor(beats / n) + 1} · ${'●'.repeat(beat + 1)}${'○'.repeat(n - 1 - beat)}`);
        // A track whose tempo wanders shows the tempo where it is.
        if (grid.warp && deck.playing) setText(d.bpmEff, deck.effectiveBpm.toFixed(1));
      } else setText(d.barpos, '');
      drawBeatGap(name);
    } else {
      d.phase.hidden = true;
      setText(d.elapsed, '0:00.0');
      setText(d.remain, '−0:00.0');
      d.remain.classList.remove('ending');
    }
    d.cue.classList.toggle('on', !deck.playing && !!deck.buffer && Math.abs(pos - deck.cuePoint) < 0.02);
    setMeter(d.stripMeter, peakDb(deck.analyser, meterScratch));
  }
  setMeter(ui.masterMeter || (ui.masterMeter = $('#masterMeter')), peakDb(mixer.masterAnalyser, meterScratch));
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
