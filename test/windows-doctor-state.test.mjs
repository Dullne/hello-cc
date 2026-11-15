import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32' };
const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), 'hcc-doctor-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.hello-cc');
  const native = loadWindowsNative();
  const env = { ...process.env, HOME: home, USERPROFILE: home, HCC_SKIP_SHIM_INSTALL: '1', HCC_NATIVE_OWNER: '', HCC_ROOT: '', HCC_DB: '' };
  function diagnose() {
    const result = spawnSync(process.execPath, ['--no-experimental-sqlite', cli, '--json', 'doctor', '--environment'],
      { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ok(result.stdout.trim(), result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.data.database_checked, false);
    return { status: result.status, ...report.data };
  }
  return { home, state, native, diagnose };
}
function reject(report, target) {
  assert.equal(report.ready, false);
  assert.equal(report.status, 1);
  assert.equal(report.permissions.state.status, 'unavailable');
  assert.equal(report.permissions.state.path, target);
  assert.ok(report.permissions.state.code);
  assert.ok(report.actions.some(action => action.includes(target) && /permissions|reparse|directory|file/i.test(action)), report.actions.join('\n'));
}

test('Windows environment diagnosis rejects a readable-by-everyone existing state without modifying ACLs', windows, t => {
  const f = fixture(t);
  f.native.createPrivateDirectory(f.state);
  const grant = spawnSync('icacls.exe', [f.state, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(grant.status, 0, grant.stderr);
  const before = f.native.inspectPathSecurity(f.state);
  assert.equal(before.private, false);
  reject(f.diagnose(), f.state);
  assert.deepEqual(f.native.inspectPathSecurity(f.state), before);
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test('Windows environment diagnosis accepts absent state and never creates it', windows, t => {
  const f = fixture(t);
  const report = f.diagnose();
  assert.equal(report.ready, true);
  assert.equal(report.status, 0);
  assert.equal(report.permissions.state.status, 'absent');
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('Windows environment diagnosis accepts private existing state without opening SQLite or changing content', windows, t => {
  const f = fixture(t);
  f.native.createPrivateDirectory(f.state);
  const projects = path.join(f.state, 'projects'); f.native.createPrivateDirectory(projects);
  const file = path.join(projects, 'mesh.db');
  fs.writeFileSync(file, 'not a database: environment diagnosis checks permissions only');
  const before = fs.statSync(file);
  const report = f.diagnose();
  assert.equal(report.ready, true);
  assert.equal(report.status, 0);
  assert.equal(report.permissions.state.status, 'trusted');
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a database: environment diagnosis checks permissions only');
  assert.deepEqual(fs.readdirSync(projects), ['mesh.db']);
});

test('Windows environment diagnosis accepts private state files beyond MAX_PATH without changing them', windows, t => {
  const f = fixture(t);
  f.native.createPrivateDirectory(f.state);
  const directory = path.join(f.state, 'd'.repeat(Math.max(8, 245 - f.state.length - 1)));
  fs.mkdirSync(directory);
  const file = path.join(directory, 'long-private-state-file.db');
  assert.ok(file.length > 260);
  fs.writeFileSync(file, 'long private file without SQLite content');
  const before = fs.statSync(file);
  const report = f.diagnose();
  assert.equal(report.ready, true);
  assert.equal(report.status, 0);
  assert.equal(report.permissions.state.status, 'trusted');
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(file, 'utf8'), 'long private file without SQLite content');
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test('Windows environment diagnosis rejects junction state and leaves the target untouched', windows, t => {
  const f = fixture(t); const target = path.join(f.home, 'target');
  f.native.createPrivateDirectory(target);
  fs.symlinkSync(target, f.state, 'junction');
  t.after(() => { if (fs.existsSync(f.state)) fs.unlinkSync(f.state); });
  reject(f.diagnose(), f.state);
  assert.deepEqual(fs.readdirSync(target), []);
});

for (const kind of ['file-state', 'file-projects', 'unsafe-child', 'hardlink-child', 'junction-child']) {
  test(`Windows environment diagnosis fails closed for ${kind}`, windows, t => {
    const f = fixture(t); let target = f.state;
    if (kind === 'file-state') fs.writeFileSync(f.state, 'preserve');
    else {
      f.native.createPrivateDirectory(f.state);
      target = path.join(f.state, kind === 'file-projects' ? 'projects' : 'entry');
      if (kind === 'junction-child') {
        const outside = path.join(f.home, 'outside'); f.native.createPrivateDirectory(outside);
        fs.symlinkSync(outside, target, 'junction');
      } else {
        fs.writeFileSync(target, 'preserve');
        if (kind === 'unsafe-child') {
          const grant = spawnSync('icacls.exe', [target, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
          assert.equal(grant.status, 0, grant.stderr);
        } else if (kind === 'hardlink-child') fs.linkSync(target, path.join(f.home, 'alias'));
      }
    }
    reject(f.diagnose(), target);
    if (kind !== 'junction-child') assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
  });
}
