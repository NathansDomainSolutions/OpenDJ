// Settings, themes, window layout, dialogs and tabs.
import { api, $, $$, mixer, group, DECKS, ACCENT, INK, state, escapeHtml, toast, cleanErr, store, pick, clamp, fourDecks } from './core.js';
import { mvScreen } from './video.js';
import { renderLibrary, attribution } from './library.js';

export function setupDialogs() {
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  $('#creditsBtn').addEventListener('click', () => {
    const lines = [...state.played.values()].map(attribution);
    $('#creditsText').value = lines.length ? `Music credits\n\n${lines.join('\n')}` : 'Play a Creative Commons track and it will show up here.';
    $('#creditsDialog').showModal();
  });
  $('#copyCredits').addEventListener('click', () => navigator.clipboard.writeText($('#creditsText').value).then(() => toast('Credits copied.')));
}

export function setupTabs() {
  const tabs = $$('.tab');
  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.toggle('on', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab.dataset.tab));
      $('.tab-tools[data-for="library"]').hidden = tab.dataset.tab !== 'library';
      if (tab.dataset.tab === 'cc') $('#ccQuery').focus();
      if (tab.dataset.tab === 'library') renderLibrary(); // its match marks aren't kept up while it's hidden
    }),
  );

  // Expand: the library / search panel covers the decks. Esc goes back.
  const max = $('#browseMax');
  const setMax = (on) => {
    document.body.classList.toggle('browse-max', on);
    max.textContent = on ? 'Collapse ⤡' : 'Expand ⤢';
  };
  max.addEventListener('click', () => setMax(!document.body.classList.contains('browse-max')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('browse-max') && !e.target.closest?.('input, textarea, select, dialog')) setMax(false);
  });
}

// ------------------------------------------------------------------ themes and fonts

// Canvas colours per theme: deck accents (match --a / --b … in styles.css), text ink, the
// shade drawn over the played part (matches --bg), and the three waveform bands.
const THEMES = {
  dark: { A: [255, 138, 61], B: [66, 182, 255], C: [181, 123, 255], D: [163, 230, 53], ink: '237,237,240', shade: '11,11,13',
    bands: { low: [240, 62, 98], mid: [255, 178, 82], high: [238, 238, 246] } },
  aloe: { light: true, A: [228, 87, 46], B: [28, 127, 196], C: [123, 79, 214], D: [77, 143, 16], ink: '18,48,28', shade: '251,254,251',
    bands: { low: [208, 36, 72], mid: [226, 142, 30], high: [52, 60, 72] } },
  mist: { light: true, A: [212, 98, 47], B: [47, 109, 176], C: [118, 86, 194], D: [79, 132, 32], ink: '30,37,45', shade: '231,233,236',
    bands: { low: [196, 42, 76], mid: [212, 134, 34], high: [44, 52, 62] } },
  cherry: { A: [255, 59, 92], B: [255, 163, 192], C: [201, 160, 255], D: [255, 209, 102], ink: '253,238,242', shade: '39,16,26',
    bands: { low: [255, 59, 92], mid: [255, 196, 120], high: [255, 225, 235] } },
};

function setTheme(name) {
  const t = THEMES[name] ? name : 'dark';
  const { ink, shade, bands, light } = THEMES[t];
  document.body.dataset.theme = t;
  for (const n of DECKS) ACCENT[n] = THEMES[t][n];
  Object.assign(INK, { ink, shade, bands, light: !!light });
  DECKS.forEach((n) => (state.overviewImg[n] = null)); // redraw overviews in the new colours
  pick($$('.theme-card'), (c) => c.dataset.theme === t);
  store.set('theme', t);
}

/** Font setting: Arial (default), Segoe UI, Playfair Display, Dancing Script, monospace. */
function setFont(name) {
  const f = ['arial', 'segoe', 'playfair', 'script', 'mono'].includes(name) ? name : 'arial';
  if (f === 'arial') delete document.body.dataset.font;
  else document.body.dataset.font = f;
  pick($$('.font-card'), (b) => b.dataset.font === f);
  store.set('font', f);
}

// ------------------------------------------------------------------ layout

const roundRect = (x1, y1, x2, y2, r) =>
  `M${x1 + r} ${y1}H${x2 - r}A${r} ${r} 0 0 1 ${x2} ${y1 + r}V${y2 - r}A${r} ${r} 0 0 1 ${x2 - r} ${y2}H${x1 + r}A${r} ${r} 0 0 1 ${x1} ${y2 - r}V${y1 + r}A${r} ${r} 0 0 1 ${x1 + r} ${y1}Z`;

// The middle (video, crossfader / XY pad) sits over the decks' inner edges: every deck
// row it overlaps gives way on that side, so nothing hides under it.
function fitNotch() {
  const g = 8; // gap between the middle panel and the decks
  const b = $('.mixer').getBoundingClientRect();
  const m = { left: b.left - g, right: b.right + g, top: b.top - g, bottom: b.bottom + g };
  for (const deck of $$('.console > .deck')) {
    const left = deck.dataset.deck === 'A' || deck.dataset.deck === 'C';
    // Cut the middle panel's footprint (plus the gap) out of the deck itself.
    const d = deck.getBoundingClientRect();
    const x1 = Math.max(-30, m.left - d.left), x2 = Math.min(d.width + 30, m.right - d.left);
    const y1 = Math.max(-30, m.top - d.top), y2 = Math.min(d.height + 30, m.bottom - d.top);
    deck.style.clipPath = x2 > x1 && y2 > y1 && deck.offsetParent
      ? `path(evenodd, 'M-40 -40H${d.width + 40}V${d.height + 40}H-40Z ${roundRect(x1, y1, x2, y2, 22)}')`
      : '';
    for (const row of [deck.querySelector('.deck-head'), ...deck.querySelector('.deck-main').children]) {
      row.style.marginLeft = row.style.marginRight = row.style.maxWidth = '';
      if (deck.offsetParent === null) continue;
      const r = row.getBoundingClientRect();
      const give = r.bottom > m.top && r.top < m.bottom ? (left ? r.right - m.left : m.right - r.left) : 0;
      if (give <= 0) continue;
      row.style[left ? 'marginRight' : 'marginLeft'] = give + 'px';
      row.style.maxWidth = `calc(100% - ${give}px)`; // the overview canvas is width: 100%
    }
  }
}

/**
 * Scale the whole UI with the window: one page zoom factor, so a small window shrinks
 * everything to fit (nothing gets cut off) and a big one enlarges it. The reference layout
 * is about 1340 px wide; decks and mixer need ~764 px of height (902 with 4 decks), and the
 * library / search list gets state.browserH on top.
 */
function fitToWindow() {
  const z = api.zoom.get();
  const w = window.innerWidth * z; // window size in unzoomed pixels
  const h = window.innerHeight * z;
  const tall = (fourDecks() ? 902 : 764) + state.browserH;
  const f = clamp(Math.min(w / 1340, h / tall), 0.55, 1.6);
  if (Math.abs(f - z) > 0.01) api.zoom.set(Math.round(f * 100) / 100);
}

const BROWSER_H = { min: 200, max: 560, normal: 330 };

/** Keeps the layout fitted: the notch, the page zoom, and the grip that resizes the library / search. */
export function setupLayout() {
  let queued = false;
  const ro = new ResizeObserver(() => {
    if (!queued) requestAnimationFrame(() => ((queued = false), fitNotch()));
    queued = true;
  });
  ro.observe($('.console'));
  ro.observe($('.mixer'));
  window.addEventListener('resize', () => requestAnimationFrame(fitToWindow));

  // The grip on top of the library / search: drag up for a longer list (the rest scales down to fit).
  const grip = $('.browser-grip');
  const setH = (h, save = true) => {
    state.browserH = Math.round(clamp(h, BROWSER_H.min, BROWSER_H.max));
    document.documentElement.style.setProperty('--browser-h', state.browserH + 'px');
    if (!save) return;
    fitToWindow();
    store.set('browserH', state.browserH);
  };
  setH(Number(store.get('browserH')) || BROWSER_H.normal, false);
  let from = null;
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    from = { y: e.clientY * api.zoom.get(), h: state.browserH }; // window pixels: stable while the zoom changes
    grip.classList.add('grabbing');
  });
  // Moves and release are watched on the window, so a fast drag that leaves the thin grip still counts.
  window.addEventListener('pointermove', (e) => from && setH(from.h + (from.y - e.clientY * api.zoom.get()) / api.zoom.get()));
  const end = () => {
    if (!from) return;
    from = null;
    grip.classList.remove('grabbing');
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => setH(BROWSER_H.normal));
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setH(state.browserH + (e.key === 'ArrowUp' ? 40 : -40));
    }
  });
}

/** 2 or 4 decks. Going back to 2 stops C and D (they'd keep playing out of sight). */
function setDeckCount(n) {
  const four = n === 4;
  document.body.classList.toggle('decks-4', four);
  pick($$('#deckCountSeg button'), (b) => Number(b.dataset.decks) === (four ? 4 : 2));
  if (!four) for (const name of ['C', 'D']) {
    if (mixer.decks[name].playing) mixer.decks[name].pause();
    group.leave(mixer.decks[name]);
  }
  state.applyXY?.(); // up/down only counts with four decks
  fitToWindow(); // 4 decks need more height
  renderLibrary();
  store.set('deckCount', four ? '4' : '2');
}

// ------------------------------------------------------------------ the Settings dialog

export function setupSettings() {
  $('#settingsBtn').addEventListener('click', () => $('#settingsDialog').showModal());
  $$('.theme-card').forEach((c) => c.addEventListener('click', () => setTheme(c.dataset.theme)));
  $$('.font-card').forEach((b) => b.addEventListener('click', () => setFont(b.dataset.font)));
  $$('#deckCountSeg button').forEach((b) => b.addEventListener('click', () => setDeckCount(Number(b.dataset.decks))));

  // Music videos: Show / Hide (hiding also pauses them).
  const setMv = (on) => {
    document.body.classList.toggle('no-mv', !on);
    pick($$('#mvSeg button'), (b) => (b.dataset.mv === 'on') === on);
    if (!on) mvScreen.video?.pause();
    store.set('musicVideos', on ? 'on' : 'off');
  };
  $$('#mvSeg button').forEach((b) => b.addEventListener('click', () => setMv(b.dataset.mv === 'on')));

  // Audio buffer: fixed when the audio engine starts, so a change applies on the next start.
  const showBuffer = (v) => pick($$('#bufferSeg button'), (b) => b.dataset.buffer === v);
  showBuffer(store.get('audioBuffer', 'balanced'));
  $$('#bufferSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      if (store.get('audioBuffer', 'balanced') === b.dataset.buffer) return;
      store.set('audioBuffer', b.dataset.buffer);
      showBuffer(b.dataset.buffer);
      toast('Audio buffer saved. It applies the next time OpenDJ starts.');
    }),
  );

  // Master volume: the same value as the top-bar slider, kept in step both ways.
  const top = $('#masterVol');
  const vol = $('#setVolume');
  vol.value = top.value;
  vol.addEventListener('input', () => {
    top.value = vol.value;
    top.dispatchEvent(new Event('input'));
  });
  top.addEventListener('input', () => (vol.value = top.value));

  // Fullscreen (also F11).
  const fs = $('#setFullscreen');
  const toggleFs = async () => {
    const full = await api.toggleFullscreen();
    fs.textContent = full ? 'Exit fullscreen (F11)' : 'Enter fullscreen (F11)';
  };
  fs.addEventListener('click', toggleFs);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFs();
    }
  });

  // Output device: AudioContext.setSinkId routes the whole mix (decks + SFX).
  const out = $('#setOutput');
  const listOutputs = async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const current = out.value;
    out.innerHTML = '<option value="">System default</option>' + devices.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Output ${i + 1}`)}</option>`).join('');
    out.value = [...out.options].some((o) => o.value === current) ? current : '';
  };
  const useOutput = async (id) => {
    try {
      await mixer.ctx.setSinkId(id);
      store.set('outputDevice', id);
    } catch (err) {
      toast(`Couldn't switch output: ${cleanErr(err)}`, 'error');
      out.value = '';
    }
  };
  out.addEventListener('change', () => useOutput(out.value));
  navigator.mediaDevices.addEventListener('devicechange', listOutputs);
  $('#settingsBtn').addEventListener('click', listOutputs);
  listOutputs().then(() => {
    const saved = store.get('outputDevice', '');
    if (saved && [...out.options].some((o) => o.value === saved)) {
      out.value = saved;
      useOutput(saved);
    }
  });

  // Saved choices.
  store.remove('bg'); // an old background-picture setting (could be megabytes)
  setMv(store.get('musicVideos') !== 'off');
  setFont(store.get('font', 'arial'));
  setDeckCount(store.get('deckCount') === '4' ? 4 : 2);
  setTheme(store.get('theme', 'dark'));
}
