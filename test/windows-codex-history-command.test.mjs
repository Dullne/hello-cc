import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as history from '../lib/core/sessions/codex-thread-root.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), 'hcc-win-codex-history-'));
  const root = path.join(home, 'project 中文'); fs.mkdirSync(root);
  const bin = path.join(home, 'npm tools'); fs.mkdirSync(bin);
  const script = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'); fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `console.log(JSON.stringify({origin:process.env.HCC_CODEX_SESSION_ORIGIN || null,args:process.argv.slice(2)}));`);
  const relative = 'node_modules\\@openai\\codex\\bin\\codex.js';
  const wrapper = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    'IF EXIST "%dp0%\\node.exe" (\r\nSET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\nSET "_prog=node"\r\nSET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n' +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relative}" %*\r\n`;
  fs.writeFileSync(path.join(bin, 'codex.cmd'), wrapper);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: bin, PATHEXT: '.EXE;.CMD', HCC_SKIP_SHIM_INSTALL: '1', NODE_NO_WARNINGS: '1' };
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE events (type TEXT, actor TEXT, payload TEXT)');
  const selected = captureSelectedCwdSnapshot(root);
  history.recordCodexThreadRoot(db, (database, type, actor, _subject, payload) =>
    database.prepare('INSERT INTO events VALUES (?,?,?)').run(type, actor, JSON.stringify(payload)), 'verified-thread', selected, 'new');
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const check = (mode, argv) => history.assertCodexTerminalLaunch(db, { provider: 'codex', resume_mode: mode,
    resume_arg: 'verified-thread', ...(mode === 'resume' ? { provider_session_id: 'verified-thread' } : {}) },
  { root, rootIdentity: selected, cwd: root, cwdIdentity: selected, argv, env });
  return { home, root, bin, script, env, check };
}

test('Windows Codex history accepts exact symbolic, npm, resolved Node and executable command descriptors', { skip: !windows }, t => {
  const f = fixture(t);
  for (const prefix of [['codex'], [path.join(f.bin, 'codex.cmd')], [process.execPath, f.script], [process.execPath.toUpperCase(), f.script.toUpperCase()]]) {
    assert.equal(f.check('new', prefix), 'new');
    assert.equal(f.check('resume', [...prefix, 'resume', 'verified-thread']), null);
    assert.equal(f.check('fork', [...prefix, 'fork', 'verified-thread']), 'fork');
    assert.equal(history.isDirectCodexNewInvocation(prefix, { env: f.env, cwd: f.root }), true);
  }
  const executable = path.join(f.bin, 'codex.exe'); fs.copyFileSync(process.execPath, executable);
  assert.equal(f.check('new', [executable]), 'new');
  assert.equal(f.check('resume', [executable, 'resume', 'verified-thread']), null);
});

test('Windows history rejects different executables, injected Node prefixes and extra directory or provider options', { skip: !windows }, t => {
  const f = fixture(t); const other = path.join(f.home, 'unrecognized.exe'); fs.copyFileSync(process.execPath, other);
  for (const argv of [
    [other, 'resume', 'verified-thread'],
    [process.execPath, '-e', 'throw 1', f.script, 'resume', 'verified-thread'],
    [process.execPath, f.script, 'resume', 'verified-thread', '--cd', f.home],
    [process.execPath, f.script, '--model', 'changed', 'resume', 'verified-thread'],
    [process.execPath, f.script, 'resume', 'different-thread']
  ]) assert.throws(() => f.check('resume', argv), { code: 'CODEX_HISTORY_COMMAND_UNVERIFIED' });
  assert.equal(history.isDirectCodexNewInvocation([other], { env: f.env, cwd: f.root }), false);
  assert.equal(history.isDirectCodexNewInvocation([process.execPath, f.script, '--cd', f.home], { env: f.env, cwd: f.root }), false);
  fs.appendFileSync(path.join(f.bin, 'codex.cmd'), '\r\necho unexpected\r\n');
  assert.throws(() => f.check('resume', [process.execPath, f.script, 'resume', 'verified-thread']), { code: 'CODEX_HISTORY_COMMAND_UNVERIFIED' });
});

test('public Windows run marks a new resolved npm Codex invocation with its verified launch origin', { skip: !windows }, t => {
  const f = fixture(t); const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  const init = spawnSync(process.execPath, [cli, '--root', f.root, '--json', 'init'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(init.status, 0, init.stderr);
  const result = spawnSync(process.execPath, [cli, '--root', f.root, 'run', '--peer', 'codex-new', '--kind', 'codex', '--', process.execPath, f.script],
    { env: f.env, cwd: f.root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const observation = result.stdout.split(/\r?\n/).find(line => line.startsWith('{"origin":'));
  assert.deepEqual(JSON.parse(observation), { origin: 'new', args: [] });
});
