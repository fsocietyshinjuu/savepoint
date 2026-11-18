'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MP4_QUALITIES = ['best', '2160', '1440', '1080', '720', '480'];
const MP3_QUALITIES = ['320', '256', '192', '128'];
const FORMATS = ['mp4', 'mp3'];
const THEMES = ['system', 'dark', 'light'];
const LITE_MODES = ['auto', 'on', 'off'];
const COOKIE_BROWSERS = ['none', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium'];
const DEFAULT_TEMPLATE = '%(title).150B [%(id)s].%(ext)s';

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createSettingsStore() {
  const file = path.join(app.getPath('userData'), 'settings.json');
  const defaultDownloadDir = path.join(app.getPath('downloads'), 'Savepoint');
  let lowSpec = false;
  try {
    const os = require('node:os');
    lowSpec = os.cpus().length <= 4 || os.totalmem() / 1024 ** 3 <= 8;
  } catch {
    lowSpec = false;
  }

  const defaults = {
    downloadDir: defaultDownloadDir,
    format: 'mp4',
    mp4Quality: '1080',
    mp3Quality: '192',
    concurrency: lowSpec ? 1 : 2,
    theme: 'system',
    liteMode: 'auto',
    reduceMotion: false,
    playlist: false,
    embedMetadata: true,
    embedThumbnail: false,
    filenameTemplate: DEFAULT_TEMPLATE,
    cookiesBrowser: 'none',
    autoCheckUpdates: true,
    autoUpdateEngine: true,
    notifications: true,
    onboarded: false,
    window: { width: 1180, height: 800, x: null, y: null, maximized: false },
  };

  let data = { ...defaults };

  function normalize(input) {
    const next = { ...defaults, ...(isPlainObject(input) ? input : {}) };

    if (!FORMATS.includes(next.format)) next.format = defaults.format;
    if (!MP4_QUALITIES.includes(String(next.mp4Quality))) next.mp4Quality = defaults.mp4Quality;
    else next.mp4Quality = String(next.mp4Quality);
    if (!MP3_QUALITIES.includes(String(next.mp3Quality))) next.mp3Quality = defaults.mp3Quality;
    else next.mp3Quality = String(next.mp3Quality);
    if (!THEMES.includes(next.theme)) next.theme = 'system';
    if (!LITE_MODES.includes(next.liteMode)) next.liteMode = 'auto';
    if (!COOKIE_BROWSERS.includes(next.cookiesBrowser)) next.cookiesBrowser = 'none';
    next.concurrency = clampInt(next.concurrency, 1, 3, defaults.concurrency);

    if (typeof next.downloadDir !== 'string' || !next.downloadDir.trim()) {
      next.downloadDir = defaults.downloadDir;
    }
    next.downloadDir = path.resolve(next.downloadDir);

    let template = typeof next.filenameTemplate === 'string' ? next.filenameTemplate.trim() : '';
    if (!template || template.length > 220 || template.includes('..') || /[<>:|"?*]/.test(template)) {
      template = DEFAULT_TEMPLATE;
    }
    if (!template.includes('%(ext)s')) template = `${template}.%(ext)s`;
    next.filenameTemplate = template;

    for (const key of ['reduceMotion', 'playlist', 'embedMetadata', 'embedThumbnail', 'autoCheckUpdates', 'autoUpdateEngine', 'notifications', 'onboarded']) {
      next[key] = Boolean(next[key]);
    }

    const w = isPlainObject(next.window) ? next.window : {};
    next.window = {
      width: clampInt(w.width, 900, 5000, defaults.window.width),
      height: clampInt(w.height, 620, 4000, defaults.window.height),
      x: Number.isFinite(w.x) ? Math.round(w.x) : null,
      y: Number.isFinite(w.y) ? Math.round(w.y) : null,
      maximized: Boolean(w.maximized),
    };

    return next;
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    data = normalize(JSON.parse(raw));
  } catch {
    data = normalize(defaults);
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // A failed settings write should never take the app down.
    }
  }

  function ensureDownloadDir() {
    try {
      fs.mkdirSync(data.downloadDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  function get() {
    return { ...data, window: { ...data.window } };
  }

  function update(patch) {
    if (!isPlainObject(patch)) return get();
    data = normalize({ ...data, ...patch });
    persist();
    ensureDownloadDir();
    return get();
  }

  ensureDownloadDir();
  persist();

  return {
    file,
    defaults,
    get,
    update,
    ensureDownloadDir,
    lowSpec,
    MP4_QUALITIES,
    MP3_QUALITIES,
    COOKIE_BROWSERS,
  };
}

module.exports = { createSettingsStore, DEFAULT_TEMPLATE };
