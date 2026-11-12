import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('thin native Windows shim preserves argv, stdin and exit status without shell forwarding',
  { skip: process.platform !== 'win32' }, t => {
    const binary = new URL('../native/bin/win32-x64/hcc-shim.exe', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(new URL('../native/bin/win32-x64/hcc-shim.json', import.meta.url)));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(manifest.binarySha256, hash(fs.readFileSync(binary)));
    assert.equal(manifest.sourceSha256, hash(fs.readFileSync(new URL('../native/windows/launcher/shim.cc', import.meta.url))));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcc-shim-中文 %!&' "));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const launcher = path.join(root, 'codex.exe'); fs.copyFileSync(binary, launcher);
    fs.writeFileSync(launcher + '.nodepath', Buffer.from('\ufeff' + process.execPath, 'utf16le'));
    fs.writeFileSync(launcher + '.mjs', `let input='';process.stdin.setEncoding('utf8');
      process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
        console.log(JSON.stringify({args:process.argv.slice(2),input}));process.exitCode=17;});`);
    const args = ['', '中文 path', 'a"b', '%!^&|<>()', 'trailing\\', '\\"quoted\\', "apostrophe's"];
    const result = spawnSync(launcher, args, { input: '中文 stdin\r\n', encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 17, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), { args, input: '中文 stdin\r\n' });
  });
