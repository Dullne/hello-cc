import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeJsonSafe } from '../lib/shared/json-file.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

test('Windows JSON publication creates private files and parents under readable ancestry',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-json-中文 '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const native = loadWindowsNative();
    const grant = spawnSync('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)(RX)'],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr);
    const file = path.join(root, 'private', 'nested', 'config.json');
    writeJsonSafe(file, { text: '秘密\r\nvalue', unrelated: 42 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { text: '秘密\r\nvalue', unrelated: 42 });
    assert.equal(native.inspectPathSecurity(path.dirname(file)).private, true);
    assert.equal(native.inspectPathSecurity(file).private, true);
    writeJsonSafe(file, { text: 'updated', unrelated: 42 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'updated');
    assert.equal(native.inspectPathSecurity(file).private, true);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
  });

test('Windows JSON writes refuse junction ancestors without changing their target',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-json-junction-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    const alias = path.join(root, 'alias'); fs.symlinkSync(outside, alias, 'junction');
    assert.throws(() => writeJsonSafe(path.join(alias, 'settings.json'), { token: 'do-not-publish' }));
    assert.deepEqual(fs.readdirSync(outside), []);
  });
