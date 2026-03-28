/**
 * YT Music Synced Lyrics — content script
 *
 * Strategy:
 *  1. Watch for song changes via MutationObserver on the player-bar title.
 *  2. On change: fetch LRC lyrics from LRCLib.
 *  3. Watch for ytmusic-description-shelf-renderer to appear (Lyrics tab opened).
 *  4. Hide the native shelf, inject our per-line container as a sibling.
 *  5. rAF loop: highlight current line via binary search on video.currentTime.
 *  6. Click a line → seek video to that timestamp.
 */

'use strict';

// ─── Confirmed selectors (verified against YouLyPlus / BetterYTM source) ──────

const SEL = {
  title:  '.title.style-scope.ytmusic-player-bar',
  byline: '.byline.style-scope.ytmusic-player-bar',
  shelf:  'ytmusic-description-shelf-renderer',
  video:  'video',
};

// ID we stamp on our injected container so we can find/remove it easily
const CONTAINER_ID = 'ytsl-container';

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  title:   '',
  artist:  '',
  /** @type {{ time: number, text: string }[]} */
  lines:       [],
  hasSynced:   false,
  plainLyrics: '',
  currentIdx:  -1,
  injectedFor: '',   // title string we last injected for
  fetchCtrl:   null,
};

// ─── LRCLib ───────────────────────────────────────────────────────────────────

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
    while ((m = timeRe.exec(line)) !== null) {
      times.push(parseInt(m[1]) * 60 + parseFloat(m[2].replace(',', '.')));
    }
    if (!times.length) continue;

    const text = line.replace(/\[[\d:.,]+\]/g, '').trim();
    for (const t of times) out.push({ time: t, text });
  }

  return out.sort((a, b) => a.time - b.time);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getTitle() {
  return document.querySelector(SEL.title)?.textContent?.trim() ?? '';
}

function getArtist() {
  // byline format: "Artist • Album"  or  "Artist"
  const raw = document.querySelector(SEL.byline)?.textContent?.trim() ?? '';
  return raw.split('•')[0].trim();
}

function getVideo() {
  return document.querySelector(SEL.video);
}

// ─── Injection ────────────────────────────────────────────────────────────────

/**
 * Remove any previously injected container and un-hide the native shelf.
 */
function removeInjected() {
  document.getElementById(CONTAINER_ID)?.remove();
  const shelf = document.querySelector(SEL.shelf);
  if (shelf) shelf.style.display = '';
  state.injectedFor = '';
  state.currentIdx  = -1;
}

/**
 * Hide the native shelf and inject our time-synced container next to it.
 * Returns true if successful.
 */
function inject() {
  const shelf = document.querySelector(SEL.shelf);
  if (!shelf) return false;

  // Already injected for this song
  if (state.injectedFor === state.title && document.getElementById(CONTAINER_ID)) return true;

  // Clean up any previous injection first
  removeInjected();

  // Build the container
  const wrap = document.createElement('div');
  wrap.id = CONTAINER_ID;
  wrap.className = 'ytsl-container';

  if (state.hasSynced && state.lines.length) {
    for (let i = 0; i < state.lines.length; i++) {
      const { time, text } = state.lines[i];
      const div = document.createElement('div');
      div.className = 'ytsl-line ytsl-future';
      div.dataset.i = i;
      div.dataset.t = time;
      div.textContent = text || '♪';
      if (!text) div.classList.add('ytsl-instrumental');
      div.addEventListener('click', () => {
        const v = getVideo();
        if (v) v.currentTime = time;
      });
      wrap.appendChild(div);
    }
  } else if (state.plainLyrics) {
    const note = document.createElement('div');
    note.className = 'ytsl-status';
    note.textContent = '(No timestamped lyrics — showing static)';
    wrap.appendChild(note);
    for (const line of state.plainLyrics.split('\n')) {
      const d = document.createElement('div');
      d.className = 'ytsl-line ytsl-future';
      d.textContent = line;
      wrap.appendChild(d);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'ytsl-status';
    d.textContent = 'No lyrics found for this track.';
    wrap.appendChild(d);
  }

  // Hide native shelf, insert our container after it
  shelf.style.display = 'none';
  shelf.insertAdjacentElement('afterend', wrap);

  state.injectedFor = state.title;
  state.currentIdx  = -1;

  startHighlight();
  return true;
}

/** Show a loading placeholder while fetch is in flight */
function injectLoading() {
  removeInjected();
  const shelf = document.querySelector(SEL.shelf);
  if (!shelf) return;

  const d = document.createElement('div');
  d.id = CONTAINER_ID;
  d.className = 'ytsl-container';
  const s = document.createElement('div');
  s.className = 'ytsl-status';
  s.textContent = 'Loading synced lyrics…';
  d.appendChild(s);

  shelf.style.display = 'none';
  shelf.insertAdjacentElement('afterend', d);
  state.injectedFor = '__loading__';
}

// ─── Highlight loop ───────────────────────────────────────────────────────────

let rafId = null;

function startHighlight() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function tick() {
  rafId = null;

  const wrap = document.getElementById(CONTAINER_ID);
  if (!wrap || !state.hasSynced || !state.lines.length) return;
  if (state.injectedFor !== state.title) return;

  const video = getVideo();
  if (!video) { rafId = requestAnimationFrame(tick); return; }

  const t = video.currentTime;

  // Binary search: last line with time <= t
  let lo = 0, hi = state.lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.lines[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  if (idx !== state.currentIdx) {
    state.currentIdx = idx;

    const els = wrap.querySelectorAll('.ytsl-line');
    els.forEach((el, i) => {
      el.classList.toggle('ytsl-past',   i < idx);
      el.classList.toggle('ytsl-active', i === idx);
      el.classList.toggle('ytsl-future', i > idx);
    });

    if (idx >= 0 && els[idx]) {
      els[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  rafId = requestAnimationFrame(tick);
}

// ─── Song change ──────────────────────────────────────────────────────────────

async function onSongChange() {
  const title  = getTitle();
  const artist = getArtist();

  if (!title || (title === state.title && artist === state.artist)) return;

  // Cancel in-flight fetch
  state.fetchCtrl?.abort();
  state.fetchCtrl = new AbortController();

  state.title      = title;
  state.artist     = artist;
  state.lines      = [];
  state.plainLyrics = '';
  state.hasSynced  = false;

  // If lyrics panel is already open, show loading
  if (document.querySelector(SEL.shelf)) injectLoading();

  try {
    const { synced, plain } = await fetchLRCLib(title, artist, state.fetchCtrl.signal);
    if (synced) {
      state.lines     = parseLRC(synced);
      state.hasSynced = state.lines.length > 0;
    }
    state.plainLyrics = plain ?? '';
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('[ytsl] fetch error:', e);
  }

  // Inject if the lyrics panel is open
  if (document.querySelector(SEL.shelf)) inject();
}

// ─── Observers ────────────────────────────────────────────────────────────────

/** Watch for the lyrics shelf appearing (user clicked Lyrics tab) */
function watchForShelf() {
  const obs = new MutationObserver(() => {
    const shelf = document.querySelector(SEL.shelf);
    if (!shelf) return;
    // Shelf appeared and we haven't injected for this song yet
    if (state.injectedFor !== state.title && state.title) {
      inject();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

/** Watch the player-bar title for text changes → song changed */
function watchTitle(el) {
  const obs = new MutationObserver(() => onSongChange());
  obs.observe(el, { childList: true, subtree: true, characterData: true });
}

/** Wait for the player bar title to appear, then start everything */
function init() {
  const existing = document.querySelector(SEL.title);
  if (existing) {
    watchTitle(existing);
    onSongChange();
    return;
  }

  const obs = new MutationObserver(() => {
    const el = document.querySelector(SEL.title);
    if (el) {
      obs.disconnect();
      watchTitle(el);
      onSongChange();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

watchForShelf();
init();
