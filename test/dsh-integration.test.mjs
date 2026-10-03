import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDshCommands } from '../lib/cli/commands/dsh.mjs';
import {
  createDshEnvironment, ensureDshIntegration, inspectDshIntegration,
  resolveDshBinary, launchDshWeb, DSH_HOOK_EVENTS
} from '../lib/integrations/dsh.mjs';

const cleanup = [];
const hccBin = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
test.afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporary(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-dsh-${label}-`));
  cleanup.push(directory);
  return directory;
}

function context(root) { return { root, cwd: root, json: false }; }
function configure(root, options = {}) { return ensureDshIntegration(context(root), { hccBin, ...options }); }
function inspect(root, options = {}) { return inspectDshIntegration(context(root), { hccBin, ...options }); }
function assertConflict(fn) { assert.throws(fn, (error) =>
  ['DSH_CONFIG_CONFLICT', 'PROJECT_PATH_FORBIDDEN'].includes(error.code)); }

test('setup writes verified project-local hooks and overlay, then remains idempotent', () => {
  const root = temporary('setup');
  const first = configure(root);
  const stat = fs.statSync(first.hooksPath);
  assert.equal(first.changed.length, 3);
  assert.equal(first.root, fs.realpathSync(root));
  assert.equal(stat.mode & 0o777, 0o600);
  const hooks = JSON.parse(fs.readFileSync(first.hooksPath, 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), [...DSH_HOOK_EVENTS]);
  for (const event of DSH_HOOK_EVENTS) {
    assert.match(hooks[event][0].hooks[0].command, new RegExp(`hook ${event.toLowerCase()} --provider dsh$`));
  }
  const patch = fs.readFileSync(first.patchPath, 'utf8');
  assert.match(patch, /- insert:\n    - id: hello-cc-dsh-hooks\n      name: "@deepseek-ai\/dsh-hooks-claude-code"/);
  assert.equal(JSON.parse(patch.match(/configPath: (.+)/)[1]), first.hooksPath);
  assert.doesNotMatch(patch, /projectDir:/);
  assert.equal(inspect(root).ready, true);
  const second = configure(root);
  assert.deepEqual(second.changed, []);
  assert.equal(fs.statSync(first.hooksPath).mtimeMs, stat.mtimeMs);
});

test('status is read-only and reports incomplete setup until all managed content is present', () => {
  const root = temporary('status');
  assert.equal(inspect(root).state, 'missing');
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
  const setup = configure(root);
  fs.unlinkSync(setup.patchPath);
  assert.deepEqual(inspect(root).missing, ['cordis.patch.yml']);
  assert.deepEqual(configure(root).changed, [setup.patchPath]);
  assert.equal(inspect(root).ready, true);
  fs.unlinkSync(setup.manifestPath);
  assert.equal(inspect(root).ready, false);
  assert.deepEqual(configure(root).changed, [setup.manifestPath]);
});

test('refresh accepts only intact previously generated content', () => {
  const root = temporary('refresh');
  configure(root, { hccBin: path.join(root, 'old-hcc.mjs') });
  assert.equal(inspect(root).state, 'refresh-needed');
  assert.equal(configure(root).changed.length, 2);
  assert.equal(inspect(root).ready, true);
});

test('modified and foreign artifacts are preserved and status detects conflict', () => {
  for (const name of ['hooks.json', 'cordis.patch.yml', 'managed.json']) {
    const root = temporary(`edited-${name}`);
    configure(root);
    const file = path.join(root, '.hello-cc', 'dsh', name);
    const edited = fs.readFileSync(file, 'utf8') + '\n';
    fs.writeFileSync(file, edited);
    assertConflict(() => configure(root));
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
    assert.equal(inspect(root).state, 'conflict');
  }
  const root = temporary('foreign');
  const directory = path.join(root, '.hello-cc', 'dsh');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'hooks.json'), '{"hooks":{}}\n');
  assertConflict(() => configure(root));
  assert.equal(fs.existsSync(path.join(directory, 'managed.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'hooks.json'), 'utf8'), '{"hooks":{}}\n');
});

test('setup refuses state/dsh/file symlinks and preserves their outside targets', () => {
  for (const location of ['state', 'dsh', 'file']) {
    const root = temporary(`symlink-${location}`);
    const outside = temporary(`outside-${location}`);
    const sentinel = path.join(outside, 'hooks.json');
    fs.writeFileSync(sentinel, 'outside-sentinel');
    const state = path.join(root, '.hello-cc');
    const directory = path.join(state, 'dsh');
    if (location === 'state') fs.symlinkSync(outside, state, 'dir');
    if (location === 'dsh') {
      fs.mkdirSync(state);
      fs.symlinkSync(outside, directory, 'dir');
    }
    if (location === 'file') {
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(sentinel, path.join(directory, 'hooks.json'), 'file');
    }
    assertConflict(() => configure(root));
    assert.equal(inspect(root).state, 'conflict');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-sentinel');
    assert.equal(fs.existsSync(path.join(outside, 'managed.json')), false);
  }
});

test('generated hook commands quote special paths and execute exactly the hcc argv', () => {
  const container = temporary('quoted');
  const root = path.join(container, "project ' $(`printf unsafe`) with spaces");
  fs.mkdirSync(root);
  const script = path.join(root, "hcc '$`().mjs");
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const setup = configure(root, { hccBin: script });
  const command = JSON.parse(fs.readFileSync(setup.hooksPath, 'utf8')).hooks.SessionStart[0].hooks[0].command;
  const result = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['hook', 'sessionstart', '--provider', 'dsh']);
  const patch = fs.readFileSync(setup.patchPath, 'utf8');
  assert.equal(JSON.parse(patch.match(/configPath: (.+)/)[1]), setup.hooksPath);
});

test('dsh launch env removes ambient agent identity while preserving credentials and home', () => {
  const original = { PATH: '/bin', HCC_PEER: 'parent', HCC_ROOT: '/wrong', HCC_DB: '/wrong/mesh.db',
    HCC_RUNTIME_URL: 'http://wrong', CLAUDECODE: '1', CLAUDE_SESSION_ID: 'claude-id',
    CLAUDE_CODE_SESSION_ID: 'claude-code-id', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_BY_BUN: '1',
    CLAUDE_PROJECT_DIR: '/wrong', CODEX_THREAD_ID: 'codex-id', CODEX_PARENT_THREAD_ID: 'parent',
    DSH_HOME: '/private/dsh', DEEPSEEK_API_KEY: 'fake-dsh-key', OPENAI_API_KEY: 'fake-openai-key' };
  const filtered = createDshEnvironment(original);
  assert.deepEqual(filtered, { PATH: '/bin', DSH_HOME: '/private/dsh',
    DEEPSEEK_API_KEY: 'fake-dsh-key', OPENAI_API_KEY: 'fake-openai-key' });
  assert.equal(original.HCC_PEER, 'parent');
  assert.equal(createDshEnvironment(original, { dshHome: 'new-home', cwd: '/project' }).DSH_HOME, '/project/new-home');
});

test('fake dsh receives exact argv, canonical project cwd, scrubbed env and returns its exit', async () => {
  const root = temporary('launch');
  const binDir = temporary('bin');
  const binary = path.join(binDir, 'dsh');
  const receipt = path.join(binDir, 'receipt.json');
  fs.writeFileSync(binary, `#!${process.execPath}\n` + [
    "const fs = require('node:fs');",
    'const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("HCC_") || name === "CODEX_THREAD_ID" || name === "DSH_HOME" || name === "DEEPSEEK_API_KEY"));',
    `fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env }));`,
    'process.exit(17);'
  ].join('\n'), { mode: 0o755 });
  const forwarded = ['--port', '8080', '--json', '--root', '/runtime-root', '--db=/runtime.db', 'a $quoted value'];
  const result = await launchDshWeb(context(root), { hccBin, dshBin: binary, dshHome: path.join(binDir, 'home'),
    args: forwarded, stdio: 'ignore', env: { PATH: binDir, HCC_PEER: 'parent', HCC_ROOT: '/wrong',
      HCC_DB: '/wrong.db', CODEX_THREAD_ID: 'parent-thread', DEEPSEEK_API_KEY: 'fake-key' } });
  const readback = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(result.code, 17);
  assert.equal(result.signal, null);
  assert.deepEqual(readback.args, ['web', '--patch', result.patchPath, ...forwarded]);
  assert.equal(readback.cwd, fs.realpathSync(root));
  assert.deepEqual(readback.env, { DSH_HOME: path.join(binDir, 'home'), DEEPSEEK_API_KEY: 'fake-key' });
  assert.equal(fs.existsSync(path.join(binDir, 'home')), false);
  assert.equal(resolveDshBinary({ env: { PATH: binDir } }), fs.realpathSync(binary));
});

test('missing dsh binary gives an install hint without creating integration state', async () => {
  const root = temporary('missing-bin');
  await assert.rejects(launchDshWeb(context(root), { hccBin, env: { PATH: '' } }), (error) =>
    error.code === 'DSH_NOT_FOUND' && /npm install -g @deepseek-ai\/dsh@0.2.0-rc.2/.test(error.message));
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
});

test('wrapper forwards help after -- to the dsh runtime', async () => {
  const root = temporary('forward-help');
  const binary = path.join(root, 'dsh');
  const receipt = path.join(root, 'receipt.json');
  fs.writeFileSync(binary, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  let helpCalls = 0;
  const { cmdDsh } = createDshCommands({ commandPath: () => hccBin, helpDsh: () => { helpCalls += 1; } });
  await cmdDsh(context(root), ['web', '--help']);
  assert.equal(helpCalls, 1);
  const previousExitCode = process.exitCode;
  try { await cmdDsh(context(root), ['web', '--dsh-bin', binary, '--', '--help']); }
  finally { process.exitCode = previousExitCode; }
  assert.equal(helpCalls, 1);
  const args = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.deepEqual(args, ['web', '--patch', path.join(fs.realpathSync(root), '.hello-cc', 'dsh', 'cordis.patch.yml'), '--help']);
});

test('dsh termination signal is observable without creating a web runtime peer', async () => {
  const root = temporary('signal');
  const binary = path.join(root, 'dsh');
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`, { mode: 0o755 });
  const result = await launchDshWeb(context(root), { hccBin, dshBin: binary, stdio: 'ignore' });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(fs.existsSync(path.join(root, '.hello-cc', 'mesh.db')), false);
});

async function movedInstallation() {
  const directory = fs.realpathSync(temporary('installed-location'));
  fs.cpSync(fileURLToPath(new URL('../lib', import.meta.url)), path.join(directory, 'lib'), { recursive: true });
  const module = await import(pathToFileURL(path.join(directory, 'lib/integrations/dsh.mjs')).href);
  return { directory, module, hccBin: path.join(directory, 'bin/hcc.mjs') };
}

test('Cordis setup migrates an unchanged legacy source overlay to an installed package', async () => {
  const root = temporary('cordis-migrate');
  const first = configure(root, { mode: 'cordis' });
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  delete manifest.pluginPath;
  fs.writeFileSync(first.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const moved = await movedInstallation();
  const options = { hccBin: moved.hccBin, mode: 'cordis' };
  assert.equal(moved.module.inspectDshIntegration(context(root), options).state, 'refresh-needed');
  const changed = moved.module.ensureDshIntegration(context(root), options);
  assert.equal(changed.changed.length, 3);
  const recorded = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  assert.equal(recorded.pluginPath, path.join(moved.directory, 'lib/integrations/dsh-cordis.mjs'));
  assert.equal(moved.module.inspectDshIntegration(context(root), options).ready, true);
  assert.deepEqual(moved.module.ensureDshIntegration(context(root), options).changed, []);
});

test('Cordis migration preserves an edited legacy overlay and its manifest', async () => {
  const root = temporary('cordis-migrate-edited');
  const first = configure(root, { mode: 'cordis' });
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8')); delete manifest.pluginPath;
  const recorded = JSON.stringify(manifest, null, 2) + '\n'; fs.writeFileSync(first.manifestPath, recorded);
  const edited = fs.readFileSync(first.patchPath, 'utf8') + '# custom configuration\n'; fs.writeFileSync(first.patchPath, edited);
  const moved = await movedInstallation();
  assertConflict(() => moved.module.ensureDshIntegration(context(root), { hccBin: moved.hccBin, mode: 'cordis' }));
  assert.equal(fs.readFileSync(first.patchPath, 'utf8'), edited);
  assert.equal(fs.readFileSync(first.manifestPath, 'utf8'), recorded);
});

test('Cordis recorded plugin path allows relocation after the overlay is missing', async () => {
  const root = temporary('cordis-migrate-missing');
  const first = configure(root, { mode: 'cordis' }); fs.unlinkSync(first.patchPath);
  const moved = await movedInstallation();
  moved.module.ensureDshIntegration(context(root), { hccBin: moved.hccBin, mode: 'cordis' });
  assert.equal(JSON.parse(fs.readFileSync(first.manifestPath, 'utf8')).pluginPath, path.join(moved.directory, 'lib/integrations/dsh-cordis.mjs'));
});
