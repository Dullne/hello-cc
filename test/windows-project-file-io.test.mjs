import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureDirectory } from '../lib/platform/windows-filesystem.mjs';
import { readWindowsProjectFile, listWindowsProjectFiles, publishWindowsProjectFile } from '../lib/platform/windows-project-files.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-windows-file-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  return { root, write };
}

test('Windows reads return bounded exact bytes and immutable file identity without modifying the project', { skip: !windows }, t => {
  const { root, write } = fixture(t); const bytes = Buffer.from('\ufeff中文\r\nhello'); write('nested/说明.txt', bytes);
  const before = fs.readdirSync(root, { recursive: true });
  const read = readWindowsProjectFile(root, 'nested/说明.txt', { maxBytes: 7 });
  assert.deepEqual(read.bytes, bytes.subarray(0, 7)); assert.equal(read.truncated, true);
  assert.deepEqual(read.snapshot.actualComponents, ['nested', '说明.txt']);
  assert.equal(read.snapshot.size, String(bytes.length)); assert.equal(read.snapshot.nlink, '1');
  assert.match(read.snapshot.identity.fileId, /^[a-f0-9]{32}$/);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
});

test('Windows listing hides private paths and excludes junctions and hard-linked files', { skip: !windows }, t => {
  const { root, write } = fixture(t);
  write('z.txt', 'z'); write('A/child.txt', 'a'); write('.env', 'secret'); write('.hello-cc/token', 'secret');
  write('.hcc-cwd-pin-fixture', ''); const linked = write('hard.txt', 'hidden'); fs.linkSync(linked, path.join(root, 'hard2.txt'));
  fs.symlinkSync(path.join(root, 'A'), path.join(root, 'junction'), 'junction');
  assert.deepEqual(listWindowsProjectFiles(root).entries.map(entry => entry.name), ['A', 'z.txt']);
  for (const name of ['.env', '.hello-cc/token', '.hcc-cwd-pin-fixture', 'hard.txt', 'junction/child.txt']) {
    assert.throws(() => readWindowsProjectFile(root, name), { code: 'PROJECT_FILE_FORBIDDEN' });
  }
});

test('child file handles retain their original objects after the caller closes the root lease', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('nested/file.txt', 'original');
  const lease = captureDirectory(root); let file;
  try {
    file = lease.openFile('nested/file.txt'); lease.close();
    assert.throws(() => fs.renameSync(root, root + '-rebound'));
    assert.deepEqual(file.read(100), Buffer.from('original'));
    assert.equal(file.assertUnchanged(), true);
  } finally { file?.close(); lease.close(); }
  assert.deepEqual(fs.readdirSync(root), ['nested']);
});

test('a native publication source blocks writes continuously while permitting an identity-checked rename', { skip: !windows }, t => {
  const { root, write } = fixture(t); const source = write('verified.txt', 'verified bytes');
  const lease = captureDirectory(root), parent = lease.openDirectory('');
  let file;
  try {
    file = parent.openPublishSource('verified.txt');
    assert.deepEqual(file.read(100), Buffer.from('verified bytes'));
    assert.throws(() => fs.writeFileSync(source, 'corrupt'), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    const expectedIdentity = file.snapshot().identity;
    parent.renameFile('verified.txt', 'published.txt', { expectedIdentity });
    const published = path.join(root, 'published.txt');
    assert.equal(fs.readFileSync(published, 'utf8'), 'verified bytes');
    assert.throws(() => fs.writeFileSync(published, 'corrupt'), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    file.close(); file = null;
    fs.writeFileSync(published, 'released');
    const ordinary = parent.openFile('published.txt');
    try { assert.throws(() => fs.renameSync(published, source)); }
    finally { ordinary.close(); }
    for (const args of [[null], ['../verified.txt'], ['published.txt', 'extra']]) {
      assert.throws(() => parent.openPublishSource(...args), { code: 'BAD_ARGS' });
    }
  } finally { file?.close(); parent.close(); lease.close(); }
});

test('native project handles enforce path and buffer bounds and reject unexpected types', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('file.txt', 'content'); const lease = captureDirectory(root, { pin: false }); let file;
  try {
    for (const name of ['../file.txt', '/file.txt', 'C:/file.txt', 'file.txt:stream', 'sub\\file.txt', 'a//b', 'file.txt.', 'NUL', '\0', '\ud800']) {
      assert.throws(() => lease.openFile(name), { code: 'BAD_ARGS' });
    }
    assert.throws(() => lease.openFile('', {}), { code: 'BAD_ARGS' });
    file = lease.openFile('file.txt');
    for (const maxBytes of [-1, 1.5, Infinity, 10485761, '100', null]) assert.throws(() => file.read(maxBytes), { code: 'BAD_ARGS' });
    assert.deepEqual(file.read(0), Buffer.alloc(0));
    assert.throws(() => lease.openDirectory('file.txt'), { code: 'PROJECT_FILE_NOT_DIRECTORY' });
    assert.throws(() => lease.openFile('missing.txt'), { code: 'PROJECT_FILE_NOT_FOUND' });
  } finally { file?.close(); lease.close(); }
});

test('directory handles enumerate bounded long names and support nested opens from the same captured root', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('nested/visible.txt', 'visible'); write('nested/b.txt', 'b');
  const lease = captureDirectory(root, { pin: false }); let directory, file;
  try {
    directory = lease.openDirectory('nested'); file = directory.openFile('visible.txt');
    assert.deepEqual(file.snapshot().actualComponents, ['nested', 'visible.txt']);
    assert.deepEqual(file.read(100), Buffer.from('visible'));
    const limited = directory.list({ maxScanned: 1 }); assert.ok(limited.entries.length <= 1); assert.equal(limited.truncated, true);
    assert.deepEqual(directory.list({ maxScanned: 100 }).entries.map(item => item.name).sort(), ['b.txt', 'visible.txt']);
  } finally { file?.close(); directory?.close(); lease.close(); }
});

test('8.3 aliases cannot bypass filtering of private file or ancestor long names', { skip: !windows }, t => {
  const { root, write } = fixture(t);
  const candidates = [write('credentials-secrets.json', 'DO_NOT_READ'), write('.hello-cc/visible.txt', 'DO_NOT_READ')];
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('./helpers/windows-short-path.ps1', import.meta.url));
  let exercised = 0;
  for (const file of candidates) {
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', file],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const short = result.stdout.trim();
    const shortRootResult = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', root],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(shortRootResult.status, 0, shortRootResult.stderr);
    const relative = path.relative(shortRootResult.stdout.trim(), short).split(path.sep).join('/');
    if (relative === path.relative(root, file).split(path.sep).join('/')) continue;
    const lease = captureDirectory(root, { pin: false }); let opened;
    try {
      opened = lease.openFile(relative);
      assert.deepEqual(opened.snapshot().actualComponents, path.relative(root, file).split(path.sep));
    } finally { opened?.close(); lease.close(); }
    assert.throws(() => readWindowsProjectFile(root, relative), { code: 'PROJECT_FILE_FORBIDDEN' }); exercised++;
  }
  if (!exercised) t.skip('The fixture volume has no usable 8.3 aliases; requires separate acceptance');
});

test('raw enumeration distinguishes an empty private directory from omitted hard links and reparse points', { skip: !windows }, t => {
  const { root, write } = fixture(t); const lease = captureDirectory(root); let directory;
  try {
    directory = lease.openDirectory('');
    const empty = directory.list({ maxScanned: 100 });
    assert.equal(empty.scanned, 1); assert.equal(empty.ownedSentinelSeen, true);
    const first = write('linked.txt', 'hidden'); fs.linkSync(first, path.join(root, 'linked2.txt'));
    fs.mkdirSync(path.join(root, 'outside')); fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'junction'), 'junction');
    const list = directory.list({ maxScanned: 100 });
    assert.equal(list.scanned, 5); assert.equal(list.ownedSentinelSeen, true);
    assert.ok(list.omittedNames.includes('linked.txt')); assert.ok(list.omittedNames.includes('linked2.txt'));
    assert.ok(list.omittedNames.includes('junction'));
  } finally { directory?.close(); lease.close(); }
});

test('Windows publication creates exclusively and replaces only the expected original bytes', { skip: !windows }, t => {
  const { root, write } = fixture(t); const initial = Buffer.from('\ufefforiginal\r\n'); write('file.txt', initial);
  const read = readWindowsProjectFile(root, 'file.txt');
  const replacement = Buffer.from('\ufeffreplacement\r\n中文');
  const receipt = publishWindowsProjectFile(root, 'file.txt', replacement,
    { operation: 'replace', expectedSnapshot: read.snapshot, expectedBytes: read.bytes });
  assert.equal(receipt.size, String(replacement.length)); assert.equal(receipt.published, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'file.txt')), replacement);
  assert.throws(() => publishWindowsProjectFile(root, 'file.txt', Buffer.from('stale'),
    { operation: 'replace', expectedSnapshot: read.snapshot, expectedBytes: read.bytes }), { code: 'PROJECT_FILE_CONFLICT' });
  publishWindowsProjectFile(root, 'new.bin', Buffer.from([0, 1, 255]), { operation: 'create' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'new.bin')), Buffer.from([0, 1, 255]));
  assert.throws(() => publishWindowsProjectFile(root, 'new.bin', Buffer.from('overwrite'), { operation: 'create' }), { code: 'PROJECT_FILE_EXISTS' });
  assert.deepEqual(fs.readdirSync(root).sort(), ['file.txt', 'new.bin']);
});

test('publication catches same-file edits and preserves explicit DACL grants and hidden attributes', { skip: !windows }, t => {
  const { root, write } = fixture(t); const file = write('edit.txt', 'original');
  const before = readWindowsProjectFile(root, 'edit.txt'); fs.writeFileSync(file, 'external');
  assert.throws(() => publishWindowsProjectFile(root, 'edit.txt', Buffer.from('stale'),
    { operation: 'replace', expectedSnapshot: before.snapshot, expectedBytes: before.bytes }), { code: 'PROJECT_FILE_CONFLICT' });
  const grant = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true }); assert.equal(grant.status, 0, grant.stderr);
  const hidden = spawnSync('attrib.exe', ['+H', file], { encoding: 'utf8', windowsHide: true }); assert.equal(hidden.status, 0, hidden.stderr);
  const current = readWindowsProjectFile(root, 'edit.txt'); assert.ok(current.snapshot.attributes & 2);
  publishWindowsProjectFile(root, 'edit.txt', Buffer.from('updated'), { operation: 'replace', expectedSnapshot: current.snapshot, expectedBytes: current.bytes });
  const lease = captureDirectory(root, { pin: false }); let opened;
  try { opened = lease.openFile('edit.txt'); assert.equal(opened.security().private, false); assert.ok(opened.snapshot().attributes & 2); }
  finally { opened?.close(); lease.close(); }
});

test('pinned private-directory creation is exclusive and flushes its actual parent', { skip: !windows }, t => {
  const { root } = fixture(t); const lease = captureDirectory(root); let parent, child;
  try {
    parent = lease.openDirectory(''); child = parent.createDirectory('private');
    assert.equal(child.security().private, true); assert.equal(child.flush(), true);
    assert.throws(() => parent.createDirectory('private'), { code: 'PROJECT_FILE_EXISTS' });
    assert.equal(parent.flush(), true);
    child.publish('authority.json', Buffer.from('{}\n'), { operation: 'create', private: true });
    const file = child.openFile('authority.json');
    try { assert.equal(file.security().private, true); assert.deepEqual(file.read(100), Buffer.from('{}\n')); } finally { file.close(); }
  } finally { child?.close(); parent?.close(); lease.close(); }
});

test('mutable file bindings permit data writes while retaining the database identity and refusing reads', { skip: !windows }, t => {
  const { root, write } = fixture(t); const filename = write('state.db', 'original');
  const lease = captureDirectory(root); let directory, file;
  try {
    directory = lease.openDirectory(''); file = directory.openMutableFile('state.db');
    const identity = file.snapshot().identity; directory.close(); lease.close();
    fs.writeFileSync(filename, 'new database content');
    assert.equal(file.assertUnchanged(), true); assert.deepEqual(file.snapshot().identity, identity);
    assert.throws(() => fs.renameSync(filename, filename + '.replaced'));
    assert.throws(() => file.read(100), { code: 'BAD_ARGS' });
  } finally { file?.close(); directory?.close(); lease.close(); }
  fs.renameSync(filename, filename + '.replaced');
  assert.deepEqual(fs.readdirSync(root), ['state.db.replaced']);
});

test('directory publication refuses unpinned authority, malformed options and read-only targets without changing bytes', { skip: !windows }, t => {
  const { root, write } = fixture(t); const filename = write('readonly.txt', 'original');
  const observed = captureDirectory(root, { pin: false }); let directory;
  try {
    directory = observed.openDirectory('');
    assert.throws(() => directory.publish('new.txt', Buffer.from('x'), { operation: 'create' }), { code: 'PROJECT_FILE_WRITE_UNAVAILABLE' });
    assert.throws(() => directory.createDirectory('new'), { code: 'PROJECT_FILE_WRITE_UNAVAILABLE' });
  } finally { directory?.close(); observed.close(); }
  const result = spawnSync('attrib.exe', ['+R', filename], { windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  try {
    const before = readWindowsProjectFile(root, 'readonly.txt');
    assert.throws(() => publishWindowsProjectFile(root, 'readonly.txt', Buffer.from('modified'),
      { operation: 'replace', expectedSnapshot: before.snapshot, expectedBytes: before.bytes }), { code: 'PROJECT_FILE_WRITE_UNAVAILABLE' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'original');
  } finally { spawnSync('attrib.exe', ['-R', filename], { windowsHide: true }); }
  assert.deepEqual(fs.readdirSync(root), ['readonly.txt']);
});

test('root identity comparison uses identity fields and reports failed post-publication confirmation as uncertain', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('file.txt', 'original');
  const lease = captureDirectory(root, { pin: false }); const snapshot = lease.snapshot(); lease.close();
  const reordered = { ...snapshot, identity: Object.fromEntries(Object.entries(snapshot.identity).reverse()) };
  assert.equal(readWindowsProjectFile(root, 'file.txt', { rootIdentity: reordered }).bytes.toString(), 'original');
  let checks = 0;
  const rootIdentity = { ...snapshot, assertUnchanged() { if (++checks === 2) throw new Error('Confirmation failed'); } };
  assert.throws(() => publishWindowsProjectFile(root, 'new.txt', Buffer.from('published'), { operation: 'create', rootIdentity }),
    { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'published');
});

test('private append resources append exact bytes, retain identity and refuse public or linked files', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('public.log', 'public');
  const grant = spawnSync('icacls.exe', [path.join(root, 'public.log'), '/grant', '*S-1-1-0:(R)'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(grant.status, 0, grant.stderr);
  const lease = captureDirectory(root); let directory, first, second;
  try {
    directory = lease.openDirectory('');
    first = directory.openAppendFile('host.log', { private: true }); second = directory.openAppendFile('host.log', { private: true });
    assert.equal(first.security().private, true); assert.equal(first.write(Buffer.from('first\n')), 6);
    assert.equal(second.write(Buffer.from('second\n')), 7); assert.equal(first.write(Buffer.from('third\n')), 6);
    assert.equal(fs.readFileSync(path.join(root, 'host.log'), 'utf8'), 'first\nsecond\nthird\n');
    directory.close(); lease.close();
    assert.throws(() => fs.renameSync(path.join(root, 'host.log'), path.join(root, 'renamed.log')));
    assert.equal(first.assertUnchanged(), true); assert.throws(() => first.read(1), { code: 'BAD_ARGS' });
  } finally { second?.close(); first?.close(); directory?.close(); lease.close(); }
  const observed = captureDirectory(root); let parent;
  try {
    parent = observed.openDirectory('');
    assert.throws(() => parent.openAppendFile('public.log', { private: true }), { code: 'WINDOWS_STATE_PERMISSIONS' });
    fs.linkSync(path.join(root, 'host.log'), path.join(root, 'linked.log'));
    assert.throws(() => parent.openAppendFile('host.log', { private: true }), { code: 'PROJECT_FILE_FORBIDDEN' });
  } finally { parent?.close(); observed.close(); }
});

test('publication reports real parent flush denial as uncertain after the new bytes become visible', { skip: !windows }, t => {
  const { root } = fixture(t);
  const denied = spawnSync('icacls.exe', [root, '/deny', '*S-1-1-0:(WA)'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(denied.status, 0, denied.stderr);
  try {
    assert.throws(() => publishWindowsProjectFile(root, 'created.txt', Buffer.from('visible'), { operation: 'create' }),
      error => error.code === 'PROJECT_FILE_WRITE_UNCONFIRMED' && error.win32Error === 5);
    assert.equal(fs.readFileSync(path.join(root, 'created.txt'), 'utf8'), 'visible');
    assert.deepEqual(fs.readdirSync(root), ['created.txt']);
  } finally {
    const restored = spawnSync('icacls.exe', [root, '/remove:d', '*S-1-1-0'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
  }
});

test('reopening a pinned nested directory shares its exact existing sentinel', { skip: !windows }, t => {
  const { root } = fixture(t); fs.mkdirSync(path.join(root, 'nested'));
  const lease = captureDirectory(root); let child, retained;
  try {
    child = lease.openDirectory('nested'); const expected = child.snapshot().sentinelName;
    retained = child.openDirectory(''); child.close();
    assert.equal(retained.snapshot().sentinelName, expected);
    const listing = retained.list({ maxScanned: 100 });
    assert.equal(listing.scanned, 1); assert.equal(listing.ownedSentinelSeen, true);
    assert.deepEqual([...listing.entries.map(entry => entry.name), ...listing.omittedNames], [expected]);
  } finally { retained?.close(); child?.close(); lease.close(); }
});

test('native file methods reject null or array options before accessing properties', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('file.txt', 'original');
  const lease = captureDirectory(root); let directory;
  try {
    directory = lease.openDirectory('');
    for (const options of [null, [], false]) {
      assert.throws(() => directory.list(options), { code: 'BAD_ARGS' });
      assert.throws(() => directory.publish('new.txt', Buffer.from('x'), options), { code: 'BAD_ARGS' });
      assert.throws(() => directory.createDirectory('new', options), { code: 'BAD_ARGS' });
      assert.throws(() => directory.openAppendFile('new.log', options), { code: 'BAD_ARGS' });
    }
    assert.throws(() => directory.publish('file.txt', Buffer.from('x'), { operation: 'replace', expectedIdentity: null, expectedBytes: Buffer.from('original') }), { code: 'BAD_ARGS' });
  } finally { directory?.close(); lease.close(); }
  assert.deepEqual(fs.readdirSync(root), ['file.txt']);
});

test('case-sensitive NTFS directories are rejected rather than resolved with ambiguous case rules', { skip: !windows }, t => {
  const { root } = fixture(t); const target = path.join(root, 'case-sensitive'); fs.mkdirSync(target);
  const result = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', target, 'enable'], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) { t.skip('This token cannot enable the NTFS per-directory case-sensitive flag; separate acceptance required'); return; }
  try {
    assert.throws(() => captureDirectory(target, { pin: false }), { code: 'PROJECT_PATH_FORBIDDEN' });
    const lease = captureDirectory(root, { pin: false });
    try { assert.throws(() => lease.openDirectory('case-sensitive'), { code: 'PROJECT_FILE_FORBIDDEN' }); } finally { lease.close(); }
  } finally {
    const restore = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', target, 'disable'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(restore.status, 0, restore.stderr);
  }
});

test('native directory enumeration stops before inspection when its elapsed-time budget is zero', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('visible.txt', 'x'); const lease = captureDirectory(root, { pin: false }); let directory;
  try {
    directory = lease.openDirectory(''); const result = directory.list({ maxScanned: 5000, timeBudgetMs: 0 });
    assert.deepEqual(result.entries, []); assert.equal(result.scanned, 0); assert.equal(result.truncated, true);
  } finally { directory?.close(); lease.close(); }
});

test('checked deletion removes only the expected file and refuses stale content, hardlinks and active append resources', { skip: !windows }, t => {
  const { root, write } = fixture(t); const filename = write('shim.cmd', 'original');
  const initial = readWindowsProjectFile(root, 'shim.cmd'); const lease = captureDirectory(root); let directory, append;
  try {
    directory = lease.openDirectory('');
    fs.writeFileSync(filename, 'external');
    assert.throws(() => directory.removeFile('shim.cmd', { expectedIdentity: initial.snapshot.identity, expectedBytes: initial.bytes }), { code: 'PROJECT_FILE_CONFLICT' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'external');
    const current = readWindowsProjectFile(root, 'shim.cmd');
    fs.linkSync(filename, path.join(root, 'linked.cmd'));
    assert.throws(() => directory.removeFile('shim.cmd', { expectedIdentity: current.snapshot.identity }), { code: 'PROJECT_FILE_FORBIDDEN' });
    fs.unlinkSync(path.join(root, 'linked.cmd'));
    assert.deepEqual(directory.removeFile('shim.cmd', { expectedIdentity: current.snapshot.identity, expectedBytes: current.bytes }), { removed: true });
    assert.equal(fs.existsSync(filename), false);
    append = directory.openAppendFile('active.log', { private: true });
    assert.throws(() => directory.removeFile('active.log', { expectedIdentity: append.snapshot().identity }),
      error => error.code === 'PROJECT_FILE_FORBIDDEN' && error.win32Error === 32);
    assert.equal(append.write(Buffer.from('alive')), 5);
  } finally { append?.close(); directory?.close(); lease.close(); }
});

test('checked deletion reports parent flush failure as uncertain after removal', { skip: !windows }, t => {
  const { root, write } = fixture(t); const filename = write('shim.cmd', 'original'); const before = readWindowsProjectFile(root, 'shim.cmd');
  const denied = spawnSync('icacls.exe', [root, '/deny', '*S-1-1-0:(WA)'], { windowsHide: true, encoding: 'utf8' }); assert.equal(denied.status, 0, denied.stderr);
  const lease = captureDirectory(root); let directory;
  try {
    directory = lease.openDirectory('');
    assert.throws(() => directory.removeFile('shim.cmd', { expectedIdentity: before.snapshot.identity, expectedBytes: before.bytes }),
      error => error.code === 'PROJECT_FILE_WRITE_UNCONFIRMED' && error.win32Error === 5);
    assert.equal(fs.existsSync(filename), false);
  } finally {
    directory?.close(); lease.close();
    const restored = spawnSync('icacls.exe', [root, '/remove:d', '*S-1-1-0'], { windowsHide: true, encoding: 'utf8' }); assert.equal(restored.status, 0, restored.stderr);
  }
});

test('checked rename preserves identity and bytes, never overwrites and refuses active append resources', { skip: !windows }, t => {
  const { root, write } = fixture(t); write('source.log', 'original'); write('existing.log', 'keep');
  const before = readWindowsProjectFile(root, 'source.log'); const lease = captureDirectory(root); let directory, append;
  try {
    directory = lease.openDirectory('');
    assert.throws(() => directory.renameFile('source.log', 'existing.log', { expectedIdentity: before.snapshot.identity }), { code: 'PROJECT_FILE_EXISTS' });
    assert.equal(fs.readFileSync(path.join(root, 'existing.log'), 'utf8'), 'keep');
    assert.deepEqual(directory.renameFile('source.log', 'source.log.1', { expectedIdentity: before.snapshot.identity }), { renamed: true });
    assert.equal(fs.existsSync(path.join(root, 'source.log')), false);
    const after = readWindowsProjectFile(root, 'source.log.1'); assert.deepEqual(after.snapshot.identity, before.snapshot.identity); assert.deepEqual(after.bytes, before.bytes);
    append = directory.openAppendFile('active.log', { private: true });
    assert.throws(() => directory.renameFile('active.log', 'active.log.1', { expectedIdentity: append.snapshot().identity }),
      error => error.code === 'PROJECT_FILE_FORBIDDEN' && error.win32Error === 32);
    assert.equal(fs.existsSync(path.join(root, 'active.log.1')), false);
  } finally { append?.close(); directory?.close(); lease.close(); }
});
