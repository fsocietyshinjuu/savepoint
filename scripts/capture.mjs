import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'landing', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(electron, ['.'], {
  cwd: root,
  env: { ...process.env, SAVEPOINT_CAPTURE: '1', SAVEPOINT_CAPTURE_DIR: outDir },
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('Screenshots saved in', outDir);
  } else {
    console.error('Capture exited with code', code);
    process.exitCode = code ?? 1;
  }
});
