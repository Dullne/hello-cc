// Shared with the installed browser fixture; importing this only defines helpers.
import { createNativeFixtureRoot } from '../../scripts/native-fixture-root.mjs';
export { createNativeFixtureRoot as createNativeTestRoot } from '../../scripts/native-fixture-root.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { ensurePrivateProjectStateDir, privateProjectStateDir } from '../../lib/runtime/private-state.mjs';

export function createPrivateNativeTestRoot(prefix, options = {}) {
  return createNativeFixtureRoot(prefix, { ...options,
    ...(process.platform === 'win32' ? { ownershipKey: root =>
      path.join(privateProjectStateDir(root), 'native', 'service-owner') } : {}) });
}

// Opt in once per test process. Windows runtime state lives in the user's
// private store, so merely making a project in Temp does not isolate it.
export function isolateNativeTestProfile() {
  if (process.platform !== 'win32') return;
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    HCC_SKIP_SHIM_INSTALL: process.env.HCC_SKIP_SHIM_INSTALL };
  const profile = fs.mkdtempSync(path.join(os.homedir(), 'hcc-shared-native-home-'));
  process.env.HOME = process.env.USERPROFILE = profile;
  process.env.HCC_SKIP_SHIM_INSTALL = '1';
  after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(profile, { recursive: true, force: true });
  });
}

export function createNativeTestContext(root) {
  const directory = process.platform === 'win32'
    ? ensurePrivateProjectStateDir(root, { create: true })
    : path.join(root, '.hello-cc');
  if (process.platform !== 'win32') fs.mkdirSync(directory);
  return { root, dbPath: path.join(directory, 'mesh.db') };
}
