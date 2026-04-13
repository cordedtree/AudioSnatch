const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } = fs;

// ── Paths ──────────────────────────────────────────────────────────────────────
const binDir      = () => path.join(app.getPath('userData'), 'bin');
const ytDlpPath   = () => path.join(binDir(), 'yt-dlp.exe');
const ffmpegPath  = () => path.join(binDir(), 'ffmpeg.exe');
const ffprobePath = () => path.join(binDir(), 'ffprobe.exe');
const dataDir     = () => path.join(app.getPath('userData'), 'data');
const settingsFile  = () => path.join(dataDir(), 'settings.json');
const queueFile     = () => path.join(dataDir(), 'queue.json');
const historyFile   = () => path.join(dataDir(), 'history.json');

let mainWindow = null;
let tray = null;
let extensionServer = null;

// ── Settings ───────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  outputFolder: '',          // empty = Downloads
  speedLimit: 0,             // 0 = unlimited, otherwise KB/s
  concurrentDownloads: 1,    // 1-3
  autoOrganize: false,       // subfolders by source
  embedMetadata: true,
  embedThumbnail: true,
  preset: 'custom',          // music | podcast | voice | custom
  format: 'mp3',
  bitrate: '0',              // '0' = best, '320', '192', '128', '64'
  extensionEnabled: false,
  extensionPort: 9638,
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsFile(), 'utf-8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function getOutputDir(settings) {
  return (settings.outputFolder && existsSync(settings.outputFolder)) ? settings.outputFolder : app.getPath('downloads');
}

// ── History ────────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(readFileSync(historyFile(), 'utf-8')); }
  catch { return []; }
}

function saveHistory(h) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(historyFile(), JSON.stringify(h, null, 2));
}

function addToHistory(entry) {
  const h = loadHistory();
  h.unshift(entry);
  if (h.length > 500) h.length = 500;
  saveHistory(h);
}

// ── Queue persistence ──────────────────────────────────────────────────────────
function loadQueue() {
  try {
    const items = JSON.parse(readFileSync(queueFile(), 'utf-8'));
    // Reset any active items to pending (app was closed mid-download)
    return items.map(i => ({ ...i, state: i.state === 'active' ? 'pending' : i.state }));
  } catch { return []; }
}

function saveQueue(items) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(queueFile(), JSON.stringify(items, null, 2));
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function fetchFollowRedirects(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'AudioSnatch/1.0' }, ...options }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        return fetchFollowRedirects(res.headers.location, options).then(resolve, reject);
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fetchFollowRedirects(url).then((res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;
      const file = createWriteStream(dest);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    }).catch(reject);
  });
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`]);
    ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Unzip exited ${code}`)));
    ps.on('error', reject);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findFile(full, name); if (f) return f; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}

// ── Binary management ──────────────────────────────────────────────────────────
function binariesExist() {
  return existsSync(ytDlpPath()) && existsSync(ffmpegPath());
}

async function downloadYtDlp(onProgress) {
  await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', ytDlpPath(), onProgress);
}

async function downloadFfmpeg(onProgress) {
  const tmpDir = path.join(binDir(), '_ffmpeg_tmp');
  const zipPath = path.join(binDir(), 'ffmpeg.zip');
  await downloadFile('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', zipPath, onProgress);

  if (existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  await unzip(zipPath, tmpDir);

  const ffmpegExe = findFile(tmpDir, 'ffmpeg.exe');
  if (!ffmpegExe) throw new Error('ffmpeg.exe not found in archive');
  fs.copyFileSync(ffmpegExe, ffmpegPath());

  // Also extract ffprobe for tag reading
  const ffprobeExe = findFile(tmpDir, 'ffprobe.exe');
  if (ffprobeExe) fs.copyFileSync(ffprobeExe, ffprobePath());

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);
}

async function setupBinaries(win) {
  mkdirSync(binDir(), { recursive: true });
  win.webContents.send('setup-status', 'Downloading yt-dlp…');
  await downloadYtDlp((p) => win.webContents.send('setup-progress', Math.round(p * 0.3)));
  win.webContents.send('setup-status', 'Downloading ffmpeg (this may take a minute)…');
  await downloadFfmpeg((p) => win.webContents.send('setup-progress', 30 + Math.round(p * 0.7)));
  win.webContents.send('setup-progress', 100);
  win.webContents.send('setup-status', 'Ready!');
}

async function checkYtDlpUpdate() {
  try {
    const cur = await new Promise((resolve, reject) => {
      const p = spawn(ytDlpPath(), ['--version']);
      let o = ''; p.stdout.on('data', d => o += d);
      p.on('close', () => resolve(o.trim())); p.on('error', reject);
    });
    const res = await fetchFollowRedirects('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
    const body = await new Promise(r => { let d = ''; res.on('data', c => d += c); res.on('end', () => r(d)); });
    const tag = JSON.parse(body).tag_name;
    if (tag && tag !== cur) { console.log(`Updating yt-dlp: ${cur} → ${tag}`); await downloadYtDlp(); }
    else console.log('yt-dlp is up to date:', cur);
  } catch (e) { console.warn('yt-dlp update check failed:', e.message); }
}

// ── URL expansion ──────────────────────────────────────────────────────────────
function runYtDlpJson(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath(), args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Failed to parse yt-dlp JSON output')); }
    });
    proc.on('error', reject);
  });
}

function isSpotifyUrl(url) { return /open\.spotify\.com/i.test(url); }

async function expandUrl(url) {
  // Use yt-dlp to inspect the URL
  const data = await runYtDlpJson(['--flat-playlist', '-J', '--no-warnings', url]);

  if (data._type === 'playlist' && data.entries && data.entries.length > 0) {
    // Check if entries have usable URLs (non-Spotify) or just metadata (Spotify)
    const isSpotify = isSpotifyUrl(url);
    let entries;

    if (isSpotify) {
      // Spotify: entries have titles/artists but no downloadable URL. Match each to YouTube.
      entries = [];
      for (const e of data.entries) {
        const query = [e.artist || e.uploader || '', e.title || ''].filter(Boolean).join(' - ');
        if (!query) continue;
        try {
          const match = await runYtDlpJson([`ytsearch1:${query}`, '-J', '--no-warnings', '--no-playlist']);
          entries.push({
            url: match.webpage_url || match.url,
            title: e.title || query,
            thumbnail: match.thumbnail || null,
          });
        } catch {
          entries.push({ url: null, title: e.title || query, thumbnail: null, error: `No YouTube match for "${query}"` });
        }
      }
    } else {
      entries = data.entries.map(e => ({
        url: e.webpage_url || e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
        title: e.title || e.id || 'Unknown',
        thumbnail: e.thumbnails?.[0]?.url || e.thumbnail || null,
      }));
    }

    return { type: 'playlist', title: data.title || 'Playlist', entries };
  }

  // Single video
  return {
    type: 'video',
    title: data.title || 'Video',
    thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || null,
    duration: data.duration || 0,
  };
}

// ── Search ─────────────────────────────────────────────────────────────────────
async function searchYouTube(query, count = 10) {
  const data = await runYtDlpJson([`ytsearch${count}:${query}`, '-J', '--no-warnings', '--flat-playlist']);
  if (!data.entries) return [];
  return data.entries.map(e => ({
    url: e.webpage_url || e.url || `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || 'Unknown',
    thumbnail: e.thumbnails?.slice(-1)[0]?.url || e.thumbnail || null,
    channel: e.channel || e.uploader || '',
    duration: e.duration || 0,
  }));
}

// ── Radio / Streaming ──────────────────────────────────────────────────────────

/** Get a direct streamable audio URL for a given video URL */
function getStreamUrl(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath(), ['-g', '-f', 'bestaudio', '--no-warnings', '--no-playlist', url]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0 && out.trim()) resolve(out.trim().split('\n')[0]);
      else reject(new Error(err.trim() || 'Failed to get stream URL'));
    });
    proc.on('error', reject);
  });
}

/** Search for related tracks and return them with metadata */
async function getRelatedTracks(query, count = 5) {
  const data = await runYtDlpJson([`ytsearch${count}:${query}`, '-J', '--no-warnings', '--flat-playlist']);
  if (!data.entries) return [];
  return data.entries.map(e => ({
    url: e.webpage_url || e.url || `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || 'Unknown',
    thumbnail: e.thumbnails?.slice(-1)[0]?.url || e.thumbnail || null,
    channel: e.channel || e.uploader || '',
    duration: e.duration || 0,
  }));
}

// ── Audio download ─────────────────────────────────────────────────────────────
function downloadAudio(win, { url, format, bitrate, itemId }) {
  const settings = loadSettings();
  const outDir = getOutputDir(settings);

  let outTemplate;
  if (settings.autoOrganize) {
    outTemplate = path.join(outDir, '%(extractor_key)s', '%(title)s.%(ext)s');
  } else {
    outTemplate = path.join(outDir, '%(title)s.%(ext)s');
  }

  // Write final filepath to a temp file so we can reliably read it
  const filepathLog = path.join(app.getPath('temp'), `audiosnatch-dl-${itemId}.txt`);

  const args = [
    '--no-playlist', '-x',
    '--audio-format', format,
    '--ffmpeg-location', binDir(),
    '-o', outTemplate,
    '--newline',
    '--print-to-file', 'after_move:filepath', filepathLog,
  ];

  // Bitrate / quality
  if (bitrate && bitrate !== '0') {
    args.push('--audio-quality', `${bitrate}K`);
  } else {
    args.push('--audio-quality', '0');
  }

  // Metadata & thumbnail embedding
  if (settings.embedMetadata) args.push('--embed-metadata');
  if (settings.embedThumbnail) args.push('--embed-thumbnail');

  // Speed limit
  if (settings.speedLimit > 0) args.push('--limit-rate', `${settings.speedLimit}K`);

  args.push(url);

  return new Promise((resolve) => {
    let lastFile = '';
    let errOutput = '';

    const proc = spawn(ytDlpPath(), args);

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) win.webContents.send('item-progress', { itemId, percent: parseFloat(match[1]) });

      // Fallback: try to catch destination from stdout
      const destMatch = text.match(/Destination: (.+)/);
      if (destMatch) lastFile = destMatch[1].trim();
      const alreadyMatch = text.match(/\[download\] (.+?) has already been downloaded/);
      if (alreadyMatch) lastFile = alreadyMatch[1].trim();
    });

    proc.stderr.on('data', d => errOutput += d);

    proc.on('close', (code) => {
      if (code === 0) {
        // Read the reliable filepath from the temp file
        let filepath = '';
        try {
          filepath = readFileSync(filepathLog, 'utf-8').trim().split('\n').pop().trim();
          fs.unlinkSync(filepathLog);
        } catch {
          filepath = lastFile || ''; // fallback to stdout parsing
        }
        const filename = filepath ? path.basename(filepath) : '(check output folder)';
        resolve({ ok: true, filename, filepath });
      } else {
        resolve({ ok: false, error: errOutput || `yt-dlp exited with code ${code}` });
      }
    });

    proc.on('error', (err) => resolve({ ok: false, error: `Failed to start yt-dlp: ${err.message}` }));
  });
}

// ── Audio trimming ─────────────────────────────────────────────────────────────
function trimAudio(filepath, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(filepath);
    const base = path.basename(filepath, ext);
    const dir = path.dirname(filepath);
    const outPath = path.join(dir, `${base}_trimmed${ext}`);

    const args = ['-y', '-i', filepath];
    if (startTime) args.push('-ss', startTime);
    if (endTime) args.push('-to', endTime);
    args.push('-c', 'copy', outPath);

    const proc = spawn(ffmpegPath(), args);
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true, filepath: outPath, filename: path.basename(outPath) });
      else reject(new Error(err || `ffmpeg exited ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Tag reading/writing ────────────────────────────────────────────────────────
function readTags(filepath) {
  return new Promise((resolve, reject) => {
    const probe = existsSync(ffprobePath()) ? ffprobePath() : ffmpegPath();
    const args = probe.includes('ffprobe')
      ? ['-v', 'quiet', '-print_format', 'json', '-show_format', filepath]
      : ['-i', filepath, '-f', 'ffmetadata', '-'];

    const proc = spawn(probe, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (probe.includes('ffprobe')) {
        try {
          const data = JSON.parse(out);
          const tags = data.format?.tags || {};
          resolve({
            title: tags.title || tags.TITLE || '',
            artist: tags.artist || tags.ARTIST || '',
            album: tags.album || tags.ALBUM || '',
            year: tags.date || tags.DATE || tags.year || '',
            genre: tags.genre || tags.GENRE || '',
          });
        } catch { resolve({ title: '', artist: '', album: '', year: '', genre: '' }); }
      } else {
        // Parse ffmetadata output
        const tags = {};
        (out + err).split('\n').forEach(line => {
          const m = line.match(/^\s*(title|artist|album|date|genre)\s*=\s*(.+)/i);
          if (m) tags[m[1].toLowerCase()] = m[2].trim();
        });
        resolve({
          title: tags.title || '', artist: tags.artist || '',
          album: tags.album || '', year: tags.date || '', genre: tags.genre || '',
        });
      }
    });
    proc.on('error', reject);
  });
}

function writeTags(filepath, tags) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(filepath);
    const tmpOut = filepath + '.tmp' + ext;

    const args = ['-y', '-i', filepath];
    if (tags.title) args.push('-metadata', `title=${tags.title}`);
    if (tags.artist) args.push('-metadata', `artist=${tags.artist}`);
    if (tags.album) args.push('-metadata', `album=${tags.album}`);
    if (tags.year) args.push('-metadata', `date=${tags.year}`);
    if (tags.genre) args.push('-metadata', `genre=${tags.genre}`);
    args.push('-c', 'copy', tmpOut);

    const proc = spawn(ffmpegPath(), args);
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0) {
        try {
          fs.unlinkSync(filepath);
          fs.renameSync(tmpOut, filepath);
          resolve({ ok: true });
        } catch (e) { reject(e); }
      } else {
        if (existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        reject(new Error(err || `ffmpeg exited ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// ── Browser extension HTTP server ──────────────────────────────────────────────
function startExtensionServer(port) {
  if (extensionServer) return;
  extensionServer = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { url } = JSON.parse(body);
          if (url && mainWindow) {
            mainWindow.webContents.send('extension-add-url', url);
            // Bring window to front
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end('Bad request');
        }
      });
    } else if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'AudioSnatch', version: '1.0.0' }));
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  extensionServer.listen(port, '127.0.0.1', () => {
    console.log(`Extension server listening on port ${port}`);
  });
  extensionServer.on('error', (err) => {
    console.warn('Extension server error:', err.message);
    extensionServer = null;
  });
}

function stopExtensionServer() {
  if (extensionServer) { extensionServer.close(); extensionServer = null; }
}

// ── System tray ────────────────────────────────────────────────────────────────
function getIconPath() {
  // In packaged app, icon is in resources; in dev, it's in the project root
  const devPath = path.join(__dirname, 'icon.ico');
  if (existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath, 'icon.ico');
}

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('AudioSnatch');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── Notifications ──────────────────────────────────────────────────────────────
function notifyQueueComplete() {
  if (Notification.isSupported()) {
    new Notification({
      title: 'AudioSnatch',
      body: 'All downloads complete!',
    }).show();
  }
}

// ── IPC Handlers ───────────────────────────────────────────────────────────────
ipcMain.handle('check-binaries', () => binariesExist());

ipcMain.handle('run-setup', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try { await setupBinaries(win); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('expand-url', async (_e, url) => {
  if (!/^https?:\/\/.+/i.test(url)) {
    return { ok: false, error: 'Enter a valid URL (must start with http:// or https://)' };
  }
  try {
    const result = await expandUrl(url);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('download-audio', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return downloadAudio(win, opts);
});

ipcMain.handle('search-youtube', async (_e, query) => {
  try {
    const results = await searchYouTube(query);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message, results: [] };
  }
});

ipcMain.handle('trim-audio', async (_e, { filepath, startTime, endTime }) => {
  try { return await trimAudio(filepath, startTime, endTime); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('read-tags', async (_e, filepath) => {
  try { return await readTags(filepath); }
  catch { return { title: '', artist: '', album: '', year: '', genre: '' }; }
});

ipcMain.handle('write-tags', async (_e, { filepath, tags }) => {
  try { return await writeTags(filepath, tags); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('open-downloads', () => {
  const s = loadSettings();
  shell.openPath(getOutputDir(s));
});

ipcMain.handle('open-file-location', (_e, filepath) => {
  if (filepath && existsSync(filepath)) shell.showItemInFolder(filepath);
  else { const s = loadSettings(); shell.openPath(getOutputDir(s)); }
});

ipcMain.handle('pick-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose output folder',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, s) => {
  saveSettings(s);
  // Toggle extension server
  if (s.extensionEnabled) startExtensionServer(s.extensionPort);
  else stopExtensionServer();
});

ipcMain.handle('load-queue', () => loadQueue());
ipcMain.handle('save-queue', (_e, items) => saveQueue(items));

ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('clear-history', () => { saveHistory([]); return { ok: true }; });
ipcMain.handle('add-to-history', (_e, entry) => { addToHistory(entry); });

ipcMain.handle('notify-queue-complete', () => notifyQueueComplete());

ipcMain.handle('get-stream-url', async (_e, url) => {
  try {
    const streamUrl = await getStreamUrl(url);
    return { ok: true, streamUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-related-tracks', async (_e, query, count) => {
  try {
    const tracks = await getRelatedTracks(query, count || 5);
    return { ok: true, tracks };
  } catch (err) {
    return { ok: false, error: err.message, tracks: [] };
  }
});

ipcMain.handle('get-file-url', (_e, filepath) => {
  if (filepath && existsSync(filepath)) return `file:///${filepath.replace(/\\/g, '/')}`;
  return null;
});

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 760,
    minWidth: 520,
    minHeight: 500,
    autoHideMenuBar: true,
    icon: getIconPath(),
    backgroundColor: '#0e0e0e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Clipboard check on focus
  mainWindow.on('focus', () => {
    try {
      const { clipboard } = require('electron');
      const text = clipboard.readText().trim();
      if (text && /^https?:\/\/.+/i.test(text)) {
        mainWindow.webContents.send('clipboard-url', text);
      }
    } catch {}
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (binariesExist()) checkYtDlpUpdate();
    // Start extension server if enabled
    const s = loadSettings();
    if (s.extensionEnabled) startExtensionServer(s.extensionPort);
  });
}

// ── Auto-updater ───────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { status: 'available', version: info.version });
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { status: 'downloading', percent: progress.percent });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { status: 'ready', version: info.version });
  }
  // Notify user
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'AudioSnatch Update Ready',
      body: `Version ${info.version} will install on next restart.`,
    });
    n.on('click', () => autoUpdater.quitAndInstall());
    n.show();
  }
});

autoUpdater.on('error', (err) => {
  console.warn('Auto-update error:', err.message);
});

ipcMain.handle('check-for-updates', () => {
  autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createWindow();
  // Check for app updates after a short delay
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
});

app.on('window-all-closed', () => {}); // keep running in tray
app.on('before-quit', () => { app.isQuitting = true; });
app.on('activate', () => { mainWindow?.show(); });
