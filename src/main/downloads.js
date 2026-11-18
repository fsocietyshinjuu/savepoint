'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { getEngineInfo, runtimeYtDlpPath, ffmpegPath } = require('./binaries');

const MAX_JOBS = 400;
const MAX_PLAYLIST_ITEMS = 100;
const YT_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (!YT_HOST.test(url.hostname)) return false;
    if (url.hostname.toLowerCase() === 'youtu.be') return url.pathname.length > 2;
    return (
      url.pathname === '/watch' ||
      url.pathname.startsWith('/shorts/') ||
      url.pathname.startsWith('/live/') ||
      url.pathname.startsWith('/embed/') ||
      url.pathname.startsWith('/playlist') ||
      url.pathname.startsWith('/@') ||
      url.pathname.startsWith('/channel/') ||
      url.pathname.startsWith('/c/') ||
      url.pathname.startsWith('/user/')
    );
  } catch {
    return false;
  }
}

function extractVideoId(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    const v = url.searchParams.get('v');
    if (v) return v;
    const match = url.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{6,})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function extractUrls(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  const compact = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const matches = compact.match(/(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s,;]+)?/gi) || [];
  for (let raw of matches) {
    raw = raw.replace(/[)\].,;'"]+$/g, '');
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    if (isYouTubeUrl(raw)) found.add(raw);
  }
  return [...found];
}

function friendlyError(text, stderr = '') {
  const haystack = `${text || ''}\n${stderr || ''}`;
  if (/Sign in to confirm|not a bot|confirm you'?re not a bot/i.test(haystack)) {
    return 'YouTube asked for a sign-in check. Turn on “Use browser cookies” in Settings, then retry.';
  }
  if (/age.?restricted|confirm your age/i.test(haystack)) {
    return 'This video is age-restricted. Enable browser cookies in Settings and retry.';
  }
  if (/private video|Video unavailable|has been removed|no longer available/i.test(haystack)) {
    return 'That video is private, removed, or unavailable in your region.';
  }
  if (/members.?only|join this channel/i.test(haystack)) {
    return 'This video is for channel members only.';
  }
  if (/HTTP Error 429|Too Many Requests/i.test(haystack)) {
    return 'YouTube is rate-limiting requests. Give it a few minutes, then retry.';
  }
  if (/ffmpeg|ffprobe|postprocessing/i.test(haystack)) {
    return 'The converter engine failed. Try updating the engine in Settings.';
  }
  if (/getaddrinfo|ENOTFOUND|network|Failed to resolve/i.test(haystack)) {
    return 'Network problem — check your connection and try again.';
  }
  if (/Unsupported URL|is not a valid URL/i.test(haystack)) {
    return 'That link does not look like a playable YouTube video.';
  }
  const cleaned = (text || stderr || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^ERROR:\s*/i, '').trim())
    .filter(Boolean)
    .pop();
  return cleaned ? cleaned.slice(0, 240) : 'The download failed. Open details for the engine log.';
}

function parseSpeed(value) {
  if (!value) return 0;
  const match = String(value).match(/([\d.]+)\s*([KMGT]?i?B)\/s/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith('t') ? 1024 ** 4 : unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
  return Math.round(amount * factor);
}

function parseEta(value) {
  if (!value || /unknown|n\/a/i.test(value)) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const parts = text.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function parseProgress(line) {
  const payload = line.slice(2);
  const parts = payload.split('|');
  if (parts.length < 6) return null;
  const rawPercent = parts[0].replace('%', '').trim();
  const downloaded = Number.parseInt(parts[3], 10);
  const total = Number.parseInt(parts[4], 10) || Number.parseInt(parts[5], 10);
  let percent = Number.parseFloat(rawPercent);
  if (!Number.isFinite(percent) && Number.isFinite(downloaded) && Number.isFinite(total) && total > 0) {
    percent = (downloaded / total) * 100;
  }
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    speed: parseSpeed(parts[1]),
    eta: parseEta(parts[2]),
    downloaded: Number.isFinite(downloaded) ? downloaded : 0,
    total: Number.isFinite(total) ? total : 0,
  };
}

function cleanText(value, max = 300) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
      killer.on('error', () => { try { child.kill(); } catch { /* noop */ } });
      killer.unref?.();
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill(); } catch { /* noop */ }
  }
}

function createDownloadManager(options) {
  const settingsStore = options.settings;
  const history = options.history;
  const emitter = new EventEmitter();
  const jobs = [];
  const tempDir = path.join(options.userDataDir, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  let emitTimer = null;
  let disposed = false;

  function publicJob(job) {
    return {
      id: job.id,
      url: job.url,
      title: job.title,
      thumbnail: job.thumbnail,
      duration: job.duration,
      uploader: job.uploader,
      format: job.format,
      quality: job.quality,
      status: job.status,
      percent: job.percent == null ? null : Math.round(job.percent * 10) / 10,
      speed: job.speed || 0,
      eta: job.eta,
      downloaded: job.downloaded || 0,
      total: job.total || 0,
      size: job.size || 0,
      stage: job.stage || '',
      outputPath: job.outputPath || '',
      error: job.error || '',
      errorDetail: job.errorDetail || '',
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      videoId: job.videoId || '',
    };
  }

  function list() {
    return jobs.map(publicJob);
  }

  function scheduleEmit(delay = 160) {
    if (disposed) return;
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      emitter.emit('jobs', list());
    }, delay);
  }

  function emitNow() {
    if (disposed) return;
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    emitter.emit('jobs', list());
  }

  function activeCount() {
    return jobs.filter((job) => job._proc).length;
  }

  function hasActive() {
    return jobs.some((job) => job._proc || job.status === 'fetching') || jobs.some((job) => job.status === 'queued' && job.autoStart !== false);
  }

  function findJob(id) {
    return jobs.find((job) => job.id === id) || null;
  }

  function newJob(url, overrides = {}) {
    const s = settingsStore.get();
    const format = overrides.format === 'mp3' ? 'mp3' : overrides.format === 'mp4' ? 'mp4' : s.format;
    return {
      id: crypto.randomUUID(),
      url,
      title: 'Reading link…',
      thumbnail: '',
      duration: 0,
      uploader: '',
      format,
      quality: overrides.quality || (format === 'mp3' ? s.mp3Quality : s.mp4Quality),
      status: 'fetching',
      percent: null,
      speed: 0,
      eta: null,
      downloaded: 0,
      total: 0,
      size: 0,
      stage: 'Reading link',
      outputPath: '',
      error: '',
      errorDetail: '',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      videoId: extractVideoId(url) || '',
      autoStart: true,
      _proc: null,
      _printFile: '',
      _stderr: [],
      _pauseRequested: false,
      _cancelRequested: false,
      _removeAfterStop: false,
    };
  }

  function applyMeta(job, meta) {
    if (!meta) return;
    job.title = cleanText(meta.title || meta.fulltitle || job.title, 300) || job.title;
    job.uploader = cleanText(meta.uploader || meta.channel || '', 120);
    job.duration = Number(meta.duration) || 0;
    const thumbs = Array.isArray(meta.thumbnails) ? meta.thumbnails : [];
    const bestThumb = meta.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : '');
    if (typeof bestThumb === 'string' && /^https?:\/\//.test(bestThumb)) job.thumbnail = bestThumb;
    if (meta.id) job.videoId = String(meta.id);
    if (Number(meta.filesize_approx)) job.total = Number(meta.filesize_approx);
  }

  function fetchJSON(url, playlistMode) {
    return new Promise((resolve) => {
      const engine = runtimeYtDlpPath();
      if (!fs.existsSync(engine)) {
        resolve({ ok: false, error: 'Engine not installed', notFound: true });
        return;
      }
      const args = [
        '--ignore-config',
        '--no-warnings',
        '--no-progress',
        '--no-colors',
        '--socket-timeout', '20',
        '-J',
      ];
      if (playlistMode) {
        args.push('--flat-playlist', '--playlist-end', String(MAX_PLAYLIST_ITEMS));
      } else {
        args.push('--no-playlist');
      }
      const cookies = settingsStore.get().cookiesBrowser;
      if (cookies && cookies !== 'none') args.push('--cookies-from-browser', cookies);
      args.push(url);

      let child;
      try {
        child = spawn(engine, args, { windowsHide: true, shell: false });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      let out = '';
      let err = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child);
        resolve({ ok: false, error: 'Timed out while reading link', timedOut: true });
      }, 45000);

      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        if (out.length > 30_000_000) {
          settled = true;
          clearTimeout(timer);
          killTree(child);
          resolve({ ok: false, error: 'Playlist metadata was too large' });
        }
      });
      child.stderr.on('data', (chunk) => { err += chunk.toString(); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ ok: false, error: friendlyError('', err), detail: cleanText(err, 4000) });
          return;
        }
        try {
          const parsed = JSON.parse(out);
          resolve({ ok: true, data: parsed });
        } catch {
          resolve({ ok: false, error: 'Could not read video information', detail: cleanText(out.slice(0, 2000), 4000) });
        }
      });
    });
  }

  function buildArgs(job, s, printFile) {
    const engine = runtimeYtDlpPath();
    const ffmpeg = ffmpegPath();
    const args = [
      '--ignore-config',
      '--newline',
      '--no-colors',
      '--no-warnings',
      '--no-playlist',
      '--windows-filenames',
      '--trim-filenames', '170',
      '--retries', '8',
      '--fragment-retries', '8',
      '--socket-timeout', '20',
      '--concurrent-fragments', '3',
      '--no-simulate',
      '--progress',
      '--progress-template', 'download:SP%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
      '--print-to-file', 'after_move:filepath', printFile,
      '--ffmpeg-location', ffmpeg,
      '-o', path.join(s.downloadDir, s.filenameTemplate),
    ];

    const height = job.format === 'mp4' && job.quality !== 'best' ? Number(job.quality) : null;
    const cap = Number.isFinite(height) ? `[height<=${height}]` : '';

    if (job.format === 'mp3') {
      args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', `${job.quality || s.mp3Quality}K`);
      if (s.embedMetadata) args.push('--embed-metadata');
      if (s.embedThumbnail) args.push('--embed-thumbnail');
    } else {
      args.push(
        '-f', `bv*${cap}[vcodec^=avc1]+ba[ext=m4a]/bv*${cap}+ba/b${cap}/b`,
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
      );
      if (s.embedMetadata) args.push('--embed-metadata');
    }

    if (s.cookiesBrowser && s.cookiesBrowser !== 'none') {
      args.push('--cookies-from-browser', s.cookiesBrowser);
    }

    args.push(job.url);
    return { engine, args };
  }

  function findOutputFile(job) {
    try {
      const dir = settingsStore.get().downloadDir;
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dir, entry.name))
        .filter((file) => {
          const ext = path.extname(file).toLowerCase();
          if (job.format === 'mp3' ? ext !== '.mp3' : ext !== '.mp4') return false;
          return job.videoId ? file.includes(`[${job.videoId}]`) : true;
        })
        .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files[0]?.file || '';
    } catch {
      return '';
    }
  }

  function finishJob(job) {
    let outputPath = '';
    try {
      if (job._printFile && fs.existsSync(job._printFile)) {
        const lines = fs.readFileSync(job._printFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        outputPath = lines[lines.length - 1] || '';
      }
    } catch {
      // fall through to scanning
    }
    if (!outputPath) outputPath = findOutputFile(job);
    job.outputPath = outputPath;
    job.size = 0;
    if (outputPath) {
      try { job.size = fs.statSync(outputPath).size; } catch { /* noop */ }
    }
    job.status = 'done';
    job.stage = 'Saved';
    job.percent = 100;
    job.speed = 0;
    job.eta = 0;
    job.finishedAt = Date.now();
    job.error = '';
    job.errorDetail = '';
    if (job._printFile) {
      try { fs.rmSync(job._printFile, { force: true }); } catch { /* noop */ }
    }
    if (outputPath) {
      history.add({
        id: `${job.videoId || job.id}`,
        title: job.title,
        path: outputPath,
        format: job.format,
        quality: job.quality,
        size: job.size,
        duration: job.duration,
        thumbnail: job.thumbnail,
        uploader: job.uploader,
        finishedAt: job.finishedAt,
      });
    }
    emitter.emit('completed', publicJob(job));
  }

  function startJob(job) {
    const s = settingsStore.get();
    const enginePath = runtimeYtDlpPath();
    if (!fs.existsSync(enginePath) || !fs.existsSync(ffmpegPath())) {
      job.status = 'error';
      job.error = 'The download or conversion engine is missing. Open Settings → Engine and repair it.';
      job.stage = 'Needs attention';
      emitNow();
      pump();
      return;
    }
    const printFile = path.join(tempDir, `${job.id}.path`);
    try { fs.rmSync(printFile, { force: true }); } catch { /* noop */ }
    const { engine, args } = buildArgs(job, s, printFile);

    job._printFile = printFile;
    job._pauseRequested = false;
    job._cancelRequested = false;
    job._stderr = [];
    job.status = 'downloading';
    job.stage = 'Downloading';
    job.error = '';
    job.errorDetail = '';
    job.percent = job.percent && job.percent > 0 ? job.percent : 0;
    job.speed = 0;
    job.stage = 'Connecting';
    job.startedAt = Date.now();
    job.finishedAt = null;

    let child;
    try {
      child = spawn(engine, args, { windowsHide: true, shell: false });
    } catch (error) {
      job.status = 'error';
      job.error = friendlyError(error.message);
      job.stage = 'Needs attention';
      emitNow();
      pump();
      return;
    }
    job._proc = child;
    emitNow();

    let stdoutBuffer = '';
    let lastStage = '';

    const handleLine = (line) => {
      if (!line) return;
      if (line.startsWith('SP') && line.includes('|')) {
        const progress = parseProgress(line);
        if (progress) {
          job.percent = progress.percent;
          job.speed = progress.speed;
          job.eta = progress.eta;
          job.downloaded = progress.downloaded;
          if (progress.total) job.total = progress.total;
          if (job.status !== 'downloading') {
            job.status = 'downloading';
            job.stage = 'Downloading';
            emitNow();
          } else if (job.stage === 'Connecting' && (progress.percent || 0) > 0) {
            job.stage = 'Downloading';
          }
          scheduleEmit();
        }
        return;
      }
      if (/^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Metadata|EmbedThumbnail|Fixup)/i.test(line)) {
        job.status = 'processing';
        job.stage = line.replace(/^\[([^\]]+)\].*/, (_, name) => {
          if (/extractaudio/i.test(name)) return 'Converting to MP3';
          if (/merger/i.test(name)) return 'Merging audio + video';
          if (/remux/i.test(name)) return 'Wrapping MP4';
          if (/metadata/i.test(name)) return 'Writing tags';
          if (/embedthumbnail/i.test(name)) return 'Adding cover art';
          return 'Processing';
        });
        job.speed = 0;
        emitNow();
        lastStage = job.stage;
        return;
      }
      if (/^\[download\]\s+Destination:/i.test(line)) {
        if (job.stage === 'Connecting') job.stage = 'Downloading';
        return;
      }
      if (/^\[download\].*has already been downloaded/i.test(line)) {
        job.stage = 'Already saved';
        return;
      }
      if (line.startsWith('ERROR:')) {
        job._stderr.push(line);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line.trim());
      if (job._stderr.length > 60) job._stderr.splice(0, job._stderr.length - 60);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) job._stderr.push(trimmed);
      }
      if (job._stderr.length > 60) job._stderr.splice(0, job._stderr.length - 60);
      if (/merging|extracting audio|postprocess/i.test(text)) {
        job.status = 'processing';
        if (job.stage !== lastStage) {
          job.stage = 'Processing';
          emitNow();
          lastStage = job.stage;
        }
      }
    });

    child.on('error', (error) => {
      job._proc = null;
      job.status = 'error';
      job.stage = 'Needs attention';
      job.error = friendlyError(error.message);
      job.errorDetail = error.message;
      emitNow();
      pump();
    });

    child.on('close', (code) => {
      job._proc = null;
      if (job._removeAfterStop) {
        const index = jobs.findIndex((item) => item.id === job.id);
        if (index >= 0) jobs.splice(index, 1);
        emitNow();
        pump();
        return;
      }
      if (job._pauseRequested) {
        job.status = 'paused';
        job.stage = 'Paused';
        job.speed = 0;
        job.eta = null;
        emitNow();
        pump();
        return;
      }
      if (job._cancelRequested) {
        job.status = 'canceled';
        job.stage = 'Canceled';
        job.speed = 0;
        job.eta = null;
        job.finishedAt = Date.now();
        cleanupPartials(job);
        emitNow();
        pump();
        return;
      }
      if (code === 0) {
        finishJob(job);
        emitNow();
        pump();
        return;
      }
      const detail = job._stderr.join('\n');
      job.status = 'error';
      job.stage = 'Needs attention';
      job.error = friendlyError('', detail);
      job.errorDetail = cleanText(detail, 4000);
      job.speed = 0;
      job.eta = null;
      job.finishedAt = Date.now();
      cleanupPartials(job);
      emitNow();
      pump();
    });
  }

  function cleanupPartials(job) {
    if (!job.videoId) return;
    try {
      const dir = settingsStore.get().downloadDir;
      for (const name of fs.readdirSync(dir)) {
        if (!name.includes(`[${job.videoId}]`)) continue;
        if (name.endsWith('.part') || name.endsWith('.ytdl') || name.endsWith('.temp')) {
          try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* noop */ }
        }
      }
    } catch {
      // noop
    }
    if (job._printFile) {
      try { fs.rmSync(job._printFile, { force: true }); } catch { /* noop */ }
    }
  }

  function pump() {
    if (disposed) return;
    const limit = settingsStore.get().concurrency;
    let running = activeCount();
    while (running < limit) {
      const next = jobs.find((job) => job.status === 'queued');
      if (!next) break;
      startJob(next);
      running += 1;
    }
  }

  async function resolveMetadata(job) {
    const s = settingsStore.get();
    const playlistMode = Boolean(s.playlist);
    const result = await fetchJSON(job.url, playlistMode);
    if (disposed) return;
    const current = findJob(job.id);
    if (!current) return;

    if (!result.ok) {
      current.status = 'error';
      current.stage = 'Needs attention';
      current.error = result.error || 'Could not read that link.';
      current.errorDetail = result.detail || '';
      current.title = current.title === 'Reading link…' ? 'Could not read link' : current.title;
      emitNow();
      return;
    }

    const meta = result.data;
    const entries = Array.isArray(meta.entries) ? meta.entries.filter(Boolean) : null;
    const looksLikePlaylist = entries && (meta._type === 'playlist' || entries.length > 1 || meta.playlist_count);

    if (playlistMode && looksLikePlaylist) {
      const accepted = [];
      const room = Math.max(0, MAX_JOBS - jobs.length + 1);
      for (const entry of entries.slice(0, Math.min(MAX_PLAYLIST_ITEMS, room))) {
        const entryUrl = entry.webpage_url || entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '');
        if (!entryUrl || !isYouTubeUrl(entryUrl)) continue;
        if (entry.id && jobs.some((other) => other !== current && other.videoId === entry.id && ['queued', 'fetching', 'downloading', 'processing', 'paused'].includes(other.status))) {
          continue;
        }
        const child = newJob(entryUrl, { format: current.format, quality: current.quality });
        child.status = 'queued';
        child.stage = 'Queued';
        child.title = cleanText(entry.title || 'Untitled video', 300);
        child.duration = Number(entry.duration) || 0;
        child.videoId = entry.id || extractVideoId(entryUrl) || '';
        child.uploader = cleanText(entry.uploader || meta.uploader || meta.title || '', 120);
        const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
        const thumb = entry.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : '');
        if (typeof thumb === 'string' && /^https?:/.test(thumb)) child.thumbnail = thumb;
        accepted.push(child);
      }
      const index = jobs.indexOf(current);
      if (accepted.length) {
        jobs.splice(index, 1, ...accepted);
        emitNow();
        pump();
      } else {
        current.status = 'error';
        current.error = 'No downloadable videos were found in that playlist.';
        current.stage = 'Needs attention';
        emitNow();
      }
      return;
    }

    applyMeta(current, meta);
    current.status = 'queued';
    current.stage = 'Queued';
    current.percent = 0;
    current.error = '';
    current.errorDetail = '';
    emitNow();
    pump();
  }

  function add(text, overrides = {}) {
    const urls = extractUrls(text);
    const rejected = [];
    const duplicates = [];
    const addedIds = [];
    if (!urls.length) {
      return { added: [], rejected: [{ value: String(text || '').slice(0, 200), reason: 'No YouTube link found' }], duplicates };
    }

    for (const url of urls) {
      if (!isYouTubeUrl(url)) {
        rejected.push({ value: url, reason: 'Not a YouTube link' });
        continue;
      }
      const videoId = extractVideoId(url);
      const playlistUrl = /[?&]list=/.test(url) || /\/playlist/.test(url);
      if (videoId && jobs.some((job) => job.videoId === videoId && ['fetching', 'queued', 'downloading', 'processing', 'paused'].includes(job.status))) {
        duplicates.push(videoId);
        continue;
      }
      if (!playlistUrl && jobs.length >= MAX_JOBS) {
        rejected.push({ value: url, reason: 'Queue is full' });
        continue;
      }
      const job = newJob(url, overrides);
      jobs.push(job);
      addedIds.push(job.id);
      resolveMetadata(job).catch(() => {});
    }

    emitNow();
    return { added: addedIds, rejected, duplicates };
  }

  function pause(id) {
    const job = findJob(id);
    if (!job) return false;
    if (job._proc) {
      job._pauseRequested = true;
      job.stage = 'Pausing…';
      emitNow();
      killTree(job._proc);
      return true;
    }
    if (job.status === 'queued' || job.status === 'fetching') {
      job.status = 'paused';
      job.stage = 'Paused';
      emitNow();
      return true;
    }
    return false;
  }

  function resume(id) {
    const job = findJob(id);
    if (!job) return false;
    if (job.status !== 'paused' && job.status !== 'error' && job.status !== 'canceled') return false;
    job._pauseRequested = false;
    job._cancelRequested = false;
    job.status = 'queued';
    job.stage = 'Queued';
    job.error = '';
    job.errorDetail = '';
    emitNow();
    pump();
    return true;
  }

  function cancel(id) {
    const job = findJob(id);
    if (!job) return false;
    if (job._proc) {
      job._cancelRequested = true;
      job.stage = 'Cancelling…';
      emitNow();
      killTree(job._proc);
      return true;
    }
    job.status = 'canceled';
    job.stage = 'Canceled';
    job.speed = 0;
    job.eta = null;
    job.finishedAt = Date.now();
    cleanupPartials(job);
    emitNow();
    return true;
  }

  function retry(id) {
    return resume(id);
  }

  function remove(id) {
    const job = findJob(id);
    if (!job) return false;
    if (job._proc) {
      job._removeAfterStop = true;
      job._cancelRequested = true;
      killTree(job._proc);
      emitNow();
      return true;
    }
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    cleanupPartials(job);
    emitNow();
    return true;
  }

  function clearFinished() {
    let removed = 0;
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      if (jobs[i].status === 'done' || jobs[i].status === 'canceled') {
        jobs.splice(i, 1);
        removed += 1;
      }
    }
    if (removed) emitNow();
    return removed;
  }

  function setFormat(id, format, quality) {
    const job = findJob(id);
    if (!job || !['mp4', 'mp3'].includes(format)) return false;
    if (['downloading', 'processing', 'fetching'].includes(job.status)) return false;
    job.format = format;
    job.quality = quality || (format === 'mp3' ? settingsStore.get().mp3Quality : settingsStore.get().mp4Quality);
    job.error = '';
    if (job.status === 'error' || job.status === 'canceled') {
      job.status = 'queued';
      job.stage = 'Queued';
    }
    emitNow();
    pump();
    return true;
  }

  function stopAll() {
    disposed = true;
    if (emitTimer) clearTimeout(emitTimer);
    for (const job of jobs) {
      if (job._proc) {
        job._cancelRequested = true;
        killTree(job._proc);
      }
    }
  }

  emitter.on('completed', () => {
    if (!hasActive()) {
      setTimeout(() => {
        if (!disposed) emitter.emit('idle', { stats: history.stats() });
      }, 400);
    }
  });

  async function engineStatus() {
    return getEngineInfo();
  }

  return {
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    list,
    add,
    pause,
    resume,
    cancel,
    retry,
    remove,
    clearFinished,
    setFormat,
    stopAll,
    pump,
    hasActive,
    engineStatus,
  };
}

module.exports = {
  createDownloadManager,
  isYouTubeUrl,
  extractUrls,
  extractVideoId,
  friendlyError,
  parseProgress,
  parseEta,
  parseSpeed,
};
