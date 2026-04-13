const { ipcRenderer } = require('electron');
const fs = require('fs');

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = (s) => document.getElementById(s);
const $$ = (s) => document.querySelectorAll(s);

const setupScreen = $('setup-screen');
const mainScreen  = $('main-screen');
const setupBar    = $('setup-bar');
const setupStatus = $('setup-status');
const btnRetry    = $('btn-retry');

// Queue tab
const urlInput       = $('url-input');
const btnAdd         = $('btn-add');
const queueList      = $('queue-list');
const clipBanner     = $('clipboard-banner');
const clipUrlEl      = $('clipboard-url');
const btnBatch       = $('btn-batch');
const btnClearDone   = $('btn-clear-done');
const btnOpenFolder  = $('btn-open-folder');

// Search tab
const searchInput  = $('search-input');
const btnSearch    = $('btn-search');
const searchResults = $('search-results');

// History tab
const historyFilter = $('history-filter');
const historyList   = $('history-list');

// Preview bar
const previewBar   = $('preview-bar');
const previewTitle = $('preview-title');
const previewSeek  = $('preview-seek');
const previewTime  = $('preview-time');

// Drag overlay
const dragOverlay = $('drag-overlay');

// ── State ──────────────────────────────────────────────────────────────────────
let settings = {};
let queue = [];
let nextId = 1;
let activeCount = 0;
let selectedPreset = 'custom';
let selectedFormat = 'mp3';
let selectedBitrate = '0';
let lastClipboardUrl = '';
let currentPreviewAudio = null;
let currentPreviewItemId = null;
let currentTagsFilepath = null;
let currentTrimFilepath = null;

// ── Presets ────────────────────────────────────────────────────────────────────
const PRESETS = {
  music:   { format: 'flac', bitrate: '0' },
  podcast: { format: 'mp3',  bitrate: '128' },
  voice:   { format: 'm4a',  bitrate: '64' },
};

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  settings = await ipcRenderer.invoke('get-settings');
  const ready = await ipcRenderer.invoke('check-binaries');

  if (!ready) {
    setupScreen.classList.add('show');
    runSetup();
  } else {
    showMain();
  }

  // Load persisted queue
  const saved = await ipcRenderer.invoke('load-queue');
  if (saved.length > 0) {
    queue = saved;
    nextId = Math.max(...queue.map(i => i.id)) + 1;
    renderQueue();
    processQueue();
  }

  applySettingsToUI();
}

function showMain() {
  setupScreen.classList.remove('show');
  mainScreen.style.display = 'flex';
  urlInput.focus();
}

async function runSetup() {
  btnRetry.style.display = 'none';
  setupBar.style.width = '0%';
  setupStatus.textContent = 'Starting download…';
  const result = await ipcRenderer.invoke('run-setup');
  if (result.ok) setTimeout(showMain, 500);
  else { setupStatus.textContent = `Setup failed: ${result.error}`; btnRetry.style.display = 'inline-block'; }
}

btnRetry.addEventListener('click', runSetup);
ipcRenderer.on('setup-progress', (_e, p) => setupBar.style.width = p + '%');
ipcRenderer.on('setup-status', (_e, t) => setupStatus.textContent = t);

// ── Tabs ───────────────────────────────────────────────────────────────────────
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'settings') applySettingsToUI();
  });
});

// ── Preset / Format / Bitrate selectors ────────────────────────────────────────
$$('#preset-group .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#preset-group .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPreset = btn.dataset.preset;
    if (PRESETS[selectedPreset]) {
      selectedFormat = PRESETS[selectedPreset].format;
      selectedBitrate = PRESETS[selectedPreset].bitrate;
      syncFormatUI();
      syncBitrateUI();
    }
  });
});

$$('#format-group .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectCustomPreset();
    $$('#format-group .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.fmt;
    updateBitrateVisibility();
  });
});

$$('#bitrate-group .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectCustomPreset();
    $$('#bitrate-group .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedBitrate = btn.dataset.br;
  });
});

function selectCustomPreset() {
  $$('#preset-group .pill-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#preset-group [data-preset="custom"]').classList.add('active');
  selectedPreset = 'custom';
}

function syncFormatUI() {
  $$('#format-group .pill-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === selectedFormat);
  });
  updateBitrateVisibility();
}

function syncBitrateUI() {
  // If bitrate is "64", there's no 64 button, so select best
  let found = false;
  $$('#bitrate-group .pill-btn').forEach(b => {
    const match = b.dataset.br === selectedBitrate;
    b.classList.toggle('active', match);
    if (match) found = true;
  });
  if (!found) {
    // Show as best
    $$('#bitrate-group .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.br === '0'));
    selectedBitrate = '0';
  }
}

function updateBitrateVisibility() {
  const show = selectedFormat === 'mp3' || selectedFormat === 'm4a';
  $('bitrate-label').style.display = show ? '' : 'none';
  $('bitrate-group').style.display = show ? '' : 'none';
}

// ── Add to queue ───────────────────────────────────────────────────────────────
btnAdd.addEventListener('click', () => addUrl(urlInput.value.trim()));
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addUrl(urlInput.value.trim()); });

// Ctrl+V anywhere → auto-add if it's a URL
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'v' && document.activeElement !== urlInput &&
      document.activeElement !== searchInput && document.activeElement?.tagName !== 'INPUT' &&
      document.activeElement?.tagName !== 'TEXTAREA') {
    navigator.clipboard.readText().then(text => {
      text = text.trim();
      if (/^https?:\/\/.+/i.test(text)) addUrl(text);
    }).catch(() => {});
  }
});

async function addUrl(url) {
  if (!url) return;
  urlInput.value = '';
  dismissClipboard();
  btnAdd.disabled = true;
  btnAdd.textContent = 'Checking…';

  const result = await ipcRenderer.invoke('expand-url', url);

  btnAdd.disabled = false;
  btnAdd.textContent = 'Add to Queue';

  if (!result.ok) {
    queue.push(makeItem({ url, title: url, state: 'failed', error: result.error }));
    renderQueue();
    return;
  }

  if (result.type === 'playlist') {
    const group = result.title;
    for (const entry of result.entries) {
      if (entry.error) {
        queue.push(makeItem({ url: entry.url || url, title: entry.title, group, state: 'failed', error: entry.error, thumbnail: entry.thumbnail }));
      } else {
        queue.push(makeItem({ url: entry.url, title: entry.title, group, thumbnail: entry.thumbnail }));
      }
    }
  } else {
    queue.push(makeItem({ url, title: result.title, thumbnail: result.thumbnail }));
  }

  renderQueue();
  persistQueue();
  processQueue();
}

function makeItem(overrides) {
  return {
    id: nextId++,
    url: '', title: 'Unknown', format: selectedFormat, bitrate: selectedBitrate,
    group: null, state: 'pending', percent: 0, filename: null, filepath: null,
    error: null, thumbnail: null,
    ...overrides,
  };
}

// ── Queue processing (supports concurrency) ────────────────────────────────────
function processQueue() {
  const max = settings.concurrentDownloads || 1;
  while (activeCount < max) {
    const next = queue.find(i => i.state === 'pending');
    if (!next) break;

    next.state = 'active';
    activeCount++;
    renderQueue();

    downloadItem(next).then(() => {
      activeCount--;
      persistQueue();
      renderQueue();

      // Check if all done
      const anyActive = queue.some(i => i.state === 'active' || i.state === 'pending');
      if (!anyActive) ipcRenderer.invoke('notify-queue-complete');

      processQueue();
    });
  }
}

async function downloadItem(item) {
  const result = await ipcRenderer.invoke('download-audio', {
    url: item.url, format: item.format, bitrate: item.bitrate, itemId: item.id,
  });

  if (result.ok) {
    item.state = 'done';
    item.percent = 100;
    item.filename = result.filename;
    item.filepath = result.filepath;

    // Add to history
    ipcRenderer.invoke('add-to-history', {
      url: item.url, title: item.title, filename: item.filename,
      filepath: item.filepath, format: item.format,
      source: extractSource(item.url), date: new Date().toISOString(),
    });
  } else {
    item.state = 'failed';
    item.error = result.error;
  }
}

function extractSource(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube';
    if (host.includes('soundcloud')) return 'SoundCloud';
    if (host.includes('tiktok')) return 'TikTok';
    if (host.includes('instagram')) return 'Instagram';
    if (host.includes('twitter') || host.includes('x.com')) return 'Twitter/X';
    if (host.includes('bandcamp')) return 'Bandcamp';
    if (host.includes('vimeo')) return 'Vimeo';
    if (host.includes('reddit')) return 'Reddit';
    if (host.includes('facebook') || host.includes('fb.')) return 'Facebook';
    if (host.includes('twitch')) return 'Twitch';
    if (host.includes('spotify')) return 'Spotify';
    return host;
  } catch { return 'Unknown'; }
}

// ── Progress from main process ─────────────────────────────────────────────────
ipcRenderer.on('item-progress', (_e, { itemId, percent }) => {
  const item = queue.find(i => i.id === itemId);
  if (item) {
    item.percent = percent;
    // Update DOM directly for performance
    const fill = document.querySelector(`[data-id="${itemId}"] .item-bar-fill`);
    const detail = document.querySelector(`[data-id="${itemId}"] .item-detail`);
    if (fill) fill.style.width = percent + '%';
    if (detail) detail.textContent = `Downloading… ${percent.toFixed(1)}%`;
  }
});

// ── Queue persistence ──────────────────────────────────────────────────────────
function persistQueue() {
  ipcRenderer.invoke('save-queue', queue);
}

// ── Remove / Retry / Clear ─────────────────────────────────────────────────────
function removeItem(id) {
  queue = queue.filter(i => i.id !== id);
  renderQueue();
  persistQueue();
}

function retryItem(id) {
  const item = queue.find(i => i.id === id);
  if (item) { item.state = 'pending'; item.error = null; item.percent = 0; }
  renderQueue();
  persistQueue();
  processQueue();
}

btnClearDone.addEventListener('click', () => {
  queue = queue.filter(i => i.state !== 'done');
  renderQueue();
  persistQueue();
});

btnOpenFolder.addEventListener('click', () => ipcRenderer.invoke('open-downloads'));

// ── Clipboard detection ────────────────────────────────────────────────────────
ipcRenderer.on('clipboard-url', (_e, url) => {
  if (url && url !== lastClipboardUrl) {
    lastClipboardUrl = url;
    clipUrlEl.textContent = url;
    clipBanner.classList.add('show');
  }
});

$('clipboard-add').addEventListener('click', () => {
  addUrl(lastClipboardUrl);
  dismissClipboard();
});

$('clipboard-dismiss').addEventListener('click', dismissClipboard);

function dismissClipboard() {
  clipBanner.classList.remove('show');
}

// ── Browser extension URL ──────────────────────────────────────────────────────
ipcRenderer.on('extension-add-url', (_e, url) => {
  addUrl(url);
  // Switch to queue tab
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'queue'));
  $$('.tab-content').forEach(t => t.classList.toggle('active', t.id === 'tab-queue'));
});

// ── Batch import modal ─────────────────────────────────────────────────────────
btnBatch.addEventListener('click', () => $('modal-batch').classList.add('show'));
$('batch-cancel').addEventListener('click', () => $('modal-batch').classList.remove('show'));
$('batch-add').addEventListener('click', () => {
  const text = $('batch-urls').value.trim();
  if (!text) return;
  const urls = text.split('\n').map(l => l.trim()).filter(l => /^https?:\/\/.+/i.test(l));
  $('modal-batch').classList.remove('show');
  $('batch-urls').value = '';
  urls.forEach(u => addUrl(u));
});

// ── Drag and drop ──────────────────────────────────────────────────────────────
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dragOverlay.classList.add('show');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragOverlay.classList.remove('show'); dragCounter = 0; }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('show');

  // Check for files (.txt)
  if (e.dataTransfer.files.length > 0) {
    for (const file of e.dataTransfer.files) {
      if (file.name.endsWith('.txt')) {
        const reader = new FileReader();
        reader.onload = () => {
          const urls = reader.result.split('\n').map(l => l.trim()).filter(l => /^https?:\/\/.+/i.test(l));
          urls.forEach(u => addUrl(u));
        };
        reader.readAsText(file);
      }
    }
    return;
  }

  // Check for dropped text/URL
  const text = e.dataTransfer.getData('text/plain')?.trim();
  if (text) {
    const urls = text.split('\n').map(l => l.trim()).filter(l => /^https?:\/\/.+/i.test(l));
    if (urls.length > 0) urls.forEach(u => addUrl(u));
    else if (/^https?:\/\/.+/i.test(text)) addUrl(text);
  }
});

// ── Render queue ───────────────────────────────────────────────────────────────
function renderQueue() {
  queueList.innerHTML = '';
  if (queue.length === 0) {
    queueList.innerHTML = '<div class="queue-empty">Queue is empty — paste a URL or search above to get started.<br>Drag and drop URLs or .txt files here.</div>';
    return;
  }

  let lastGroup = undefined;
  for (const item of queue) {
    if (item.group && item.group !== lastGroup) {
      const lbl = document.createElement('div');
      lbl.className = 'group-label';
      lbl.textContent = item.group;
      queueList.appendChild(lbl);
      lastGroup = item.group;
    } else if (!item.group) lastGroup = null;

    const el = document.createElement('div');
    el.className = `queue-item state-${item.state}`;
    el.setAttribute('data-id', item.id);

    // Thumbnail
    if (item.thumbnail) {
      const img = document.createElement('img');
      img.className = 'item-thumb';
      img.src = item.thumbnail;
      img.loading = 'lazy';
      img.onerror = () => img.style.display = 'none';
      el.appendChild(img);
    }

    // Status icon
    const st = document.createElement('div');
    st.className = 'item-status';
    const stClass = { pending: 'st-pending', active: 'st-active', done: 'st-done', failed: 'st-failed' };
    st.innerHTML = `<div class="${stClass[item.state]}"></div>`;
    el.appendChild(st);

    // Info
    const info = document.createElement('div');
    info.className = 'item-info';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.title;
    info.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'item-detail';
    if (item.state === 'pending') detail.textContent = `${item.format.toUpperCase()} · Waiting…`;
    else if (item.state === 'active') detail.textContent = item.percent > 0 ? `Downloading… ${item.percent.toFixed(1)}%` : 'Starting…';
    else if (item.state === 'done') { detail.className = 'item-detail is-file'; detail.textContent = item.filename; }
    else if (item.state === 'failed') { detail.className = 'item-detail is-error'; detail.textContent = item.error; }
    info.appendChild(detail);

    if (item.state === 'active') {
      const bar = document.createElement('div');
      bar.className = 'item-bar';
      bar.innerHTML = `<div class="item-bar-fill" style="width:${item.percent}%"></div>`;
      info.appendChild(bar);
    }

    el.appendChild(info);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (item.state === 'pending') {
      actions.appendChild(makeIconBtn('✕', 'danger', () => removeItem(item.id), 'Remove'));
    }
    if (item.state === 'failed') {
      actions.appendChild(makeIconBtn('↻', '', () => retryItem(item.id), 'Retry'));
      actions.appendChild(makeIconBtn('✕', 'danger', () => removeItem(item.id), 'Remove'));
    }
    if (item.state === 'done') {
      actions.appendChild(makeIconBtn('▶', 'play', () => playPreview(item), 'Play'));
      actions.appendChild(makeIconBtn('✂', '', () => openTrimModal(item), 'Trim'));
      actions.appendChild(makeIconBtn('🏷', '', () => openTagsModal(item), 'Tags'));
      actions.appendChild(makeIconBtn('📂', '', () => ipcRenderer.invoke('open-file-location', item.filepath), 'Show in folder'));
    }

    el.appendChild(actions);
    queueList.appendChild(el);
  }

  // Scroll active item into view
  const active = queueList.querySelector('.state-active');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function makeIconBtn(icon, extraClass, onClick, title) {
  const btn = document.createElement('button');
  btn.className = `btn-icon ${extraClass}`;
  btn.textContent = icon;
  btn.title = title || '';
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

// ── Audio preview player + Radio ───────────────────────────────────────────────
let radioMode = false;
let radioHistory = [];     // URLs already played in this radio session
let currentStreamInfo = null; // { url, title, channel, thumbnail } for the currently streaming track

function stopPreview() {
  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio.removeAttribute('src');
    currentPreviewAudio.load();
    currentPreviewAudio = null;
  }
  currentPreviewItemId = null;
  currentStreamInfo = null;
  previewBar.classList.remove('show');
  $('preview-play').textContent = '▶';
  previewSeek.value = 0;
  previewTime.textContent = '0:00';
  previewTitle.textContent = '—';
  $('preview-artist').textContent = '';
  $('preview-thumb').style.display = 'none';
  $('preview-download').style.display = 'none';
}

function setupAudioEvents(audio) {
  audio.addEventListener('timeupdate', () => {
    if (currentPreviewAudio && currentPreviewAudio.duration) {
      previewSeek.value = (currentPreviewAudio.currentTime / currentPreviewAudio.duration) * 100;
      previewTime.textContent = formatTime(currentPreviewAudio.currentTime);
    }
  });

  audio.addEventListener('ended', () => {
    if (radioMode) {
      playNextRadioTrack();
    } else {
      stopPreview();
    }
  });
}

function showPreviewBar(title, artist, thumbnail, isStream) {
  previewTitle.textContent = title;
  $('preview-artist').textContent = artist || '';
  if (thumbnail) {
    $('preview-thumb').src = thumbnail;
    $('preview-thumb').style.display = '';
    $('preview-thumb').onerror = () => $('preview-thumb').style.display = 'none';
  } else {
    $('preview-thumb').style.display = 'none';
  }
  // Show download button for streamed (non-local) tracks
  $('preview-download').style.display = isStream ? '' : 'none';
  previewBar.classList.add('show');
  $('preview-play').textContent = '⏸';
}

/** Play a local file from a completed queue item */
async function playPreview(item) {
  if (currentPreviewItemId === item.id && !currentStreamInfo) {
    stopPreview();
    return;
  }

  stopPreview();

  const fileUrl = await ipcRenderer.invoke('get-file-url', item.filepath);
  if (!fileUrl) return;

  currentPreviewItemId = item.id;
  currentPreviewAudio = new Audio(fileUrl);
  showPreviewBar(item.title || item.filename, '', item.thumbnail, false);
  setupAudioEvents(currentPreviewAudio);

  // Seed radio history with this track's title for finding related tracks
  if (radioMode) radioHistory = [item.title || item.filename];

  currentPreviewAudio.play();
}

/** Stream a track directly from URL (for radio) */
async function streamTrack(track) {
  stopPreview();

  previewTitle.textContent = track.title;
  $('preview-artist').textContent = track.channel || 'Loading stream…';
  previewBar.classList.add('show');
  $('preview-play').textContent = '⏸';

  const result = await ipcRenderer.invoke('get-stream-url', track.url);
  if (!result.ok) {
    $('preview-artist').textContent = 'Failed to stream — skipping…';
    if (radioMode) setTimeout(playNextRadioTrack, 1500);
    return;
  }

  currentStreamInfo = track;
  radioHistory.push(track.url);

  currentPreviewAudio = new Audio(result.streamUrl);
  showPreviewBar(track.title, track.channel, track.thumbnail, true);
  setupAudioEvents(currentPreviewAudio);
  currentPreviewAudio.play();
}

/** Find and play the next related track */
async function playNextRadioTrack() {
  // Build a search query from what was just playing
  const lastTitle = currentStreamInfo?.title || previewTitle.textContent || '';
  const query = lastTitle.replace(/\(.*?\)|\[.*?\]/g, '').trim() + ' similar music';

  previewTitle.textContent = 'Finding next track…';
  $('preview-artist').textContent = '';
  $('preview-play').textContent = '⏸';
  $('preview-download').style.display = 'none';

  const result = await ipcRenderer.invoke('get-related-tracks', query, 8);
  if (!result.ok || result.tracks.length === 0) {
    $('preview-artist').textContent = 'No more tracks found';
    setTimeout(stopPreview, 2000);
    return;
  }

  // Pick a track we haven't played yet
  const next = result.tracks.find(t => !radioHistory.includes(t.url));
  if (!next) {
    // All played, reset history and try again with different query
    radioHistory = radioHistory.slice(-3);
    const fallback = result.tracks[Math.floor(Math.random() * result.tracks.length)];
    await streamTrack(fallback);
    return;
  }

  await streamTrack(next);
}

// Preview controls
$('preview-play').addEventListener('click', () => {
  if (!currentPreviewAudio) return;
  if (currentPreviewAudio.paused) { currentPreviewAudio.play(); $('preview-play').textContent = '⏸'; }
  else { currentPreviewAudio.pause(); $('preview-play').textContent = '▶'; }
});

previewSeek.addEventListener('input', () => {
  if (currentPreviewAudio && currentPreviewAudio.duration) {
    currentPreviewAudio.currentTime = (previewSeek.value / 100) * currentPreviewAudio.duration;
  }
});

$('preview-close').addEventListener('click', stopPreview);

// Radio toggle
$('preview-radio').addEventListener('click', () => {
  radioMode = !radioMode;
  $('preview-radio').classList.toggle('on', radioMode);
  if (radioMode) radioHistory = [];
});

// Download the currently streaming track
$('preview-download').addEventListener('click', () => {
  if (!currentStreamInfo) return;
  queue.push(makeItem({
    url: currentStreamInfo.url,
    title: currentStreamInfo.title,
    thumbnail: currentStreamInfo.thumbnail,
  }));
  renderQueue();
  persistQueue();
  processQueue();
  $('preview-download').style.display = 'none';
});

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Trim modal ─────────────────────────────────────────────────────────────────
function openTrimModal(item) {
  currentTrimFilepath = item.filepath;
  $('trim-file').value = item.filename || item.filepath;
  $('trim-start').value = '';
  $('trim-end').value = '';
  $('modal-trim').classList.add('show');
}

$('trim-cancel').addEventListener('click', () => $('modal-trim').classList.remove('show'));
$('trim-save').addEventListener('click', async () => {
  const start = $('trim-start').value.trim();
  const end = $('trim-end').value.trim();
  if (!start && !end) return;

  $('trim-save').disabled = true;
  $('trim-save').textContent = 'Trimming…';

  const result = await ipcRenderer.invoke('trim-audio', {
    filepath: currentTrimFilepath,
    startTime: start || null,
    endTime: end || null,
  });

  $('trim-save').disabled = false;
  $('trim-save').textContent = 'Trim';
  $('modal-trim').classList.remove('show');

  if (result.ok) {
    // Add trimmed file as a "done" item in queue for visibility
    queue.push({
      id: nextId++, url: '', title: `Trimmed: ${result.filename}`, format: '',
      bitrate: '', group: null, state: 'done', percent: 100,
      filename: result.filename, filepath: result.filepath,
      error: null, thumbnail: null,
    });
    renderQueue();
  }
});

// ── Tag editor modal ───────────────────────────────────────────────────────────
async function openTagsModal(item) {
  currentTagsFilepath = item.filepath;
  $('modal-tags').classList.add('show');
  $('tag-title').value = '';
  $('tag-artist').value = '';
  $('tag-album').value = '';
  $('tag-year').value = '';
  $('tag-genre').value = '';

  const tags = await ipcRenderer.invoke('read-tags', item.filepath);
  $('tag-title').value = tags.title;
  $('tag-artist').value = tags.artist;
  $('tag-album').value = tags.album;
  $('tag-year').value = tags.year;
  $('tag-genre').value = tags.genre;
}

$('tags-cancel').addEventListener('click', () => $('modal-tags').classList.remove('show'));
$('tags-save').addEventListener('click', async () => {
  $('tags-save').disabled = true;
  $('tags-save').textContent = 'Saving…';

  await ipcRenderer.invoke('write-tags', {
    filepath: currentTagsFilepath,
    tags: {
      title: $('tag-title').value,
      artist: $('tag-artist').value,
      album: $('tag-album').value,
      year: $('tag-year').value,
      genre: $('tag-genre').value,
    },
  });

  $('tags-save').disabled = false;
  $('tags-save').textContent = 'Save Tags';
  $('modal-tags').classList.remove('show');
});

// ── Search ─────────────────────────────────────────────────────────────────────
btnSearch.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  btnSearch.disabled = true;
  btnSearch.textContent = 'Searching…';
  searchResults.innerHTML = '<div class="search-empty">Searching…</div>';

  const result = await ipcRenderer.invoke('search-youtube', q);

  btnSearch.disabled = false;
  btnSearch.textContent = 'Search';

  if (!result.ok || result.results.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">No results found.</div>';
    return;
  }

  searchResults.innerHTML = '';
  for (const r of result.results) {
    const el = document.createElement('div');
    el.className = 'search-item';

    if (r.thumbnail) {
      const img = document.createElement('img');
      img.className = 'search-thumb';
      img.src = r.thumbnail;
      img.loading = 'lazy';
      img.onerror = () => img.style.display = 'none';
      el.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'search-info';
    info.innerHTML = `<div class="search-title">${escapeHtml(r.title)}</div>
      <div class="search-meta">${escapeHtml(r.channel)}${r.duration ? ' · ' + formatTime(r.duration) : ''}</div>`;
    el.appendChild(info);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-primary';
    addBtn.textContent = '+ Add';
    addBtn.style.padding = '6px 12px';
    addBtn.style.fontSize = '12px';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      queue.push(makeItem({ url: r.url, title: r.title, thumbnail: r.thumbnail }));
      renderQueue();
      persistQueue();
      processQueue();
      addBtn.textContent = 'Added ✓';
      addBtn.disabled = true;
    });
    el.appendChild(addBtn);

    searchResults.appendChild(el);
  }
}

// ── History ────────────────────────────────────────────────────────────────────
async function loadHistory() {
  const history = await ipcRenderer.invoke('get-history');
  renderHistory(history);
}

historyFilter.addEventListener('input', async () => {
  const history = await ipcRenderer.invoke('get-history');
  const q = historyFilter.value.toLowerCase();
  const filtered = q ? history.filter(h =>
    h.title?.toLowerCase().includes(q) || h.filename?.toLowerCase().includes(q) || h.source?.toLowerCase().includes(q)
  ) : history;
  renderHistory(filtered);
});

function renderHistory(history) {
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyList.innerHTML = '<div class="search-empty">No download history yet.</div>';
    return;
  }

  for (const h of history) {
    const el = document.createElement('div');
    el.className = 'history-item';

    const info = document.createElement('div');
    info.className = 'history-info';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = h.title || h.filename;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const date = h.date ? new Date(h.date).toLocaleDateString() : '';
    meta.textContent = [h.source, h.format?.toUpperCase(), date].filter(Boolean).join(' · ');
    info.appendChild(meta);

    el.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (h.filepath) {
      actions.appendChild(makeIconBtn('📂', '', () => ipcRenderer.invoke('open-file-location', h.filepath), 'Show'));
    }
    if (h.url) {
      actions.appendChild(makeIconBtn('↻', '', () => {
        queue.push(makeItem({ url: h.url, title: h.title }));
        renderQueue();
        persistQueue();
        processQueue();
        // Switch to queue tab
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'queue'));
        $$('.tab-content').forEach(t => t.classList.toggle('active', t.id === 'tab-queue'));
      }, 'Re-download'));
    }

    el.appendChild(actions);
    historyList.appendChild(el);
  }
}

$('btn-clear-history').addEventListener('click', async () => {
  await ipcRenderer.invoke('clear-history');
  renderHistory([]);
});

// ── Settings ───────────────────────────────────────────────────────────────────
function applySettingsToUI() {
  $('settings-folder').textContent = settings.outputFolder || 'Downloads (default)';
  setToggle('toggle-organize', settings.autoOrganize);
  setToggle('toggle-speed', settings.speedLimit > 0);
  $('speed-limit-input').value = settings.speedLimit || '';
  setToggle('toggle-metadata', settings.embedMetadata !== false);
  setToggle('toggle-thumbnail', settings.embedThumbnail !== false);
  setToggle('toggle-extension', settings.extensionEnabled);
  $('extension-port').value = settings.extensionPort || 9638;

  $$('#concurrent-group .pill-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.n) === (settings.concurrentDownloads || 1));
  });
}

function setToggle(id, on) {
  $(id).classList.toggle('on', !!on);
}

function toggleClick(id, key) {
  $(id).addEventListener('click', () => {
    const isOn = $(id).classList.toggle('on');
    settings[key] = isOn;
    saveSettingsDebounced();
  });
}

toggleClick('toggle-organize', 'autoOrganize');
toggleClick('toggle-metadata', 'embedMetadata');
toggleClick('toggle-thumbnail', 'embedThumbnail');

$('toggle-speed').addEventListener('click', () => {
  const isOn = $('toggle-speed').classList.toggle('on');
  settings.speedLimit = isOn ? (parseInt($('speed-limit-input').value) || 500) : 0;
  $('speed-limit-input').value = settings.speedLimit || '';
  saveSettingsDebounced();
});

$('speed-limit-input').addEventListener('change', () => {
  const val = parseInt($('speed-limit-input').value) || 0;
  settings.speedLimit = val;
  setToggle('toggle-speed', val > 0);
  saveSettingsDebounced();
});

$('toggle-extension').addEventListener('click', () => {
  const isOn = $('toggle-extension').classList.toggle('on');
  settings.extensionEnabled = isOn;
  saveSettingsDebounced();
});

$('extension-port').addEventListener('change', () => {
  settings.extensionPort = parseInt($('extension-port').value) || 9638;
  saveSettingsDebounced();
});

$$('#concurrent-group .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#concurrent-group .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.concurrentDownloads = parseInt(btn.dataset.n);
    saveSettingsDebounced();
  });
});

$('btn-pick-folder').addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('pick-output-folder');
  if (folder) {
    settings.outputFolder = folder;
    $('settings-folder').textContent = folder;
    saveSettingsDebounced();
  }
});

$('btn-reset-folder').addEventListener('click', () => {
  settings.outputFolder = '';
  $('settings-folder').textContent = 'Downloads (default)';
  saveSettingsDebounced();
});

let saveTimer = null;
function saveSettingsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ipcRenderer.invoke('save-settings', settings), 300);
}

// ── Util ───────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── Auto-update UI ─────────────────────────────────────────────────────────────
let updateReady = false;

function showUpdateStatus(msg, isReady, version) {
  // Top banner
  const banner = $('update-banner');
  const bannerText = $('update-text');
  const bannerBtn = $('update-action');

  bannerText.textContent = msg;
  if (isReady) {
    bannerBtn.textContent = 'Restart to Update';
    bannerBtn.style.display = '';
  } else {
    bannerBtn.style.display = 'none';
  }
  banner.classList.add('show');

  // Settings section
  $('update-settings-status').style.display = 'flex';
  $('update-settings-text').textContent = msg;
  if (isReady) {
    $('btn-install-update').style.display = '';
    updateReady = true;
  }
}

ipcRenderer.on('update-status', (_e, { status, version, percent }) => {
  if (status === 'available') {
    showUpdateStatus(`Downloading update v${version}…`, false);
  } else if (status === 'downloading') {
    showUpdateStatus(`Downloading update… ${percent?.toFixed(0) || 0}%`, false);
  } else if (status === 'ready') {
    showUpdateStatus(`Update v${version} ready!`, true, version);
  }
});

$('update-action').addEventListener('click', () => ipcRenderer.invoke('install-update'));
$('btn-install-update').addEventListener('click', () => ipcRenderer.invoke('install-update'));

// Check for updates button in settings
$('btn-check-updates').addEventListener('click', async () => {
  $('btn-check-updates').disabled = true;
  $('btn-check-updates').textContent = 'Checking…';
  $('update-settings-status').style.display = 'flex';
  $('update-settings-text').textContent = 'Checking for updates…';

  await ipcRenderer.invoke('check-for-updates');

  // Give it a few seconds to respond
  setTimeout(() => {
    if (!updateReady) {
      $('update-settings-text').textContent = 'You\'re on the latest version.';
      $('update-settings-text').style.color = 'var(--green)';
    }
    $('btn-check-updates').disabled = false;
    $('btn-check-updates').textContent = 'Check for Updates';
  }, 5000);
});

// Show current version
ipcRenderer.invoke('get-app-version').then(v => $('current-version').textContent = `v${v}`);

// ── Init ───────────────────────────────────────────────────────────────────────
init();
