import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prevalidateProjectDatabaseLocation, resolveProjectDatabase } from '../lib/runtime/project-path.mjs';
import { shortHash } from '../lib/core/peers/format.mjs';
import {
  tmuxManagedSessionName,
  tmuxManagedSessionNameMatches,
  tmuxManagedSessionPrefix,
  tmuxManagedSessionPrefixMatches
} from '../lib/tmux.mjs';

const cleanup = [];

test.afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-project-path-${label}-`));
  cleanup.push(dir);
  return dir;
}

function assertForbidden(fn) {
  assert.throws(fn, (error) => error?.code === 'PROJECT_PATH_FORBIDDEN');
}

test('canonicalizes an existing root alias and allows a regular custom database', () => {
  const container = tempDir('canonical');
  const root = path.join(container, 'project');
  const alias = path.join(container, 'project-alias');
  const stateDir = path.join(root, '.hello-cc');
  const dbDir = path.join(stateDir, 'custom');
  const db = path.join(dbDir, 'project.sqlite');
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(db, '');
  fs.symlinkSync(root, alias, 'dir');

  const resolved = resolveProjectDatabase({ root: alias, db, createStateDir: false });

  assert.equal(resolved.root, fs.realpathSync(root));
  assert.equal(resolved.stateDir, fs.realpathSync(stateDir));
  assert.equal(resolved.db, fs.realpathSync(db));
});

test('uses one managed tmux identity for lexical aliases of the same project root', (t) => {
  const root = tempDir('tmux-root-alias');
  const canonicalRoot = fs.realpathSync(root);
  if (root === canonicalRoot) {
    t.skip('temporary directory has no lexical realpath alias on this platform');
    return;
  }

  assert.equal(
    tmuxManagedSessionName({ root }, 'alias-peer'),
    tmuxManagedSessionName({ root: canonicalRoot }, 'alias-peer')
  );
  assert.equal(
    tmuxManagedSessionPrefix({ root }),
    tmuxManagedSessionPrefix({ root: canonicalRoot })
  );

  const legacyName = `hcc-${shortHash(path.resolve(root))}-alias-peer`;
  assert.notEqual(legacyName, tmuxManagedSessionName({ root: canonicalRoot }, 'alias-peer'));
  assert.equal(
    tmuxManagedSessionNameMatches({ root: canonicalRoot }, legacyName, 'alias-peer', root),
    true
  );
  assert.equal(
    tmuxManagedSessionPrefixMatches({ root: canonicalRoot }, legacyName, root),
    true
  );
  assert.equal(
    tmuxManagedSessionNameMatches({ root: canonicalRoot }, legacyName, 'different-peer', root),
    false
  );
  assert.equal(
    tmuxManagedSessionNameMatches({ root: canonicalRoot }, legacyName, 'alias-peer', tempDir('wrong-root')),
    false
  );
});

test('a private replacement generation cannot match the historical tmux namespace', () => {
  const root = tempDir('tmux-generation-root');
  const historical = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  const replacement = { root, dbPath: path.join(root, '.hello-cc', 'projects',
    `${'a'.repeat(64)}.generations`, 'b'.repeat(32), 'mesh.db') };
  const oldName = tmuxManagedSessionName(historical, 'shared-peer');
  const newName = tmuxManagedSessionName(replacement, 'shared-peer');
  assert.notEqual(oldName, newName);
  assert.equal(tmuxManagedSessionNameMatches(replacement, oldName, 'shared-peer', root), false);
  assert.equal(tmuxManagedSessionPrefixMatches(replacement, oldName, root), false);
  assert.equal(tmuxManagedSessionNameMatches(replacement, newName, 'shared-peer', root), true);
});

test('does not create a missing state directory unless explicitly requested', () => {
  const root = tempDir('no-create');
  const stateDir = path.join(root, '.hello-cc');
  const db = path.join(stateDir, 'mesh.db');

  const resolved = resolveProjectDatabase({ root, db, createStateDir: false });

  assert.equal(resolved.root, fs.realpathSync(root));
  assert.equal(resolved.stateDir, path.join(resolved.root, '.hello-cc'));
  assert.equal(resolved.db, path.join(resolved.root, '.hello-cc', 'mesh.db'));
  assert.equal(fs.existsSync(stateDir), false);
});

test('database admission checks a missing nested path without creating state or tightening existing permissions', () => {
  const root = tempDir('admission-read-only');
  const stateDir = path.join(root, '.hello-cc');
  const db = path.join(stateDir, 'custom', 'mesh.db');
  const inspected = prevalidateProjectDatabaseLocation({ root, db });
  assert.equal(inspected.requestedDb, path.join(fs.realpathSync(root), '.hello-cc', 'custom', 'mesh.db'));
  assert.equal(fs.existsSync(stateDir), false);

  fs.mkdirSync(stateDir, { mode: 0o755 });
  fs.chmodSync(stateDir, 0o755);
  prevalidateProjectDatabaseLocation({ root, db });
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.dirname(db)), false);
});

test('database admission refuses a nested symlink even when its target stays inside state', () => {
  const root = tempDir('admission-link');
  const stateDir = path.join(root, '.hello-cc');
  const actual = path.join(stateDir, 'actual');
  fs.mkdirSync(actual, { recursive: true, mode: 0o700 });
  fs.symlinkSync(actual, path.join(stateDir, 'custom'), 'dir');
  assertForbidden(() => prevalidateProjectDatabaseLocation({
    root, db: path.join(stateDir, 'custom', 'mesh.db')
  }));
  assert.deepEqual(fs.readdirSync(actual), []);
  assert.equal(fs.lstatSync(path.join(stateDir, 'custom')).isSymbolicLink(), true);
});

test('database admission refuses an outside database before any state is created', () => {
  const root = tempDir('admission-outside-root');
  const outside = tempDir('admission-outside-target');
  assertForbidden(() => prevalidateProjectDatabaseLocation({
    root, db: path.join(outside, 'mesh.db')
  }));
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('creates a missing state directory privately when requested', () => {
  const root = tempDir('create');
  const stateDir = path.join(root, '.hello-cc');
  const previousUmask = process.umask(0);
  let resolved;
  try {
    resolved = resolveProjectDatabase({
      root,
      db: path.join(stateDir, 'mesh.db'),
      createStateDir: true
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(resolved.stateDir, fs.realpathSync(stateDir));
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});

test('rejects an outside database before creating a missing state directory', () => {
  const root = tempDir('outside-before-create-root');
  const outside = tempDir('outside-before-create-target');
  const stateDir = path.join(root, '.hello-cc');

  assertForbidden(() => resolveProjectDatabase({
    root,
    db: path.join(outside, 'outside.sqlite'),
    createStateDir: true
  }));
  assert.equal(fs.existsSync(stateDir), false);
});

test('rejects a state directory symlink without touching its outside target', () => {
  const root = tempDir('state-link-root');
  const outside = tempDir('state-link-outside');
  const outsideDb = path.join(outside, 'mesh.db');
  fs.symlinkSync(outside, path.join(root, '.hello-cc'), 'dir');

  assertForbidden(() => resolveProjectDatabase({
    root,
    db: path.join(root, '.hello-cc', 'mesh.db'),
    createStateDir: true
  }));
  assert.equal(fs.existsSync(outsideDb), false);
});

test('rejects a nested database parent symlink escape', () => {
  const root = tempDir('parent-link-root');
  const outside = tempDir('parent-link-outside');
  const stateDir = path.join(root, '.hello-cc');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(stateDir, 'nested'), 'dir');

  assertForbidden(() => resolveProjectDatabase({
    root,
    db: path.join(stateDir, 'nested', 'escape.sqlite'),
    createStateDir: true
  }));
  assert.equal(fs.existsSync(path.join(outside, 'escape.sqlite')), false);
});

test('rejects nested parent symlinks even when they currently point inside the state directory', () => {
  const root = tempDir('parent-link-inside');
  const stateDir = path.join(root, '.hello-cc');
  const realParent = path.join(stateDir, 'real-parent');
  fs.mkdirSync(realParent, { recursive: true });
  fs.symlinkSync(realParent, path.join(stateDir, 'nested'), 'dir');

  assertForbidden(() => resolveProjectDatabase({
    root,
    db: path.join(stateDir, 'nested', 'project.sqlite'),
    createStateDir: true
  }));
});

test('rejects an existing database file symlink escape', () => {
  const root = tempDir('file-link-root');
  const outside = tempDir('file-link-outside');
  const stateDir = path.join(root, '.hello-cc');
  const outsideDb = path.join(outside, 'outside.sqlite');
  const db = path.join(stateDir, 'mesh.db');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(outsideDb, 'outside-sentinel');
  fs.symlinkSync(outsideDb, db, 'file');

  assertForbidden(() => resolveProjectDatabase({ root, db, createStateDir: true }));
  assert.equal(fs.readFileSync(outsideDb, 'utf8'), 'outside-sentinel');
});

test('requires an existing database target to be a regular file', () => {
  const root = tempDir('non-file');
  const stateDir = path.join(root, '.hello-cc');
  const db = path.join(stateDir, 'mesh.db');
  fs.mkdirSync(db, { recursive: true });

  assertForbidden(() => resolveProjectDatabase({ root, db, createStateDir: true }));
});

test('a connect-time identity recheck rejects a state directory rebound after resolution', () => {
  const root = tempDir('state-rebound-root');
  const outside = tempDir('state-rebound-outside');
  const stateDir = path.join(root, '.hello-cc');
  const movedState = path.join(root, '.hello-cc-before-rebind');
  const db = path.join(stateDir, 'mesh.db');
  fs.mkdirSync(stateDir, { mode: 0o700 });

  const first = resolveProjectDatabase({ root, db, createStateDir: true });
  fs.renameSync(stateDir, movedState);
  fs.symlinkSync(outside, stateDir, 'dir');

  assertForbidden(() => resolveProjectDatabase({
    root: first.root,
    db: first.db,
    createStateDir: true
  }));
  assert.equal(fs.existsSync(path.join(outside, 'mesh.db')), false);
});

test('rejects Linux proc pseudo-file targets', { skip: process.platform !== 'linux' }, () => {
  assertForbidden(() => resolveProjectDatabase({
    root: '/',
    db: '/proc/self/status',
    createStateDir: false
  }));
});
