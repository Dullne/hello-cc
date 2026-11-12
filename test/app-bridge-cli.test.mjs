import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), 'hcc-app-cli-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), privateHome = path.join(directory, 'home');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(privateHome, { mode: 0o700 });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: privateHome, USERPROFILE: privateHome, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1', HCC_SKIP_SHIM_INSTALL: '1' };
  const run = args => spawnSync(process.execPath, [cli, '--root', root, '--json', ...args], { env, encoding: 'utf8', timeout: 5000 });
  return { root, directory, env, run };
}
test('App CLI reports the version prerequisite without claiming a connected desktop', t => {
  const f = fixture(t);
  const old = f.run(['app', 'claude', 'capability', '--version', '2.1.217']);
  assert.equal(old.status, 0, old.stderr);
  assert.equal(JSON.parse(old.stdout).data.supported, false);
  const current = f.run(['app', 'claude', 'capability', '--version', '2.1.287']);
  assert.equal(JSON.parse(current.stdout).data.supported, true);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
});
test('App CLI rejects unknown options and another project database', t => {
  const f = fixture(t);
  for (const args of [
    ['app', 'codex', 'send', '--thread', 'any'],
    ['app', 'claude', 'serve', '--session-id', 'test', '--unknown', 'value'],
    ['--db', path.join(f.directory, 'foreign.db'), 'app', 'claude', 'serve', '--session-id', 'test']
  ]) {
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout || result.stderr).error.code, 'BAD_ARGS');
  }
});
test('foreground bridge prints no secret and removes its generated plugin on shutdown', { timeout: 12000 }, async t => {
  const f = fixture(t), pluginDirectory = path.join(f.directory, 'plugin');
  const args = [cli, '--root', f.root, '--json', 'app', 'claude', 'serve',
    '--session-id', 'desktop-test', '--plugin-dir', pluginDirectory];
  // child.kill('SIGINT') forcibly terminates Windows processes; it does not
  // deliver the console event that invokes the CLI's graceful shutdown hook.
  const bootstrap = `import {pathToFileURL} from 'node:url';
    process.once('message',()=>{process.disconnect();process.emit('SIGINT')});
    await import(pathToFileURL(process.argv[1]));`;
  const child = spawn(process.execPath, process.platform === 'win32' ? ['--input-type=module', '-e', bootstrap, ...args] : args,
    { env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(process.platform === 'win32' ? ['ipc'] : [])] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      try { resolve(JSON.parse(stdout)); } catch {}
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Bridge exited before startup: ' + stderr)));
  });
  const result = await started;
  assert.equal(result.data.connected, false);
  assert.equal(result.data.marketplaceDirectory, pluginDirectory);
  assert.equal(result.data.pluginDirectory, path.join(pluginDirectory, 'plugin'));
  assert.doesNotMatch(stdout, /Bearer|"secret"|connectionId/);
  assert.ok(fs.existsSync(path.join(pluginDirectory, 'plugin', '.claude-plugin', 'plugin.json')));
  const ended = once(child, 'exit');
  if (process.platform === 'win32') child.send('graceful-shutdown'); else child.kill('SIGINT');
  const [code] = await ended;
  assert.equal(code, 0, stderr);
  assert.equal(fs.existsSync(pluginDirectory), false);
});

test('Codex dispatcher requires the original App terminal and cannot target another thread or database', t => {
  const f = fixture(t);
  const outside = f.run(['app', 'codex', 'watch', '--cli', '/not-executed', '--sqlite-home', f.directory, '--app-server-pid', '1']);
  assert.equal(JSON.parse(outside.stdout || outside.stderr).error.code, 'CODEX_APP_SCOPE_INVALID');
  for (const args of [
    ['app', 'codex', 'watch', '--thread', 'someone-else'],
    ['--db', path.join(f.directory, 'foreign.db'), 'app', 'codex', 'watch'],
    ['app', 'codex', 'dispatch-status', '--thread', 'someone-else'],
    ['app', 'codex', 'auto-enable', '--thread', 'someone-else'],
    ['app', 'codex', 'auto-disable', '--thread', 'someone-else']
  ]) {
    const result = f.run(args);
    assert.equal(JSON.parse(result.stdout || result.stderr).error.code, 'BAD_ARGS');
  }
  const auto = f.run(['app', 'codex', 'auto-enable']);
  assert.equal(JSON.parse(auto.stdout || auto.stderr).error.code, 'CODEX_APP_SCOPE_INVALID');
});
