import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { CliError } from '../lib/shared/errors.mjs';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';
import { saveProjectFile, uploadProjectFile } from '../lib/web/project-file-write.mjs';
import { previewProjectFile, inspectProjectFileStatus, PROJECT_FILE_LIMITS } from '../lib/web/project-files.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hcc-file-write-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, async file(name, bytes = '') {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return target;
  } };
}
const upload = (name, bytes) => ({ path: name, encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function injected(marker, code) {
  return (command, args, options) => {
    const altered = [...args], config = JSON.parse(altered.at(-1));
    assert.ok(config.args[1].includes(marker));
    config.args[1] = config.args[1].replace(marker, code);
    altered[altered.length - 1] = JSON.stringify(config);
    return spawnSync(command, altered, options);
  };
}
const beforePublish = '/* PINNED_FILE_TEST_BEFORE_PUBLISH */';
const afterPublish = '/* PINNED_FILE_TEST_AFTER_PUBLISH */';
async function noTemporary(root) { assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.hcc-file-write-'))); }

test('text save publishes exact UTF-8 BOM/CRLF bytes, preserves permissions and returns the new preview revision', async t => {
  const f = await fixture(t), target = await f.file('note.md', '\ufeffold\r\n');
  await fs.chmod(target, 0o750);
  const preview = await previewProjectFile(f.root, 'note.md'), content = '\ufeff中文 new\r\nsecond\r\n';
  const saved = await saveProjectFile(f.root, { path: 'note.md', revision: preview.revision, content });
  const after = await previewProjectFile(f.root, 'note.md');
  assert.equal(saved.saved, true); assert.equal(saved.revision, after.revision);
  assert.notEqual(saved.revision, preview.revision); assert.equal(saved.contentHash, hash(Buffer.from(content)));
  assert.deepEqual(await fs.readFile(target), Buffer.from(content)); assert.equal((await fs.stat(target)).mode & 0o777, 0o750);
  await assert.rejects(saveProjectFile(f.root, { path: 'note.md', revision: preview.revision, content: 'stale' }), { code: 'PROJECT_FILE_CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), content); await noTemporary(f.root);
});

test('save permits exactly 1 MiB of text and counts Unicode bytes while rejecting invalid Unicode', async t => {
  const f = await fixture(t); await f.file('limit.txt', 'old');
  const preview = await previewProjectFile(f.root, 'limit.txt');
  const content = '中'.repeat(Math.floor(PROJECT_FILE_LIMITS.textBytes / 3)) + 'x';
  assert.equal(Buffer.byteLength(content), PROJECT_FILE_LIMITS.textBytes);
  const saved = await saveProjectFile(f.root, { path: 'limit.txt', revision: preview.revision, content });
  assert.equal(saved.size, PROJECT_FILE_LIMITS.textBytes);
  await assert.rejects(saveProjectFile(f.root, { path: 'limit.txt', revision: saved.revision, content: content + '中' }), { code: 'PROJECT_FILE_TOO_LARGE' });
  for (const content of ['\ud800', 'binary\0text']) {
    await assert.rejects(saveProjectFile(f.root, { path: 'limit.txt', revision: saved.revision, content }), { code: 'BAD_REQUEST' });
  }
});

test('upload publishes exactly 10 MiB of binary data with status readback and no repeated-group regex failure', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(PROJECT_FILE_LIMITS.mediaBytes, 255);
  const result = await uploadProjectFile(f.root, upload('data.bin', bytes));
  assert.deepEqual(result, { path: 'data.bin', created: true, size: bytes.length, contentHash: hash(bytes) });
  assert.deepEqual(await inspectProjectFileStatus(f.root, 'data.bin'), { path: 'data.bin', size: bytes.length, contentHash: hash(bytes) });
  assert.deepEqual(await fs.readFile(path.join(f.root, 'data.bin')), bytes);
  await assert.rejects(uploadProjectFile(f.root, upload('oversize.bin', Buffer.alloc(bytes.length + 1))), { code: 'PROJECT_FILE_TOO_LARGE' });
  assert.deepEqual(await fs.readdir(f.root), ['data.bin']);
});

test('upload never replaces an existing ordinary file, directory, symlink or hardlink and creates no parents', async t => {
  const f = await fixture(t), target = await f.file('exists.txt', 'keep');
  await fs.mkdir(path.join(f.root, 'directory')); await fs.symlink('exists.txt', path.join(f.root, 'symlink.txt'));
  await fs.link(target, path.join(f.root, 'hardlink.txt'));
  for (const name of ['exists.txt', 'directory', 'symlink.txt', 'hardlink.txt']) {
    await assert.rejects(uploadProjectFile(f.root, upload(name, 'changed')), { code: 'PROJECT_FILE_EXISTS' });
  }
  await assert.rejects(uploadProjectFile(f.root, upload('absent/new.txt', 'new')), { code: 'PROJECT_FILE_NOT_FOUND' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep'); assert.equal(fsSync.existsSync(path.join(f.root, 'absent')), false);
  await noTemporary(f.root);
});

test('save refuses linked, unsupported and binary targets before replacing any bytes', async t => {
  const f = await fixture(t), ordinary = await f.file('original.txt', 'original');
  const revision = (await previewProjectFile(f.root, 'original.txt')).revision;
  await fs.symlink('original.txt', path.join(f.root, 'link.txt')); await fs.link(ordinary, path.join(f.root, 'hard.txt'));
  await f.file('binary.txt', Buffer.from([0, 255, 1])); await f.file('binary.bin', 'text');
  for (const name of ['original.txt', 'link.txt', 'hard.txt', 'binary.bin']) {
    await assert.rejects(saveProjectFile(f.root, { path: name, revision, content: 'changed' }), { code: 'PROJECT_FILE_FORBIDDEN' });
  }
  await assert.rejects(saveProjectFile(f.root, { path: 'binary.txt', revision, content: 'changed' }), { code: 'PROJECT_FILE_CONFLICT' });
  assert.equal(await fs.readFile(ordinary, 'utf8'), 'original'); await noTemporary(f.root);
});

test('write request validation excludes traversal, sensitive files, unknown keys and noncanonical base64', async t => {
  const f = await fixture(t);
  for (const name of ['../x.txt', '/tmp/x.txt', 'a//b', 'a\\b']) await assert.rejects(uploadProjectFile(f.root, upload(name, 'new')), { code: 'PROJECT_FILE_BAD_PATH' });
  for (const name of ['.env', '.git/config', 'secrets.json', '.hcc-file-write-test', 'sub/.aws/config']) {
    await assert.rejects(uploadProjectFile(f.root, upload(name, 'new')), { code: 'PROJECT_FILE_FORBIDDEN' });
  }
  for (const content of ['a', 'Zg', 'Zg=\n', 'Zh==', 'Zg===', '=Zg=', 'Zg==AAAA']) {
    await assert.rejects(uploadProjectFile(f.root, { path: 'new.txt', encoding: 'base64', content }), { code: 'BAD_REQUEST' });
  }
  await assert.rejects(uploadProjectFile(f.root, { ...upload('new.txt', 'new'), extra: true }), { code: 'BAD_REQUEST' });
  await assert.rejects(saveProjectFile(f.root, { path: 'new.txt', revision: 'invented', content: '' }), { code: 'BAD_REQUEST' });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('an external edit before publication conflicts and preserves the external bytes', async t => {
  const f = await fixture(t), target = await f.file('note.txt', 'before');
  const revision = (await previewProjectFile(f.root, 'note.txt')).revision;
  await assert.rejects(saveProjectFile(f.root, { path: 'note.txt', revision, content: 'ours' }, {
    spawnProcess: injected(beforePublish, "fs.writeFileSync(name, 'external');")
  }), { code: 'PROJECT_FILE_CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'external'); await noTemporary(f.root);
});

test('a file growing after its initial stat is read within the text bound and cannot be saved', async t => {
  const f = await fixture(t), target = await f.file('note.txt', 'before');
  const revision = (await previewProjectFile(f.root, 'note.txt')).revision;
  await assert.rejects(saveProjectFile(f.root, { path: 'note.txt', revision, content: 'ours' }, {
    spawnProcess: injected('const oldBytes =', "fs.truncateSync(name, 2097152); const oldBytes =")
  }), { code: 'PROJECT_FILE_CONFLICT' });
  assert.equal((await fs.stat(target)).size, 2097152); await noTemporary(f.root);
});

test('temporary path replacement is rejected before publishing the replacement inode', async t => {
  const f = await fixture(t);
  await assert.rejects(uploadProjectFile(f.root, upload('new.txt', 'good'), {
    spawnProcess: injected(beforePublish, "fs.renameSync(temporary, 'held.txt'); fs.writeFileSync(temporary, 'evil');")
  }), { code: 'PROJECT_FILE_CHANGED' });
  assert.equal(fsSync.existsSync(path.join(f.root, 'new.txt')), false);
  const attackerTemp = (await fs.readdir(f.root)).find(name => name.startsWith('.hcc-file-write-'));
  assert.equal(await fs.readFile(path.join(f.root, attackerTemp), 'utf8'), 'evil');
  assert.equal(await fs.readFile(path.join(f.root, 'held.txt'), 'utf8'), 'good');
});

test('a concurrent upload creator wins and is never overwritten', async t => {
  const f = await fixture(t);
  await assert.rejects(uploadProjectFile(f.root, upload('new.txt', 'ours'), {
    spawnProcess: injected(beforePublish, "fs.writeFileSync(name, 'external', { flag: 'wx' });")
  }), { code: 'PROJECT_FILE_EXISTS' });
  assert.equal(await fs.readFile(path.join(f.root, 'new.txt'), 'utf8'), 'external'); await noTemporary(f.root);
});

test('post-publication same-size in-place mutations cannot produce a false success receipt', async t => {
  const f = await fixture(t);
  await assert.rejects(uploadProjectFile(f.root, upload('new.txt', 'good'), {
    spawnProcess: injected(afterPublish, "fs.writeFileSync(name, 'evil');")
  }), { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
  assert.equal(await fs.readFile(path.join(f.root, 'new.txt'), 'utf8'), 'evil');
  assert.equal((await inspectProjectFileStatus(f.root, 'new.txt')).contentHash, hash('evil')); await noTemporary(f.root);
});

test('post-publication errors and lost responses retain published bytes for explicit status verification', async t => {
  const f = await fixture(t);
  for (const [name, spawnProcess] of [
    ['error.bin', injected(afterPublish, "throw new Error('injected fsync failure');")],
    ['lost.bin', (command, args, options) => { const result = spawnSync(command, args, options); return { ...result, stdout: '' }; }]
  ]) {
    const bytes = Buffer.from([0, 255, 3]);
    await assert.rejects(uploadProjectFile(f.root, upload(name, bytes), { spawnProcess }), { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
    assert.equal((await inspectProjectFileStatus(f.root, name)).contentHash, hash(bytes));
  }
  await noTemporary(f.root);
});

test('a rebound parent keeps mutations pinned to the original inode and reports an unconfirmed requested path', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'sub'));
  const oldParent = path.join(f.root, 'sub'), movedParent = path.join(f.root, 'moved');
  const code = 'fs.renameSync(' + JSON.stringify(oldParent) + ',' + JSON.stringify(movedParent) + ');' +
    'fs.mkdirSync(' + JSON.stringify(oldParent) + '); fs.writeFileSync(' + JSON.stringify(path.join(oldParent, 'sentinel.txt')) + ", 'keep');";
  await assert.rejects(uploadProjectFile(f.root, upload('sub/new.txt', 'ours'), { spawnProcess: injected(beforePublish, code) }), { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
  assert.deepEqual(await fs.readdir(oldParent), ['sentinel.txt']);
  assert.equal(await fs.readFile(path.join(movedParent, 'new.txt'), 'utf8'), 'ours'); await noTemporary(movedParent);
});

test('a selected root identity rejects replacement before a write and cannot claim success after a pinned-root replacement', async t => {
  const f = await fixture(t);
  for (const timing of ['before', 'after-pin']) {
    const root = path.join(f.root, timing), moved = root + '-moved'; await fs.mkdir(root);
    const rootIdentity = captureSelectedCwdIdentity(root);
    try {
      if (timing === 'before') {
        await fs.rename(root, moved); await fs.mkdir(root);
        await assert.rejects(uploadProjectFile(root, upload('new.txt', 'ours'), { rootIdentity }), { code: 'PROJECT_PATH_CHANGED' });
        assert.deepEqual(await fs.readdir(moved), []);
      } else {
        const code = 'fs.renameSync(' + JSON.stringify(root) + ',' + JSON.stringify(moved) + ');fs.mkdirSync(' + JSON.stringify(root) + ');';
        await assert.rejects(uploadProjectFile(root, upload('new.txt', 'ours'), {
          rootIdentity, spawnProcess: injected(beforePublish, code)
        }), { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
        assert.equal(await fs.readFile(path.join(moved, 'new.txt'), 'utf8'), 'ours');
      }
      assert.deepEqual(await fs.readdir(root), []);
    } finally { rootIdentity.release(); }
  }
});

test('lock release failure after successful publication returns unconfirmed and preserves the status receipt', async t => {
  const f = await fixture(t), original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...args) {
    const result = original.call(this, message, ...args);
    if (message?.type === 'release') throw Object.assign(new Error('injected release failure'), { code: 'ERR_FILE_LOCK_RELEASE_FAILED' });
    return result;
  };
  try {
    await assert.rejects(uploadProjectFile(f.root, upload('new.txt', 'published')), { code: 'PROJECT_FILE_WRITE_UNCONFIRMED' });
  } finally { Worker.prototype.postMessage = original; }
  assert.equal((await inspectProjectFileStatus(f.root, 'new.txt')).contentHash, hash('published')); await noTemporary(f.root);
});

test('two independent HCC processes saving the same preview allow only one winner', async t => {
  const f = await fixture(t); await f.file('race.txt', 'before');
  const revision = (await previewProjectFile(f.root, 'race.txt')).revision;
  const script = `import { saveProjectFile } from ${JSON.stringify(new URL('../lib/web/project-file-write.mjs', import.meta.url).href)};
    try { const value = await saveProjectFile(process.argv[1], JSON.parse(process.argv[2])); console.log(JSON.stringify(value)); }
    catch (error) { console.log(JSON.stringify({ error: error.code })); }`;
  const run = content => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root, JSON.stringify({ path: 'race.txt', revision, content })]);
    let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(errors)); else resolve(JSON.parse(output)); });
  });
  const results = await Promise.all([run('first'), run('second')]);
  assert.equal(results.filter(result => result.saved).length, 1, JSON.stringify(results));
  assert.ok(['PROJECT_FILE_CONFLICT', 'PROJECT_FILE_CHANGED'].includes(results.find(result => result.error)?.error), JSON.stringify(results));
  assert.ok(['first', 'second'].includes(await fs.readFile(path.join(f.root, 'race.txt'), 'utf8'))); await noTemporary(f.root);
});

test('write routes retain auth, API version, origin and selected-project boundaries', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.file('note.txt', 'first'); await second.file('note.txt', 'second');
  const { handleWebRequest } = createHttpRoutes({ ctx: { root: first.root }, sessions: new Map(), token: 'fixture-token',
    webAuthMode: (_url, req) => req.headers.authorization === 'Bearer fixture-token' ? 'token' : null,
    cookieSessionOk: req => req.headers.cookie === 'fixture-session', projectFromRequest: (_req, url) => {
      const selected = url.searchParams.get('root');
      if (selected && selected !== 'second') throw new CliError('PROJECT_FILE_FORBIDDEN', 'Select a registered project');
      return { root: selected === 'second' ? second.root : first.root };
    }, webErrorStatus: () => 500 });
  const server = http.createServer(handleWebRequest); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer fixture-token', 'X-HCC-API-Version': '2', 'Content-Type': 'application/json' };
  const body = JSON.stringify(upload('new.bin', Buffer.from([0, 255, 1])));
  assert.equal((await fetch(base + '/api/files/upload', { method: 'POST', headers: { 'X-HCC-API-Version': '2' }, body })).status, 401);
  assert.equal((await fetch(base + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer fixture-token' }, body })).status, 426);
  assert.equal((await fetch(base + '/api/files/upload', { method: 'POST', headers: { ...headers, Cookie: 'fixture-session', Origin: 'https://untrusted.invalid' }, body })).status, 403);
  const created = await fetch(base + '/api/files/upload?root=second', { method: 'POST', headers, body });
  assert.equal(created.status, 201); const receipt = await created.json(); assert.equal(receipt.created, true);
  assert.equal(fsSync.existsSync(path.join(first.root, 'new.bin')), false);
  const status = await fetch(base + '/api/files/status?root=second&path=new.bin', { headers });
  assert.equal(status.status, 200); assert.equal((await status.json()).contentHash, receipt.contentHash);
  const revision = (await previewProjectFile(second.root, 'note.txt')).revision;
  const saved = await fetch(base + '/api/files/content?root=second', { method: 'PUT', headers, body: JSON.stringify({ path: 'note.txt', revision, content: 'updated' }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).saved, true);
  assert.equal(await fs.readFile(path.join(first.root, 'note.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(second.root, 'note.txt'), 'utf8'), 'updated');
  assert.equal((await fetch(base + '/api/files/upload?root=second', { method: 'POST', headers, body })).status, 409);
});
