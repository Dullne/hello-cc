import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(fromUrl = import.meta.url) {
  return path.resolve(fileURLToPath(fromUrl), '..', '..');
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
