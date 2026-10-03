import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../lib/runtime/private-state.mjs', import.meta.url));
const childCode = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(process.env.HCC_PRIVATE_STATE_MODULE).href);
const { action, root, options } = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  if (action === 'fail-authority-publish' || action === 'fail-manifest-publish') {
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if ((action === 'fail-authority-publish' && target.endsWith('.authority.json')) ||
          (action === 'fail-manifest-publish' && target.endsWith('/.project-root.json'))) {
        throw Object.assign(new Error('injected failure'), { code: 'EIO' });
      }
      return rename(source, target);
    };
  }
  const value = action === 'path' ? api.privateProjectStateDir(root)
    : action === 'base' ? api.privateStateBaseDir()
    : action === 'global' ? api.validatedGlobalStateDir()
    : api.ensurePrivateProjectStateDir(root, options);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`;

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hcc-private-store-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o755 });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, home, root };
}

function invoke(f, action, root = f.root, options = undefined) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    input: JSON.stringify({ action, root, options }),
    env: { ...process.env, HOME: f.home, HCC_PRIVATE_STATE_MODULE: modulePath },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function value(result) {
  assert.equal(result.ok, true, result.message);
  return result.value;
}

function denied(result, code = 'PROJECT_PATH_FORBIDDEN') {
  assert.equal(result.ok, false);
  assert.equal(result.code, code, result.message);
}

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

test('path derivation is read-only, hashes canonical roots, and uses lexical missing roots', (t) => {
  const f = fixture(t);
  const alias = path.join(f.sandbox, 'alias');
  fs.symlinkSync(f.root, alias, 'dir');
  const expected = path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(fs.realpathSync(f.root)).digest('hex'));
  assert.equal(value(invoke(f, 'base')), path.join(f.home, '.hello-cc'));
  assert.equal(value(invoke(f, 'path')), expected);
  assert.equal(value(invoke(f, 'path', alias)), expected);
  const missing = path.join(f.sandbox, 'missing');
  assert.equal(value(invoke(f, 'path', missing)), path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(path.resolve(missing)).digest('hex')));
  denied(invoke(f, 'ensure', missing), 'PROJECT_NOT_REGISTERED');
  assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
});

test('pure path derivation tolerates a missing HOME without creating it', (t) => {
  const f = fixture(t);
  fs.rmdirSync(f.home);
  assert.equal(value(invoke(f, 'base')), path.join(f.home, '.hello-cc'));
  assert.equal(value(invoke(f, 'path')), path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(fs.realpathSync(f.root)).digest('hex')));
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(f.home), false);
});

test('read-only lookup never creates or chmods; create establishes 0700 store and inode manifest', (t) => {
  const f = fixture(t);
  const base = path.join(f.home, '.hello-cc');
  assert.equal(value(invoke(f, 'ensure')), null);
  assert.equal(fs.existsSync(base), false);
  fs.mkdirSync(base, { mode: 0o755 });
  assert.equal(value(invoke(f, 'ensure')), null);
  assert.equal(mode(base), 0o755);

  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(directory, value(invoke(f, 'path')));
  assert.equal(mode(base), 0o700);
  assert.equal(mode(path.dirname(directory)), 0o700);
  assert.equal(mode(directory), 0o700);
  const manifestPath = path.join(directory, '.project-root.json');
  assert.equal(mode(manifestPath), 0o600);
  const stat = fs.statSync(f.root, { bigint: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    version: 1,
    canonicalRoot: fs.realpathSync(f.root),
    dev: stat.dev.toString(),
    ino: stat.ino.toString()
  });

  fs.chmodSync(base, 0o755);
  assert.equal(value(invoke(f, 'ensure')), directory);
  assert.equal(mode(base), 0o755);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(mode(base), 0o700);
});

test('interrupted first authority publication leaves no partial final marker and can be retried', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  denied(invoke(f, 'fail-authority-publish', f.root, { create: true }));
  assert.equal(fs.existsSync(`${directory}.authority.json`), false);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readdirSync(path.dirname(directory)).some((name) => name.includes('.authority.json.tmp-')), false);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'fresh');
});

test('direct private-state initialization refuses an unmigrated legacy store', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'mesh.db'), 'old-data', { mode: 0o600 });
  denied(invoke(f, 'ensure', f.root, { create: true }), 'STATE_MIGRATION_REQUIRED');
  const privateDir = value(invoke(f, 'path'));
  assert.equal(fs.existsSync(privateDir), false);
  assert.equal(fs.existsSync(`${privateDir}.authority.json`), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'mesh.db'), 'utf8'), 'old-data');
});

test('interrupted manifest publication leaves an empty pending directory that can be retried', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  denied(invoke(f, 'fail-manifest-publish', f.root, { create: true }));
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'pending');
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'fresh');
});

test('a writable project root is accepted but replacement at the same path cannot reuse state', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  assert.equal(value(invoke(f, 'path')), directory);
  denied(invoke(f, 'ensure'));
  denied(invoke(f, 'ensure', f.root, { create: true }));
});

test('an uncommitted nonempty state directory is never adopted', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'partial.db'), 'sentinel');
  denied(invoke(f, 'ensure'));
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(path.join(directory, '.project-root.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'partial.db'), 'utf8'), 'sentinel');
});

test('store and manifest symlinks are rejected without touching targets', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  const base = path.join(f.home, '.hello-cc');
  fs.symlinkSync(external, base, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.deepEqual(fs.readdirSync(external), []);
  fs.unlinkSync(base);

  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  const manifestPath = path.join(directory, '.project-root.json');
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'untouched', { mode: 0o600 });
  fs.unlinkSync(manifestPath);
  fs.symlinkSync(sentinel, manifestPath, 'file');
  denied(invoke(f, 'ensure'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('projects and per-project directories cannot be symlinks', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  const directory = value(invoke(f, 'path'));
  const projects = path.dirname(directory);
  fs.mkdirSync(path.dirname(projects), { mode: 0o700 });
  fs.symlinkSync(external, projects, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  fs.unlinkSync(projects);
  fs.mkdirSync(projects, { mode: 0o700 });
  fs.symlinkSync(external, directory, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.deepEqual(fs.readdirSync(external), []);
});

test('manifest hardlinks are refused', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.linkSync(path.join(directory, '.project-root.json'), path.join(f.sandbox, 'linked-manifest'));
  denied(invoke(f, 'ensure'));
});

test('nonsticky writable home ancestry is refused; sticky /tmp with an owned child is safe', (t) => {
  const f = fixture(t);
  const unsafe = path.join(f.sandbox, 'writable');
  fs.mkdirSync(unsafe, { mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  const badHome = path.join(unsafe, 'home');
  fs.mkdirSync(badHome, { mode: 0o700 });
  denied(invoke({ ...f, home: badHome }, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(path.join(badHome, '.hello-cc')), false);

  const stickyParent = fs.realpathSync('/tmp');
  if ((fs.statSync(stickyParent).mode & 0o1777) !== 0o1777) return;
  const stickySandbox = fs.mkdtempSync(path.join(stickyParent, 'hcc-private-sticky-'));
  t.after(() => fs.rmSync(stickySandbox, { recursive: true, force: true }));
  const stickyHome = path.join(stickySandbox, 'home');
  fs.mkdirSync(stickyHome, { mode: 0o700 });
  const result = invoke({ ...f, home: stickyHome }, 'ensure', f.root, { create: true });
  assert.equal(mode(value(result)), 0o700);
});

test('global state path rejects a writable or redirected parent before exposing runtime pointers', (t) => {
  const f = fixture(t);
  const global = path.join(f.home, '.hello-cc');
  assert.equal(value(invoke(f, 'global')), global);
  assert.equal(fs.existsSync(global), false);
  fs.mkdirSync(global, { mode: 0o700 });
  assert.equal(value(invoke(f, 'global')), global);
  fs.chmodSync(global, 0o777);
  denied(invoke(f, 'global'));
  fs.rmSync(global, { recursive: true });
  const outside = path.join(f.sandbox, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, global, 'dir');
  denied(invoke(f, 'global'));
});
