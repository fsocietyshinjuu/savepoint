'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, ...args) => {
    try { callback(...args); } catch (error) { console.error(error); }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('savepoint', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  app: {
    info: () => invoke('app:info'),
    onExternalUrl: (callback) => subscribe('app:external-url', callback),
    onSystemTheme: (callback) => subscribe('theme:system-changed', callback),
    applyTheme: (isDark) => invoke('theme:apply', isDark),
    isMaximized: () => invoke('window:isMaximized'),
    onMaximized: (callback) => subscribe('window:maximized', callback),
  },

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChange: (callback) => subscribe('settings:changed', callback),
  },

  dialog: {
    chooseFolder: () => invoke('dialog:chooseFolder'),
  },

  queue: {
    add: (text, overrides) => invoke('queue:add', text, overrides),
    pause: (id) => invoke('queue:action', 'pause', id),
    resume: (id) => invoke('queue:action', 'resume', id),
    cancel: (id) => invoke('queue:action', 'cancel', id),
    retry: (id) => invoke('queue:action', 'retry', id),
    remove: (id) => invoke('queue:action', 'remove', id),
    clearFinished: () => invoke('queue:action', 'clearFinished'),
    setFormat: (id, format, quality) => invoke('queue:action', 'setFormat', id, { format, quality }),
    onJobs: (callback) => subscribe('queue:jobs', callback),
    onCompleted: (callback) => subscribe('queue:completed', callback),
    onIdle: (callback) => subscribe('queue:idle', callback),
  },

  history: {
    clear: () => invoke('history:clear'),
    onUpdated: (callback) => subscribe('history:updated', callback),
  },

  system: {
    openFolder: () => invoke('system:openFolder'),
    openPath: (target) => invoke('system:openPath', target),
    showItem: (target) => invoke('system:showItem', target),
    clipboard: () => invoke('system:clipboard'),
    openExternal: (url) => invoke('system:openExternal', url),
    storage: () => invoke('system:storage'),
  },

  engine: {
    info: () => invoke('engine:info'),
    update: (options) => invoke('engine:update', options),
    onProgress: (callback) => subscribe('engine:progress', callback),
    onChanged: (callback) => subscribe('engine:changed', callback),
  },

  updates: {
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    install: () => invoke('updates:install'),
    state: () => invoke('updates:state'),
    onEvent: (callback) => subscribe('updates:event', callback),
  },
});
