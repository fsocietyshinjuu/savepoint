import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const ref = process.env.GITHUB_REF_NAME || '';
const requested = process.env.SAVEPOINT_VERSION || (ref.startsWith('v') ? ref.slice(1) : '');
if (!requested) {
  console.log(`Keeping package version ${pkg.version}`);
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  console.error(`Invalid version: ${requested}`);
  process.exit(1);
}

pkg.version = requested;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`Version set to ${requested}`);
