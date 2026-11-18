import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'resources', 'bin');
const appFontDir = path.join(root, 'src', 'renderer', 'fonts');
const landingAssets = path.join(root, 'landing', 'assets');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(appFontDir, { recursive: true });
fs.mkdirSync(landingAssets, { recursive: true });

const force = process.argv.includes('--force');
const skipDownload = process.argv.includes('--offline');
const YTDLP = path.join(binDir, 'yt-dlp.exe');
const FFMPEG = path.join(binDir, 'ffmpeg.exe');

function copyIfPresent(source, target, label) {
  try {
    if (!fs.existsSync(source)) {
      if (label) console.warn(`Missing ${label}: ${source}`);
      return false;
    }
    fs.copyFileSync(source, target);
    return true;
  } catch (error) {
    console.warn(`Could not copy ${label || source}: ${error.message}`);
    return false;
  }
}

/* ---------- ffmpeg ---------- */
if (force || !fs.existsSync(FFMPEG) || fs.statSync(FFMPEG).size < 1_000_000) {
  if (!copyIfPresent(ffmpegStatic, FFMPEG, 'ffmpeg binary')) {
    console.error('ffmpeg-static did not provide a binary. Run: npm install');
    process.exitCode = 1;
  } else {
    console.log('ffmpeg ready:', (fs.statSync(FFMPEG).size / 1024 / 1024).toFixed(1), 'MB');
  }
}
copyIfPresent(path.join(root, 'node_modules', 'ffmpeg-static', 'LICENSE'), path.join(binDir, 'ffmpeg.LICENSE.txt'), 'ffmpeg license');

/* ---------- yt-dlp ---------- */
async function latestRelease() {
  const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
    headers: { 'user-agent': 'Savepoint-Build', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((item) => item.name === 'yt-dlp.exe');
  if (!asset) throw new Error('yt-dlp.exe not found in the latest release');
  return { tag: release.tag_name, url: asset.browser_download_url, size: asset.size };
}

async function download(url, target) {
  const res = await fetch(url, { headers: { 'user-agent': 'Savepoint-Build' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download returned ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1_000_000) throw new Error('Downloaded engine is suspiciously small');
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) throw new Error('Downloaded engine is not an executable');
  fs.writeFileSync(target, buffer);
  return buffer.length;
}

if (skipDownload) {
  console.log('Skipping yt-dlp download (--offline)');
} else if (force || !fs.existsSync(YTDLP) || fs.statSync(YTDLP).size < 1_000_000) {
  try {
    const release = await latestRelease();
    console.log(`Fetching yt-dlp ${release.tag} (${(release.size / 1024 / 1024).toFixed(1)} MB)…`);
    const size = await download(release.url, `${YTDLP}.tmp`);
    fs.renameSync(`${YTDLP}.tmp`, YTDLP);
    fs.writeFileSync(path.join(binDir, 'yt-dlp.version.txt'), `${release.tag}\n`, 'utf8');
    console.log('yt-dlp ready:', (size / 1024 / 1024).toFixed(1), 'MB', release.tag);
  } catch (error) {
    console.error('Could not fetch yt-dlp:', error.message);
    console.error('The app can still download it on first launch, but the installer will start without an engine.');
    process.exitCode = 1;
  }
} else {
  console.log('yt-dlp already present, keeping existing binary');
}

if (fs.existsSync(YTDLP)) {
  try {
    const result = spawnSync(YTDLP, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.stdout) console.log('yt-dlp reports:', result.stdout.trim());
  } catch {
    // noop
  }
}

fs.writeFileSync(path.join(binDir, 'THIRD-PARTY-NOTICES.txt'), [
  'Savepoint bundles the following third-party tools:',
  '',
  'yt-dlp — https://github.com/yt-dlp/yt-dlp',
  'License: The Unlicense (public domain dedication).',
  'Bundled to download media from sites the user is authorized to access.',
  '',
  'ffmpeg — https://ffmpeg.org',
  'License: GPL (the Windows build distributed by ffmpeg-static).',
  'Source: https://github.com/eugeneware/ffmpeg-static',
  'Bundled for format merging and MP3 conversion.',
  '',
  'Electron — https://www.electronjs.org (MIT License)',
  'Electron builder — https://www.electron.build (MIT License)',
].join('\n'), 'utf8');

/* ---------- fonts ---------- */
const fontSource = path.join(root, 'node_modules', '@fontsource-variable', 'bricolage-grotesque', 'files', 'bricolage-grotesque-latin-standard-normal.woff2');
const fontLicense = path.join(root, 'node_modules', '@fontsource-variable', 'bricolage-grotesque', 'LICENSE');
for (const target of [path.join(appFontDir, 'bricolage.woff2'), path.join(landingAssets, 'bricolage.woff2')]) {
  copyIfPresent(fontSource, target, 'Bricolage Grotesque font');
}
copyIfPresent(fontLicense, path.join(appFontDir, 'OFL.txt'), 'font license');
copyIfPresent(fontLicense, path.join(landingAssets, 'OFL.txt'), 'font license');

console.log('Assets ready.');
