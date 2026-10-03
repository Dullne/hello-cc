import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertHookRootIdentity, hookRootIdentityValue } from '../lib/core/sessions/hook-root-identity.mjs';
import { childSessionEnv } from '../lib/core/sessions/launch.mjs';
import { nativeWorkerEnv } from '../lib/integrations/native/index.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

const hcc = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

test('a launch-bound hook does not write to B after A is replaced by B',
  { skip: process.platform === 'win32' }, (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-launch-')));
    const home = path.join(base, 'home');
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    const movedA = path.join(base, 'moved-a');
    for (const dir of [home, a, b]) fs.mkdirSync(dir);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const env = { ...process.env, HOME: home, HCC_RUNTIME_URL: '', NODE_NO_WARNINGS: '1' };
    const dbPath = (root) => path.join(root, 'custom.db');
    const cli = (root, args, extraEnv = {}, input = '') => spawnSync(process.execPath,
      [hcc, '--root', root, '--db', dbPath(root), '--json', ...args], {
        cwd: base, env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 10000
      });
    for (const root of [a, b]) {
      const result = cli(root, ['init', '--no-guidance']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const count = (dbFile) => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try { return db.prepare('SELECT COUNT(*) AS n FROM events').get().n; }
      finally { db.close(); }
    };
    const launchEnv = childSessionEnv({ HCC_ROOT: a, HCC_DB: dbPath(a), HCC_PEER: 'a-peer' },
      env, { rootIdentity: captureSelectedCwdSnapshot(a) });
    assert.equal(typeof launchEnv.HCC_HOOK_ROOT_IDENTITY, 'string');
    const control = cli(a, ['hook', 'SessionStart', '--provider', 'claude'], launchEnv,
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'a-session', cwd: b }));
    assert.equal(control.status, 0, control.stderr || control.stdout);
    assert.equal(count(dbPath(a)), 2, 'managed hook writes to A despite an arbitrary payload cwd');
    assert.equal(count(dbPath(b)), 1, 'managed hook does not write to the payload workspace');
    const changedRoot = cli(b, ['hook', 'SessionStart', '--provider', 'claude'],
      { ...launchEnv, HCC_ROOT: b, HCC_DB: dbPath(b) },
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'a-session', cwd: b }));
    assert.notEqual(changedRoot.status, 0, changedRoot.stdout);
    assert.match(changedRoot.stderr, /HOOK_ROOT_IDENTITY_MISMATCH/);
    assert.equal(count(dbPath(b)), 1, 'changing only the root string cannot retarget a launch-bound hook');
    fs.renameSync(a, movedA);
    fs.renameSync(b, a);
    const replacedDb = dbPath(a);
    const before = count(replacedDb);
    const registry = path.join(home, '.hello-cc', 'projects.json');
    const registryBefore = fs.readFileSync(registry);
    const result = cli(a, ['hook', 'SessionStart', '--provider', 'claude'], launchEnv,
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'a-session', cwd: a }));
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /HOOK_ROOT_IDENTITY_MISMATCH|PROJECT_PATH_CHANGED/);
    assert.equal(count(replacedDb), before, 'B database must not receive A hook events');
    assert.deepEqual(fs.readFileSync(registry), registryBefore);
    assert.equal(count(dbPath(movedA)), 2, 'original A database stays untouched');
  });

test('an alias marker follows its original inode and malformed markers fail closed',
  { skip: process.platform === 'win32' }, (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-alias-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    const alias = path.join(base, 'alias');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.symlinkSync(a, alias);
    const original = captureSelectedCwdSnapshot(alias);
    const marker = hookRootIdentityValue(alias, original);
    assert.equal(assertHookRootIdentity(alias, marker).requested, alias);
    assert.throws(() => assertHookRootIdentity(b, marker), { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
    assert.throws(() => assertHookRootIdentity(alias, '{'), { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
    fs.unlinkSync(alias);
    fs.symlinkSync(b, alias);
    assert.throws(() => assertHookRootIdentity(alias, marker), { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
    assert.throws(() => hookRootIdentityValue(alias, original), { code: 'PROJECT_PATH_CHANGED' });
  });

test('managed launch helpers replace inherited markers with the selected root identity', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-env-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const inherited = { HCC_ROOT: a, HCC_HOOK_ROOT_IDENTITY: hookRootIdentityValue(a) };
  const child = childSessionEnv({ HCC_ROOT: b }, inherited,
    { rootIdentity: captureSelectedCwdSnapshot(b) });
  assert.equal(assertHookRootIdentity(b, child.HCC_HOOK_ROOT_IDENTITY).requested, b);
  assert.notEqual(child.HCC_HOOK_ROOT_IDENTITY, inherited.HCC_HOOK_ROOT_IDENTITY);
  const native = nativeWorkerEnv(inherited, {
    root: b, dbPath: path.join(b, 'custom.db'), initialRootIdentity: captureSelectedCwdSnapshot(b)
  }, 'b-peer', 'b-native-owner');
  assert.equal(assertHookRootIdentity(b, native.HCC_HOOK_ROOT_IDENTITY).requested, b);
  assert.equal(native.HCC_PEER, 'b-peer');
});

test('unmanaged hooks still follow each payload workspace without a launch marker',
  { skip: process.platform === 'win32' }, (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-unmanaged-')));
    const home = path.join(base, 'home');
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    for (const dir of [home, a, b]) fs.mkdirSync(dir);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const env = { ...process.env, HOME: home, HCC_RUNTIME_URL: '', NODE_NO_WARNINGS: '1' };
    for (const [index, root] of [a, b].entries()) {
      const result = spawnSync(process.execPath, [hcc, 'hook', 'SessionStart', '--provider', 'claude'], {
        cwd: base, env: { ...env, HCC_ROOT: '', HCC_DB: '', HCC_PEER: '',
          HCC_NATIVE_OWNER: '', HCC_HOOK_ROOT_IDENTITY: undefined },
        input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: `unmanaged-${index}`, cwd: root }),
        encoding: 'utf8', timeout: 10000
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    for (const root of [a, b]) {
      const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peers').get().n, 1); }
      finally { db.close(); }
    }
  });
