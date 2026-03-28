'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  SELECTORS  (verified against YouLyPlus / BetterYTM source + page source)
// ═══════════════════════════════════════════════════════════════════════════

const SEL = {
  title:    '.title.style-scope.ytmusic-player-bar',
  byline:   '.byline.style-scope.ytmusic-player-bar',
  art:      '#song-image img, .image.ytmusic-player-bar img',
  shelf:    'ytmusic-description-shelf-renderer',
  video:    'video',
  tabList:  'tp-yt-paper-tabs',
  tabs:     'tp-yt-paper-tab',
  tabContents: 'ytmusic-section-list-renderer #contents',
};

const CONTAINER_ID = 'ytsl-container';
const AMBIENT_ID   = 'ytsl-ambient';
const STORAGE_KEY  = 'ytsl-v1';

// ═══════════════════════════════════════════════════════════════════════════
//  MODE STATE  — driven by chrome.storage.local (shared with popup)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = { sync: true, large: false, overhaul: false };
let modes = { ...DEFAULTS };

function applyModes() {
  document.body.classList.toggle('ytsl-large',    modes.large);
  document.body.classList.toggle('ytsl-overhaul', modes.overhaul);

  if (modes.overhaul) startOverhaul(); else stopOverhaul();

  const shelf = document.querySelector(SEL.shelf);
  if (!shelf) return;

  if (modes.sync) {
    if (sync.title) inject();
  } else {
    removeInjected();
    shelf.style.display = '';
  }
}

// Listen for popup toggling modes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  modes = { ...DEFAULTS, ...(changes[STORAGE_KEY].newValue || {}) };
  applyModes();
});

// ═══════════════════════════════════════════════════════════════════════════
//  LRCLIB
// ═══════════════════════════════════════════════════════════════════════════

async function fetchLRCLib(title, artist, signal) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  const r = await fetch(`https://lrclib.net/api/get?${q}`, { signal });
  if (!r.ok) return { synced: null, plain: null };
  const d = await r.json();
  return { synced: d.syncedLyrics || null, plain: d.plainLyrics || null };
}

function parseLRC(lrc) {
  const metaRe = /^\[(?:ar|ti|al|by|offset|length|re|ve):/i;
  const timeRe = /\[(\d{2}):(\d{2}[.,]\d{2,3})\]/g;
  const out = [];
  for (const raw of lrc.split('\n')) {
    const line = raw.trim();
    if (!line || metaRe.test(line)) continue;
    const times = [];
    let m;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(line)) !== null)
      times.push(parseInt(m[1]) * 60 + parseFloat(m[2].replace(',', '.')));
    if (!times.length) continue;
    const text = line.replace(/\[[\d:.,]+\]/g, '').trim();
    for (const t of times) out.push({ time: t, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SYNCED LYRICS STATE
// ═══════════════════════════════════════════════════════════════════════════

const sync = {
  title: '', artist: '',
  lines: [], hasSynced: false, plain: '',
  currentIdx: -1, injectedFor: '',
  fetchCtrl: null,
};

const getTitle  = () => document.querySelector(SEL.title)?.textContent?.trim() ?? '';
const getArtist = () => (document.querySelector(SEL.byline)?.textContent?.trim() ?? '').split('•')[0].trim();

// ═══════════════════════════════════════════════════════════════════════════
//  INJECT / REMOVE
// ═══════════════════════════════════════════════════════════════════════════

function removeInjected() {
  document.getElementById(CONTAINER_ID)?.remove();
  sync.injectedFor = '';
  sync.currentIdx  = -1;
}

// Returns true when the Lyrics tab is the active/selected tab
function isLyricsTabActive() {
  const tabs = [...document.querySelectorAll(SEL.tabs)];
  const lyricsTab = tabs.find(t => t.textContent.trim() === 'Lyrics');
  if (!lyricsTab) return false;
  // YTM uses iron-selected class on the active tab
  return lyricsTab.classList.contains('iron-selected') ||
         lyricsTab.getAttribute('aria-selected') === 'true';
}

// Fallback mount point when YTM has no lyrics shelf
function getFallbackMount() {
  return document.querySelector(SEL.tabContents);
}

function _mountWrap(wrap) {
  const shelf = document.querySelector(SEL.shelf);
  if (shelf) {
    shelf.style.display = 'none';
    shelf.insertAdjacentElement('afterend', wrap);
    return true;
  }
  if (isLyricsTabActive()) {
    const mount = getFallbackMount();
    if (mount) {
      mount.innerHTML = '';
      mount.appendChild(wrap);
      return true;
    }
  }
  return false;
}

function inject() {
  if (!modes.sync) return;
  const shelf = document.querySelector(SEL.shelf);
  if (!shelf && !isLyricsTabActive()) return;
  if (sync.injectedFor === sync.title && document.getElementById(CONTAINER_ID)) return;

  removeInjected();

  const wrap = document.createElement('div');
  wrap.id = CONTAINER_ID;

  if (sync.hasSynced && sync.lines.length) {
    sync.lines.forEach(({ time, text }, i) => {
      const d = document.createElement('div');
      d.className   = 'ytsl-line ytsl-future';
      d.dataset.i   = i;
      d.dataset.t   = time;
      d.textContent = text || '♪';
      if (!text) d.classList.add('ytsl-instrumental');
      d.addEventListener('click', () => {
        const v = document.querySelector(SEL.video);
        if (v) v.currentTime = time;
      });
      wrap.appendChild(d);
    });
  } else if (sync.plain) {
    const note = document.createElement('div');
    note.className   = 'ytsl-status';
    note.textContent = 'No timestamped lyrics — showing static';
    wrap.appendChild(note);
    sync.plain.split('\n').forEach(line => {
      const d = document.createElement('div');
      d.className   = 'ytsl-line ytsl-future';
      d.textContent = line;
      wrap.appendChild(d);
    });
  } else {
    const d = document.createElement('div');
    d.className   = 'ytsl-status';
    d.textContent = 'No lyrics found for this track.';
    wrap.appendChild(d);
  }

  if (!_mountWrap(wrap)) return;
  sync.injectedFor = sync.title;
  sync.currentIdx  = -1;
  startHighlight();
}

function injectLoading() {
  if (!modes.sync) return;
  removeInjected();
  const shelf = document.querySelector(SEL.shelf);
  if (!shelf && !isLyricsTabActive()) return;
  const wrap = document.createElement('div');
  wrap.id = CONTAINER_ID;
  const s = document.createElement('div');
  s.className = 'ytsl-status ytsl-loading';
  s.textContent = 'Loading synced lyrics…';
  wrap.appendChild(s);
  if (!_mountWrap(wrap)) return;
  sync.injectedFor = '__loading__';
}

// ═══════════════════════════════════════════════════════════════════════════
//  HIGHLIGHT LOOP
// ═══════════════════════════════════════════════════════════════════════════

let rafId = null;

function startHighlight() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function tick() {
  rafId = null;
  const wrap = document.getElementById(CONTAINER_ID);
  if (!wrap || !sync.hasSynced || !sync.lines.length) return;
  if (sync.injectedFor !== sync.title) return;

  const video = document.querySelector(SEL.video);
  if (!video) { rafId = requestAnimationFrame(tick); return; }

  const t = video.currentTime;
  let lo = 0, hi = sync.lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sync.lines[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  if (idx !== sync.currentIdx) {
    sync.currentIdx = idx;
    const els = wrap.querySelectorAll('.ytsl-line');
    els.forEach((el, i) => {
      el.classList.toggle('ytsl-past',   i < idx);
      el.classList.toggle('ytsl-active', i === idx);
      el.classList.toggle('ytsl-future', i > idx);
    });
    if (idx >= 0 && els[idx]) els[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  rafId = requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SONG CHANGE
// ═══════════════════════════════════════════════════════════════════════════

async function onSongChange() {
  const title  = getTitle();
  const artist = getArtist();
  if (!title || (title === sync.title && artist === sync.artist)) return;

  sync.fetchCtrl?.abort();
  sync.fetchCtrl = new AbortController();
  sync.title = title; sync.artist = artist;
  sync.lines = []; sync.plain = ''; sync.hasSynced = false;

  const shelfNow = () => document.querySelector(SEL.shelf);
  if (modes.sync && (shelfNow() || isLyricsTabActive())) injectLoading();
  if (modes.overhaul) updateAmbient();

  try {
    const { synced, plain } = await fetchLRCLib(title, artist, sync.fetchCtrl.signal);
    if (synced) { sync.lines = parseLRC(synced); sync.hasSynced = sync.lines.length > 0; }
    sync.plain = plain ?? '';
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('[ytsl] fetch error:', e);
  }

  if (modes.sync && (shelfNow() || isLyricsTabActive())) inject();
}

// ═══════════════════════════════════════════════════════════════════════════
//  OVERHAUL — AMBIENT BACKGROUND
// ═══════════════════════════════════════════════════════════════════════════

let ambientTimer = null;
let lastArtUrl   = '';

function updateAmbient() {
  if (!modes.overhaul) return;
  const img = document.querySelector(SEL.art);
  const url = img?.src ?? '';
  if (!url || url === lastArtUrl) return;
  lastArtUrl = url;

  let el = document.getElementById(AMBIENT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = AMBIENT_ID;
    document.body.insertBefore(el, document.body.firstChild);
  }
  el.style.backgroundImage = `url("${url}")`;
}

function startOverhaul() {
  updateAmbient();
  const poll = () => {
    if (!modes.overhaul) { ambientTimer = null; return; }
    updateAmbient();
    ambientTimer = setTimeout(poll, 2000);
  };
  if (!ambientTimer) ambientTimer = setTimeout(poll, 1000);
}

function stopOverhaul() {
  if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = null; }
  document.getElementById(AMBIENT_ID)?.remove();
  lastArtUrl = '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  OBSERVERS
// ═══════════════════════════════════════════════════════════════════════════

let lyricsTabDebounce = null;

function watchForShelf() {
  // Watch for shelf appearing (song has YTM lyrics)
  new MutationObserver(() => {
    if (!modes.sync) return;
    const shelf = document.querySelector(SEL.shelf);
    if (shelf && sync.injectedFor !== sync.title && sync.title) inject();
  }).observe(document.body, { childList: true, subtree: true });

  // Watch for Lyrics tab activation (fallback: no shelf, pull from LRCLib)
  document.addEventListener('click', e => {
    const tab = e.target.closest(SEL.tabs);
    if (!tab || tab.textContent.trim() !== 'Lyrics') return;
    clearTimeout(lyricsTabDebounce);
    lyricsTabDebounce = setTimeout(() => {
      if (!modes.sync || !sync.title) return;
      if (document.getElementById(CONTAINER_ID)) return;
      // Shelf may not exist yet — give YTM a moment to render, then inject
      inject();
    }, 400);
  }, true);
}

function watchTitle(el) {
  new MutationObserver(() => onSongChange())
    .observe(el, { childList: true, subtree: true, characterData: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════

function boot() {
  watchForShelf();

  const tryTitle = () => {
    const el = document.querySelector(SEL.title);
    if (!el) return false;
    watchTitle(el);
    onSongChange();
    return true;
  };

  if (!tryTitle()) {
    const obs = new MutationObserver(() => { if (tryTitle()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }
}

// Load modes from chrome.storage, then start
chrome.storage.local.get(STORAGE_KEY).then(result => {
  modes = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
  applyModes();
  boot();
});
