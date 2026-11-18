'use strict';

const { app } = require('electron');
const log = require('electron-log/main');

let updater = null;
let lastState = { status: 'idle' };
let checkTimer = null;
let wired = false;

function publicState(extra = {}) {
  return { ...lastState, ...extra };
}

function createUpdateService({ onEvent, enabled = true }) {
  const isDev = !app.isPackaged;
  let manualCheck = false;

  function send(state) {
    lastState = { ...lastState, ...state, updatedAt: Date.now() };
    try { onEvent(publicState()); } catch { /* window may be gone */ }
  }

  function wire() {
    if (wired || isDev) return;
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (error) {
      log.warn('Auto-updater unavailable', error);
      return;
    }
    wired = true;
    updater.logger = log;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;

    updater.on('checking-for-update', () => send({ status: 'checking' }));
    updater.on('update-available', (info) => {
      send({
        status: 'available',
        version: info?.version || null,
        releaseDate: info?.releaseDate || null,
        notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : '',
      });
      if (manualCheck) send({ status: 'available', manual: true });
    });
    updater.on('update-not-available', (info) => {
      send({ status: 'current', version: info?.version || app.getVersion(), manual: manualCheck });
      manualCheck = false;
    });
    updater.on('download-progress', (progress) => {
      send({
        status: 'downloading',
        percent: Math.round(progress.percent || 0),
        transferred: progress.transferred || 0,
        total: progress.total || 0,
        bytesPerSecond: progress.bytesPerSecond || 0,
      });
    });
    updater.on('update-downloaded', (info) => {
      send({ status: 'ready', version: info?.version || null });
    });
    updater.on('error', (error) => {
      log.warn('Update check failed', error?.message || error);
      send({ status: 'error', message: String(error?.message || error).slice(0, 300), manual: manualCheck });
      manualCheck = false;
    });
  }

  async function check(options = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (isDev) {
      send({ status: 'dev', message: 'Updates are disabled in development builds.' });
      return { ok: false, reason: 'dev' };
    }
    wire();
    if (!updater) return { ok: false, reason: 'unavailable' };
    manualCheck = Boolean(options.manual);
    try {
      await updater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      send({ status: 'error', message: String(error?.message || error).slice(0, 300), manual: manualCheck });
      manualCheck = false;
      return { ok: false, reason: 'error' };
    }
  }

  async function download() {
    wire();
    if (!updater) return { ok: false };
    try {
      await updater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      send({ status: 'error', message: String(error?.message || error).slice(0, 300) });
      return { ok: false };
    }
  }

  function install() {
    if (!updater) return false;
    setImmediate(() => {
      try {
        updater.quitAndInstall(false, true);
      } catch (error) {
        log.warn('Could not launch installer', error);
      }
    });
    return true;
  }

  function start(intervalMs = 4 * 60 * 60 * 1000) {
    if (isDev || !enabled) return;
    setTimeout(() => { check({ silent: true }).catch(() => {}); }, 9000);
    checkTimer = setInterval(() => { check({ silent: true }).catch(() => {}); }, intervalMs);
    if (checkTimer.unref) checkTimer.unref();
  }

  function stop() {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
  }

  return { check, download, install, start, stop, getState: () => publicState(), isDev };
}

module.exports = { createUpdateService };
