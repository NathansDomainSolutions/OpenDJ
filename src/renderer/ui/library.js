// The library table: filter, sort, and marks for what mixes well with the deck on air.
import { keyName, camelot } from '../analysis.js';
import { mixFit, wheel, hasKey } from '../match.js';
import { api, $, $$, mixer, DECKS, activeDecks, state, escapeHtml, fmtTime, toast, shortLicense, keyLabel, leadDeck, heardKey, store } from './core.js';
import { loadToDeck } from './load.js';

export async function refreshLibrary() {
  state.tracks = await api.library.list();
  renderLibrary();
}

/**
 * What the library is matched against: the deck on air, or (while nothing plays) the first
 * loaded deck. Returns { deck, bpm, key } as heard, or null.
 */
function matchRef() {
  const deck = leadDeck() || activeDecks().map((n) => mixer.decks[n]).find((d) => d.track);
  if (!deck) return null;
  const ref = { deck, bpm: deck.effectiveBpm, key: heardKey(deck) };
  return ref.bpm || hasKey(ref.key) ? ref : null;
}

// Column sorts: the value a track sorts by (null = unknown, always last).
const SORT_KEYS = {
  title: (t) => (t.title || '').toLowerCase() || null,
  artist: (t) => (t.artist || '').toLowerCase() || null,
  bpm: (t) => t.bpm || null,
  key: (t) => {
    const w = wheel(t.key); // round the Camelot wheel: 1A, 1B, 2A …
    return w ? 2 * w.n + (w.minor ? 0 : 1) : null;
  },
  duration: (t) => t.duration || null,
};

function sortRows(rows, fits) {
  const { by, dir } = state.sort || {};
  if (by === 'match') return fits.size ? [...rows].sort((a, b) => (fits.get(b)?.score ?? -1) - (fits.get(a)?.score ?? -1)) : rows;
  const value = SORT_KEYS[by];
  if (!value) return rows; // as added
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return dir * (x < y ? -1 : x > y ? 1 : 0);
  });
}

const KEY_FIT = { same: 'In key with', relative: 'Relative key of', adjacent: 'One step round the wheel from' };

export function renderLibrary() {
  const q = state.filter.trim().toLowerCase();
  const found = q
    ? state.tracks.filter((t) => `${t.title} ${t.artist} ${t.source?.uploader || ''} ${keyLabel(t.key)}`.toLowerCase().includes(q))
    : state.tracks;
  // How each track would mix with the deck on air (tempo and key), for the marks and the Match order.
  const ref = matchRef();
  const fits = new Map();
  if (ref) for (const t of found) if (t.id !== ref.deck.track.id) fits.set(t, mixFit(t, ref));
  const on = ref && `deck ${ref.deck.name}`;
  const loadedOn = (t) => activeDecks().filter((n) => mixer.decks[n].track?.id === t.id).map((n) => `on-${n.toLowerCase()}`);

  $('#libCount').textContent = state.tracks.length;
  $('#libEmpty').hidden = state.tracks.length > 0;
  for (const th of $$('.lib th[data-sort]')) {
    const mine = state.sort?.by === th.dataset.sort;
    th.setAttribute('aria-sort', !mine ? 'none' : state.sort.dir > 0 ? 'ascending' : 'descending');
  }
  const match = $('#libMatch');
  match.classList.toggle('on', state.sort?.by === 'match');
  match.setAttribute('aria-pressed', String(state.sort?.by === 'match'));
  match.title = ref
    ? `Put the tracks that mix best with ${on} first: closest tempo, then a key that fits (${ref.bpm ? `${ref.bpm.toFixed(1)} BPM` : 'no BPM'}${hasKey(ref.key) ? `, ${camelot(ref.key)}` : ''}).`
    : 'Put the tracks that mix best with the deck on air first. Load a track to use it.';

  $('#libBody').innerHTML = sortRows(found, fits)
    .map((t) => {
      const web = t.source?.kind === 'web';
      const src = web
        ? `<span class="src cc" title="${escapeHtml(t.source.license || '')}">${escapeHtml(shortLicense(t.source.license))} · ${escapeHtml(t.source.extractor || 'web')}</span>`
        : '<span class="src local">Local file</span>';
      const cls = [t.missing ? 'missing' : '', ...loadedOn(t)].join(' ');
      const fit = fits.get(t);
      const pct = fit?.rate ? (fit.rate - 1) * 100 : 0;
      const tempoTip = fit?.rate ? `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% to match ${on}${fit.k === 1 ? '' : fit.k === 2 ? ' (double time)' : ' (half time)'}` : '';
      const keyTip = fit?.key ? `${KEY_FIT[fit.key]} ${on} (${camelot(ref.key)})` : keyName(t.key);
      return `<tr draggable="true" data-id="${t.id}" class="${cls}">
        <td>${DECKS.map((n) => `<button class="load-btn ${n.toLowerCase()}" data-load="${n}" title="Load to deck ${n}">${n}</button>`).join('')}</td>
        <td title="${escapeHtml(t.title)}"><span class="lib-thumb">${trackThumb(t) ? `<img src="${escapeHtml(trackThumb(t))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}</span>${escapeHtml(t.title)}</td>
        <td title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</td>
        <td class="num${fit?.near ? ' fit' : ''}" title="${escapeHtml(tempoTip)}">${t.bpm ? Number(t.bpm).toFixed(1) : ''}</td>
        <td class="c-key${fit?.key ? ` fit fit-${fit.key}` : ''}" title="${escapeHtml(keyTip)}">${escapeHtml(camelot(t.key))} <span class="dim">${escapeHtml(keyName(t.key))}</span></td>
        <td class="num">${fmtTime(t.duration)}</td>
        <td>${src}</td>
        <td>${web ? '<button class="row-act" data-act="credit" title="Copy attribution">credit</button>' : ''}<button class="row-act" data-act="remove" title="Remove from library">✕</button></td>
      </tr>`;
    })
    .join('');
}

/** Re-render shortly (tempo, key and crossfader moves change what matches); skipped while the library is hidden. */
let soon = 0;
export function renderLibrarySoon() {
  if (soon || !$('.panel[data-panel="library"]').classList.contains('on')) return;
  soon = setTimeout(() => {
    soon = 0;
    renderLibrary();
  }, 300);
}

/** Sort by a column (click again to reverse, a third time for the order tracks were added) or by match. */
function setSort(by) {
  const cur = state.sort;
  if (by === 'match') state.sort = cur?.by === 'match' ? null : { by, dir: -1 };
  else state.sort = cur?.by !== by ? { by, dir: 1 } : cur.dir > 0 ? { by, dir: -1 } : null;
  store.set('libSort', state.sort ? `${state.sort.by}:${state.sort.dir}` : '');
  renderLibrary();
}

/** A web track's thumbnail: the one saved at download, else YouTube's standard one for the video. */
function trackThumb(t) {
  const s = t.source || {};
  if (s.kind !== 'web') return null;
  if (s.thumbnail) return s.thumbnail;
  return /youtube/i.test(s.extractor || '') && /^[\w-]{6,}$/.test(s.id || '') ? `https://i.ytimg.com/vi/${s.id}/mqdefault.jpg` : null;
}

async function removeTrack(id) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  if (DECKS.some((n) => mixer.decks[n].track?.id === id)) {
    return toast('That track is loaded on a deck.', 'error');
  }
  const web = t.source?.kind === 'web';
  const ok = confirm(web ? `Remove “${t.title}” and delete its downloaded audio?` : `Remove “${t.title}” from the library? (The file itself stays where it is.)`);
  if (!ok) return;
  await api.library.remove(id, { deleteFile: web });
  state.tracks = state.tracks.filter((x) => x.id !== id);
  renderLibrary();
}

export function attribution(t) {
  const s = t.source || {};
  const by = s.uploader || t.artist || 'unknown creator';
  return `“${t.title}” by ${by} — ${s.url || ''} — ${s.license || 'license not checked'}`;
}

export function setupLibrary() {
  const [by, dir] = (store.get('libSort') || '').split(':');
  if (by === 'match' || by in SORT_KEYS) state.sort = { by, dir: Number(dir) < 0 ? -1 : 1 };
  $('.lib thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) setSort(th.dataset.sort);
  });
  $('#libMatch').addEventListener('click', () => setSort('match'));

  const body = $('#libBody');
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const load = e.target.closest('[data-load]');
    if (load) return loadToDeck(load.dataset.load, id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') return removeTrack(id);
    if (act === 'credit') {
      const t = state.tracks.find((x) => x.id === id);
      navigator.clipboard.writeText(attribution(t)).then(() => toast('Attribution copied.'));
    }
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target.closest('button')) return;
    // Double-click loads onto the first deck that's stopped (A, B, then C, D).
    const target = activeDecks().find((n) => !mixer.decks[n].playing);
    if (target) loadToDeck(target, tr.dataset.id);
    else toast('Every deck is playing.', 'error');
  });
  body.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.dataTransfer.setData('text/x-cdj-track', tr.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  const filter = $('#libFilter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderLibrary();
  });

  $('#addFiles').addEventListener('click', async () => {
    const added = await api.library.importDialog();
    if (added.length) {
      await refreshLibrary();
      toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
    }
  });
  $('#openFolder').addEventListener('click', () => api.library.openFolder());
}

export async function importFiles(files) {
  const added = await api.library.importFiles(files);
  if (added.length) {
    await refreshLibrary();
    toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
  } else if (files.length) {
    toast('Nothing new to add (unsupported or already in library).');
  }
  return added;
}

// Window-wide file drop.
let dragDepth = 0;
export function hideDropOverlay() {
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
}
export function setupWindowDrop() {
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('#dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    hideDropOverlay();
    importFiles(e.dataTransfer.files);
  });
}
