import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shellExports } from '../lib/format.mjs';

const windows = { skip: process.platform !== 'win32' };
const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-shell-env-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); const root = path.join(base, "项目 & O'Brien (workspace)");
  fs.mkdirSync(home); fs.mkdirSync(root);
  const env = { ...process.env, HOME: home, USERPROFILE: home, HCC_SKIP_SHIM_INSTALL: '1',
    HCC_ROOT: '', HCC_DB: '', HCC_PEER: '', HCC_NATIVE_OWNER: '', NODE_NO_WARNINGS: '1' };
  const probe = path.join(base, 'probe.cjs');
  fs.writeFileSync(probe, 'process.stdout.write(JSON.stringify(Object.fromEntries(["HCC_PEER","HCC_ROOT","HCC_DB"].map(k=>[k,process.env[k]]))))');
  return { base, root, env, probe };
}
function powershell(source, f) {
  const program = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${source}\n& '${process.execPath.replace(/'/g, "''")}' '${f.probe.replace(/'/g, "''")}'`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
    { env: f.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
}
function cmd(source, f) {
  const script = path.join(f.base, 'apply.cmd');
  fs.writeFileSync(script, `@echo off\r\nchcp 65001 >nul\r\n${source.replace(/\n/g, '\r\n')}\r\n"${process.execPath}" "${f.probe}"\r\n`);
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:on', '/c', script],
    { env: f.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
}

test('PowerShell exports preserve Unicode, quotes, newlines and expressions without executing them', windows, t => {
  const f = fixture(t);
  const values = { HCC_PEER: "中文 ' ‘ ’ ‚ ‛ \" $([Environment]::Exit(42)) ` & | ; % ! ^\r\nsecond line", HCC_ROOT: f.root, HCC_DB: 'C:\\a b\\mesh.db' };
  const result = powershell(shellExports(values, 'powershell'), f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('PowerShell low and reversed curly quotes cannot terminate a literal and inject a command', windows, t => {
  const f = fixture(t);
  for (const quote of ['\u201a', '\u201b']) {
    const values = { HCC_PEER: `a${quote}; exit 42; ${quote}z`, HCC_ROOT: f.root, HCC_DB: 'literal' };
    const result = powershell(shellExports(values, 'powershell'), f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), values);
  }
});

test('cmd exports preserve representable Unicode and metacharacters even with delayed expansion enabled', windows, t => {
  const f = fixture(t);
  const values = { HCC_PEER: "中文 '& | < > ( ) ^ ; =", HCC_ROOT: f.root, HCC_DB: 'C:\\a b\\mesh.db' };
  const result = cmd(shellExports(values, 'cmd'), f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('shell exports reject unsupported shells, invalid keys and cmd expansion or command injection', () => {
  assert.throws(() => shellExports({ HCC_PEER: 'safe' }, 'fish'), { code: 'BAD_ARGS' });
  for (const shell of ['powershell', 'cmd', 'posix']) {
    assert.throws(() => shellExports({ 'NAME; exit': 'value' }, shell), { code: 'BAD_ARGS' });
    assert.throws(() => shellExports({ HCC_PEER: 'a\0b' }, shell), { code: 'BAD_ARGS' });
  }
  for (const value of ['%PATH%', '!PATH!', 'a" & exit 42 & "', 'a\r\nb', 'a\tb']) {
    assert.throws(() => shellExports({ HCC_PEER: value }, 'cmd'), { code: 'BAD_ARGS' });
  }
});

test('explicit POSIX exports preserve the existing quoting contract', () => {
  assert.equal(shellExports({ HCC_PEER: "a'b", HCC_ROOT: '/tmp/project' }, 'posix'),
    "export HCC_PEER='a'\\''b'\nexport HCC_ROOT=/tmp/project");
});

for (const command of ['env', 'join']) {
  test(`Windows ${command} defaults to PowerShell, supports cmd/POSIX and preserves JSON`, windows, t => {
    const f = fixture(t);
    function invoke(extra) {
      return spawnSync(process.execPath, [cli, '--root', f.root, command, '--peer', 'shell-peer', ...extra],
        { env: f.env, encoding: 'utf8', timeout: 20000, windowsHide: true });
    }
    const json = invoke(['--json']);
    assert.equal(json.status, 0, json.stderr);
    const values = JSON.parse(json.stdout).data;
    for (const [args, execute] of [[[], powershell], [['--shell', 'powershell'], powershell], [['--shell', 'cmd'], cmd]]) {
      const output = invoke(args);
      assert.equal(output.status, 0, output.stderr);
      const applied = execute(output.stdout.trimEnd(), f);
      assert.equal(applied.status, 0, applied.stderr);
      assert.deepEqual(JSON.parse(applied.stdout), values);
    }
    assert.match(invoke(['--shell', 'posix']).stdout, /^export HCC_PEER=/);
    assert.deepEqual(JSON.parse(invoke(['--json', '--shell', 'cmd']).stdout).data, values);
    const nativeInvocation = `& '${process.execPath.replace(/'/g, "''")}' '${cli.replace(/'/g, "''")}' --root '${f.root.replace(/'/g, "''")}' ${command} --peer shell-peer --shell powershell | Out-String | Invoke-Expression`;
    const piped = powershell(nativeInvocation, f);
    assert.equal(piped.status, 0, piped.stderr);
    assert.deepEqual(JSON.parse(piped.stdout), values);
    const invalid = invoke(['--shell', 'fish', '--json']);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'BAD_ARGS');
  });
}

test('JSON preserves paths that cmd output refuses and a rejected join does not register the peer', windows, t => {
  const f = fixture(t); const root = path.join(f.base, '%PATH%!literal'); fs.mkdirSync(root);
  function invoke(args) {
    return spawnSync(process.execPath, [cli, '--root', root, ...args], { env: f.env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  }
  const rejected = invoke(['join', '--peer', 'rejected-peer', '--shell', 'cmd']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Cannot safely represent HCC_ROOT/);
  const values = invoke(['env', '--peer', 'literal-peer', '--shell', 'cmd', '--json']);
  assert.equal(values.status, 0, values.stderr);
  assert.equal(JSON.parse(values.stdout).data.HCC_ROOT, root);
  const peers = invoke(['peers', '--json']);
  assert.equal(peers.status, 0, peers.stderr);
  assert.doesNotMatch(peers.stdout, /rejected-peer/);
});
