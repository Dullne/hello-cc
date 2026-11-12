import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInstallCommands } from '../lib/cli/commands/install.mjs';
import { parseOpts, validateOpts } from '../lib/cli-args.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { windowsEnvironment } from '../lib/platform/windows-command.mjs';

test('Windows update resolves npm launcher and passes registry as one literal argument',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-update-中文 '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const capture = path.join(root, 'captured.json');
    fs.writeFileSync(target, 'require("node:fs").writeFileSync(process.env.HCC_UPDATE_CAPTURE, JSON.stringify(process.argv.slice(2)))');
    const launcher = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\nSET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\nSET "_prog=node"\r\nSET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n';
    fs.writeFileSync(path.join(root, 'npm.cmd'), launcher);
    const registry = 'https://registry.example/中文 path?value=%!^&|<>()"';
    let printed;
    const commands = createInstallCommands({
      process: { platform: 'win32', cwd: () => root,
        env: { ...windowsEnvironment(process.env), PATH: root, PATHEXT: '.CMD', HCC_UPDATE_CAPTURE: capture } },
      path, fs, CliError, parseOpts, validateOpts,
      NPM_PACKAGE_NAME: '@example/hcc-test', shellCommand: args => args.join(' '),
      printResult: (ctx, data) => { printed = data; }
    });
    await commands.cmdUpdate({ json: true }, ['--tag', '1.2.3-test', '--registry', registry]);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')),
      ['install', '-g', '@example/hcc-test@1.2.3-test', '--registry', registry]);
    assert.equal(printed.tag, '1.2.3-test');
    fs.unlinkSync(capture);
    await commands.cmdUpdate({ json: true }, ['--dry-run']);
    assert.equal(printed.dry_run, true);
    assert.equal(fs.existsSync(capture), false);
  });
