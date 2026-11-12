import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = process.platform === 'win32';
const stateUrl = new URL('../lib/runtime/private-state.mjs', import.meta.url).href;
const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
function fixture(t) {
  // This machine's shared Temp hierarchy intentionally permits other local
  // principals to mutate children. An isolated profile under the owned home
  // exercises the accepted ancestry without weakening the real ACL policy.
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-win-private-test-'));
  const home = path.join(base, '用户 home'); const root = path.join(base, '项目');
  fs.mkdirSync(home); fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1' };
  function invoke(action, options = {}) {
    const code = `import * as api from ${JSON.stringify(stateUrl)};
      try { const args=JSON.parse(process.argv[1]); const value=api[args.action](args.root,args.options);
        console.log(JSON.stringify({ok:true,value})); }
      catch(error) { console.log(JSON.stringify({ok:false,code:error.code,message:error.message})); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code,
      JSON.stringify({ action, root, options })], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  }
  return { base, home, root, env, invoke };
}
function value(result) { assert.equal(result.ok, true, result.message); return result.value; }

test('Windows private state binds the native identity and persists the existing pending to fresh transition',
  { skip: !windows }, t => {
    const f = fixture(t);
    assert.equal(value(f.invoke('ensurePrivateProjectStateDir')), null);
    assert.deepEqual(fs.readdirSync(f.home), []);
    const directory = value(f.invoke('ensurePrivateProjectStateDir', { create: true }));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.project-root.json')));
    const authority = JSON.parse(fs.readFileSync(directory + '.authority.json'));
    assert.equal(manifest.version, 3);
    assert.equal(manifest.identity.platform, 'win32');
    assert.equal(Object.hasOwn(manifest, 'dev'), false);
    assert.deepEqual(manifest.identity, loadWindowsNative().inspectDirectory(f.root).identity);
    assert.deepEqual(authority, { ...manifest, kind: 'fresh' });
    assert.equal(loadWindowsNative().inspectPathSecurity(directory).private, true);
    assert.equal(loadWindowsNative().inspectPathSecurity(directory + '.authority.json').private, true);
    assert.equal(value(f.invoke('ensurePrivateProjectStateDir')), directory);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });

test('Windows private state refuses root replacement, incompatible versions and public authority ACLs',
  { skip: !windows }, t => {
    const f = fixture(t); const directory = value(f.invoke('ensurePrivateProjectStateDir', { create: true }));
    const marker = directory + '.authority.json'; const original = fs.readFileSync(marker);
    fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root);
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'PROJECT_PATH_FORBIDDEN');
    fs.rmdirSync(f.root); fs.renameSync(f.root + '-old', f.root);
    const unknown = JSON.parse(original); unknown.identity.version = 2; fs.writeFileSync(marker, JSON.stringify(unknown));
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'PROJECT_PATH_FORBIDDEN');
    const missingKind = JSON.parse(original); delete missingKind.kind; fs.writeFileSync(marker, JSON.stringify(missingKind));
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'PROJECT_PATH_FORBIDDEN');
    fs.writeFileSync(marker, original);
    const grant = spawnSync('icacls.exe', [marker, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr);
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'PROJECT_PATH_FORBIDDEN');
  });

test('Windows CLI initialization uses only the temporary profile and creates a private native binding',
  { skip: !windows }, t => {
    const f = fixture(t);
    const result = spawnSync(process.execPath, [cli, '--root', f.root, '--json', 'init', '--no-guidance'], {
      env: f.env, encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const directory = value(f.invoke('privateProjectStateDir'));
    assert.equal(JSON.parse(fs.readFileSync(directory + '.authority.json')).kind, 'fresh');
    assert.equal(fs.existsSync(path.join(directory, 'mesh.db')), true);
    assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  });

test('Windows pending initialization refuses foreign entries and resumes only a matching binding',
  { skip: !windows }, t => {
    const f = fixture(t); const directory = value(f.invoke('ensurePrivateProjectStateDir', { create: true }));
    const marker = directory + '.authority.json'; const manifestFile = path.join(directory, '.project-root.json');
    const manifest = fs.readFileSync(manifestFile); const authority = JSON.parse(fs.readFileSync(marker));
    fs.writeFileSync(marker, JSON.stringify({ ...authority, kind: 'pending' })); fs.unlinkSync(manifestFile);
    const foreign = path.join(directory, '.hcc-cwd-pin-' + 'a'.repeat(32)); fs.writeFileSync(foreign, 'foreign');
    assert.equal(f.invoke('ensurePrivateProjectStateDir', { create: true }).code, 'PROJECT_PATH_FORBIDDEN');
    assert.equal(JSON.parse(fs.readFileSync(marker)).kind, 'pending');
    fs.unlinkSync(foreign); fs.writeFileSync(manifestFile, manifest);
    assert.equal(value(f.invoke('ensurePrivateProjectStateDir', { create: true })), directory);
    assert.equal(JSON.parse(fs.readFileSync(marker)).kind, 'fresh');
  });

test('explicit Windows replacement selection preserves old state behind a versioned generation fence',
  { skip: !windows }, t => {
    const f = fixture(t); const original = value(f.invoke('ensurePrivateProjectStateDir', { create: true }));
    const savedManifest = fs.readFileSync(path.join(original, '.project-root.json'));
    fs.writeFileSync(path.join(original, 'preserve.txt'), 'old root state');
    fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root);
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'PROJECT_PATH_FORBIDDEN');
    const replacement = value(f.invoke('provisionPrivateProjectGeneration'));
    assert.match(replacement, /\.generations[\\/][a-f0-9]{32}$/);
    assert.equal(JSON.parse(fs.readFileSync(original + '.authority.json')).fence, 'windows-v3');
    assert.equal(value(f.invoke('ensurePrivateProjectStateDir', { create: true })), replacement);
    assert.equal(value(f.invoke('privateProjectStateDir')), replacement);
    assert.deepEqual(fs.readFileSync(path.join(original, '.project-root.json')), savedManifest);
    assert.equal(fs.readFileSync(path.join(original, 'preserve.txt'), 'utf8'), 'old root state');
    assert.equal(JSON.parse(fs.readFileSync(replacement + '.authority.json')).kind, 'fresh');
  });

test('Windows purge preserves the purging marker on unsafe content and reaches reset only after confirmed deletion',
  { skip: !windows }, t => {
    const f = fixture(t); const directory = value(f.invoke('ensurePrivateProjectStateDir', { create: true }));
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    const junction = path.join(directory, 'junction'); fs.symlinkSync(outside, junction, 'junction');
    const rejected = f.invoke('purgePrivateProjectState');
    assert.equal(rejected.ok, false);
    assert.equal(JSON.parse(fs.readFileSync(directory + '.authority.json')).kind, 'purging');
    assert.equal(f.invoke('ensurePrivateProjectStateDir').code, 'STATE_PURGE_INCOMPLETE');
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
    fs.unlinkSync(junction);
    assert.equal(value(f.invoke('purgePrivateProjectState')), directory);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(JSON.parse(fs.readFileSync(directory + '.authority.json')).kind, 'reset');
    assert.equal(value(f.invoke('ensurePrivateProjectStateDir', { create: true })), directory);
    assert.equal(JSON.parse(fs.readFileSync(directory + '.authority.json')).kind, 'fresh');
  });
