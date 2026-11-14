// Search (YouTube / Spotify) and downloads through yt-dlp.
import { api, $, $$, state, escapeHtml, toast, cleanErr, jobId, store, pick, openLinks } from './core.js';
import { renderLibrary } from './library.js';

function setCcStatus(text, error = false) {
  const el = $('#ccStatus');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

// Over this, a result is probably a mix rather than a single track.
const LONG_RESULT_SECONDS = 20 * 60;

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// What exactly was searched, and what came back — so a missing video can be
// traced to the query, the result limit, or the app dropping it.
function renderCcInfo(s) {
  const el = $('#ccInfo');
  if (!s) {
    el.hidden = true;
    return;
  }
  const long = s.results.filter((r) => r.duration > LONG_RESULT_SECONDS).length;
  const live = s.results.filter((r) => !r.duration).length;
  el.innerHTML = `
    <div class="row">
      <span>“<b>${escapeHtml(s.query)}</b>” on ${state.source === 'spotify' ? 'Spotify' : 'YouTube'}</span>
      <span>showing <b>${s.results.length}</b> of <b>${s.received}</b> returned (limit ${s.limit})</span>
      ${long ? `<span class="warn">${long} over 20 min</span>` : ''}
      ${live ? `<span class="warn">${live} live / no length</span>` : ''}
      ${s.dropped.length ? `<span class="warn">${s.dropped.length} hidden</span>` : ''}
      <span>${(s.ms / 1000).toFixed(1)}s</span>
      <a class="open" data-url="${escapeHtml(s.url)}">Open on ${state.source === 'spotify' ? 'Spotify' : 'YouTube'} to compare</a>
    </div>
    <details>
      <summary>Details</summary>
      <div class="row">Filter: <b>${escapeHtml(s.filter)}</b></div>
      <div class="row"><code>${escapeHtml(s.url)}</code></div>
      ${s.dropped.map((d) => `<div class="row warn">Hidden: ${escapeHtml(d.title || d.id)} — ${escapeHtml(d.reason)}</div>`).join('')}
    </details>`;
  el.hidden = false;
}

function renderCcResults() {
  $('#ccResults').innerHTML = state.results
    .map((r, i) => `
      <div class="cc-item" data-vid="${escapeHtml(r.id)}" data-i="${i}">
        <div class="thumb-wrap">
          ${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="thumb"></div>'}
          ${r.rank ? `<span class="rank">#${r.rank}</span>` : ''}
          ${r.duration ? `<span class="dur ${r.duration > LONG_RESULT_SECONDS ? 'long' : ''}">${fmtDuration(r.duration)}</span>` : ''}
        </div>
        <div class="meta">
          <div class="ttl" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
          <div class="sub">${escapeHtml(r.channel)} · <a class="open" data-url="${escapeHtml(r.url)}">open</a></div>
          <div class="vid">${escapeHtml(r.album || r.id)}</div>
          <div class="msg"></div>
        </div>
        <button class="btn ${r.inLibrary ? '' : 'primary'}" data-get="${escapeHtml(r.url)}" ${r.inLibrary ? 'disabled' : ''}>${r.inLibrary ? 'In library' : 'Add'}</button>
        <div class="bar"></div>
      </div>`)
    .join('');
}

// `target` is a link (YouTube etc.) or a Spotify search result, which gets matched to a YouTube upload.
async function startDownload(target, itemEl) {
  const id = jobId();
  const btn = itemEl ? $('[data-get]', itemEl) : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
  }
  state.jobs.set(id, { el: itemEl, url: target.url || target });
  try {
    await (typeof target === 'string' ? api.cc.download(target, id) : api.spotify.download(target, id));
  } catch {
    // progress handler already reported the error
  } finally {
    state.jobs.delete(id);
  }
}

function onDownloadProgress(p) {
  const job = state.jobs.get(p.jobId);
  const el = job?.el;
  if (el) {
    const btn = $('[data-get]', el);
    const msg = $('.msg', el);
    const bar = $('.bar', el);
    if (p.stage === 'downloading') {
      btn.textContent = p.percent != null ? `${Math.round(p.percent)}%` : '…';
      bar.style.width = `${p.percent || 0}%`;
    } else if (p.stage === 'done') {
      btn.textContent = 'In library';
      btn.classList.remove('primary');
      bar.style.width = '100%';
      msg.textContent = '';
    } else if (p.stage === 'error') {
      btn.disabled = false;
      btn.textContent = 'Retry';
      bar.style.width = '0';
      msg.textContent = p.message;
      msg.classList.add('error');
    } else {
      btn.textContent = p.stage === 'setup' ? 'Setting up…' : 'Fetching…';
      msg.textContent = p.message || '';
      msg.classList.remove('error');
    }
  } else {
    // A pasted link (no result card): use the status line.
    if (p.stage === 'downloading') setCcStatus(`Downloading… ${p.percent != null ? Math.round(p.percent) + '%' : ''}`);
    else if (p.stage === 'error') setCcStatus(p.message, true);
    else if (p.stage === 'done') setCcStatus(`${p.message}: “${p.track?.title}”`);
    else setCcStatus(p.message || 'Working…');
  }
  if (p.stage === 'done' && p.track) {
    const isNew = !state.tracks.some((t) => t.id === p.track.id);
    if (isNew) state.tracks.unshift(p.track);
    renderLibrary();
    toast(isNew ? `Added “${p.track.title}”.` : `“${p.track.title}” is already in your library.`);
  } else if (p.stage === 'error' && !el) {
    toast(p.message, 'error');
  }
}

const SPOTIFY_TRACK_LINK = /^(https?:\/\/open\.spotify\.com\/(intl-[a-z-]+\/)?track\/|spotify:track:)/;

async function setSource(source) {
  state.source = source;
  pick($$('#sourceSeg button'), (b) => b.dataset.source === source);
  const sp = source === 'spotify';
  $('#ccQuery').placeholder = sp ? 'Search Spotify — song, artist or album' : 'Search YouTube — try “lofi beat”, “house loop”, “funk breakbeat”';
  $('#spotifyKeys').hidden = !sp || (await api.spotify.hasKeys());
  state.results = [];
  renderCcResults();
  renderCcInfo(null);
  setCcStatus('');
  store.set('searchSource', source);
}

export function setupCc() {
  api.cc.onProgress(onDownloadProgress);

  $('#sourceSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-source]');
    if (b && b.dataset.source !== state.source) setSource(b.dataset.source);
  });
  setSource(store.get('searchSource') === 'spotify' ? 'spotify' : 'youtube');
  for (const el of [$('#spotifyKeys'), $('#ccResults'), $('#ccInfo')]) openLinks(el);

  $('#spotifyKeys').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.spotify.setKeys($('#spClientId').value, $('#spClientSecret').value);
      $('#spClientSecret').value = '';
      $('#spotifyKeys').hidden = true;
      toast('Spotify key saved.');
    } catch (err) {
      toast(cleanErr(err), 'error');
    }
  });
  $('#ccSearchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#ccQuery').value.trim();
    if (!q) return;
    const sp = state.source === 'spotify';
    setCcStatus(`Searching ${sp ? 'Spotify' : 'YouTube'} for “${q}”…`);
    $('#ccResults').innerHTML = '';
    renderCcInfo(null);
    try {
      const search = await (sp ? api.spotify.search(q) : api.cc.search(q));
      state.results = search.results;
      setCcStatus(state.results.length ? '' : 'No results. Try broader words.');
      renderCcInfo(search);
      renderCcResults();
    } catch (err) {
      setCcStatus(`Search failed: ${cleanErr(err)}`, true);
    }
    refreshYtdlpChip();
  });

  $('#ccLinkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#ccLink').value.trim();
    if (!url) return;
    $('#ccLink').value = '';
    if (SPOTIFY_TRACK_LINK.test(url)) {
      // Show the Spotify track as a result card; its Add button does the YouTube match.
      setSource('spotify').then(() => {
        $('#ccQuery').value = url;
        $('#ccSearchForm').requestSubmit();
      });
      return;
    }
    setCcStatus('Fetching video info…');
    startDownload(url, null);
  });

  $('#ccResults').addEventListener('click', (e) => {
    const get = e.target.closest('[data-get]');
    if (get && !get.disabled) {
      const item = get.closest('.cc-item');
      startDownload(state.source === 'spotify' ? state.results[item.dataset.i] : get.dataset.get, item);
    }
  });
}

/** The yt-dlp chip in the top bar: its version, or that it still has to be set up. */
async function refreshYtdlpChip() {
  const chip = $('#ytdlpChip');
  chip.textContent = 'yt-dlp …';
  chip.className = 'chip';
  const s = await api.ytdlp.status();
  if (s.installed) {
    chip.textContent = `yt-dlp ${s.version}`;
    chip.className = 'chip ok';
    chip.title = 'Click to check for a yt-dlp update';
  } else {
    chip.textContent = 'yt-dlp not set up';
    chip.className = 'chip warn';
    chip.title = s.error || 'It will be downloaded the first time you search.';
  }
}

export function setupYtdlpChip() {
  const chip = $('#ytdlpChip');
  chip.addEventListener('click', async () => {
    chip.textContent = 'Updating…';
    try {
      const msg = await api.ytdlp.update();
      toast(msg || 'yt-dlp is up to date.');
    } catch (err) {
      toast(`yt-dlp update failed: ${cleanErr(err)}`, 'error');
    }
    refreshYtdlpChip();
  });
  refreshYtdlpChip();
}
