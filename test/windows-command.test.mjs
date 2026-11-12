import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError } from '../lib/shared/errors.mjs';
import { resolveWindowsCommand, windowsEnvironment } from '../lib/platform/windows-command.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-windows-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, text = '') => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);
    return filename;
  };
  return { root, put };
}

// npm cmd-shim's launcher shape, with a real on-disk JS/executable target.
function npmShim(target, executable = false) {
  const head = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
  if (executable) return head + `"%dp0%\\${target}"   %*\r\n`;
  return head + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
}

function fails(code) {
  return error => error instanceof CliError && error.code === code && Boolean(error.message);
}

test('environment normalization preserves Node duplicate precedence without changing the caller', () => {
  const env = { Path: 'ignored', PATH: 'selected', PaTh: 'also ignored', pathext: '.EXE;.CMD', Foo: 'first', foo: 'second', OMIT: undefined };
  assert.deepEqual(windowsEnvironment(env), { FOO: 'first', PATH: 'selected', PATHEXT: '.EXE;.CMD' });
  assert.equal(env.Path, 'ignored');
  assert.throws(() => windowsEnvironment({ PATH: 'bad\0value' }), fails('WINDOWS_ENV_INVALID'));
});

test('explicit executable and relative paths remain literal with Unicode, spaces and shell metacharacters', t => {
  const { root, put } = fixture(t);
  const executable = put('中文 tools %!^&()/agent.EXE');
  assert.deepEqual(resolveWindowsCommand(executable, { env: {}, cwd: root }), { file: executable, args: [], kind: 'executable' });
  assert.deepEqual(resolveWindowsCommand('./中文 tools %!^&()/agent.EXE', { env: {}, cwd: root }), { file: executable, args: [], kind: 'executable' });
});

test('PATH casing, quoted directories and PATHEXT order determine command selection', t => {
  const { root, put } = fixture(t);
  put('first/agent.exe');
  const selected = put('second directory/agent.com');
  put('second directory/agent.exe');
  const result = resolveWindowsCommand('agent', { cwd: root,
    env: { Path: path.join(root, 'first'), PATH: `"${path.join(root, 'second directory')}"`, PATHEXT: '.COM;.EXE' } });
  assert.deepEqual(result, { file: selected, args: [], kind: 'executable' });
});

test('missing, directories, command text and unsupported extensions produce typed failures', t => {
  const { root, put } = fixture(t);
  put('directory.exe/child');
  put('notes.txt');
  for (const command of ['', null, 'agent\0.exe', 'agent\r.exe']) {
    assert.throws(() => resolveWindowsCommand(command, { cwd: root, env: {} }), fails('WINDOWS_COMMAND_INVALID'));
  }
  assert.throws(() => resolveWindowsCommand('absent', { cwd: root, env: { PATH: root } }), fails('WINDOWS_COMMAND_NOT_FOUND'));
  assert.throws(() => resolveWindowsCommand(path.join(root, 'directory.exe'), { cwd: root, env: {} }), fails('WINDOWS_COMMAND_NOT_FOUND'));
  assert.throws(() => resolveWindowsCommand(path.join(root, 'notes.txt'), { cwd: root, env: {} }), fails('WINDOWS_COMMAND_UNSUPPORTED'));
});

test('npm JS launchers resolve to the actual entry and current Node without executing batch', t => {
  const { root, put } = fixture(t);
  const entry = put('node_modules/@example/agent/bin/agent.js', '#!/usr/bin/env node\n');
  const shim = put('agent.cmd', npmShim('node_modules\\@example\\agent\\bin\\agent.js'));
  assert.deepEqual(resolveWindowsCommand(shim, { cwd: root, env: {} }), {
    file: process.execPath, args: [entry], kind: 'node-script'
  });
  assert.deepEqual(resolveWindowsCommand('agent', { cwd: root, env: { Path: root } }).args, [entry]);
});

test('npm launchers for real executables resolve without a shell', t => {
  const { root, put } = fixture(t);
  const entry = put('node_modules/agent/bin/agent.exe');
  const shim = put('agent.cmd', npmShim('node_modules\\agent\\bin\\agent.exe', true));
  assert.deepEqual(resolveWindowsCommand(shim, { cwd: root, env: {} }), { file: entry, args: [], kind: 'executable' });
});

test('modified npm launchers, missing targets, traversal and arbitrary batch fail closed', t => {
  const { root, put } = fixture(t);
  put('node_modules/agent/bin/agent.js');
  put('outside.js');
  const original = npmShim('node_modules\\agent\\bin\\agent.js');
  const sources = [
    '@echo off\r\nnode app.js %*\r\n',
    original + 'echo injected\r\n',
    original.replace('SETLOCAL', 'SETLOCAL\r\nSET ATTACK=1'),
    original.replace('"%_prog%"  ', '"%_prog%" --require bad.js '),
    npmShim('node_modules\\agent\\bin\\missing.js'),
    npmShim('node_modules\\..\\outside.js'),
    npmShim('node_modules\\agent\\%EVIL%\\agent.js')
  ];
  for (const [i, source] of sources.entries()) {
    const shim = put(`bad${i}.cmd`, source);
    assert.throws(() => resolveWindowsCommand(shim, { cwd: root, env: {} }), fails('WINDOWS_WRAPPER_UNSUPPORTED'), shim);
  }
  assert.throws(() => resolveWindowsCommand(put('arbitrary.bat', 'echo harmless'), { cwd: root, env: {} }), fails('WINDOWS_WRAPPER_UNSUPPORTED'));
});

test('HCC wrappers never recurse and PATH continues to a real provider', t => {
  const { root, put } = fixture(t);
  const wrapper = put('.hcc-shims/agent.cmd', '@rem hello-cc shim\r\n');
  const hiddenWrapper = put('other wrappers/agent.cmd', '@rem hello-cc shim\r\n');
  const executable = put('provider/agent.exe');
  const result = resolveWindowsCommand('agent', { cwd: root,
    env: { PATH: [path.dirname(wrapper), path.dirname(hiddenWrapper), path.dirname(executable)].join(';') } });
  assert.equal(result.file, executable);
  assert.throws(() => resolveWindowsCommand(wrapper, { cwd: root, env: {} }), fails('WINDOWS_SHIM_RECURSION'));
});

test('explicit Node scripts preserve every argument in an actual subprocess', t => {
  const { root, put } = fixture(t);
  const script = put('中文 & spaces/argv.mjs', 'console.log(JSON.stringify(process.argv.slice(2)));');
  const launch = resolveWindowsCommand(script, { cwd: root, env: {} });
  const argv = ['', '中文 空格', 'double"quote', "single'quote", '%!^&|<>()', 'trailing\\', 'space \\', '--flag', '$(noop)'];
  const result = spawnSync(launch.file, [...launch.args, ...argv], { cwd: root, shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), argv);
});

test('PowerShell scripts select an explicit host and use File arguments without command interpolation', t => {
  const { root, put } = fixture(t);
  const host = put('tools/pwsh.exe');
  const script = put('中文 & scripts/agent.ps1', 'param($value)\n$value');
  assert.deepEqual(resolveWindowsCommand(script, { cwd: root, env: { PATH: path.dirname(host) } }), {
    file: host, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], kind: 'powershell-script'
  });
  assert.throws(() => resolveWindowsCommand(script, { cwd: root, env: {} }), fails('WINDOWS_POWERSHELL_NOT_FOUND'));
});

test('npm local bin launchers resolve package entries outside the .bin directory', t => {
  const { root, put } = fixture(t);
  const entry = put('node_modules/@example/agent/bin/agent.js');
  const shim = put('node_modules/.bin/agent.cmd', npmShim('..\\@example\\agent\\bin\\agent.js'));
  assert.deepEqual(resolveWindowsCommand(shim, { cwd: root, env: {} }).args, [entry]);
});

function npmBootstrap(name) {
  const variable = name.toUpperCase();
  return `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "${variable}_CLI_JS=%~dp0\\node_modules\\npm\\bin\\${name}-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_${variable}_CLI_JS=%%F\\node_modules\\npm\\bin\\${name}-cli.js"
)
IF EXIST "%NPM_PREFIX_${variable}_CLI_JS%" (
  SET "${variable}_CLI_JS=%NPM_PREFIX_${variable}_CLI_JS%"
)

"%NODE_EXE%" "%${variable}_CLI_JS%" %*
`;
}

test('npm and npx distribution launchers select their installed CLI without running prefix discovery', t => {
  const { root, put } = fixture(t);
  for (const name of ['npm', 'npx']) {
    const entry = put(`node_modules/npm/bin/${name}-cli.js`);
    const shim = put(`${name}.cmd`, npmBootstrap(name));
    assert.deepEqual(resolveWindowsCommand(shim, { cwd: root, env: {} }), { file: process.execPath, args: [entry], kind: 'node-script' });
    put(`${name}.cmd`, npmBootstrap(name) + '\necho unexpected\n');
    assert.throws(() => resolveWindowsCommand(shim, { cwd: root, env: {} }), fails('WINDOWS_WRAPPER_UNSUPPORTED'));
  }
});

test('directory aliases cannot conceal HCC wrappers', { skip: process.platform !== 'win32' }, t => {
  const { root, put } = fixture(t);
  put('.hcc-shims/agent.cmd', npmShim('node_modules\\agent\\bin\\agent.js'));
  put('.hcc-shims/node_modules/agent/bin/agent.js');
  fs.symlinkSync(path.join(root, '.hcc-shims'), path.join(root, 'alias'), 'junction');
  assert.throws(() => resolveWindowsCommand(path.join(root, 'alias/agent.cmd'), { cwd: root, env: {} }), fails('WINDOWS_SHIM_RECURSION'));
});

test('npm package junctions cannot route resolved entries back into HCC wrappers', { skip: process.platform !== 'win32' }, t => {
  const { root, put } = fixture(t);
  put('.hcc-shims/bin/agent.js');
  put('.hcc-shims/bin/npm-cli.js');
  const ordinary = put('linked package/bin/agent.js');
  const shim = put('agent.cmd', npmShim('node_modules\\agent\\bin\\agent.js'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(root, '.hcc-shims'), path.join(root, 'node_modules/agent'), 'junction');
  assert.throws(() => resolveWindowsCommand(shim, { cwd: root, env: {} }), fails('WINDOWS_SHIM_RECURSION'));
  const npm = put('npm.cmd', npmBootstrap('npm'));
  fs.symlinkSync(path.join(root, '.hcc-shims'), path.join(root, 'node_modules/npm'), 'junction');
  assert.throws(() => resolveWindowsCommand(npm, { cwd: root, env: {} }), fails('WINDOWS_SHIM_RECURSION'));
  fs.unlinkSync(path.join(root, 'node_modules/agent'));
  fs.symlinkSync(path.dirname(path.dirname(ordinary)), path.join(root, 'node_modules/agent'), 'junction');
  assert.deepEqual(resolveWindowsCommand(shim, { cwd: root, env: {} }).args, [path.join(root, 'node_modules/agent/bin/agent.js')]);
});

test('system PowerShell receives literal script arguments', { skip: process.platform !== 'win32' }, t => {
  const { root, put } = fixture(t);
  const script = put('中文 & scripts/argv.ps1', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::Out.Write((ConvertTo-Json -InputObject @($args) -Compress))');
  const launch = resolveWindowsCommand(script, { cwd: root,
    env: { SYSTEMROOT: process.env.SystemRoot || process.env.SYSTEMROOT } });
  const argv = ['', '中文 空格', 'double"quote', "single'quote", '%!^&|<>()', 'trailing\\', 'space \\', '--flag', '$(noop)'];
  const result = spawnSync(launch.file, [...launch.args, ...argv], { cwd: root, shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), argv);
});
