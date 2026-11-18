import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function parseRepository(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : value.url;
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

const fromEnv = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/') : null;
const local = parseRepository(pkg.repository);
const owner = (fromEnv && fromEnv[0]) || local?.owner || 'savepoint-app';
const repo = (fromEnv && fromEnv[1]) || local?.repo || 'savepoint';

if (owner === 'savepoint-app') {
  console.warn('Release owner is still the placeholder "savepoint-app". Auto-updates will not work until the repository is set.');
}

const templatePath = path.join(root, 'electron-builder.yml');
const template = fs.readFileSync(templatePath, 'utf8');
const resolved = template
  .replaceAll('__OWNER__', owner)
  .replaceAll('__REPO__', repo);
fs.writeFileSync(path.join(root, 'electron-builder.generated.yml'), resolved, 'utf8');

fs.writeFileSync(
  path.join(root, 'src', 'main', 'release-info.json'),
  `${JSON.stringify({ owner, repo, landing: `https://${owner}.github.io/${repo}/`, github: `https://github.com/${owner}/${repo}` }, null, 2)}\n`,
  'utf8',
);

console.log(`Release target: github.com/${owner}/${repo}`);
console.log(`Landing page: https://${owner}.github.io/${repo}/`);
