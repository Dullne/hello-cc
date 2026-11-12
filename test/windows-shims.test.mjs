import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as shims from '../lib/platform/windows-shims.mjs';
import { planWindowsShimLaunch } from '../lib/platform/windows-shim-runner.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), "hcc-shims-test-中文 %!&' "));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const provider = path.join(home, 'provider.mjs');
  fs.writeFileSync(provider, `let input='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
      console.log(JSON.stringify({args:process.argv.slice(2),input}));process.exitCode=17;});`);
  const hcc = path.join(home, 'hcc.mjs'); fs.writeFileSync(hcc, 'throw Error("unexpected managed route");');
  const shimDir = path.join(home, '.hcc-shims');
  const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1', PATH: shimDir };
  return { home, provider, hcc, shimDir, env, options: { shimDir, env, realBins: { claude: provider, codex: provider } } };
}

test('Windows shim installation is private, idempotent, literal, and removable from its ownership manifest', { skip: !windows }, t => {
  const f = fixture(t);
  const first = shims.installWindowsShims(f.hcc, f.options);
  assert.equal(first.installed.length, 2);
  assert.equal(first.changed.length, 2);
  assert.equal(shims.windowsShimStatus({ shimDir: f.shimDir }).complete, true);
  assert.deepEqual(shims.installWindowsShims(f.hcc, f.options).changed, []);
  const args = ['--help', '', '中文 space', 'a"b', '%!^&|<>()', 'trailing\\', "apostrophe's"];
  const result = spawnSync(path.join(f.shimDir, 'codex.exe'), args, {
    env: f.env, cwd: f.home, input: '中文 stdin\r\n', encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(result.status, 17, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: '中文 stdin\r\n' });
  fs.writeFileSync(path.join(f.shimDir, 'unrelated.txt'), 'keep');
  assert.equal(shims.uninstallWindowsShims({ shimDir: f.shimDir }).length, 2);
  assert.deepEqual(fs.readdirSync(f.shimDir), ['unrelated.txt']);
  assert.equal(shims.windowsShimStatus({ shimDir: f.shimDir }).installed, false);
});

test('Windows shim updates and removal refuse modified or unowned files before changing either provider', { skip: !windows }, t => {
  const f = fixture(t); shims.installWindowsShims(f.hcc, f.options);
  const modified = path.join(f.shimDir, 'codex.exe.mjs');
  fs.appendFileSync(modified, '\n// local customization');
  assert.equal(shims.windowsShimStatus({ shimDir: f.shimDir }).tools.codex.installed, false);
  assert.throws(() => shims.installWindowsShims(f.hcc, f.options), { code: 'WINDOWS_SHIM_CONFLICT' });
  assert.throws(() => shims.uninstallWindowsShims({ shimDir: f.shimDir }), { code: 'WINDOWS_SHIM_CONFLICT' });
  assert.equal(fs.existsSync(path.join(f.shimDir, 'claude.exe')), true);
  assert.match(fs.readFileSync(modified, 'utf8'), /local customization/);
});

test('Windows shim installer refuses a redirected directory and providers pointing back to owned wrappers', { skip: !windows }, t => {
  const f = fixture(t); const outside = path.join(f.home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.shimDir, 'junction');
  assert.throws(() => shims.installWindowsShims(f.hcc, f.options));
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmdirSync(f.shimDir); shims.installWindowsShims(f.hcc, f.options);
  assert.throws(() => shims.installWindowsShims(f.hcc, { ...f.options,
    realBins: { codex: path.join(f.shimDir, 'codex.exe') } }), { code: 'WINDOWS_SHIM_RECURSION' });
});

test('Windows shim routing preserves utility passthrough and hashes complete provider session ids', { skip: !windows }, t => {
  const f = fixture(t); const config = { tool: 'codex', hccBin: f.hcc, realBin: f.provider };
  for (const argv of [['--help'], ['--config', 'x=y', 'exec', 'prompt'], ['login'], ['--model=x', 'mcp-server']]) {
    const result = planWindowsShimLaunch(config, argv, { root: f.home, env: f.env });
    assert.equal(result.route, 'provider'); assert.deepEqual(result.args, [f.provider, ...argv]);
  }
  const argv = ['resume', 'full-provider-session-id', 'literal %!&'];
  const peer = 'codex-' + createHash('sha1').update(argv[1]).digest('hex').slice(0, 8);
  const managed = planWindowsShimLaunch(config, argv, { root: f.home, env: f.env });
  assert.equal(managed.route, 'managed');
  assert.deepEqual(managed.args, [f.hcc, '--root', f.home, 'run', '--peer', peer, '--kind', 'codex', '--', process.execPath, f.provider, ...argv]);
  assert.equal(managed.env.HCC_PEER, peer);
  assert.equal(planWindowsShimLaunch(config, [], { root: null, env: f.env }).route, 'provider');
  const claude = planWindowsShimLaunch({ ...config, tool: 'claude' }, ['--resume', 'old', '--fork-session'], { root: f.home, env: f.env, ppid: 123 });
  assert.equal(claude.env.HCC_PEER, 'claude-123');
});

test('installed Windows launcher passes through outside projects and enters the public managed CLI after init', { skip: !windows }, t => {
  const f = fixture(t); const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  const root = path.join(f.home, 'project'); fs.mkdirSync(root);
  shims.installWindowsShims(cli, f.options);
  const launcher = path.join(f.shimDir, 'claude.exe');
  const invoke = () => spawnSync(launcher, ['literal 中文 %!& prompt'], { env: f.env, cwd: root,
    input: 'provider input', encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const outside = invoke(); assert.equal(outside.status, 17, outside.stderr);
  assert.deepEqual(JSON.parse(outside.stdout), { args: ['literal 中文 %!& prompt'], input: 'provider input' });
  const init = spawnSync(process.execPath, [cli, '--root', root, '--json', 'init'], {
    env: f.env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(init.status, 0, init.stderr);
  const managed = invoke(); assert.equal(managed.status, 17, managed.stderr || managed.stdout);
  assert.match(managed.stdout, /provider input/);
  const status = spawnSync(process.execPath, [cli, '--json', 'shim', 'status'], {
    env: f.env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.complete, true);
});
