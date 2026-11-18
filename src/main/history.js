'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_HISTORY = 200;

function createHistoryStore() {
  const file = path.join(app.getPath('userData'), 'history.json');
  let items = [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) items = parsed.filter((item) => item && typeof item === 'object');
  } catch {
    items = [];
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // History is a convenience, not critical state.
    }
  }

  function list() {
    return items.map((item) => ({ ...item }));
  }

  function add(entry) {
    const record = {
      id: String(entry.id || ''),
      title: String(entry.title || 'Untitled'),
      path: typeof entry.path === 'string' ? entry.path : '',
      format: entry.format === 'mp3' ? 'mp3' : 'mp4',
      quality: String(entry.quality || ''),
      size: Number(entry.size) || 0,
      duration: Number(entry.duration) || 0,
      thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : '',
      uploader: typeof entry.uploader === 'string' ? entry.uploader : '',
      finishedAt: Number(entry.finishedAt) || Date.now(),
    };
    items = [record, ...items.filter((item) => item.id !== record.id)].slice(0, MAX_HISTORY);
    persist();
    return record;
  }

  function removeByPath(filePath) {
    const before = items.length;
    items = items.filter((item) => item.path !== filePath);
    if (items.length !== before) persist();
  }

  function clear() {
    items = [];
    persist();
  }

  function stats() {
    const totalSize = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const totalDuration = items.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    return { count: items.length, totalSize, totalDuration };
  }

  return { file, list, add, removeByPath, clear, stats };
}

module.exports = { createHistoryStore };
