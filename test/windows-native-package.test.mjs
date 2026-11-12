import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('packed Windows component loads using only its extracted package files',
  { skip: process.platform !== 'win32', timeout: 120000 }, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-package-中文 '));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
    const metadata = JSON.parse(packed.stdout)[0];
    const artifact = path.join(temporary, metadata.filename);
    const extract = path.join(temporary, 'extracted installation');
    fs.mkdirSync(extract);
    const tar = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = spawnSync(tar, ['-xf', artifact, '-C', extract],
      { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(unpacked.status, 0, unpacked.stderr || unpacked.error?.message);
    const installed = path.join(extract, 'package');
    assert.equal(fs.existsSync(path.join(installed, 'native', 'windows', 'addon.cc')), true,
      'The package must include the native sources required to validate its source hash');
    // This fresh process loads the extracted module at its default package root.
    // No alternate root or source-checkout import can conceal missing artifacts.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const { loadWindowsNative } = await import(pathToFileURL(path.join(process.cwd(), 'lib/platform/windows-native.mjs')));
      const native = loadWindowsNative();
      console.log(JSON.stringify({ capabilities: native.capabilities, observed: native.inspectProcess(process.pid) }));
    `], { cwd: installed, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    const report = JSON.parse(probe.stdout);
    assert.equal(report.capabilities.processIdentity, true);
    assert.equal(report.observed.state, 'live');
    assert.match(report.observed.creationTime, /^[1-9][0-9]+$/);
  });
