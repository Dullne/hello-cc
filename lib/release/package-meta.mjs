import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(fromUrl = import.meta.url) {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readPackageJson(root) {
  return readJson(path.join(root, 'package.json'));
}

export function readPackageMeta(root) {
  const pkg = readPackageJson(root);
  return {
    name: pkg.name,
    version: pkg.version,
    packageJson: pkg
  };
}
