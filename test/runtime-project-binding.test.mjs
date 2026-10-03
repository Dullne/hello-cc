import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const driver = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const { repo, root, scenario } = JSON.parse(process.argv[1]);
  const load = relative => import(pathToFileURL(path.join(repo, relative)).href);
  const state = await load('lib/runtime/state.mjs');
  const { ensurePrivateProjectStateDir } = await load('lib/runtime/private-state.mjs');
  const { runtimePath, webLogPath, projectRegistryPath } = await load('lib/runtime/paths.mjs');
  const directory = ensurePrivateProjectStateDir(root, { create: true });
  const ctx = { root, cwd: root, dbPath: path.join(directory, 'mesh.db'), json: true };
  const identity = { pid: process.pid, startToken: 'binding-probe', commandHash: 'a'.repeat(64) };
  const runtime = { pid: process.pid, process_identity: identity, base_url: 'http://127.0.0.1:1', marker: 'old-project' };
  state.writeRuntime(ctx, runtime);
  const pointer = runtimePath(ctx);
  const original = fs.readFileSync(pointer);
  const inspectProcessIdentity = () => ({ state: 'live', identity });
  assert.equal(state.readRuntime(ctx, { localOnly: true, inspectProcessIdentity }).marker, 'old-project');
  assert.deepEqual(state.readRuntimeFile(ctx), runtime);
  const manifest = fs.readFileSync(path.join(directory, '.project-root.json'));
  const authority = fs.readFileSync(directory + '.authority.json');
  const oldRoot = fs.statSync(root, { bigint: true });
  function replaceRoot() {
    fs.renameSync(root, root + '.retired');
    fs.mkdirSync(root, { mode: 0o777 });
    fs.chmodSync(root, 0o777);
    assert.notEqual(fs.statSync(root, { bigint: true }).ino, oldRoot.ino);
    assert.equal(runtimePath(ctx), pointer);
  }
  if (scenario === 'startup') {
    const { createWebStartup } = await load('lib/web/startup.mjs');
    const log = webLogPath(ctx);
    fs.writeFileSync(log, 'old-project-log', { mode: 0o600 });
    let entered, release;
    const prepared = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const startup = createWebStartup({
      CLI_NAME: 'hcc', PRODUCT_NAME: 'hello-cc', now: () => 1,
      redactedLogText: value => value,
      splitProcessArgs: line => line.split(/\s+/),
      sameResolvedPath: (left, right) => Boolean(left && right) && path.resolve(left) === path.resolve(right),
      async prepareLocalBus() { entered(); await resume; return {}; }
    });
    // If a regression reaches the old log, fail before any background child
    // could be launched. The real startup path and await boundary still run.
    const open = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (file === log) throw new Error('startup reached the retired project log');
      return open(file, ...args);
    };
    const starting = startup.startWebBackground(ctx, ['--local', '--no-token', '--no-guidance', '--no-discover']);
    await prepared;
    replaceRoot();
    release();
    await assert.rejects(starting, { code: 'PROJECT_PATH_FORBIDDEN' });
    fs.openSync = open;
    assert.equal(fs.readFileSync(log, 'utf8'), 'old-project-log');
    assert.equal(fs.existsSync(projectRegistryPath()), false);
  } else {
    replaceRoot();
    if (scenario === 'read') {
      assert.throws(() => state.readRuntime(ctx, { localOnly: true, inspectProcessIdentity }), { code: 'PROJECT_PATH_FORBIDDEN' });
    } else if (scenario === 'read-file') {
      assert.throws(() => state.readRuntimeFile(ctx), { code: 'PROJECT_PATH_FORBIDDEN' });
    } else if (scenario === 'write') {
      assert.throws(() => state.writeRuntime(ctx, { ...runtime, marker: 'replacement-project' }), { code: 'PROJECT_PATH_FORBIDDEN' });
    } else if (scenario === 'clear') {
      state.clearRuntime(ctx, process.pid);
    } else throw new Error('unknown scenario');
  }
  assert.deepEqual(fs.readFileSync(pointer), original);
  assert.deepEqual(fs.readFileSync(path.join(directory, '.project-root.json')), manifest);
  assert.deepEqual(fs.readFileSync(directory + '.authority.json'), authority);
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
  process.stdout.write('BINDING_PRESERVED');
`;

for (const scenario of ['read', 'read-file', 'write', 'clear', 'startup']) {
  test(`a replaced project root cannot ${scenario} its previous runtime state`, {
    timeout: 20_000,
    skip: process.platform === 'win32'
  }, (t) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-binding-'));
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
    const home = path.join(sandbox, 'home');
    const root = path.join(sandbox, 'shared-project');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(root, { mode: 0o777 });
    fs.chmodSync(root, 0o777);
    const env = { ...process.env, HOME: home, NODE_NO_WARNINGS: '1' };
    for (const name of Object.keys(env)) if (name.startsWith('HCC_')) delete env[name];
    env.HCC_SKIP_SHIM_INSTALL = '1';
    env.HCC_NO_AUTO_INSTALL_TMUX = '1';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver,
      JSON.stringify({ repo, root, scenario })], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    assert.equal(result.stdout, 'BINDING_PRESERVED');
  });
}
