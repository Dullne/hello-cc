import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPeerInvocation, defaultSessionCommand } from '../lib/integrations/providers.mjs';

test('Windows shell prefers an available PowerShell 7 executable and otherwise uses absolute system PowerShell',
  { skip: process.platform !== 'win32' }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-shell-choice-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { PATH: directory, SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows' };
    assert.equal(defaultSessionCommand('shell', env), path.join(env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const executable = path.join(directory, 'pwsh.exe'); fs.copyFileSync(process.execPath, executable);
    assert.equal(defaultSessionCommand('shell', env), executable);
  });

test('literal peer invocation preserves custom argument boundaries without interpreting a shell command', () => {
  const args = ['tool.exe', '', 'a b', '中文 %!&', 'a"b'];
  const built = buildPeerInvocation('peer', 'other', {}, args);
  assert.deepEqual({ file: built.file, args: built.args }, { file: args[0], args: args.slice(1) });
  assert.equal(built.binding.resume_mode, 'command');
  assert.throws(() => buildPeerInvocation('peer', 'other', { command: 'echo && run' }, []), { code: 'WINDOWS_COMMAND_INVALID' });
});

test('provider resume and fork options become literal argv with matching binding identities', () => {
  const id = 'thread & 中文 "id"';
  for (const [kind, options, args, mode] of [
    ['codex', { resume: id }, ['resume', id], 'resume'],
    ['codex', { fork: true, resume: id }, ['fork', id], 'fork'],
    ['codex', { last: true }, ['resume', '--last'], 'last'],
    ['claude', { resume: id, fork: true, name: 'name %!' }, ['--resume', id, '--fork-session', '--name', 'name %!'], 'fork-resume'],
    ['claude', { session: id }, ['--session-id', id], 'session'],
    ['claude', { continue: true }, ['--continue'], 'continue']
  ]) {
    const result = buildPeerInvocation('peer', kind, options, []);
    assert.equal(result.file, kind); assert.deepEqual(result.args, args); assert.equal(result.binding.resume_mode, mode);
  }
});
