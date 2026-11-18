'use strict';

const sp = window.savepoint;

const LINKS = {
  landing: 'https://savepoint-app.github.io/savepoint/',
  github: 'https://github.com/savepoint-app/savepoint',
};

const QUALITY = {
  mp4: [
    ['best', 'Best'],
    ['2160', '4K'],
    ['1440', '1440p'],
    ['1080', '1080p'],
    ['720', '720p'],
    ['480', '480p'],
  ],
  mp3: [
    ['320', '320k'],
    ['256', '256k'],
    ['192', '192k'],
    ['128', '128k'],
  ],
};

const state = {
  settings: null,
  meta: null,
  engine: null,
  updates: { status: 'idle' },
  jobs: [],
  history: [],
  historyStats: { count: 0, totalSize: 0 },
  filter: 'all',
  adding: false,
  engineUpdating: false,
  engineProgress: null,
  announcedUpdate: null,
  announcedReady: null,
  wizardShown: false,
  paletteIndex: 0,
  paletteCommands: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {};

function cacheElements() {
  const ids = [
    'enginePill', 'engineDot', 'engineLabel', 'paletteBtn', 'themeBtn', 'themeGlyph', 'settingsBtn',
    'settingsDialog', 'closeSettingsBtn', 'settingsFolder', 'settingsConcurrency', 'settingsPlaylist',
    'settingsCookies', 'settingsTheme', 'settingsLite', 'settingsMotion', 'engineVersionSetting',
    'engineReadyBadge', 'ffmpegVersionSetting', 'engineProgress', 'engineProgressLabel', 'engineUpdateBtn',
    'settingsEngineAuto', 'appVersionSetting', 'updateStateLabel', 'checkUpdateBtn', 'updateActions',
    'downloadUpdateBtn', 'installUpdateBtn', 'updateProgress', 'updateProgressLabel', 'settingsAutoUpdate',
    'aboutVersion', 'landingLink', 'githubLink', 'historySummary', 'clearHistoryBtn',
    'addForm', 'urlInput', 'addBtn', 'detected', 'folderBtn', 'folderLabel', 'openFolderBtn',
    'railFiles', 'railSize', 'railEngine', 'qualityChips', 'qualityLabel', 'queueCount', 'clearBtn',
    'jobList', 'emptyState', 'pasteBtn', 'queueSummary', 'historyStat', 'ffmpegStatus', 'ffmpegLabel', 'versionStatus',
    'liteBadge', 'updateBtn', 'engineVersion', 'toasts', 'dropOverlay', 'onboarding',
    'finishOnboarding', 'palette', 'paletteInput', 'paletteList', 'engineProgressBar',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
  els.filters = $$('.filter');
  els.formatButtons = $$('[data-format]');
  els.engineProgressBar = els.engineProgress ? els.engineProgress.querySelector('.bar > i') : null;
  els.updateProgressBar = els.updateProgress ? els.updateProgress.querySelector('.bar > i') : null;
}

/* ---------- formatting ---------- */

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatEta(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${total}s`;
}

function shortPath(fullPath) {
  if (typeof fullPath !== 'string') return '';
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return `…\\${parts.slice(-2).join('\\')}`;
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}

/* ---------- theme / lite ---------- */

function resolvedTheme() {
  if (!state.settings) return 'dark';
  if (state.settings.theme === 'dark') return 'dark';
  if (state.settings.theme === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  if (els.themeGlyph) els.themeGlyph.textContent = theme === 'dark' ? '☾' : '☀';
  if (sp) sp.app.applyTheme(theme === 'dark').catch(() => {});
}

function isLite() {
  if (!state.settings) return false;
  if (state.settings.liteMode === 'on') return true;
  if (state.settings.liteMode === 'off') return false;
  return Boolean(state.meta?.lowSpec);
}

function applyLite() {
  const lite = isLite();
  document.documentElement.classList.toggle('lite', lite);
  document.documentElement.classList.toggle('reduce-motion', Boolean(state.settings?.reduceMotion));
  if (els.liteBadge) {
    els.liteBadge.hidden = !lite;
    els.liteBadge.title = lite
      ? `Lite mode is on${state.settings?.liteMode === 'auto' ? ' (matched to this PC)' : ''}`
      : '';
  }
}

/* ---------- composer ---------- */

function currentQuality() {
  if (!state.settings) return '1080';
  return state.settings.format === 'mp3' ? state.settings.mp3Quality : state.settings.mp4Quality;
}

function syncFormatUI() {
  if (!state.settings) return;
  for (const button of els.formatButtons) {
    const active = button.dataset.format === state.settings.format;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  els.qualityLabel.textContent = state.settings.format === 'mp3' ? 'Bitrate' : 'Quality';
  renderQualityChips();
}

function renderQualityChips() {
  if (!state.settings) return;
  const format = state.settings.format;
  const selected = currentQuality();
  els.qualityChips.replaceChildren();
  for (const [value, label] of QUALITY[format]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${value === selected ? ' is-active' : ''}`;
    button.dataset.quality = value;
    button.setAttribute('aria-pressed', String(value === selected));
    button.textContent = label;
    button.title = format === 'mp3' ? `${label}bps MP3` : value === 'best' ? 'Best available quality' : `${label} MP4`;
    els.qualityChips.appendChild(button);
  }
}

function updateFolderLabel() {
  if (!state.settings) return;
  const dir = state.settings.downloadDir;
  els.folderLabel.textContent = dir;
  els.folderLabel.title = dir;
  els.folderLabel.style.direction = 'rtl';
  els.settingsFolder.textContent = dir;
  els.settingsFolder.title = dir;
}

function autoSizeInput() {
  const input = els.urlInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(150, Math.max(48, input.scrollHeight))}px`;
}

function countLinks(text) {
  const matches = String(text || '').match(/(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s]+/gi);
  return matches ? matches.length : 0;
}

function updateDetected() {
  const count = countLinks(els.urlInput.value);
  els.detected.hidden = count === 0;
  if (count > 0) els.detected.textContent = `${plural(count, 'link')} detected`;
}

function setAdding(busy) {
  state.adding = busy;
  els.addBtn.disabled = busy;
  const label = els.addBtn.querySelector('span');
  if (label) label.textContent = busy ? 'Reading…' : 'Grab it';
}

async function submitUrls(text) {
  if (state.adding) return;
  const value = String(text ?? els.urlInput.value).trim();
  if (!value) {
    await pasteFromClipboard(true);
    return;
  }
  setAdding(true);
  try {
    const result = await sp.queue.add(value, {
      format: state.settings.format,
      quality: currentQuality(),
    });
    if (result.added?.length) {
      els.urlInput.value = '';
      autoSizeInput();
      updateDetected();
      els.jobList.scrollTop = 0;
      if (result.added.length > 1) {
        toast(`${plural(result.added.length, 'link')} queued`, { body: 'Reading details in the background.' });
      }
    }
    if (result.duplicates?.length) {
      toast('Already in the queue', { body: 'That video is already waiting or downloading.', type: 'warn' });
    }
    if (result.rejected?.length) {
      const first = result.rejected[0];
      toast('That link was skipped', { body: first.reason || 'Not a YouTube link.', type: 'error' });
    }
  } catch (error) {
    toast('Could not add that link', { body: String(error?.message || error), type: 'error' });
  } finally {
    setAdding(false);
    els.urlInput.focus();
  }
}

async function pasteFromClipboard(autoSubmit) {
  try {
    const text = await sp.system.clipboard();
    if (!countLinks(text)) {
      toast('No YouTube link on the clipboard', { body: 'Copy a video or playlist link first.', type: 'warn' });
      return;
    }
    const existing = els.urlInput.value.trim();
    els.urlInput.value = existing ? `${existing}\n${text.trim()}` : text.trim();
    autoSizeInput();
    updateDetected();
    els.urlInput.focus();
    if (autoSubmit) {
      await submitUrls(els.urlInput.value);
    } else {
      toast('Link pasted', { body: 'Press Enter to queue it.' });
    }
  } catch (error) {
    toast('Clipboard is unavailable', { body: String(error?.message || error), type: 'error' });
  }
}

/* ---------- queue rendering ---------- */

function jobActions(job) {
  if (job.status === 'done') {
    return '<button class="job-action primary" data-act="open">Open</button><button class="job-action" data-act="reveal">Show in folder</button>';
  }
  if (job.status === 'error' || job.status === 'canceled') {
    return '<button class="job-action primary" data-act="retry">Retry</button><button class="job-action" data-act="remove">Remove</button>';
  }
  return '';
}

function jobTools(job) {
  const button = (act, icon, label, danger) =>
    `<button type="button" class="job-tool${danger ? ' is-danger' : ''}" data-act="${act}" title="${label}" aria-label="${label}"><svg><use href="#i-${icon}"></use></svg></button>`;

  if (job.status === 'downloading') return button('pause', 'pause', 'Pause') + button('cancel', 'x', 'Cancel download', true);
  if (job.status === 'processing' || job.status === 'fetching') return button('cancel', 'x', 'Cancel', true);
  if (job.status === 'queued') return button('remove', 'x', 'Remove from queue', true);
  if (job.status === 'paused') return button('resume', 'play', 'Resume') + button('remove', 'x', 'Remove', true);
  if (job.status === 'error' || job.status === 'canceled') return button('retry', 'retry', 'Retry') + button('remove', 'x', 'Remove', true);
  if (job.status === 'done') return button('reveal', 'external', 'Show in folder') + button('remove', 'x', 'Remove from list', true);
  return '';
}

const STATUS_TEXT = {
  fetching: 'Reading link',
  queued: 'Queued',
  downloading: 'Downloading',
  processing: 'Processing',
  paused: 'Paused',
  done: 'Saved',
  error: 'Needs attention',
  canceled: 'Canceled',
};

const STATUS_CLASS = {
  error: 'is-error',
  done: 'is-done',
  processing: 'is-processing',
  paused: 'is-paused',
};

function createJobNode(job) {
  const node = document.createElement('article');
  node.className = 'job is-new';
  node.dataset.id = job.id;
  node.innerHTML = `
    <div class="job-thumb">
      <div class="thumb-fallback">MP4</div>
      <img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      <span class="job-format">MP4</span>
    </div>
    <div class="job-body">
      <div class="job-heading">
        <h3></h3>
        <div class="job-tools"></div>
      </div>
      <p class="job-sub"></p>
      <div class="job-progress"><div class="bar"><i></i></div></div>
      <div class="job-meta">
        <span class="job-state"></span>
        <span class="job-pct"></span>
        <span class="spacer"></span>
        <span class="job-speed"></span>
        <span class="job-eta"></span>
      </div>
      <div class="job-error" hidden>
        <p class="job-error-text"></p>
        <pre class="job-error-detail" hidden></pre>
        <button type="button" class="job-detail-btn" data-act="details" hidden>Details</button>
      </div>
      <div class="job-actions" hidden></div>
    </div>`;

  const img = node.querySelector('.job-thumb img');
  img.addEventListener('load', () => {
    img.classList.add('is-loaded');
    node.querySelector('.job-thumb').classList.add('has-image');
  });
  img.addEventListener('error', () => {
    node.querySelector('.job-thumb').classList.remove('has-image');
  });

  setTimeout(() => node.classList.remove('is-new'), 400);
  return node;
}

function updateJobNode(node, job, queuedIndex) {
  const previousStatus = node.dataset.status;
  node.dataset.status = job.status;
  node.classList.toggle('is-audio', job.format === 'mp3');
  node.classList.toggle('is-done', job.status === 'done');
  node.classList.toggle('is-error', job.status === 'error');

  const thumb = node.querySelector('.job-thumb');
  const img = thumb.querySelector('img');
  const fallback = thumb.querySelector('.thumb-fallback');
  const formatBadge = thumb.querySelector('.job-format');
  fallback.textContent = job.format === 'mp3' ? 'MP3' : 'MP4';
  formatBadge.textContent = (job.format || 'mp4').toUpperCase();

  if (job.thumbnail && img.getAttribute('src') !== job.thumbnail) {
    img.classList.remove('is-loaded');
    thumb.classList.remove('has-image');
    img.src = job.thumbnail;
  } else if (!job.thumbnail && img.getAttribute('src')) {
    img.removeAttribute('src');
    thumb.classList.remove('has-image');
  }

  node.querySelector('h3').textContent = job.title || 'Untitled video';

  const subParts = [];
  if (job.uploader) subParts.push(job.uploader);
  if (job.duration) subParts.push(formatDuration(job.duration));
  node.querySelector('.job-sub').textContent = subParts.join(' · ') || (job.videoId ? `youtube.com/watch?v=${job.videoId}` : 'YouTube');

  const meta = node.querySelector('.job-meta');
  meta.className = 'job-meta';
  if (STATUS_CLASS[job.status]) meta.classList.add(STATUS_CLASS[job.status]);

  let displayStatus = STATUS_TEXT[job.status] || job.status;
  if (job.status === 'queued' && queuedIndex >= 0) displayStatus = `Queued · #${queuedIndex + 1}`;
  if (job.status === 'processing' && job.stage) displayStatus = job.stage;
  node.querySelector('.job-state').textContent = displayStatus;

  const pctEl = node.querySelector('.job-pct');
  const speedEl = node.querySelector('.job-speed');
  const etaEl = node.querySelector('.job-eta');
  pctEl.textContent = '';
  speedEl.textContent = '';
  etaEl.textContent = '';

  if (job.status === 'downloading') {
    if (Number.isFinite(job.percent)) pctEl.textContent = `${Math.round(job.percent)}%`;
    if (job.speed > 0) speedEl.textContent = `${formatBytes(job.speed)}/s`;
    if (job.eta) etaEl.textContent = `ETA ${formatEta(job.eta)}`;
  } else if (job.status === 'paused') {
    if (Number.isFinite(job.percent)) pctEl.textContent = `${Math.round(job.percent)}%`;
    if (job.speed > 0) speedEl.textContent = `${formatBytes(job.speed)}/s`;
  } else if (job.status === 'done') {
    if (job.size > 0) speedEl.textContent = formatBytes(job.size);
    etaEl.textContent = `${(job.format || 'mp4').toUpperCase()}${job.quality ? ` · ${qualityLabel(job.format, job.quality)}` : ''}`;
  } else if (job.status === 'processing') {
    etaEl.textContent = 'Finishing up';
  } else if (job.status === 'queued' && job.total > 0) {
    etaEl.textContent = `~${formatBytes(job.total)}`;
  }

  const progress = node.querySelector('.job-progress .bar');
  const fill = progress.querySelector('i');
  const indeterminate = job.status === 'fetching' || job.status === 'processing' || (job.status === 'downloading' && job.percent == null);
  progress.classList.toggle('is-indeterminate', indeterminate);
  progress.classList.toggle('is-paused', job.status === 'paused');
  let percent = Number(job.percent);
  if (job.status === 'done') percent = 100;
  if (!Number.isFinite(percent)) percent = 0;
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, percent / 100))})`;

  const errorBox = node.querySelector('.job-error');
  const isError = job.status === 'error' && Boolean(job.error);
  errorBox.hidden = !isError;
  if (isError) {
    node.querySelector('.job-error-text').textContent = job.error;
    const detail = node.querySelector('.job-error-detail');
    const detailButton = node.querySelector('.job-detail-btn');
    if (job.errorDetail) {
      detail.textContent = job.errorDetail;
      detailButton.hidden = false;
    } else {
      detail.hidden = true;
      detail.textContent = '';
      detailButton.hidden = true;
    }
  }

  const toolsKey = `${job.status}`;
  const tools = node.querySelector('.job-tools');
  if (node.dataset.toolsFor !== toolsKey) {
    tools.innerHTML = jobTools(job);
    node.dataset.toolsFor = toolsKey;
  }

  const actions = node.querySelector('.job-actions');
  const actionsKey = `${job.status}`;
  if (node.dataset.actionsFor !== actionsKey) {
    actions.innerHTML = jobActions(job);
    actions.hidden = !actions.innerHTML;
    node.dataset.actionsFor = actionsKey;
  }

  if (previousStatus !== job.status && job.status === 'done') {
    node.classList.add('is-new');
    setTimeout(() => node.classList.remove('is-new'), 400);
  }
}

function qualityLabel(format, quality) {
  const entry = (QUALITY[format] || []).find(([value]) => value === String(quality));
  return entry ? entry[1] : String(quality || '');
}

function filteredJobs() {
  if (state.filter === 'active') {
    return state.jobs.filter((job) => ['fetching', 'queued', 'downloading', 'processing', 'paused'].includes(job.status));
  }
  if (state.filter === 'done') return state.jobs.filter((job) => job.status === 'done');
  return state.jobs;
}

function renderJobs() {
  const jobs = filteredJobs();
  const nodeMap = new Map($$('.job', els.jobList).map((node) => [node.dataset.id, node]));
  const ordered = [];
  const queued = state.jobs.filter((job) => job.status === 'queued');
  let empty = els.jobList.querySelector('.jobs-empty');

  for (const job of jobs) {
    let node = nodeMap.get(job.id);
    if (!node) {
      node = createJobNode(job);
      nodeMap.set(job.id, node);
    }
    const queuedIndex = job.status === 'queued' ? queued.indexOf(job) : -1;
    updateJobNode(node, job, queuedIndex);
    ordered.push(node);
  }

  for (const [id, node] of nodeMap) {
    if (!state.jobs.some((job) => job.id === id && jobs.some((visible) => visible.id === id))) {
      node.remove();
      nodeMap.delete(id);
    }
  }

  const existing = new Set($$('.job', els.jobList).map((node) => node.dataset.id));
  for (const node of ordered) {
    if (!existing.has(node.dataset.id)) els.jobList.appendChild(node);
  }
  // Keep order stable.
  for (const node of ordered) els.jobList.appendChild(node);

  if (empty) {
    empty.remove();
    empty = null;
  }
  if (jobs.length === 0 && state.jobs.length > 0) {
    const note = document.createElement('div');
    note.className = 'jobs-empty';
    note.textContent = state.filter === 'active' ? 'Nothing active right now.' : 'Nothing in this view. Try “All”.';
    els.jobList.appendChild(note);
  }

  els.emptyState.hidden = state.jobs.length !== 0;
  renderCounts();
}

function renderCounts() {
  const total = state.jobs.length;
  const active = state.jobs.filter((job) => ['fetching', 'queued', 'downloading', 'processing'].includes(job.status)).length;
  const done = state.jobs.filter((job) => job.status === 'done').length;
  const paused = state.jobs.filter((job) => job.status === 'paused').length;
  const waiting = state.jobs.filter((job) => job.status === 'queued').length;

  els.queueCount.textContent = String(total);
  if (active > 0) {
    const bits = [];
    const downloading = state.jobs.filter((job) => job.status === 'downloading').length;
    const processing = state.jobs.filter((job) => job.status === 'processing').length;
    const reading = state.jobs.filter((job) => job.status === 'fetching').length;
    if (downloading) bits.push(`${downloading} downloading`);
    if (processing) bits.push(`${processing} converting`);
    if (reading) bits.push(`${reading} reading`);
    if (waiting) bits.push(`${waiting} waiting`);
    if (paused) bits.push(`${paused} paused`);
    els.queueSummary.textContent = bits.join(' · ') || 'Working…';
  } else if (done > 0) {
    els.queueSummary.textContent = `${plural(done, 'file')} saved`;
  } else if (total > 0) {
    els.queueSummary.textContent = `${plural(total, 'file')} in the queue`;
  } else {
    els.queueSummary.textContent = 'Ready when you are.';
  }
}

function renderHistory() {
  const count = state.historyStats.count || 0;
  const size = state.historyStats.totalSize || 0;
  if (els.railFiles) els.railFiles.textContent = count ? String(count) : '0';
  if (els.railSize) els.railSize.textContent = count ? formatBytes(size) : '0 MB';
  els.historyStat.textContent = count ? `${formatBytes(size)} offline` : '';
  els.historySummary.textContent = count
    ? `${plural(count, 'file')} · ${formatBytes(size)} kept locally`
    : 'No history yet';
}

/* ---------- updates / engines ---------- */

function engineLabelText(engine) {
  if (!engine) return 'Engine —';
  if (engine.ready) return `Engine ${engine.ytdlpVersion || ''}`.trim();
  return engine.ytdlpError ? 'Engine needs attention' : 'Engine missing';
}

function renderEngine(engine) {
  state.engine = engine || state.engine;
  const info = state.engine || {};
  els.enginePill.classList.toggle('is-ready', Boolean(info.ready));
  els.enginePill.classList.toggle('is-error', !info.ready && !state.engineUpdating);
  els.enginePill.classList.toggle('is-busy', state.engineUpdating);
  els.engineLabel.textContent = state.engineUpdating
    ? `Updating engine${state.engineProgress?.percent != null ? ` · ${state.engineProgress.percent}%` : '…'}`
    : engineLabelText(info);

  els.engineVersion.textContent = info.ytdlpVersion ? `Engine ${info.ytdlpVersion}` : 'Engine —';
  if (els.railEngine) els.railEngine.textContent = info.ready ? (info.ytdlpVersion || 'Ready') : 'Needs fix';
  els.engineVersionSetting.textContent = info.ytdlpVersion ? `yt-dlp ${info.ytdlpVersion}` : 'yt-dlp missing';
  els.ffmpegVersionSetting.textContent = info.ffmpegVersion ? `ffmpeg ${info.ffmpegVersion}` : 'ffmpeg missing';
  els.engineReadyBadge.textContent = info.ready ? 'Ready' : 'Needs update';
  els.engineReadyBadge.classList.toggle('is-error', !info.ready);

  els.ffmpegLabel.textContent = info.ffmpegVersion ? `ffmpeg ${info.ffmpegVersion}` : 'Converter missing';
  const dot = els.ffmpegStatus.querySelector('.status-dot');
  dot.classList.toggle('is-error', !info.ffmpegVersion);
  dot.classList.toggle('is-warn', Boolean(info.ffmpegVersion) && !info.ytdlpVersion);

  if (!state.engineUpdating && state.engineProgress?.stage === 'done') {
    setTimeout(() => {
      els.engineProgress.hidden = true;
      state.engineProgress = null;
    }, 1400);
  }
}

function renderEngineProgress(progress) {
  state.engineProgress = progress;
  if (!progress) return;
  state.engineUpdating = progress.stage !== 'done';
  els.engineProgress.hidden = false;
  const percent = Number(progress.percent);
  if (Number.isFinite(percent) && els.engineProgressBar) {
    els.engineProgressBar.style.transform = `scaleX(${Math.max(0, Math.min(100, percent)) / 100})`;
  }
  els.engineProgressLabel.textContent = progress.label || 'Updating engine…';
  renderEngine(state.engine);
}

function updateStateText(updates) {
  switch (updates.status) {
    case 'checking': return 'Checking for updates…';
    case 'available': return `Savepoint ${updates.version || ''} is available`;
    case 'downloading': return `Downloading update · ${updates.percent || 0}%`;
    case 'ready': return `Version ${updates.version || ''} is ready`;
    case 'current': return 'You’re up to date';
    case 'error': return 'Could not check for updates';
    case 'dev': return 'Updates are off in dev builds';
    default: return 'Not checked yet';
  }
}

function renderUpdates(updates) {
  state.updates = { ...state.updates, ...(updates || {}) };
  const u = state.updates;

  els.updateStateLabel.textContent = updateStateText(u);
  els.updateStateLabel.title = u.message || '';

  const showPill = ['available', 'downloading', 'ready'].includes(u.status);
  els.updateBtn.hidden = !showPill;
  if (showPill) {
    if (u.status === 'available') els.updateBtn.textContent = `Update ${u.version || ''} · Download`;
    else if (u.status === 'downloading') els.updateBtn.textContent = `Update ${u.percent || 0}%`;
    else els.updateBtn.textContent = 'Restart to update';
  }

  const checking = u.status === 'checking';
  els.checkUpdateBtn.disabled = checking || u.status === 'downloading';
  els.checkUpdateBtn.textContent = checking ? 'Checking…' : 'Check now';

  els.updateActions.hidden = !['available', 'ready'].includes(u.status);
  els.downloadUpdateBtn.hidden = u.status !== 'available';
  els.installUpdateBtn.hidden = u.status !== 'ready';

  if (u.status === 'downloading') {
    els.updateProgress.hidden = false;
    const percent = Math.max(0, Math.min(100, Number(u.percent) || 0));
    if (els.updateProgressBar) els.updateProgressBar.style.transform = `scaleX(${percent / 100})`;
    els.updateProgressLabel.textContent = `Downloading update · ${percent}%`;
  } else {
    els.updateProgress.hidden = true;
  }

  if (u.status === 'available' && state.announcedUpdate !== u.version) {
    state.announcedUpdate = u.version;
    toast(`Savepoint ${u.version || ''} is available`, {
      body: 'Small fixes and a fresher engine. Download in the background.',
      type: 'info',
      timeout: 8000,
      action: { label: 'Download', onClick: () => sp.updates.download() },
    });
  }
  if (u.status === 'ready' && state.announcedReady !== u.version) {
    state.announcedReady = u.version;
    toast('Update ready to install', {
      body: `Version ${u.version || ''} will apply on restart.`,
      type: 'info',
      timeout: 0,
      action: { label: 'Restart now', onClick: () => sp.updates.install() },
    });
  }
}

/* ---------- settings UI ---------- */

function setSegmented(container, value) {
  if (!container) return;
  for (const button of $$('button[data-value]', container)) {
    const active = button.dataset.value === String(value);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setSwitch(button, checked) {
  if (!button) return;
  button.setAttribute('aria-checked', String(Boolean(checked)));
}

function syncSettingsUI() {
  if (!state.settings) return;
  const s = state.settings;
  els.settingsFolder.textContent = s.downloadDir;
  els.settingsFolder.title = s.downloadDir;
  setSegmented(els.settingsConcurrency, s.concurrency);
  setSegmented(els.settingsTheme, s.theme);
  setSegmented(els.settingsLite, s.liteMode);
  setSwitch(els.settingsPlaylist, s.playlist);
  setSwitch(els.settingsMotion, s.reduceMotion);
  setSwitch(els.settingsEngineAuto, s.autoUpdateEngine);
  setSwitch(els.settingsAutoUpdate, s.autoCheckUpdates);
  els.settingsCookies.value = s.cookiesBrowser;
  els.appVersionSetting.textContent = state.meta?.version || '1.0.0';
  els.aboutVersion.textContent = `v${state.meta?.version || '1.0.0'}`;
  els.versionStatus.textContent = `v${state.meta?.version || '1.0.0'}`;
  renderUpdates(state.updates);
}

function openSettings(section) {
  if (!state.settings) return;
  syncSettingsUI();
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
  if (section) {
    const heading = [...$$('.setting-group h3', els.settingsDialog)].find((h) => h.textContent.toLowerCase().includes(section));
    if (heading) heading.closest('.setting-group').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

async function updateSettings(patch) {
  try {
    const next = await sp.settings.update(patch);
    state.settings = next;
    applyTheme();
    applyLite();
    syncFormatUI();
    updateFolderLabel();
    syncSettingsUI();
  } catch (error) {
    toast('Could not save that setting', { body: String(error?.message || error), type: 'error' });
  }
}

/* ---------- palette ---------- */

function paletteCommands() {
  const s = state.settings || {};
  return [
    { id: 'paste', label: 'Paste link from clipboard', hint: 'Ctrl V', run: () => pasteFromClipboard(false) },
    { id: 'folder', label: 'Choose download folder', hint: '', run: chooseFolder },
    { id: 'mp4', label: 'Switch to MP4 video', hint: s.format === 'mp4' ? 'Active' : '', run: () => updateSettings({ format: 'mp4' }).then(syncFormatUI) },
    { id: 'mp3', label: 'Switch to MP3 audio', hint: s.format === 'mp3' ? 'Active' : '', run: () => updateSettings({ format: 'mp3' }).then(syncFormatUI) },
    { id: 'theme', label: 'Toggle dark / light theme', hint: '', run: toggleTheme },
    { id: 'lite', label: 'Toggle lite mode', hint: isLite() ? 'On' : 'Off', run: () => updateSettings({ liteMode: isLite() ? 'off' : 'on' }) },
    { id: 'open', label: 'Open downloads folder', hint: '', run: openFolder },
    { id: 'clear', label: 'Clear finished downloads', hint: '', run: clearFinished },
    { id: 'updates', label: 'Check for app updates', hint: '', run: checkUpdates },
    { id: 'engine', label: 'Update downloader engine', hint: '', run: () => updateEngine(false) },
    { id: 'settings', label: 'Open settings', hint: '', run: () => openSettings() },
  ];
}

function renderPalette() {
  const query = els.paletteInput.value.trim().toLowerCase();
  const commands = paletteCommands().filter((command) => command.label.toLowerCase().includes(query));
  state.paletteCommands = commands;
  if (state.paletteIndex >= commands.length) state.paletteIndex = 0;
  els.paletteList.replaceChildren();

  if (!commands.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'No command matches that.';
    els.paletteList.appendChild(empty);
    return;
  }

  commands.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `palette-item${index === state.paletteIndex ? ' is-selected' : ''}`;
    button.dataset.index = String(index);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = command.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = command.hint;
    button.append(label, hint);
    button.addEventListener('click', () => runPaletteCommand(command));
    button.addEventListener('mousemove', () => {
      if (state.paletteIndex === index) return;
      state.paletteIndex = index;
      for (const item of $$('.palette-item', els.paletteList)) item.classList.remove('is-selected');
      button.classList.add('is-selected');
    });
    els.paletteList.appendChild(button);
  });
}

function openPalette() {
  els.palette.hidden = false;
  els.paletteInput.value = '';
  state.paletteIndex = 0;
  renderPalette();
  setTimeout(() => els.paletteInput.focus(), 10);
}

function closePalette() {
  els.palette.hidden = true;
  if (els.paletteBtn) els.paletteBtn.focus();
}

function runPaletteCommand(command) {
  closePalette();
  try { command.run(); } catch (error) { toast('Command failed', { body: String(error?.message || error), type: 'error' }); }
}

/* ---------- toasts ---------- */

function toast(title, options = {}) {
  if (!els.toasts) return;
  while (els.toasts.children.length >= 3) els.toasts.firstElementChild?.remove();
  const node = document.createElement('div');
  node.className = `toast${options.type ? ` is-${options.type}` : ''}`;

  const body = document.createElement('div');
  body.className = 'toast-body';
  const strong = document.createElement('strong');
  strong.textContent = title;
  body.appendChild(strong);
  if (options.body) {
    const span = document.createElement('span');
    span.textContent = options.body;
    body.appendChild(span);
  }
  if (options.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.action.label;
    action.addEventListener('click', () => {
      try { options.action.onClick(); } finally { node.remove(); }
    });
    body.appendChild(action);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '<svg><use href="#i-x"></use></svg>';
  close.addEventListener('click', () => node.remove());

  node.append(body, close);
  els.toasts.appendChild(node);

  const timeout = options.timeout ?? 4600;
  if (timeout > 0) setTimeout(() => { if (node.isConnected) node.remove(); }, timeout);
}

/* ---------- actions ---------- */

async function chooseFolder() {
  try {
    const folder = await sp.dialog.chooseFolder();
    if (!folder) return;
    await updateSettings({ downloadDir: folder });
    toast('Download folder updated', { body: folder });
  } catch (error) {
    toast('Could not open the folder picker', { body: String(error?.message || error), type: 'error' });
  }
}

async function openFolder() {
  const result = await sp.system.openFolder();
  if (result && result.ok === false) toast('Could not open the folder', { body: result.error, type: 'error' });
}

function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  updateSettings({ theme: next });
}

async function clearFinished() {
  const count = state.jobs.filter((job) => job.status === 'done' || job.status === 'canceled').length;
  if (!count) {
    toast('Nothing finished to clear', { type: 'warn' });
    return;
  }
  await sp.queue.clearFinished();
  toast(`${plural(count, 'item')} cleared from the queue`);
}

async function checkUpdates() {
  const result = await sp.updates.check();
  if (result?.reason === 'dev') toast('Dev build', { body: 'Auto-updates are disabled while developing.' });
}

async function updateEngine(force) {
  if (state.engineUpdating) return;
  state.engineUpdating = true;
  renderEngine(state.engine);
  els.engineUpdateBtn.disabled = true;
  els.engineProgress.hidden = false;
  els.engineProgressLabel.textContent = 'Starting engine update…';
  if (els.engineProgressBar) els.engineProgressBar.style.transform = 'scaleX(0)';
  try {
    const result = await sp.engine.update({ force: Boolean(force) });
    if (result.ok) {
      if (result.info) renderEngine(result.info);
      else renderEngine(await sp.engine.info());
      toast(result.updated ? 'Engines updated' : 'Engines are current', {
        body: result.version ? `yt-dlp ${result.version}` : '',
      });
      renderEngineProgress({ stage: 'done', percent: 100, label: 'Engines ready' });
    } else if (result.busy) {
      toast('Finish the queue first', { body: result.error, type: 'warn' });
      els.engineProgress.hidden = true;
    } else {
      toast('Engine update failed', { body: result.error || 'Check your connection and try again.', type: 'error', timeout: 7000 });
      els.engineProgress.hidden = true;
    }
  } catch (error) {
    toast('Engine update failed', { body: String(error?.message || error), type: 'error' });
    els.engineProgress.hidden = true;
  } finally {
    state.engineUpdating = false;
    els.engineUpdateBtn.disabled = false;
    renderEngine(state.engine);
  }
}

function openJob(job) {
  if (!job.outputPath) {
    toast('This file is not on disk anymore', { body: 'It may have been moved or deleted.', type: 'warn' });
    return;
  }
  sp.system.openPath(job.outputPath).then((result) => {
    if (result && result.ok === false) toast('Could not open the file', { body: result.error, type: 'error' });
  });
}

async function handleQueueAction(act, id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  if (act === 'open') return openJob(job);
  if (act === 'reveal') {
    const ok = await sp.system.showItem(job.outputPath);
    if (!ok) toast('That file is not on disk anymore', { type: 'warn' });
    return;
  }
  if (act === 'pause') { await sp.queue.pause(id); return; }
  if (act === 'resume') { await sp.queue.resume(id); return; }
  if (act === 'cancel') { await sp.queue.cancel(id); return; }
  if (act === 'retry') { await sp.queue.retry(id); return; }
  if (act === 'remove') { await sp.queue.remove(id); return; }
}

/* ---------- wiring ---------- */

function bindEvents() {
  els.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitUrls();
  });

  els.urlInput.addEventListener('input', () => {
    autoSizeInput();
    updateDetected();
  });
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitUrls();
    }
  });

  for (const button of els.formatButtons) {
    button.addEventListener('click', async () => {
      if (state.settings.format === button.dataset.format) return;
      state.settings.format = button.dataset.format;
      syncFormatUI();
      await updateSettings({ format: button.dataset.format });
    });
  }

  els.qualityChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const value = chip.dataset.quality;
    const key = state.settings.format === 'mp3' ? 'mp3Quality' : 'mp4Quality';
    state.settings[key] = value;
    renderQualityChips();
    updateSettings({ [key]: value });
  });

  els.folderBtn.addEventListener('click', chooseFolder);
  els.openFolderBtn.addEventListener('click', openFolder);
  els.settingsFolder.addEventListener('click', chooseFolder);

  els.settingsBtn.addEventListener('click', () => openSettings());
  els.enginePill.addEventListener('click', () => openSettings('engines'));
  els.closeSettingsBtn.addEventListener('click', () => els.settingsDialog.close());
  els.settingsDialog.addEventListener('click', (event) => {
    if (event.target === els.settingsDialog) els.settingsDialog.close();
  });

  els.themeBtn.addEventListener('click', toggleTheme);
  els.paletteBtn.addEventListener('click', openPalette);

  els.filters.forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      for (const item of els.filters) item.classList.toggle('is-active', item === button);
      renderJobs();
    });
  });

  els.clearBtn.addEventListener('click', clearFinished);
  els.pasteBtn.addEventListener('click', () => pasteFromClipboard(true));

  els.jobList.addEventListener('click', async (event) => {
    const detail = event.target.closest('[data-act="details"]');
    if (detail) {
      const card = detail.closest('.job');
      const pre = card.querySelector('.job-error-detail');
      pre.hidden = !pre.hidden;
      detail.textContent = pre.hidden ? 'Details' : 'Hide details';
      return;
    }
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const card = button.closest('.job');
    if (!card) return;
    await handleQueueAction(button.dataset.act, card.dataset.id);
  });

  // settings segmented controls
  bindSegmented(els.settingsConcurrency, (value) => updateSettings({ concurrency: Number(value) }));
  bindSegmented(els.settingsTheme, (value) => updateSettings({ theme: value }));
  bindSegmented(els.settingsLite, (value) => updateSettings({ liteMode: value }));

  bindSwitch(els.settingsPlaylist, 'playlist');
  bindSwitch(els.settingsMotion, 'reduceMotion');
  bindSwitch(els.settingsEngineAuto, 'autoUpdateEngine');
  bindSwitch(els.settingsAutoUpdate, 'autoCheckUpdates');

  els.settingsCookies.addEventListener('change', () => updateSettings({ cookiesBrowser: els.settingsCookies.value }));

  els.engineUpdateBtn.addEventListener('click', () => updateEngine(false));
  els.checkUpdateBtn.addEventListener('click', checkUpdates);
  els.downloadUpdateBtn.addEventListener('click', () => sp.updates.download());
  els.installUpdateBtn.addEventListener('click', () => sp.updates.install());
  els.updateBtn.addEventListener('click', () => {
    const status = state.updates.status;
    if (status === 'available') sp.updates.download();
    else if (status === 'ready') sp.updates.install();
    else if (status === 'downloading') openSettings('updates');
  });

  els.clearHistoryBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear the list of saved files? The files themselves stay on disk.')) return;
    await sp.history.clear();
    state.historyStats = { count: 0, totalSize: 0 };
    state.history = [];
    renderHistory();
    toast('History cleared');
  });

  els.landingLink.addEventListener('click', () => sp.system.openExternal(LINKS.landing));
  els.githubLink.addEventListener('click', () => sp.system.openExternal(LINKS.github));

  els.finishOnboarding.addEventListener('click', async () => {
    els.onboarding.hidden = true;
    state.wizardShown = true;
    await updateSettings({ onboarded: true });
    els.urlInput.focus();
  });

  els.paletteInput.addEventListener('input', () => {
    state.paletteIndex = 0;
    renderPalette();
  });
  els.paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.paletteIndex = Math.min(state.paletteCommands.length - 1, state.paletteIndex + 1);
      renderPalette();
      $$('.palette-item', els.paletteList)[state.paletteIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.paletteIndex = Math.max(0, state.paletteIndex - 1);
      renderPalette();
      $$('.palette-item', els.paletteList)[state.paletteIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = state.paletteCommands[state.paletteIndex];
      if (command) runPaletteCommand(command);
    }
  });
  for (const closer of $$('[data-close-palette]')) closer.addEventListener('click', closePalette);

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (els.palette.hidden) openPalette();
      else closePalette();
      return;
    }
    if (event.key === 'Escape') {
      if (!els.palette.hidden) closePalette();
      return;
    }
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.matches('input, textarea, select, [contenteditable="true"]'));
    if (mod && event.key.toLowerCase() === 'v' && !editing) {
      event.preventDefault();
      pasteFromClipboard(false);
    }
  });

  // drag + drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const text = transfer.getData('text/uri-list') || transfer.getData('text/plain') || '';
    if (countLinks(text)) {
      els.urlInput.value = text.trim();
      autoSizeInput();
      updateDetected();
      await submitUrls(text);
      return;
    }
    if (transfer.files && transfer.files.length) {
      toast('Drop a link, not a file', { body: 'Savepoint downloads from URLs. Paste a YouTube link instead.', type: 'warn' });
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings?.theme === 'system') applyTheme();
  });

  // main-process events
  sp.queue.onJobs((jobs) => {
    state.jobs = Array.isArray(jobs) ? jobs : [];
    renderJobs();
  });
  sp.queue.onCompleted((job) => {
    toast('Saved to your folder', {
      body: job.title ? job.title.slice(0, 110) : 'Your file is ready.',
      action: job.outputPath ? { label: 'Show in folder', onClick: () => sp.system.showItem(job.outputPath) } : null,
      timeout: 6000,
    });
  });
  sp.queue.onIdle(() => {
    renderCounts();
  });
  sp.history.onUpdated((payload) => {
    state.history = payload.items || [];
    state.historyStats = payload.stats || { count: state.history.length, totalSize: 0 };
    renderHistory();
  });
  sp.settings.onChange((next) => {
    state.settings = next;
    applyTheme();
    applyLite();
    syncFormatUI();
    updateFolderLabel();
    syncSettingsUI();
  });
  sp.engine.onProgress(renderEngineProgress);
  sp.engine.onChanged((engine) => {
    renderEngine(engine);
    state.engineUpdating = false;
    els.engineUpdateBtn.disabled = false;
  });
  sp.updates.onEvent((updates) => renderUpdates(updates));
  sp.app.onExternalUrl((url) => {
    els.urlInput.value = url;
    autoSizeInput();
    updateDetected();
    els.urlInput.focus();
    toast('Link received', { body: 'Press Enter to queue it.' });
  });
  sp.app.onSystemTheme(() => {
    if (state.settings?.theme === 'system') applyTheme();
  });
}

function bindSegmented(container, onSelect) {
  if (!container) return;
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    for (const item of $$('button[data-value]', container)) item.classList.toggle('is-active', item === button);
    onSelect(button.dataset.value);
  });
}

function bindSwitch(button, key) {
  if (!button) return;
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    updateSettings({ [key]: next });
  });
}

/* ---------- bootstrap ---------- */

async function init() {
  cacheElements();
  if (!sp) {
    document.body.classList.remove('booting');
    els.engineLabel.textContent = 'Desktop app required';
    els.addBtn.disabled = true;
    return;
  }

  bindEvents();

  let info;
  try {
    info = await sp.app.info();
  } catch (error) {
    document.body.classList.remove('booting');
    toast('Savepoint had trouble starting', { body: String(error?.message || error), type: 'error', timeout: 0 });
    return;
  }

  if (info.links) {
    LINKS.landing = info.links.landing || LINKS.landing;
    LINKS.github = info.links.github || LINKS.github;
  }
  state.meta = info;
  state.settings = info.settings;
  state.engine = info.engine;
  state.updates = info.updates || { status: 'idle' };
  state.history = info.history || [];
  state.historyStats = info.historyStats || { count: 0, totalSize: 0 };

  document.documentElement.classList.toggle('is-win', info.platform === 'win32');
  applyTheme();
  applyLite();
  syncFormatUI();
  updateFolderLabel();
  updateDetected();
  syncSettingsUI();
  renderEngine(info.engine);
  renderUpdates(info.updates || { status: 'idle' });
  renderHistory();
  renderCounts();
  autoSizeInput();
  els.emptyState.hidden = false;

  if (!info.settings.onboarded && !state.wizardShown) {
    state.wizardShown = true;
    els.onboarding.hidden = false;
  }

  document.body.classList.remove('booting');

  sp.system.storage().then((storage) => {
    if (storage?.ok) {
      els.folderBtn.title = `${info.settings.downloadDir} · ${formatBytes(storage.free)} free`;
      els.settingsFolder.title = `${info.settings.downloadDir} · ${formatBytes(storage.free)} free`;
    }
  }).catch(() => {});

  if (!info.engine?.ready) {
    setTimeout(() => {
      if (!state.engine?.ready) {
        toast('Engines need a quick update', {
          body: 'The downloader or converter is missing. Savepoint can fetch it for you.',
          type: 'warn',
          timeout: 9000,
          action: { label: 'Update now', onClick: () => updateEngine(true) },
        });
      }
    }, 1800);
  }

  if (state.updates.status === 'available' || state.updates.status === 'ready') {
    renderUpdates(state.updates);
  }

  setTimeout(() => els.urlInput.focus(), 350);
  window.__savepointReady = true;
}

/* ---------- deterministic demo state (used for store screenshots) ---------- */

window.__savepointDemo = (theme = 'dark') => {
  if (!state.settings) return;
  document.documentElement.classList.add('capture-mode');
  document.getElementById('onboarding').hidden = true;
  state.settings = {
    ...state.settings,
    onboarded: true,
    theme,
    liteMode: 'off',
    format: 'mp4',
    mp4Quality: '1080',
    mp3Quality: '192',
    downloadDir: 'C:\\Users\\OJ\\Downloads\\Savepoint',
  };
  state.meta = { ...(state.meta || {}), version: '1.0.0', lowSpec: false };
  state.engine = { ready: true, ytdlpVersion: '2026.10.26', ffmpegVersion: '6.0', ytdlpPath: '', ffmpegPath: '' };
  state.updates = { status: 'current' };
  state.filter = 'all';
  const now = Date.now();
  state.jobs = [
    {
      id: 'demo-1', url: '', title: 'The quiet craft of building a mechanical keyboard',
      thumbnail: './assets/demo/keyboard.jpg', duration: 1284,
      uploader: 'Maker Notes', format: 'mp4', quality: '1080', status: 'downloading',
      percent: 63.4, speed: 5800000, eta: 42, downloaded: 136000000, total: 214000000,
      size: 0, stage: 'Downloading', outputPath: '', error: '', errorDetail: '',
      createdAt: now - 60000, startedAt: now - 52000, finishedAt: null, videoId: 'demo1',
    },
    {
      id: 'demo-2', url: '', title: 'Lofi beats to compile code to — 3 hour mix',
      thumbnail: './assets/demo/code.jpg', duration: 10800,
      uploader: 'chill.exe', format: 'mp3', quality: '192', status: 'processing',
      percent: 100, speed: 0, eta: null, downloaded: 96000000, total: 96000000,
      size: 0, stage: 'Converting to MP3', outputPath: '', error: '', errorDetail: '',
      createdAt: now - 240000, startedAt: now - 230000, finishedAt: null, videoId: 'demo2',
    },
    {
      id: 'demo-3', url: '', title: 'A studio tour of a 12 m² cabin in the woods',
      thumbnail: './assets/demo/cabin.jpg', duration: 612,
      uploader: 'Small Spaces', format: 'mp4', quality: '1080', status: 'queued',
      percent: 0, speed: 0, eta: null, downloaded: 0, total: 88000000,
      size: 0, stage: 'Queued', outputPath: '', error: '', errorDetail: '',
      createdAt: now - 30000, startedAt: null, finishedAt: null, videoId: 'demo3',
    },
    {
      id: 'demo-4', url: '', title: 'Big Buck Bunny — remastered in 4K',
      thumbnail: './assets/demo/forest.jpg', duration: 596,
      uploader: 'Blender Foundation', format: 'mp4', quality: '2160', status: 'done',
      percent: 100, speed: 0, eta: 0, downloaded: 0, total: 0,
      size: 231000000, stage: 'Saved', outputPath: 'C:\\Users\\OJ\\Downloads\\Savepoint\\Big Buck Bunny [aqz-KE-bpKQ].mp4',
      error: '', errorDetail: '', createdAt: now - 900000, startedAt: now - 890000,
      finishedAt: now - 720000, videoId: 'aqz-KE-bpKQ',
    },
    {
      id: 'demo-5', url: '', title: 'Rain on a tin roof · 45 minutes of calm',
      thumbnail: './assets/demo/rain.jpg', duration: 2700,
      uploader: 'Field Recordings', format: 'mp3', quality: '320', status: 'done',
      percent: 100, speed: 0, eta: 0, downloaded: 0, total: 0,
      size: 62000000, stage: 'Saved', outputPath: 'C:\\Users\\OJ\\Downloads\\Savepoint\\Rain on a tin roof [rain45].mp3',
      error: '', errorDetail: '', createdAt: now - 1800000, startedAt: now - 1790000,
      finishedAt: now - 1740000, videoId: 'rain45',
    },
  ];
  state.history = state.jobs.filter((job) => job.status === 'done');
  state.historyStats = { count: 18, totalSize: 3_400_000_000 };
  document.documentElement.dataset.theme = theme;
  if (sp) sp.app.applyTheme(theme === 'dark').catch(() => {});
  if (els.themeGlyph) els.themeGlyph.textContent = theme === 'dark' ? '☾' : '☀';
  applyLite();
  syncFormatUI();
  updateFolderLabel();
  renderEngine(state.engine);
  renderHistory();
  renderJobs();
  syncSettingsUI();
  document.getElementById('emptyState').hidden = true;
  document.getElementById('urlInput').value = '';
  window.__savepointReady = true;
};

init().catch((error) => {
  console.error(error);
  document.body.classList.remove('booting');
  try {
    toast('Something went wrong', { body: String(error?.message || error), type: 'error', timeout: 0 });
  } catch {
    // noop
  }
});
