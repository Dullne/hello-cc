import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';

const moduleUrl = new URL('../lib/integrations/dsh-collaboration.mjs', import.meta.url).href;
const sessionId = 'cordis-recovery-boundary';
const supported = ['darwin', 'linux'].includes(process.platform);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cordis-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), privateHome = path.join(directory, 'home');
  fs.mkdirSync(root); fs.mkdirSync(privateHome);
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  function run(dispose = false) {
    const script = `import { createDshCollaboration } from ${JSON.stringify(moduleUrl)};
      try {
        const state = createDshCollaboration({ sessionId: ${JSON.stringify(sessionId)}, cwd: process.env.HCC_RECOVERY_PROJECT });
        console.log(JSON.stringify({ ok: true, peer: state.peer }));
        ${dispose ? 'state.dispose();' : ''}
      } catch (error) {
        console.log(JSON.stringify({ ok: false, code: error.code }));
        process.exitCode = 1;
      }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: privateHome, HCC_RECOVERY_PROJECT: root }, encoding: 'utf8'
    });
    assert.equal(child.error, undefined);
    return { ...JSON.parse(child.stdout.trim()), status: child.status, pid: child.pid };
  }
  function withDb(fn) {
    const db = new DatabaseSync(dbPath);
    try { return fn(db); } finally { db.close(); }
  }
  const record = () => withDb(db => ({
    peer: { ...db.prepare('SELECT * FROM peers').get() },
    binding: { ...db.prepare('SELECT * FROM peer_bindings').get() }
  }));
  const created = run();
  assert.equal(created.status, 0);
  assert.equal(inspectProcessIdentity(created.pid).state, 'dead');
  return { run, withDb, record, created };
}

test('Cordis recovery does not take a live PID when only its command changed', { skip: !supported }, t => {
  const f = fixture(t), live = inspectProcessIdentity(process.pid);
  assert.equal(live.state, 'live');
  const differentHash = live.identity.commandHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  f.withDb(db => db.prepare('UPDATE peers SET pid=?, pid_start_token=?, pid_command_hash=?')
    .run(process.pid, live.identity.startToken, differentHash));
  const before = f.record(), resumed = f.run(true);
  assert.equal(resumed.code, 'DSH_COLLABORATION_CONFLICT');
  assert.equal(resumed.status, 1);
  assert.deepEqual(f.record(), before, 'a live owner and its binding must remain unchanged');
});

test('Cordis recovery replaces a recycled PID only when its start token changed', { skip: !supported }, t => {
  const f = fixture(t), live = inspectProcessIdentity(process.pid);
  assert.equal(live.state, 'live');
  f.withDb(db => db.prepare('UPDATE peers SET pid=?, pid_start_token=?, pid_command_hash=?')
    .run(process.pid, `${live.identity.startToken}:previous-process`, live.identity.commandHash));
  const before = f.record(), resumed = f.run();
  assert.equal(resumed.status, 0);
  assert.equal(resumed.peer, f.created.peer);
  const after = f.record();
  assert.notEqual(after.binding.runtime_target, before.binding.runtime_target);
  assert.equal(after.binding.provider_session_id, sessionId);
  assert.equal(after.binding.runtime_session_id, sessionId);
  assert.equal(after.peer.pid, resumed.pid);
  assert.equal(f.withDb(db => db.prepare('SELECT COUNT(*) AS n FROM peer_bindings').get().n), 1);
  assert.equal(inspectProcessIdentity(process.pid).state, 'live', 'recovery must not signal the recycled PID');
});

test('Cordis recovery rejects a dead owner whose runtime session differs from its provider session', { skip: !supported }, t => {
  const f = fixture(t);
  f.withDb(db => db.prepare('UPDATE peer_bindings SET runtime_session_id=?').run('foreign-session'));
  const before = f.record(), resumed = f.run(true);
  assert.equal(resumed.status, 1);
  assert.equal(resumed.code, 'DSH_COLLABORATION_CONFLICT');
  assert.deepEqual(f.record(), before);
});

test('Cordis recovery preserves a live legacy Mac owner across the boot-token migration', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), live = inspectProcessIdentity(process.pid);
  assert.equal(live.state, 'live'); assert.match(live.identity.startToken, /^darwin:/);
  const start = live.identity.startToken.split(':').slice(2).join(':');
  f.withDb(db => db.prepare('UPDATE peers SET pid=?, pid_start_token=?, pid_command_hash=?')
    .run(process.pid, `1789353593:539676:${start}`, live.identity.commandHash));
  const before = f.record(), resumed = f.run(true);
  assert.equal(resumed.status, 1); assert.equal(resumed.code, 'DSH_COLLABORATION_CONFLICT');
  assert.deepEqual(f.record(), before, 'token migration must not replace a live Cordis owner');
});

test('Cordis recovery rejects a dead owner with an incomplete command identity', { skip: !supported }, t => {
  const f = fixture(t);
  for (const incomplete of [null, 'invalid-command-hash']) {
    f.withDb(db => db.prepare('UPDATE peers SET pid_command_hash=?').run(incomplete));
    const before = f.record(), resumed = f.run(true);
    assert.equal(resumed.status, 1);
    assert.equal(resumed.code, 'DSH_COLLABORATION_CONFLICT');
    assert.deepEqual(f.record(), before);
  }
});
