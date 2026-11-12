import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { windowsHookCommand, isWindowsHccHookCommand } from '../lib/platform/windows-hook-command.mjs';

test('Windows hook install, literal execution, status and uninstall preserve unrelated settings',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcc-hooks-中文 %!&' "));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const fake = path.join(root, 'hcc.mjs');
    fs.writeFileSync(fake, `let input=''; process.stdin.setEncoding('utf8');
      process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>
        process.stdout.write(JSON.stringify({args:process.argv.slice(2),input})));`);
    const unrelated = { type: 'command', command: 'echo unrelated hcc hook text' };
    for (const [directory, file] of [['.claude', 'settings.json'], ['.codex', 'hooks.json']]) {
      fs.mkdirSync(path.join(home, directory));
      fs.writeFileSync(path.join(home, directory, file), JSON.stringify({ keep: 42,
        hooks: { SessionStart: [{ hooks: [unrelated] }] } }));
    }
    const api = new URL('../lib/integrations/hooks.mjs', import.meta.url).href;
    const env = { ...process.env, HOME: home, USERPROFILE: home, HCC_NATIVE_OWNER: '' };
    const invoke = uninstall => {
      const script = `import * as api from ${JSON.stringify(api)};
        const file=process.argv[1];
        ${uninstall ? 'api.uninstallClaudeHooks(); api.uninstallCodexHooks();' :
          'api.installClaudeHooks(file); api.installCodexHooks(file); api.installClaudeHooks(file); api.installCodexHooks(file);'}
        console.log(JSON.stringify([api.verifyClaudeHooks(file),api.verifyCodexHooks(file)]));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, fake], {
        env, encoding: 'utf8', windowsHide: true, timeout: 20000
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), [!uninstall, !uninstall]);
    };
    invoke(false);
    const files = [path.join(home, '.claude', 'settings.json'), path.join(home, '.codex', 'hooks.json')];
    const input = JSON.stringify({ cwd: root, text: '中文 %!^&|<>()"' });
    // A project-local executable must not replace the intended hook interpreter.
    fs.copyFileSync(process.execPath, path.join(root, 'powershell.exe'));
    for (const file of files) {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(settings.keep, 42);
      const handlers = settings.hooks.SessionStart.flatMap(group => group.hooks);
      assert.deepEqual(handlers[0], unrelated); assert.equal(handlers.length, 2);
      const command = handlers[1].command;
      assert.match(command, /WindowsPowerShell\\v1\.0\\powershell\.exe['"] -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
      if (file.includes('.claude')) assert.equal(handlers[1].shell, 'powershell');
      const claude = file.includes('.claude');
      const result = spawnSync(claude ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.env.ComSpec || 'cmd.exe',
        claude ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['/d', '/s', '/c', `"${command}"`], {
        input, env, cwd: root, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: !claude, timeout: 15000
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), { args: ['hook', 'sessionstart'], input });
    }
    invoke(true);
    for (const file of files) {
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { keep: 42,
        hooks: { SessionStart: [{ hooks: [unrelated] }] } });
    }
  });

test('Windows hook ownership rejects modified encoded commands and arbitrary markers',
  { skip: process.platform !== 'win32' }, () => {
    const command = windowsHookCommand("C:\\中文 %!&' path\\hcc.mjs", 'stop');
    assert.equal(isWindowsHccHookCommand(command), true);
    assert.equal(isWindowsHccHookCommand(command + ' & echo unrelated'), false);
    const prefix = command.slice(0, command.lastIndexOf(' ') + 1);
    const source = Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
    for (const changed of [source + 'Write-Output unrelated\n', source.replace("'hook'", "'status'"),
      source.replace('hcc.mjs', 'unrelated.mjs'), source.replace('exit $LASTEXITCODE', 'exit 0')]) {
      assert.equal(isWindowsHccHookCommand(prefix + Buffer.from(changed, 'utf16le').toString('base64')), false);
    }
  });
