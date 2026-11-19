'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard,
  nativeTheme, Notification, screen,
} = require('electron');
const log = require('electron-log/main');

const { createSettingsStore } = require('./settings');
const { createHistoryStore } = require('./history');
const { ensureRuntimeBinaries, getEngineInfo, updateEngine, ffmpegPath } = require('./binaries');
const { createDownloadManager, isYouTubeUrl } = require('./downloads');
const { createUpdateService } = require('./updates');
const { getLinks } = require('./links');

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? 'warn' : 'info';

const isDev = !app.isPackaged;
if (process.env.SAVEPOINT_CAPTURE === '1') {
  // Software compositing keeps capturePage deterministic on Windows.
  app.disableHardwareAcceleration();
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

let mainWindow = null;
let settings = null;
let history = null;
let manager = null;
let updateService = null;
let isQuitting = false;
let engineBootstrapStarted = false;

function liteRecommended() {
  try {
    return os.cpus().length <= 4 || os.totalmem() / 1024 ** 3 <= 8;
  } catch {
    return false;
  }
}

function resolveThemeIsDark() {
  if (!settings) return true;
  const theme = settings.get().theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function applyTitlebarTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (process.platform === 'win32' && typeof mainWindow.setTitleBarOverlay === 'function') {
      const dark = resolveThemeIsDark();
      mainWindow.setTitleBarOverlay({
        color: dark ? '#080a07' : '#f4f2ea',
        symbolColor: dark ? '#d9f99d' : '#1b1d16',
        height: 46,
      });
    }
  } catch {
    // Title bar overlays are not available on every platform/window state.
  }
}

function isTrustedSender(event) {
  try {
    return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
  } catch {
    return false;
  }
}

function registerIpc() {
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted sender');
      return handler(...args);
    });
  };

  handle('app:info', async () => {
    const engine = await getEngineInfo();
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
      settings: settings.get(),
      engine,
      history: history.list(),
      historyStats: history.stats(),
      lowSpec: liteRecommended(),
      updates: updateService ? updateService.getState() : { status: 'idle' },
      links: getLinks(),
    };
  });

  handle('settings:get', () => settings.get());

  handle('settings:update', (patch) => {
    const allowed = [
      'downloadDir', 'format', 'mp4Quality', 'mp3Quality', 'concurrency', 'theme', 'liteMode',
      'reduceMotion', 'playlist', 'embedMetadata', 'embedThumbnail', 'filenameTemplate',
      'cookiesBrowser', 'autoCheckUpdates', 'autoUpdateEngine', 'notifications', 'onboarded',
    ];
    const safe = {};
    if (patch && typeof patch === 'object') {
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) safe[key] = patch[key];
      }
    }
    const before = settings.get();
    const next = settings.update(safe);
    if (next.downloadDir !== before.downloadDir) settings.ensureDownloadDir();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:changed', next);
    }
    applyTitlebarTheme();
    if (manager) manager.pump();
    if (updateService && next.autoCheckUpdates && !before.autoCheckUpdates) updateService.start();
    return next;
  });

  handle('dialog:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where Savepoint keeps your files',
      defaultPath: settings.get().downloadDir,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return result.filePaths[0];
  });

  handle('queue:add', (text, overrides) => {
    if (!manager) return { added: [], rejected: [], duplicates: [] };
    const safe = {};
    if (overrides && typeof overrides === 'object') {
      if (overrides.format === 'mp4' || overrides.format === 'mp3') safe.format = overrides.format;
      if (typeof overrides.quality === 'string') safe.quality = overrides.quality;
    }
    return manager.add(typeof text === 'string' ? text.slice(0, 50000) : '', safe);
  });

  handle('queue:action', (action, id, payload) => {
    if (!manager) return false;
    switch (action) {
      case 'pause': return manager.pause(String(id || ''));
      case 'resume': return manager.resume(String(id || ''));
      case 'cancel': return manager.cancel(String(id || ''));
      case 'retry': return manager.retry(String(id || ''));
      case 'remove': return manager.remove(String(id || ''));
      case 'clearFinished': return manager.clearFinished();
      case 'setFormat':
        return manager.setFormat(String(id || ''), payload?.format, payload?.quality);
      default: return false;
    }
  });

  handle('system:openFolder', async () => {
    const dir = settings.get().downloadDir;
    settings.ensureDownloadDir();
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  });

  handle('system:openPath', async (target) => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return { ok: false, error: 'Invalid path' };
    try {
      if (!fs.existsSync(target)) return { ok: false, error: 'That file is no longer there.' };
      const error = await shell.openPath(target);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  handle('system:showItem', (target) => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
    try {
      if (!fs.existsSync(target)) return false;
      shell.showItemInFolder(target);
      return true;
    } catch {
      return false;
    }
  });

  handle('system:clipboard', () => {
    try { return clipboard.readText(); } catch { return ''; }
  });

  handle('system:openExternal', async (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });

  handle('system:storage', async () => {
    const dir = settings.get().downloadDir;
    try {
      const stats = await fs.promises.statfs(dir);
      const bsize = Number(stats.bsize) || 0;
      return {
        ok: true,
        free: Number(stats.bavail) * bsize,
        total: Number(stats.blocks) * bsize,
        path: dir,
      };
    } catch {
      return { ok: false, free: 0, total: 0, path: dir };
    }
  });

  handle('engine:info', () => getEngineInfo({ refresh: true }));

  handle('engine:update', async (options) => {
    const busy = manager.list().some((job) => ['queued', 'fetching', 'downloading', 'processing', 'paused'].includes(job.status));
    if (busy) {
      return { ok: false, busy: true, error: 'Finish or clear the queue before updating the engine.' };
    }
    const result = await updateEngine(
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:progress', progress);
      },
      { force: Boolean(options?.force) },
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:changed', await getEngineInfo({ refresh: true }));
    }
    return result;
  });

  handle('history:clear', () => {
    if (!history) return false;
    history.clear();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history:updated', { items: history.list(), stats: history.stats() });
    }
    return true;
  });

  handle('updates:check', () => updateService.check({ manual: true }));
  handle('updates:download', () => updateService.download());
  handle('updates:install', () => updateService.install());
  handle('updates:state', () => updateService.getState());

  handle('theme:apply', (dark) => {
    if (!settings) return false;
    try {
      nativeTheme.themeSource = settings.get().theme === 'system' ? 'system' : dark ? 'dark' : 'light';
    } catch {
      // noop
    }
    applyTitlebarTheme();
    return true;
  });

  handle('window:isMaximized', () => Boolean(mainWindow?.isMaximized()));
}

function wireManager() {
  manager.on('jobs', (jobs) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('queue:jobs', jobs);
  });

  manager.on('completed', (job) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue:completed', job);
      mainWindow.webContents.send('history:updated', { items: history.list(), stats: history.stats() });
    }
    try {
      if (settings.get().notifications && Notification.isSupported() && (!mainWindow || !mainWindow.isFocused())) {
        const notification = new Notification({
          title: 'Saved',
          body: job.title ? job.title.slice(0, 120) : 'Your file is ready.',
          silent: false,
        });
        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        });
        notification.show();
      }
    } catch {
      // Notifications are best effort.
    }
  });

  manager.on('idle', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('queue:idle', payload);
  });
}

function createWindow() {
  const bounds = settings.get().window;
  const defaults = { width: 1180, height: 800 };
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width || defaults.width;
  let height = bounds.height || defaults.height;

  if (x != null && y != null) {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x >= area.x - 80 && y >= area.y - 40 && x < area.x + area.width - 120 && y < area.y + area.height - 80;
    });
    if (!visible) { x = null; y = null; }
  }

  const captureMode = process.env.SAVEPOINT_CAPTURE === '1';
  mainWindow = new BrowserWindow({
    width: captureMode ? 1360 : width,
    height: captureMode ? 860 : height,
    x: x ?? undefined,
    y: y ?? undefined,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#080a07',
    title: 'Savepoint',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#080a07', symbolColor: '#d9f99d', height: 46 }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !captureMode,
      devTools: isDev,
    },
  });

  applyTitlebarTheme();
  Menu.setApplicationMenu(null);

  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (bounds.maximized && !captureMode) mainWindow.maximize();
    mainWindow.show();
    if (isDev && process.argv.includes('--devtools')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  setupCapture();

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    const active = manager.list().some((job) => ['downloading', 'processing', 'fetching'].includes(job.status));
    if (active) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        title: 'Downloads are still running',
        message: 'Savepoint is still working on your files.',
        detail: 'Quitting now will pause the current download. Partial files can be resumed next time.',
        buttons: ['Keep downloading', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
    }
    try {
      const normal = mainWindow.getNormalBounds();
      settings.update({ window: { ...normal, maximized: mainWindow.isMaximized() } });
    } catch {
      // noop
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('maximize', () => {
    if (mainWindow) mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) mainWindow.webContents.send('window:maximized', false);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setupCapture() {
  if (process.env.SAVEPOINT_CAPTURE !== '1' || !mainWindow) return;
  const outDir = process.env.SAVEPOINT_CAPTURE_DIR || path.join(app.getAppPath(), 'landing', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  mainWindow.webContents.once('did-finish-load', async () => {
    const waitForPaint = async (ms = 500) => {
      mainWindow.webContents.invalidate();
      await wait(ms);
    };
    const waitForImages = async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const done = await mainWindow.webContents.executeJavaScript(`(() => {
          const images = [...document.querySelectorAll('.job-thumb img')];
          return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
        })()`);
        if (done) return true;
        await wait(150);
      }
      return false;
    };
    const captureTo = async (name) => {
      await waitForPaint(600);
      await mainWindow.webContents.capturePage();
      await wait(150);
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, name), image.toPNG());
    };
    const fitToContent = async () => {
      const metrics = await mainWindow.webContents.executeJavaScript(`(() => ({
        scroll: document.documentElement.scrollHeight,
        inner: window.innerHeight,
        width: window.innerWidth,
      }))()`);
      const [width, height] = mainWindow.getContentSize();
      log.info('Capture metrics', metrics, width, height);
      if (metrics.scroll > metrics.inner + 4) {
        const target = Math.min(metrics.scroll, 1040);
        mainWindow.setContentSize(width, target);
        await wait(700);
        log.info('Capture resized to', width, target);
      }
    };

    try {
      let ready = false;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        ready = await mainWindow.webContents.executeJavaScript('Boolean(window.__savepointReady)');
        if (ready) break;
        await wait(250);
      }
      if (!ready) throw new Error('Renderer never signalled readiness');

      mainWindow.show();
      mainWindow.focus();

      await mainWindow.webContents.executeJavaScript("window.__savepointDemo('dark')");
      await wait(700);
      const imagesReady = await waitForImages();
      log.info('Capture images ready', imagesReady);
      await fitToContent();
      const jobCount = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('.job').length");
      log.info('Capture job nodes', jobCount);
      await captureTo('app-dark.png');

      await mainWindow.webContents.executeJavaScript("window.__savepointDemo('light')");
      await wait(900);
      await captureTo('app-light.png');
      log.info('Capture screenshots written to', outDir);
    } catch (error) {
      log.error('Capture failed', error);
    } finally {
      app.quit();
    }
  });
}

function startEngineBootstrap() {
  if (engineBootstrapStarted) return;
  engineBootstrapStarted = true;
  setTimeout(async () => {
    try {
      const info = await getEngineInfo({ refresh: true });
      if (!info.ready && settings.get().autoUpdateEngine) {
        log.info('Engine not ready on launch, attempting bootstrap update');
        await updateEngine(
          (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:progress', progress);
          },
          { force: true },
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine:changed', await getEngineInfo({ refresh: true }));
        }
      }
    } catch (error) {
      log.warn('Engine bootstrap failed', error);
    }
  }, 1500);
}

function bootstrap() {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const candidate = (argv || []).find((arg) => typeof arg === 'string' && isYouTubeUrl(arg));
    if (candidate && mainWindow) mainWindow.webContents.send('app:external-url', candidate);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (manager) manager.stopAll();
    if (updateService) updateService.stop();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && settings) createWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.savepoint.app');
    settings = createSettingsStore();
    history = createHistoryStore();
    ensureRuntimeBinaries();

    const defaultSession = require('electron').session.defaultSession;
    defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    defaultSession.setPermissionCheckHandler(() => false);

    updateService = createUpdateService({
      enabled: settings.get().autoCheckUpdates,
      onEvent: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:event', state);
      },
    });

    manager = createDownloadManager({
      settings,
      history,
      userDataDir: app.getPath('userData'),
    });

    registerIpc();
    wireManager();
    createWindow();
    startEngineBootstrap();
    if (settings.get().autoCheckUpdates) updateService.start();

    nativeTheme.on('updated', () => {
      if (settings.get().theme === 'system') {
        applyTitlebarTheme();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
      }
    });

    log.info('Savepoint ready', {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      ffmpeg: ffmpegPath(),
      lowSpec: liteRecommended(),
    });
  }).catch((error) => {
    log.error('Failed to start', error);
    dialog.showErrorBox('Savepoint could not start', String(error?.stack || error));
    app.quit();
  });
}
