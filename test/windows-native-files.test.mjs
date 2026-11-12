import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureDirectory, inspectDirectory } from '../lib/platform/windows-filesystem.mjs';

const windows = process.platform === 'win32';
const probe = fileURLToPath(new URL('./helpers/windows-file-probe.ps1', import.meta.url));
async function attacker(t, root, target) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Path', root, '-Target', target, '-WaitForSignal'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.pid) child.kill(); });
  let text = '', errors = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.on('data', chunk => { text += chunk; if (text.includes('{"ready":true}')) readyResolve(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', readyReject);
  const completed = new Promise((resolve, reject) => child.once('exit', code => {
    if (code !== 0) { const error = new Error(errors || `probe exit ${code}`); readyReject(error); reject(error); }
    else resolve();
  }));
  // Avoid an unhandled rejection when an opening failure rejects readiness.
  completed.catch(() => {});
  await ready;
  return async () => {
    child.stdin.end('GO\n'); await completed;
    return JSON.parse(text.trim().split(/\r?\n/).at(-1));
  };
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-files-'));
  const root = path.join(base, '项目 with spaces');
  fs.mkdirSync(root);
  // Only this freshly created test directory is recursively cleaned. Leases
  // are explicitly closed in test finally blocks before cleanup runs.
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

test('native directory inspection reports exact identity without creating a sentinel', { skip: !windows }, t => {
  const { root } = fixture(t);
  const snapshot = inspectDirectory(root);
  assert.equal(snapshot.canonical, fs.realpathSync.native(root));
  assert.equal(snapshot.identity.platform, 'win32');
  assert.equal(snapshot.identity.version, 1);
  assert.match(snapshot.identity.volumeSerial, /^[0-9]+$/);
  assert.match(snapshot.identity.fileId, /^[a-f0-9]{32}$/);
  assert.match(snapshot.identity.creationTime, /^[1-9][0-9]+$/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(inspectDirectory(root.toUpperCase()).identity, snapshot.identity);
});

test('retained directory lease blocks rename and sentinel removal while ordinary file writes work', { skip: !windows }, t => {
  const { base, root } = fixture(t);
  const before = inspectDirectory(root);
  const lease = captureDirectory(root);
  try {
    assert.equal(lease.snapshot().mode, 'pinned');
    assert.deepEqual(lease.snapshot().identity, before.identity);
    const entries = fs.readdirSync(root);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^\.hcc-cwd-pin-[a-f0-9]{32}$/);
    assert.throws(() => fs.unlinkSync(path.join(root, entries[0])), error => ['EPERM', 'EBUSY'].includes(error.code));
    assert.equal(fs.existsSync(path.join(root, entries[0])), true);
    assert.throws(() => fs.renameSync(root, root + '-moved'));
    assert.throws(() => fs.renameSync(base, base + '-moved'));
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'first');
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'second');
    assert.equal(fs.readFileSync(path.join(root, 'ordinary.txt'), 'utf8'), 'second');
    assert.equal(lease.assertUnchanged(), true);
    const copy = lease.snapshot(); copy.identity.fileId = '0'.repeat(32);
    assert.deepEqual(lease.snapshot().identity, before.identity);
  } finally { lease.close(); }
  assert.doesNotThrow(() => lease.close());
  assert.deepEqual(fs.readdirSync(root), ['ordinary.txt']);
  assert.throws(() => lease.assertUnchanged(), { code: 'WINDOWS_DIRECTORY_LEASE_CLOSED' });
  assert.throws(() => lease.snapshot(), { code: 'WINDOWS_DIRECTORY_LEASE_CLOSED' });
  fs.renameSync(root, root + '-moved');
});

test('observation lease creates no files and detects directory replacement', { skip: !windows }, t => {
  const { root } = fixture(t);
  const lease = captureDirectory(root, { pin: false });
  try {
    assert.equal(lease.snapshot().mode, 'observed');
    assert.deepEqual(fs.readdirSync(root), []);
    fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
    assert.throws(() => lease.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
  } finally { lease.close(); }
});

test('attribute-only handles opened before and after capture cannot convert the retained directory into a junction',
  { skip: !windows, timeout: 30000 }, async t => {
    const { base, root } = fixture(t);
    const target = path.join(base, 'outside'); fs.mkdirSync(target);
    const oldHandleAttack = await attacker(t, root, target);
    const lease = captureDirectory(root);
    try {
      assert.deepEqual(await oldHandleAttack(), { win32Error: 145 });
      const newHandleAttack = await attacker(t, root, target);
      assert.deepEqual(await newHandleAttack(), { win32Error: 145 });
      assert.equal(lease.assertUnchanged(), true);
      assert.deepEqual(fs.readdirSync(target), []);
    } finally { lease.close(); }
    // Positive control: the exact same attribute-only operation succeeds once
    // the sentinel is released. Cleanup removes this known junction itself.
    const releasedAttack = await attacker(t, root, target);
    assert.deepEqual(await releasedAttack(), { win32Error: 0 });
    assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
    fs.unlinkSync(root);
  });

test('directory capture rejects existing junctions in leaf and ancestor without mutation', { skip: !windows }, t => {
  const { base, root } = fixture(t);
  const target = path.join(base, 'outside'); fs.mkdirSync(target);
  const alias = path.join(base, 'alias'); fs.symlinkSync(target, alias, 'junction');
  const child = path.join(target, 'child'); fs.mkdirSync(child);
  for (const candidate of [alias, path.join(alias, 'child')]) {
    assert.throws(() => captureDirectory(candidate), { code: 'PROJECT_PATH_FORBIDDEN' });
    assert.throws(() => inspectDirectory(candidate), { code: 'PROJECT_PATH_FORBIDDEN' });
  }
  assert.deepEqual(fs.readdirSync(child), []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a directory that denies child creation remains inspectable and refuses a pinned lease without mutation', { skip: !windows }, t => {
  const { root } = fixture(t);
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const deny = spawnSync(icacls, [root, '/deny', '*S-1-1-0:(WD)'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(deny.status, 0, deny.stderr);
  try {
    const before = inspectDirectory(root);
    assert.throws(() => captureDirectory(root), error => error.code === 'WINDOWS_DIRECTORY_PIN_UNAVAILABLE' && error.win32Error === 5);
    assert.deepEqual(inspectDirectory(root).identity, before.identity);
    assert.deepEqual(fs.readdirSync(root), []);
    const observation = captureDirectory(root, { pin: false });
    try { assert.equal(observation.assertUnchanged(), true); } finally { observation.close(); }
  } finally {
    const restore = spawnSync(icacls, [root, '/remove:d', '*S-1-1-0'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(restore.status, 0, restore.stderr);
  }
  const lease = captureDirectory(root); lease.close();
});

test('native boundary refuses malformed paths, options, excess arguments and invalid receivers', { skip: !windows }, t => {
  const { root } = fixture(t);
  for (const value of [undefined, null, {}, 1, '', '.', 'C:relative', '\\\\server\\share', '\\\\?\\C:\\device',
    root + '\0extra', root + '\\..', root + '\\trailing.', root + '\\trailing ', root + '\\NUL', root + '\\file:stream',
    root + '\\\ud800', root + '\\' + 'a'.repeat(32768)]) {
    assert.throws(() => captureDirectory(value), { code: 'BAD_ARGS' });
    assert.throws(() => inspectDirectory(value), { code: 'BAD_ARGS' });
  }
  for (const options of [null, false, [], { pin: 'yes' }, { unknown: true }, { pin: true, unknown: true }]) {
    assert.throws(() => captureDirectory(root, options), { code: 'BAD_ARGS' });
  }
  assert.throws(() => captureDirectory(root, {}, true), { code: 'BAD_ARGS' });
  assert.throws(() => inspectDirectory(root, {}), { code: 'BAD_ARGS' });
  const lease = captureDirectory(root);
  try {
    assert.throws(() => lease.snapshot('extra'), { code: 'BAD_ARGS' });
    assert.throws(() => lease.snapshot.call({}), { code: 'BAD_ARGS' });
    assert.throws(() => lease.snapshot.call(null), { code: 'BAD_ARGS' });
    assert.throws(() => lease.assertUnchanged.call(Object.create(lease)), { code: 'BAD_ARGS' });
    assert.throws(() => lease.close.call({}), { code: 'BAD_ARGS' });
    assert.equal(lease.assertUnchanged(), true);
  } finally { lease.close(); }
});
