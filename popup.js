'use strict';

const STORAGE_KEY = 'ytsl-v1';
const DEFAULTS    = { sync: true, large: false, overhaul: false };

let modes = { ...DEFAULTS };

// ── Render ─────────────────────────────────────────────────────────────

function render() {
  ['sync', 'large', 'overhaul'].forEach(mode => {
    document.getElementById(`toggle-${mode}`)
      ?.classList.toggle('on', !!modes[mode]);
  });
}

// ── Bind row clicks ─────────────────────────────────────────────────────

document.querySelectorAll('.row[data-mode]').forEach(row => {
  row.addEventListener('click', () => {
    const mode = row.dataset.mode;
    modes[mode] = !modes[mode];
    chrome.storage.local.set({ [STORAGE_KEY]: modes });
    render();
  });
});

// ── Load initial state ──────────────────────────────────────────────────

chrome.storage.local.get(STORAGE_KEY).then(result => {
  modes = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
  render();
});
