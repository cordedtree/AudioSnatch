# AudioSnatch

A desktop app for downloading audio from YouTube, SoundCloud, TikTok, Instagram, Twitter/X, Bandcamp, Spotify playlists, and 1000+ other sites. Built with Electron and powered by yt-dlp.

Paste a URL, pick a format, and hit download. That's it.

## Features

### Core
- **Universal URL support** — works with any site yt-dlp supports (YouTube, SoundCloud, TikTok, Instagram, Twitter/X, Bandcamp, Vimeo, Reddit, Facebook, Twitch, and many more)
- **Multiple audio formats** — MP3, WAV, FLAC, M4A
- **Bitrate control** — Best, 320k, 192k, 128k (for MP3/M4A)
- **Format presets** — Music (FLAC/best), Podcast (MP3/128k), Voice (M4A/64k), or Custom

### Queue System
- Add multiple URLs — downloads process sequentially or concurrently (1-3 parallel)
- Playlist URLs automatically expand into individual items with a group label
- Spotify playlists/albums are matched to YouTube and queued
- Add new URLs while downloads are in progress
- Remove pending items, retry failed items, clear completed
- Persistent queue — survives app restarts

### Search
- Built-in YouTube search — type a query, browse results with thumbnails, and add to queue
- No need to leave the app to find content

### Post-Processing
- **Audio trimming** — set start/end timestamps on any completed download (uses ffmpeg)
- **ID3 tag editor** — read and edit title, artist, album, year, genre on downloaded files
- **Metadata embedding** — automatically embeds title/artist metadata and thumbnail as album art

### Input Methods
- Paste a URL into the input field
- **Drag and drop** — drop URLs or `.txt` files directly onto the window
- **Clipboard detection** — detects a URL on your clipboard when the app gains focus and offers to add it
- **Batch import** — paste multiple URLs (one per line) via the Batch modal
- **Ctrl+V anywhere** — auto-adds clipboard URL even when the input isn't focused
- **Browser extension** — companion Chrome/Opera GX extension sends the current tab URL to AudioSnatch

### Settings
- **Output folder** — choose any folder or use Downloads (default)
- **Auto-organize** — create subfolders by source (YouTube/, SoundCloud/, TikTok/, etc.)
- **Speed limit** — toggle bandwidth throttling with configurable KB/s
- **Concurrent downloads** — 1, 2, or 3 parallel downloads
- **Metadata/thumbnail embedding** — toggle on or off

### Other
- **Download history** — searchable log of past downloads with re-download and show-in-folder
- **Audio preview** — play completed downloads in a built-in player with seek and play/pause
- **System tray** — minimizes to tray instead of closing, keeps running in the background
- **Windows notifications** — toast notification when the entire queue finishes
- **Auto-updates** — checks for new releases on GitHub and installs updates automatically

## Installation

### Download
Grab the latest installer from the [Releases](https://github.com/Cordedtree/AudioSnatch/releases) page:

**`AudioSnatch Setup X.X.X.exe`**

Run it. Done. The app handles everything else.

### First Launch
On first launch, AudioSnatch downloads yt-dlp and ffmpeg automatically. This only happens once. A progress bar shows the download status. Both binaries are stored in `%APPDATA%/AudioSnatch/bin/`.

### Updates
The app checks for updates on every launch. When a new version is available, a banner appears with a one-click "Restart to Update" button. Updates are downloaded in the background.

## Browser Extension (Optional)

A companion extension for Chrome and Opera GX lets you send the current tab's URL to AudioSnatch with one click.

### Install
1. Open `chrome://extensions` (Chrome) or `opera://extensions` (Opera GX)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

### Usage
1. In AudioSnatch, go to **Settings** and enable **Browser Extension Server**
2. Click the AudioSnatch extension icon on any page
3. The URL gets sent to AudioSnatch and added to the queue

## Building from Source

> **Most users can ignore this section.** If you just want to use AudioSnatch, download the installer from the [Releases](https://github.com/Cordedtree/AudioSnatch/releases) page — no setup required.

This is only needed if you want to modify the code or build the app yourself.

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- npm

### Setup
```bash
git clone https://github.com/Cordedtree/AudioSnatch.git
cd AudioSnatch
npm install
```

### Run in Development
```bash
npm start
```

### Build Windows Installer
```bash
npm run dist
```

The installer is output to `dist/AudioSnatch Setup X.X.X.exe`.

## Project Structure

```
AudioSnatch/
  main.js              Electron main process — IPC, yt-dlp/ffmpeg management,
                        queue processing, auto-updater, tray, extension server
  renderer/
    index.html         UI — tabbed layout, modals, all CSS
    app.js             Renderer logic — queue, search, history, settings, drag-drop
  extension/
    manifest.json      Chrome Manifest V3
    popup.html         Extension popup UI
    popup.js           Sends current tab URL to AudioSnatch
  package.json         Dependencies and electron-builder config
```

## Tech Stack

- **Electron** — desktop shell
- **yt-dlp** — audio extraction from 1000+ sites
- **ffmpeg/ffprobe** — format conversion, trimming, tag editing
- **electron-updater** — automatic updates via GitHub Releases
- Plain HTML/CSS/JS renderer — no framework dependencies

## Supported Sites

AudioSnatch supports every site that yt-dlp supports. The full list includes 1000+ sites. Some popular ones:

YouTube, YouTube Music, SoundCloud, TikTok, Instagram, Twitter/X, Bandcamp, Vimeo, Reddit, Facebook, Twitch, Dailymotion, Mixcloud, Audiomack, and many more.

Spotify playlists and albums are supported via automatic YouTube matching — each track is searched on YouTube and the best match is downloaded.

## Disclaimer

AudioSnatch is intended for personal use with content you have the right to download. Respect copyright laws and the terms of service of the platforms you use. The developers are not responsible for misuse of this tool.

## License

MIT
