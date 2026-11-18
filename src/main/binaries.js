'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const YTDLP_LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

let versionCache = null;
let releaseCache = null;

function bundledBinDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin');
}

function runtimeBinDir() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runtimeYtDlpPath() {
  return path.join(runtimeBinDir(), 'yt-dlp.exe');
}

function ffmpegPath() {
  const bundled = path.join(bundledBinDir(), 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (!app.isPackaged) {
    try {
      const devBinary = require('ffmpeg-static');
      if (devBinary && fs.existsSync(devBinary)) return devBinary;
    } catch {
      // ignored
    }
  }
  return bundled;
}

function existsWithSize(file, minBytes = 1024) {
  try {
    return fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

function runVersion(binary, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!binary || !fs.existsSync(binary)) {
      resolve({ ok: false, version: null, error: 'Binary not found' });
      return;
    }
    const started = Date.now();
    const child = spawn(binary, args, { windowsHide: true, shell: false });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* noop */ }
        resolve({ ok: false, version: null, error: 'Timed out' });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, version: null, error: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = (out.split(/\r?\n/).find((value) => value.trim()) || '').trim();
      resolve({
        ok: code === 0,
        version: line || null,
        error: code === 0 ? null : (err.split(/\r?\n/).find(Boolean) || `Exit code ${code}`),
        ms: Date.now() - started,
      });
    });
  });
}

function bundledStamp() {
  const file = path.join(bundledBinDir(), 'yt-dlp.exe');
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * Seed the writable per-user engine folder from the copy that shipped with the app.
 * Keeping the executable outside Program Files lets it update itself without admin rights.
 */
function ensureRuntimeBinaries() {
  const target = runtimeYtDlpPath();
  const bundled = path.join(bundledBinDir(), 'yt-dlp.exe');
  const markerFile = path.join(runtimeBinDir(), '.bundle-stamp');
  const stamp = bundledStamp();
  const info = { seeded: false, bundledPresent: existsWithSize(bundled, 1_000_000), runtimePresent: existsWithSize(target, 1_000_000) };

  if (!info.bundledPresent) return info;

  let marker = null;
  try {
    marker = fs.readFileSync(markerFile, 'utf8').trim();
  } catch {
    // No marker yet: first run, or the user cleared the folder.
    marker = null;
  }

  const shouldCopy = !info.runtimePresent || (stamp && marker !== stamp);
  if (!shouldCopy) return info;

  try {
    fs.copyFileSync(bundled, target);
    if (stamp) fs.writeFileSync(markerFile, stamp, 'utf8');
    info.seeded = true;
    info.runtimePresent = true;
    versionCache = null;
  } catch {
    // If seeding fails, the engine check will surface a helpful error.
  }

  return info;
}

async function getEngineInfo(options = {}) {
  if (!options.refresh && versionCache && Date.now() - versionCache.at < 30000) {
    return { ...versionCache.info };
  }

  const ytdlp = runtimeYtDlpPath();
  const ffmpeg = ffmpegPath();
  const [yt, ff] = await Promise.all([
    runVersion(ytdlp, ['--version']),
    runVersion(ffmpeg, ['-version']),
  ]);

  const info = {
    ytdlpPath: ytdlp,
    ffmpegPath: ffmpeg,
    ytdlpVersion: yt.version,
    ffmpegVersion: ff.version ? (ff.version.match(/ffmpeg version (\S+)/i)?.[1] || ff.version.slice(0, 40)) : null,
    ready: Boolean(yt.ok && ff.ok),
    ytdlpError: yt.ok ? null : (yt.error || 'Downloader engine missing'),
    ffmpegError: ff.ok ? null : (ff.error || 'Converter engine missing'),
    bundled: bundledStamp() !== null,
  };
  versionCache = { at: Date.now(), info };
  return { ...info };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

async function fetchLatestRelease(force = false) {
  if (!force && releaseCache && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache.data;
  const res = await fetch(YTDLP_LATEST_API, {
    headers: {
      'user-agent': 'Savepoint-App',
      accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const json = await res.json();
  const asset = Array.isArray(json.assets)
    ? json.assets.find((item) => item.name === 'yt-dlp.exe')
    : null;
  if (!asset) throw new Error('No Windows engine in the latest release');
  const data = {
    tag: json.tag_name,
    publishedAt: json.published_at,
    url: asset.browser_download_url,
    size: asset.size,
    notes: typeof json.body === 'string' ? json.body : '',
  };
  releaseCache = { at: Date.now(), data };
  return data;
}

async function downloadWithProgress(url, destination, onProgress) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Savepoint-App', accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const fd = fs.openSync(destination, 'w');
  const reader = res.body.getReader();
  let received = 0;
  let lastReport = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      fs.writeSync(fd, buffer);
      received += buffer.length;
      const now = Date.now();
      if (onProgress && (now - lastReport > 200 || received === total)) {
        lastReport = now;
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return received;
}

let updateInFlight = null;

/**
 * Update yt-dlp from GitHub releases. Resolves with a status object instead of throwing
 * for expected conditions (already current, offline) so the UI can stay calm.
 */
async function updateEngine(onProgress, options = {}) {
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    const info = await getEngineInfo({ refresh: true });
    let latest = null;
    try {
      latest = await fetchLatestRelease(true);
    } catch (error) {
      return { ok: false, updated: false, error: `Could not reach GitHub — ${error.message}` };
    }

    if (!options.force && info.ytdlpVersion && latest.tag && info.ytdlpVersion === latest.tag) {
      return {
        ok: true,
        updated: false,
        upToDate: true,
        version: info.ytdlpVersion,
        latest: latest.tag,
      };
    }

    const target = runtimeYtDlpPath();
    const temp = `${target}.download`;
    const onProgressSafe = typeof onProgress === 'function' ? onProgress : () => {};
    onProgressSafe({ stage: 'download', percent: 0, received: 0, total: latest.size || 0, label: 'Downloading engine' });

    try {
      const received = await downloadWithProgress(latest.url, temp, (progress) => {
        onProgressSafe({
          stage: 'download',
          ...progress,
          label: `Downloading engine ${formatBytes(progress.received)}`,
        });
      });
      if (received < 1_000_000) throw new Error('Downloaded engine looks incomplete');

      const header = Buffer.alloc(2);
      const fd = fs.openSync(temp, 'r');
      fs.readSync(fd, header, 0, 2, 0);
      fs.closeSync(fd);
      if (header[0] !== 0x4d || header[1] !== 0x5a) throw new Error('Downloaded file is not a Windows executable');

      onProgressSafe({ stage: 'install', percent: 100, label: 'Installing engine' });
      const backup = `${target}.old`;
      try { fs.rmSync(backup, { force: true }); } catch { /* noop */ }
      if (fs.existsSync(target)) {
        try { fs.renameSync(target, backup); } catch { /* noop */ }
      }
      fs.renameSync(temp, target);
      try { fs.rmSync(backup, { force: true }); } catch { /* noop */ }
      versionCache = null;
      const fresh = await getEngineInfo({ refresh: true });
      onProgressSafe({ stage: 'done', percent: 100, label: 'Engine ready' });
      return {
        ok: fresh.ready,
        updated: true,
        version: fresh.ytdlpVersion,
        latest: latest.tag,
        info: fresh,
      };
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* noop */ }
      const restored = `${target}.old`;
      if (!fs.existsSync(target) && fs.existsSync(restored)) {
        try { fs.renameSync(restored, target); } catch { /* noop */ }
      }
      return { ok: false, updated: false, error: error.message };
    }
  })().finally(() => {
    updateInFlight = null;
  });

  return updateInFlight;
}

module.exports = {
  ensureRuntimeBinaries,
  getEngineInfo,
  updateEngine,
  fetchLatestRelease,
  ffmpegPath,
  runtimeYtDlpPath,
  YTDLP_LATEST_API,
};
