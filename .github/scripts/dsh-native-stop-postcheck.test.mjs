import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectProcessIdentity, compareProcessIdentity, waitForLiveProcessIdentity } from '../../lib/process/identity.mjs';

const helper = new URL('./dsh-native-stop-postcheck.mjs', import.meta.url);
const identity = { pid: 4312, startToken: 'boot:123', commandHash: 'a'.repeat(64) };
const expected = { generation: 'acceptance-generation', pid: identity.pid, root: '/owned/project', meshDb: '/owned/project/.hello-cc/mesh.db' };
const owner = { state: 'released', generation: expected.generation, meshDb: expected.meshDb, identity };

test('CI provides a separate bounded stop confirmation instead of rewriting the frozen receipt', () => {
  assert.equal(fs.existsSync(helper), true, 'The immediate post-down sample needs an independent bounded verifier');
});

test('pointer absence and released ownership wait for the actual recorded child to exit', async () => {
  const { confirmNativeStop } = await import(helper);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const observed = await waitForLiveProcessIdentity(child.pid, { timeoutMs: 1000 });
  assert.equal(observed.state, 'live');
  const captured = { ...expected, pid: child.pid };
  let polls = 0;
  const result = await confirmNativeStop({ expected: captured, timeoutMs: 3000, pollMs: 20,
    readPointer: () => null, readOwner: () => ({ ...owner, identity: observed.identity }),
    inspect: inspectProcessIdentity, compare: compareProcessIdentity, onObservation: () => polls++ });
  await exited;
  assert.equal(result.success, true);
  assert.ok(polls > 1, 'A released row alone must not report a still-live process as stopped');
  assert.deepEqual(result.identity, observed.identity);
  assert.equal(result.processState, 'dead');
});

test('a live identity times out even after pointer removal and owner release', async () => {
  const { confirmNativeStop } = await import(helper);
  const result = await confirmNativeStop({ expected, timeoutMs: 50, pollMs: 5,
    readPointer: () => null, readOwner: () => owner,
    inspect: () => ({ state: 'live', identity }), compare: compareProcessIdentity });
  assert.equal(result.success, false);
  assert.equal(result.code, 'NATIVE_STOP_TIMEOUT');
  assert.equal(result.processState, 'live');
});

test('PID reuse proves the recorded identity exited without signalling the replacement', async () => {
  const { confirmNativeStop } = await import(helper);
  const result = await confirmNativeStop({ expected, timeoutMs: 100, pollMs: 5,
    readPointer: () => null, readOwner: () => owner,
    inspect: () => ({ state: 'live', identity: { ...identity, startToken: 'boot:124' } }), compare: compareProcessIdentity });
  assert.equal(result.success, true);
  assert.equal(result.processState, 'reused');
  assert.deepEqual(result.identity, identity);
});

test('unknown, incomplete and changed-generation evidence cannot qualify cleanup', async () => {
  const { confirmNativeStop } = await import(helper);
  for (const readOwner of [() => ({ state: 'absent' }), () => ({ ...owner, identity: { pid: identity.pid } }),
    () => ({ ...owner, generation: 'successor' })]) {
    const result = await confirmNativeStop({ expected, timeoutMs: 50, pollMs: 5, readPointer: () => null,
      readOwner, inspect: () => ({ state: 'dead' }), compare: compareProcessIdentity });
    assert.equal(result.success, false);
    assert.equal(result.code, 'NATIVE_STOP_UNVERIFIED');
  }
  const result = await confirmNativeStop({ expected, timeoutMs: 50, pollMs: 5,
    readPointer: () => null, readOwner: () => owner,
    inspect: () => ({ state: 'unknown', identity: null }), compare: compareProcessIdentity });
  assert.equal(result.success, false);
  assert.equal(result.code, 'NATIVE_STOP_UNVERIFIED');
});

test('a successor owner appearing while shutdown is pending is rejected', async () => {
  const { confirmNativeStop } = await import(helper);
  let count = 0;
  const result = await confirmNativeStop({ expected, timeoutMs: 100, pollMs: 5,
    readPointer: () => null, readOwner: () => count++ ? { ...owner, generation: 'successor' } : owner,
    inspect: () => ({ state: 'live', identity }), compare: compareProcessIdentity });
  assert.equal(result.success, false);
  assert.equal(result.code, 'NATIVE_STOP_UNVERIFIED');
});

function fixture(t, { blocking = false } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-stop-check-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), home = path.join(directory, 'home');
  const prefix = path.join(directory, 'npm-install'), selected = path.join(directory, 'selected');
  const installed = path.join(prefix, 'node_modules', '@logicseek', 'hello-cc');
  for (const file of [root, home, selected, installed]) fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const startup = { ...expected, root, meshDb: path.join(root, '.hello-cc', 'mesh.db') };
  const canonicalMesh = path.join(home, '.hello-cc', 'projects', 'fixture', 'mesh.db');
  fs.mkdirSync(path.dirname(canonicalMesh), { recursive: true });
  fs.writeFileSync(canonicalMesh, '', { mode: 0o600 });
  const savedOwner = { ...owner, meshDb: canonicalMesh };
  const state = path.join(home, 'state.db'); fs.writeFileSync(state, 'fixture state', { mode: 0o600 });
  const sources = {
    'package.json': JSON.stringify({ name: '@logicseek/hello-cc', version: '1.2.1', type: 'module' }),
    'lib/runtime/native/store.mjs': `import os from 'node:os';export const nativePaths=()=>({db:${JSON.stringify(state)},meshDb:${JSON.stringify(canonicalMesh)}});export function readNativeOwnerStatus(){${blocking ? 'while(true){}' : ''}return ${JSON.stringify(savedOwner)}}
      export function readNativePointer(){if(os.homedir()!==${JSON.stringify(home)}||process.env.HOME!==${JSON.stringify(home)}||process.env.HCC_ROOT)throw Error('profile not isolated');return null}`,
    'lib/runtime/project-path.mjs': `export const resolveProjectDatabase=({db})=>({db:db===${JSON.stringify(startup.meshDb)}?${JSON.stringify(canonicalMesh)}:db});`,
    'lib/runtime/paths.mjs': `export const projectStateDir=()=>${JSON.stringify(path.dirname(canonicalMesh))};`,
    'lib/runtime/private-state.mjs': `export const inspectPrivateProjectAuthority=()=> 'fresh';`,
    'lib/process/identity.mjs': `export const inspectProcessIdentity=()=>({state:'dead'});export const compareProcessIdentity=()=>{throw Error('unexpected comparison')}`
  };
  for (const target of [selected, installed]) for (const [name, data] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
    fs.writeFileSync(path.join(target, name), data);
  }
  const tarball = path.join(directory, 'selected.tgz'); fs.writeFileSync(tarball, 'fixture archive');
  const receipt = path.join(directory, 'original.json'), output = path.join(directory, 'postcheck.json');
  const original = JSON.stringify({ passed: true, directory, packageInstallPrefix: prefix,
    package: { sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') },
    cleanup: { nativeRuntimeStopped: false } });
  fs.writeFileSync(receipt, original);
  fs.writeFileSync(path.join(directory, 'hcc-native-up.log'), JSON.stringify({ ok: true, data: startup }, null, 2) + '\n(node:123) ExperimentalWarning: SQLite\n');
  return { directory, installed, selected, tarball, receipt, output, original };
}

function runFixture(f, timeoutMs = 1000) {
  const env = { ...process.env, HCC_ROOT: 'parent-project-must-not-leak' }; delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [fileURLToPath(helper), '--receipt', f.receipt, '--selected-package', f.selected,
    '--tarball', f.tarball, '--output', f.output, '--timeout-ms', String(timeoutMs)],
  { encoding: 'utf8', timeout: 5000, env, windowsHide: true });
}

test('real postcheck process verifies installed bytes, preserves the original false receipt, and records complete identity', t => {
  const f = fixture(t), result = runFixture(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(fs.readFileSync(f.output));
  assert.equal(report.success, true);
  assert.equal(report.originalNativeRuntimeStopped, false);
  assert.deepEqual(report.identity, identity);
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), f.original);
});

test('a blocked read-only probe cannot hold the parent beyond its deadline', t => {
  const f = fixture(t, { blocking: true }), result = runFixture(f, 200);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const report = JSON.parse(fs.readFileSync(f.output));
  assert.equal(report.success, false);
  assert.equal(report.code, 'NATIVE_STOP_TIMEOUT');
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), f.original);
});

test('changed installed bytes and a prefix outside the receipt directory fail before importing installed code', t => {
  for (const alter of [f => fs.appendFileSync(path.join(f.installed, 'lib/runtime/native/store.mjs'), '\nthrow Error("must not import")'),
    f => { const original = JSON.parse(f.original); original.packageInstallPrefix = path.dirname(f.directory); fs.writeFileSync(f.receipt, JSON.stringify(original)); }]) {
    const f = fixture(t); alter(f); const before = fs.readFileSync(f.receipt), result = runFixture(f);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.output)).success, false);
    assert.doesNotMatch(result.stderr, /must not import/);
    assert.deepEqual(fs.readFileSync(f.receipt), before);
  }
});

test('actual installed state readers validate both project-local and private-profile database mappings',
  { skip: process.platform === 'win32' }, t => {
    for (const privateProfile of [false, true]) {
    const f = fixture(t);
    for (const target of [f.selected, f.installed]) {
      fs.cpSync(new URL('../../lib', import.meta.url), path.join(target, 'lib'), { recursive: true });
    }
    const root = path.join(f.directory, 'project'), home = path.join(f.directory, 'home');
    const setup = `import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
      import {pathToFileURL} from 'node:url';
      const base=${JSON.stringify(f.installed)},root=${JSON.stringify(root)};
      const {resolveProjectDatabase}=await import(pathToFileURL(path.join(base,'lib/runtime/project-path.mjs')));
      const {ensurePrivateProjectStateDir}=await import(pathToFileURL(path.join(base,'lib/runtime/private-state.mjs')));
      const {nativePaths}=await import(pathToFileURL(path.join(base,'lib/runtime/native/store.mjs')));
      const {inspectProcessIdentity}=await import(pathToFileURL(path.join(base,'lib/process/identity.mjs')));
      const ctx={root,dbPath:path.join(root,'.hello-cc','mesh.db')};
      if(${privateProfile})ensurePrivateProjectStateDir(root,{create:true});
      const selected=resolveProjectDatabase({root,db:ctx.dbPath,createStateDir:true});
      fs.writeFileSync(selected.db,'',{mode:0o600});
      const native=nativePaths(ctx,{create:true}),identity=inspectProcessIdentity(process.pid).identity;
      const db=new DatabaseSync(native.db);
      db.exec('CREATE TABLE native_owner(singleton INTEGER,generation TEXT,mesh_db TEXT,state_generation TEXT,pid INTEGER,start_token TEXT,command_hash TEXT,state TEXT)');
      db.prepare('INSERT INTO native_owner VALUES(1,?,?,?,?,?,?,?)').run('acceptance-generation',selected.db,'fixture',identity.pid,identity.startToken,identity.commandHash,'released');
      db.close();fs.chmodSync(native.db,0o600);
      const startup={root,meshDb:ctx.dbPath,pid:identity.pid,generation:'acceptance-generation'};
      fs.writeFileSync(${JSON.stringify(path.join(f.directory, 'hcc-native-up.log'))},JSON.stringify({ok:true,data:startup},null,2));
      console.log(JSON.stringify({identity,canonicalDb:selected.db,legacyDb:ctx.dbPath}));`;
    const env = { ...process.env, HOME: home, USERPROFILE: home, HCC_SKIP_SHIM_INSTALL: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('HCC_') && key !== 'HCC_SKIP_SHIM_INSTALL') delete env[key];
    delete env.NODE_TEST_CONTEXT;
    const prepared = spawnSync(process.execPath, ['--input-type=module', '-e', setup], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const actual = JSON.parse(prepared.stdout);
    if (privateProfile) {
      assert.notEqual(actual.canonicalDb, actual.legacyDb);
      assert.ok(actual.canonicalDb.startsWith(home + path.sep));
    } else assert.equal(actual.canonicalDb, actual.legacyDb);
    const result = runFixture(f, 3000);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(f.output));
    assert.equal(report.success, true);
    assert.deepEqual(report.identity, actual.identity);
    assert.equal(report.processState, 'dead');
    assert.equal(fs.readFileSync(f.receipt, 'utf8'), f.original);
    }
  });
