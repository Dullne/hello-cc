import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');

function isolated(t, body) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-shutdown-state-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const prelude = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { performance } from 'node:perf_hooks';
    import { DatabaseSync } from 'node:sqlite';
    import { pathToFileURL } from 'node:url';
    const load = p => import(pathToFileURL(path.join(${JSON.stringify(repo)}, p)));
    const sandbox = ${JSON.stringify(sandbox)};
    const root = path.join(sandbox, 'project');
    fs.mkdirSync(root, { mode: 0o700 });
    const { createConnectionHelpers } = await load('lib/db/connection.mjs');
    const { createPeerBindingStore } = await load('lib/db/stores/peers.mjs');
    const { connect } = createConnectionHelpers({ now: () => 1,
      dedupePeerBindings: createPeerBindingStore().dedupePeerBindings, redactedLogText: v => v });
    const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + body], {
    env: { ...process.env, HOME: sandbox, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

test('shutdown pointer cleanup skips a contended lock and keeps a successor owner', t => isolated(t, `
  const { writeRuntime, clearRuntime, readRuntimeFile } = await load('lib/runtime/state.mjs');
  const { acquireFileLock } = await load('lib/shared/file-lock.mjs');
  const owner = { pid: process.pid, startToken: 'boot:original', commandHash: 'a'.repeat(64) };
  const value = { pid: process.pid, process_identity: owner, base_url: 'http://127.0.0.1:1' };
  const file = writeRuntime(ctx, value);
  const lease = acquireFileLock(file);
  const started = performance.now();
  try {
    clearRuntime(ctx, process.pid, { nonblocking: true, clearGlobal: false,
      expectedIdentity: owner, deadline: started + 1000 });
    assert.ok(performance.now() - started < 1500, 'contended cleanup waited for the normal 5s lock timeout');
    assert.equal(readRuntimeFile(ctx).process_identity.startToken, owner.startToken);
  } finally { lease.release(); }
  const successor = { ...owner, startToken: 'boot:successor' };
  writeRuntime(ctx, { ...value, process_identity: successor });
  clearRuntime(ctx, process.pid, { nonblocking: true, clearGlobal: false, expectedIdentity: owner });
  assert.equal(readRuntimeFile(ctx).process_identity.startToken, successor.startToken);
  clearRuntime(ctx, process.pid, { nonblocking: true, clearGlobal: false, expectedIdentity: successor });
  assert.equal(fs.existsSync(file), false);
`));

test('shutdown connection uses an existing schema without waiting on its writer', t => isolated(t, `
  connect(ctx, { migrateRegistered: false }).close();
  const holder = new DatabaseSync(ctx.dbPath);
  holder.exec('BEGIN IMMEDIATE');
  let db;
  const started = performance.now();
  try {
    db = connect(ctx, { create: false, existingSchema: true });
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked|busy/i);
    assert.ok(performance.now() - started < 1500, 'shutdown connection waited on the writer');
  } finally { db?.close(); holder.exec('ROLLBACK'); holder.close(); }
`));

test('shutdown connection rejects old schema without migrating or creating a database', t => isolated(t, `
  const db = connect(ctx, { migrateRegistered: false });
  db.exec('DELETE FROM schema_migrations');
  db.exec('PRAGMA user_version = 1');
  db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  db.close();
  assert.throws(() => connect(ctx, { create: false, existingSchema: true }), { code: 'DB_SCHEMA_NOT_CURRENT' });
  const check = new DatabaseSync(ctx.dbPath, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  check.close();
  assert.throws(() => connect({ dbPath: path.join(sandbox, 'missing.db') },
    { create: false, existingSchema: true }));
  assert.equal(fs.existsSync(path.join(sandbox, 'missing.db')), false);
  assert.throws(() => connect(ctx, { existingSchema: true }), /create.*false/i);
`));

const stateFixture = `
  const { cleanupRuntimeState } = await load('lib/web/shutdown-state.mjs');
  const seed = connect(ctx, { migrateRegistered: false });
  for (const [id, transport, target] of [['owned', 'tmux', '%1'], ['pty', 'web-pty', null], ['replaced', 'tmux', '%99']]) {
    seed.prepare("INSERT INTO peers(id, kind, pid, status, created_at, last_seen_at) VALUES (?, 'shell', 123, 'running', 1, 1)").run(id);
    seed.prepare("INSERT INTO peer_bindings(peer, provider, transport, runtime_session_id, runtime_target, created_at, updated_at) VALUES (?, 'shell', ?, ?, ?, 1, 1)").run(id, transport, id, target);
  }
  seed.close();
  const sessions = new Map(['owned', 'pty', 'replaced'].map(id => [id,
    { id, peerId: id, pid: 123, type: id === 'pty' ? undefined : 'tmux',
      pty: id === 'pty' ? {} : undefined, pane: '%1', status: 'running', ctx }]));
  const clean = extra => cleanupRuntimeState({ ctx, sessions, ownerIdentity: null,
    connectWebProject: connect, now: () => 2, ...extra });
  const rows = () => {
    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try { return db.prepare('SELECT p.id, p.status, b.runtime_target, b.updated_at FROM peers p JOIN peer_bindings b ON b.peer = p.id ORDER BY p.id').all().map(r => ({...r})); }
    finally { db.close(); }
  };
`;

test('busy shutdown leaves both records intact; later cleanup detaches only the captured tmux and PTY owners', t => isolated(t, stateFixture + `
  const original = rows();
  const holder = new DatabaseSync(ctx.dbPath);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    assert.equal(clean().skippedProjects, 1);
    assert.ok(performance.now() - started < 1500);
    assert.deepEqual(rows(), original);
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  assert.equal(clean().detachedProjects, 1);
  assert.deepEqual(rows(), [
    { id: 'owned', status: 'detached', runtime_target: null, updated_at: 2 },
    { id: 'pty', status: 'detached', runtime_target: null, updated_at: 2 },
    { id: 'replaced', status: 'running', runtime_target: '%99', updated_at: 1 }
  ]);
`));

test('a failed binding update rolls back the preceding peer status update', t => isolated(t, stateFixture + `
  const original = rows();
  const db = new DatabaseSync(ctx.dbPath);
  db.exec("CREATE TRIGGER reject_shutdown BEFORE UPDATE ON peer_bindings BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  db.close();
  assert.equal(clean().skippedProjects, 1);
  assert.deepEqual(rows(), original);
`));

test('a replacement PTY process or transport is not detached by its previous runtime session', t => isolated(t, stateFixture + `
  for (const mutation of ["UPDATE peers SET pid = 456 WHERE id = 'pty'",
    "UPDATE peer_bindings SET transport = 'native' WHERE peer = 'pty'"] ) {
    const db = new DatabaseSync(ctx.dbPath);
    db.exec("UPDATE peers SET pid = 123 WHERE id = 'pty'; UPDATE peer_bindings SET transport = 'web-pty' WHERE peer = 'pty'");
    db.exec(mutation); db.close();
    const before = rows().find(row => row.id === 'pty');
    clean();
    assert.deepEqual(rows().find(row => row.id === 'pty'), before);
  }
`));

test('a rebound project is left unchanged and a consumed shared budget admits no new work', t => isolated(t, stateFixture + `
  const original = rows();
  ctx.rootIdentity = { assertUnchanged() { throw new Error('fixture project rebound'); } };
  assert.equal(clean().skippedProjects, 1);
  assert.deepEqual(rows(), original);
  delete ctx.rootIdentity;
  const owner = { pid: 73, startToken: 'boot:old', commandHash: 'a'.repeat(64) };
  const calls = [];
  let tick = 0;
  clean({ ownerIdentity: owner, monotonicNow: () => tick, budgetMs: 10,
    clearPointers: (project, pid, options) => { calls.push({root: project.root, options}); tick = 10; },
    readProjects: () => { throw new Error('registry read after budget'); },
    connectWebProject: () => { throw new Error('database open after budget'); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.nonblocking, true);
  assert.equal(calls[0].options.deadline, 10);
  assert.deepEqual(rows(), original);
`));

test('pointer sweep deduplicates the primary project and clears global only once', t => isolated(t, `
  const { cleanupRuntimeState } = await load('lib/web/shutdown-state.mjs');
  const calls = [];
  cleanupRuntimeState({ ctx, sessions: new Map(), connectWebProject: connect, now: () => 1,
    ownerIdentity: { pid: 73, startToken: 'boot:old', commandHash: 'a'.repeat(64) },
    readProjects: () => [{root}, {root: path.join(root, '.')}, {root: path.join(sandbox, 'second')}],
    clearPointers: (project, pid, options) => calls.push({root: project.root, options}) });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.clearGlobal, undefined);
  assert.equal(calls[1].options.clearGlobal, false);
`));
