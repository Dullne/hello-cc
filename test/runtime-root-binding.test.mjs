import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('a recreated project path cannot read, replace, or clear the old private runtime pointer', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX private project state required');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-binding-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o777 });
  fs.chmodSync(root, 0o777);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const repo = process.env.HCC_TEST_REPO;
    const root = process.env.HCC_TEST_ROOT;
    const { writeRuntime, readRuntimeFile, clearRuntime } = await import(pathToFileURL(path.join(repo, 'lib/runtime/state.mjs')));
    const { runtimePath } = await import(pathToFileURL(path.join(repo, 'lib/runtime/paths.mjs')));
    const ctx = { root };
    const pointer = writeRuntime(ctx, { pid: process.pid, base_url: 'http://127.0.0.1:1' });
    assert.equal(pointer, runtimePath(ctx));
    const original = fs.readFileSync(pointer);
    fs.renameSync(root, root + '-old');
    fs.mkdirSync(root, { mode: 0o777 });
    fs.chmodSync(root, 0o777);
    assert.throws(() => readRuntimeFile(ctx), { code: 'PROJECT_PATH_FORBIDDEN' });
    assert.throws(() => writeRuntime(ctx, { pid: process.pid, base_url: 'http://127.0.0.1:2' }),
      { code: 'PROJECT_PATH_FORBIDDEN' });
    clearRuntime(ctx, process.pid);
    assert.deepEqual(fs.readFileSync(pointer), original);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, HCC_TEST_REPO: repo, HCC_TEST_ROOT: root },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a project symlink alias cannot redirect a validated runtime operation to another project', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX project symlinks required');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-alias-'));
  const home = path.join(sandbox, 'home');
  const shared = path.join(sandbox, 'shared');
  const rootA = path.join(shared, 'project-a');
  const rootB = path.join(shared, 'project-b');
  const alias = path.join(shared, 'project');
  for (const directory of [home, shared, rootA, rootB]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(shared, 0o777);
  fs.symlinkSync(rootA, alias);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const script = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const repo = process.env.HCC_TEST_REPO;
    const { rootA, rootB, alias } = JSON.parse(process.env.HCC_TEST_PATHS);
    const { writeRuntime, readRuntimeFile, clearRuntime } = await import(pathToFileURL(path.join(repo, 'lib/runtime/state.mjs')));
    const { runtimePath } = await import(pathToFileURL(path.join(repo, 'lib/runtime/paths.mjs')));
    const ctx = { root: alias };
    const canonicalA = fs.realpathSync(rootA);
    const value = (name) => ({ pid: process.pid, base_url: 'http://127.0.0.1/' + name });
    const rebind = (root) => { fs.unlinkSync(alias); fs.symlinkSync(root, alias); };
    const fileA = writeRuntime({ root: rootA }, value('a'));
    const fileB = writeRuntime({ root: rootB }, value('b'));
    assert.equal(runtimePath(ctx), fileA); // An unchanged alias is supported.

    const originalLstat = fs.lstatSync;
    let switched = 0;
    fs.lstatSync = function(target, ...args) {
      if (!switched && path.resolve(String(target)) === fileA) {
        switched++;
        rebind(rootB); // Last target inspection, after root/state validation.
      }
      return originalLstat.call(this, target, ...args);
    };
    let written;
    try { written = writeRuntime(ctx, value('a-updated')); }
    finally { fs.lstatSync = originalLstat; }
    assert.equal(switched, 1);
    assert.equal(written, fileA);
    assert.equal(readRuntimeFile({ root: rootA }).base_url, value('a-updated').base_url);
    assert.equal(readRuntimeFile({ root: rootB }).base_url, value('b').base_url);

    const originalStat = fs.statSync;
    const switchDuringValidation = (action) => {
      rebind(rootA);
      let hit = 0;
      fs.statSync = function(target, ...args) {
        const result = originalStat.call(this, target, ...args);
        if (!hit && path.resolve(String(target)) === canonicalA) {
          hit++;
          rebind(rootB); // Root A is now fixed; the alias moves during validation.
        }
        return result;
      };
      try { return { result: action(), hit }; }
      finally { fs.statSync = originalStat; }
    };
    const read = switchDuringValidation(() => readRuntimeFile(ctx));
    assert.equal(read.hit, 1);
    assert.equal(read.result.base_url, value('a-updated').base_url);

    const cleared = switchDuringValidation(() => clearRuntime(ctx, process.pid));
    assert.equal(cleared.hit, 1);
    assert.equal(fs.existsSync(fileA), false);
    assert.equal(readRuntimeFile({ root: rootB }).base_url, value('b').base_url);

    // A custom DB is valid even when the unused default mesh.db is unsafe.
    const unusedMeshDb = path.join(path.dirname(fileA), 'mesh.db');
    fs.symlinkSync(fileB, unusedMeshDb);
    const customDb = path.join(path.dirname(fileA), 'custom.db');
    assert.equal(writeRuntime({ root: rootA, dbPath: customDb }, value('custom')), fileA);
    assert.equal(readRuntimeFile({ root: rootA }).base_url, value('custom').base_url);

    if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0) {
      const { createWebStartup } = await import(pathToFileURL(path.join(repo, 'lib/web/startup.mjs')));
      rebind(rootA);
      const nestedAliasDb = path.join(alias, '.hello-cc', 'nested', 'mesh.db');
      const startup = createWebStartup({
        CLI_NAME: 'hcc', PRODUCT_NAME: 'hello-cc',
        redactedLogText: (text) => text,
        splitProcessArgs: (text) => text.split(/\\s+/),
        sameResolvedPath: (left, right) => path.resolve(left || '') === path.resolve(right || ''),
        prepareLocalBus: async (preparedCtx) => {
          assert.equal(preparedCtx.root, canonicalA);
          assert.equal(preparedCtx.dbPath, path.join(path.dirname(fileA), 'nested', 'mesh.db'));
          rebind(rootB); // Rebind during the asynchronous setup step.
          return { warnings: [], shims: { installed: [] } };
        }
      });
      await assert.rejects(
        startup.startWebBackground({ ...ctx, dbPath: nestedAliasDb }, ['--local', '--no-token']),
        { code: 'PROJECT_PATH_CHANGED' }
      );
      assert.equal(readRuntimeFile({ root: rootB }).base_url, value('b').base_url);

      rebind(rootA);
      const externalDb = path.join(path.dirname(path.dirname(rootA)), 'external.db');
      const prepared = new Error('external DB setup reached');
      const externalStartup = createWebStartup({
        CLI_NAME: 'hcc', PRODUCT_NAME: 'hello-cc',
        redactedLogText: (text) => text,
        prepareLocalBus: async (preparedCtx) => {
          assert.equal(preparedCtx.root, canonicalA);
          assert.equal(preparedCtx.dbPath, externalDb);
          throw prepared;
        }
      });
      await assert.rejects(
        externalStartup.startWebBackground({ ...ctx, dbPath: externalDb }, ['--local', '--no-token']),
        (error) => error === prepared
      );
    }
    fs.unlinkSync(unusedMeshDb);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env, HOME: home, HCC_TEST_REPO: repo,
      HCC_TEST_PATHS: JSON.stringify({ rootA, rootB, alias }),
      HCC_NO_AUTO_INSTALL_TMUX: '1'
    },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
