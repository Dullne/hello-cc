import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const childCode = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.HCC_TEST_REPO;
const load = (name) => import(pathToFileURL(path.join(repo, name)).href);
const { root, action } = JSON.parse(fs.readFileSync(0, 'utf8'));
const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
try {
  let value;
  if (action === 'state-path') {
    const { projectStateDir } = await load('lib/runtime/paths.mjs');
    value = projectStateDir(root);
  } else if (action === 'native-read' || action === 'native-write') {
    const { nativePaths, createNativeStore, writeNativePointer } = await load('lib/runtime/native/store.mjs');
    if (action === 'native-read') value = nativePaths(ctx);
    else {
      const store = createNativeStore(ctx);
      store.close();
      const paths = nativePaths(ctx);
      writeNativePointer(ctx, { root: fs.realpathSync(root), meshDb: path.resolve(ctx.dbPath),
        port: 12345, token: 'token'.repeat(10), generation: 'test' });
      value = paths;
    }
  } else if (action === 'dsh-write') {
    const { ensureDshIntegration } = await load('lib/integrations/dsh.mjs');
    value = ensureDshIntegration(ctx, { hccBin: path.join(repo, 'bin/hcc.mjs') });
  } else if (action === 'guidance-write') {
    const { writeGuidance } = await load('lib/guidance.mjs');
    value = writeGuidance(root);
  } else if (action === 'buffer-read') {
    const { collectBufferEvidence } = await load('lib/runtime/buffer-evidence.mjs');
    const { projectStateDir } = await load('lib/runtime/paths.mjs');
    const bufs = path.join(projectStateDir(root), 'bufs');
    const result = collectBufferEvidence({
      directories: [bufs],
      projectDbs: [{ ctx, db: { prepare: () => ({ all: () => [{ id: 'peer', status: 'running',
        transport: 'tmux', runtime_target: 'pane', runtime_session_id: 'run' }] }) } }],
      observePeer: () => ({ state: 'live' })
    });
    value = [...result.protectedPaths];
  } else if (action === 'purge') {
    const { createInstallCommands } = await load('lib/cli/commands/install.mjs');
    const { parseOpts } = await load('lib/cli-args.mjs');
    const { CliError } = await load('lib/shared/errors.mjs');
    const commands = createInstallCommands({
      path, fs, CliError, parseOpts,
      readRuntime: () => null,
      loadSetup: async () => ({ uninstallClaudeHooks: () => false,
        uninstallCodexHooks: () => false, uninstallShims: () => [],
        uninstallPathEntry: () => ({ missing: true, rcFile: '.zshrc' }) }),
      removeGuidanceBlocks: () => [],
      printResult: (_ctx, data, format) => { value = { data, message: format(data) }; }
    });
    await commands.cmdUninstall(ctx, ['--purge', '--yes']);
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`;

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-secondary-state-'));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(root, { mode: 0o777 });
  fs.chmodSync(root, 0o777);
  fs.mkdirSync(home, { mode: 0o700 });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, root, home };
}

function invoke(f, action) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    input: JSON.stringify({ root: f.root, action }),
    env: { ...process.env, HOME: f.home, HCC_TEST_REPO: repo },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
}

function succeeded(result) {
  assert.equal(result.ok, true, result.message);
  return result.value;
}

test('unsafe roots require offline migration before secondary state access', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX root permissions required');
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'sentinel'), 'legacy');
  for (const action of ['native-read', 'native-write', 'dsh-write', 'guidance-write', 'buffer-read', 'purge']) {
    const result = invoke(f, action);
    assert.equal(result.code, 'STATE_MIGRATION_REQUIRED', `${action}: ${result.message}`);
  }
  assert.equal(fs.readFileSync(path.join(legacy, 'sentinel'), 'utf8'), 'legacy');
  assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
});

test('secondary native, dsh, guidance, and buffer paths use the private binding', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX root permissions required');
  const f = fixture(t);
  const guidance = succeeded(invoke(f, 'guidance-write'));
  const privateState = path.dirname(guidance);
  assert.ok(privateState.startsWith(path.join(fs.realpathSync(f.home), '.hello-cc', 'projects') + path.sep));
  const native = succeeded(invoke(f, 'native-write'));
  const dsh = succeeded(invoke(f, 'dsh-write'));
  assert.equal(native.dir, path.join(privateState, 'native'));
  assert.equal(dsh.hooksPath, path.join(privateState, 'dsh', 'hooks.json'));
  assert.equal(fs.existsSync(native.db), true);
  assert.equal(fs.existsSync(native.pointer), true);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  fs.mkdirSync(path.join(privateState, 'bufs'));
  const protectedPaths = succeeded(invoke(f, 'buffer-read'));
  assert.ok(protectedPaths.includes(path.join(privateState, 'bufs', 'tmux-pane-run.pipe')));
});

test('ordinary hook delivery creates its database in the private store', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX root permissions required');
  const f = fixture(t);
  const privateState = path.dirname(succeeded(invoke(f, 'guidance-write')));
  const env = { ...process.env, HOME: f.home };
  for (const name of ['HCC_ROOT', 'HCC_DB', 'HCC_PEER', 'HCC_NATIVE_OWNER']) delete env[name];
  const hook = spawnSync(process.execPath, [path.join(repo, 'bin/hcc.mjs'), '--root', f.root,
    'hook', 'sessionstart', '--provider', 'claude'], {
    cwd: f.root, env, encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'private-state-test', cwd: f.root })
  });
  assert.equal(hook.status, 0, hook.stderr || hook.error?.message);
  assert.equal(fs.existsSync(path.join(privateState, 'mesh.db')), true);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
});

test('manual GC sees the selected private buffer directory', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX root permissions required');
  const f = fixture(t);
  const env = { ...process.env, HOME: f.home };
  for (const name of ['HCC_ROOT', 'HCC_DB', 'HCC_PEER', 'HCC_RUNTIME_URL']) delete env[name];
  const cli = (...args) => spawnSync(process.execPath,
    [path.join(repo, 'bin/hcc.mjs'), '--root', f.root, ...args], {
      cwd: f.root, env, encoding: 'utf8', timeout: 10000
    });
  const init = cli('init', '--no-guidance');
  assert.equal(init.status, 0, init.stderr || init.error?.message);
  const state = succeeded(invoke(f, 'state-path'));
  const bufs = path.join(state, 'bufs');
  fs.mkdirSync(bufs);
  const old = path.join(bufs, 'orphan.out');
  fs.writeFileSync(old, 'old buffer');
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
  const gc = cli('gc', '--older-than', '1', '--yes');
  assert.equal(gc.status, 0, gc.stderr || gc.error?.message);
  assert.match(gc.stdout, /buffer files(?: deferred)?:\s+1/);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
});

test('purge removes selected private state but preserves a remaining legacy source', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX root permissions required');
  const f = fixture(t);
  const privateState = path.dirname(succeeded(invoke(f, 'guidance-write')));
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'sentinel'), 'legacy');
  const result = succeeded(invoke(f, 'purge'));
  assert.equal(result.data.purge, true);
  assert.equal(fs.existsSync(privateState), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'sentinel'), 'utf8'), 'legacy');
  assert.match(result.message, /legacy project data kept/);
});
