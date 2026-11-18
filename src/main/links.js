'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseRepository(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : value.url;
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function getLinks() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-info.json'), 'utf8'));
    if (info && info.owner && info.repo) {
      return {
        landing: info.landing || `https://${info.owner}.github.io/${info.repo}/`,
        github: info.github || `https://github.com/${info.owner}/${info.repo}`,
        owner: info.owner,
        repo: info.repo,
      };
    }
  } catch {
    // fall through to package.json
  }
  try {
    const pkg = require('../../package.json');
    const parsed = parseRepository(pkg.repository);
    if (parsed) {
      return {
        landing: `https://${parsed.owner}.github.io/${parsed.repo}/`,
        github: `https://github.com/${parsed.owner}/${parsed.repo}`,
        owner: parsed.owner,
        repo: parsed.repo,
      };
    }
  } catch {
    // noop
  }
  return { landing: 'https://github.com', github: 'https://github.com', owner: '', repo: '' };
}

module.exports = { getLinks };
