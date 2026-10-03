import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createDshCollaboration } from '../lib/integrations/dsh-collaboration.mjs';
import { createDshCordisPlugin } from '../lib/integrations/dsh-cordis.mjs';
import { ensureDshIntegration, inspectDshIntegration } from '../lib/integrations/dsh.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cordis-test-home-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
test.after(() => { process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); });
const cleanups = new WeakMap();
function cleanup(t, fn) {
  if (!cleanups.has(t)) { cleanups.set(t, []); t.after(async () => { for (const action of cleanups.get(t).reverse()) await action(); }); }
  cleanups.get(t).push(fn);
}
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cordis-project-')));
  cleanup(t, () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function session(t, root, id, options = {}) {
  const s = createDshCollaboration({ sessionId: id, cwd: root, ...options });
  cleanup(t, () => s.dispose());
  return s;
}
function read(s, query, ...params) {
  const db = new DatabaseSync(s.ctx.dbPath);
  try { return db.prepare(query).all(...params).map(row => ({ ...row })); }
  finally { db.close(); }
}
function fakeContext() {
  const listeners = new Map(), tools = new Map();
  return {
    tools: { register(tool) { if (tools.has(tool.name)) throw new Error('duplicate tool'); tools.set(tool.name, tool); } },
    catalogue: tools,
    on(name, fn, opts) { const entries = listeners.get(name) || []; opts?.prepend ? entries.unshift(fn) : entries.push(fn); listeners.set(name, entries); },
    async emit(name, ...args) { for (const callback of listeners.get(name) || []) await callback(...args); },
    async waterfall(name, payload, terminal) {
      const entries = listeners.get(name) || [];
      const step = index => index < entries.length ? entries[index](payload, () => step(index + 1)) : terminal();
      return step(0);
    },
    async dispose() { await this.emit('dispose'); tools.clear(); listeners.clear(); }
  };
}
function fakeAgent(root, id) { return { session: { header: { cwd: root, id } }, steer() { throw new Error('Unexpected steering'); } }; }
const signal = new AbortController().signal;

test('Cordis setup selects one injector, remembers the mode, disables and re-enables idempotently', t => {
  const root = project(t), ctx = { root, cwd: root };
  const first = ensureDshIntegration(ctx, { mode: 'cordis' });
  assert.match(fs.readFileSync(first.patchPath, 'utf8'), /dsh-cordis\.mjs/);
  assert.doesNotMatch(fs.readFileSync(first.patchPath, 'utf8'), /hooks-claude-code/);
  assert.equal(inspectDshIntegration(ctx).mode, 'cordis');
  assert.deepEqual(ensureDshIntegration(ctx).changed, []);
  const off = ensureDshIntegration(ctx, { mode: 'off' });
  assert.match(fs.readFileSync(off.patchPath, 'utf8'), /\[\]/);
  assert.equal(inspectDshIntegration(ctx).state, 'disabled');
  assert.deepEqual(ensureDshIntegration(ctx).changed, []);
  assert.equal(ensureDshIntegration(ctx, { mode: 'hooks' }).mode, 'hooks');
  assert.match(fs.readFileSync(first.patchPath, 'utf8'), /hooks-claude-code/);
});

test('Agent tools and context bind raw session IDs to separate projects and peers', async t => {
  const root = project(t), other = project(t);
  const a = session(t, root, 'opaque/session A'), b = session(t, root, 'opaque/session B'), c = session(t, other, 'opaque/session A');
  assert.notEqual(a.peer, b.peer);
  assert.equal(a.peer, c.peer);
  assert.notEqual(a.ctx.dbPath, c.ctx.dbPath);
  assert.equal((await a.call('hcc_message_send', { to: b.peer, body: 'MESSAGE_ONLY_FOR_B' })).ok, true);
  assert.doesNotMatch(a.snapshot().text, /MESSAGE_ONLY_FOR_B/);
  assert.match(b.snapshot().text, /MESSAGE_ONLY_FOR_B/);
  assert.doesNotMatch(c.snapshot().text, /MESSAGE_ONLY_FOR_B/);
  const forged = await a.call('hcc_message_send', { to: b.peer, body: 'forged', from: 'coordinator' });
  assert.equal(forged.ok, false);
  assert.equal(read(a, 'SELECT sender FROM messages')[0].sender, a.peer);
});

test('two concurrent Agents cannot claim one session and a hooks binding prevents double injection', t => {
  const root = project(t), a = session(t, root, 'same');
  assert.throws(() => createDshCollaboration({ sessionId: 'same', cwd: root }), { code: 'DSH_COLLABORATION_CONFLICT' });
  const db = new DatabaseSync(a.ctx.dbPath);
  db.prepare("UPDATE peer_bindings SET transport='hook', runtime_target=NULL WHERE peer=?").run(a.peer);
  db.close();
  assert.throws(() => a.snapshot(), { code: 'DSH_COLLABORATION_CONFLICT' });
  assert.throws(() => createDshCollaboration({ sessionId: 'same', cwd: root }), { code: 'DSH_COLLABORATION_CONFLICT' });
  // A lost owner must not mark the replacement hook peer exited.
  assert.throws(() => a.dispose(), { code: 'DSH_COLLABORATION_CONFLICT' });
  assert.equal(read(a, 'SELECT status FROM peers')[0].status, 'idle');
});

test('disposal expires only the owned peer, preserves raw identity and permits a clean resume', t => {
  const root = project(t), a = session(t, root, 'resume/A'), b = session(t, root, 'resume/B');
  a.dispose(); a.dispose();
  assert.throws(() => a.snapshot(), { code: 'DSH_COLLABORATION_CONFLICT' });
  assert.equal(read(b, 'SELECT status FROM peers WHERE id=?', a.peer)[0].status, 'exited');
  assert.equal(read(b, 'SELECT status FROM peers WHERE id=?', b.peer)[0].status, 'idle');
  const resumed = session(t, root, 'resume/A');
  assert.equal(resumed.peer, a.peer);
  assert.equal(read(resumed, 'SELECT provider_session_id FROM peer_bindings WHERE peer=?', a.peer)[0].provider_session_id, 'resume/A');
});

test('failed database retirement fences the old authority and remains retryable', t => {
  const root = project(t), a = session(t, root, 'retire/retry');
  const backup = `${a.ctx.dbPath}.temporarily-moved`;
  fs.renameSync(a.ctx.dbPath, backup);
  try {
    assert.throws(() => a.dispose(), { code: 'NOT_FOUND' });
    assert.throws(() => a.snapshot(), { code: 'DSH_COLLABORATION_CONFLICT' });
  } finally {
    fs.renameSync(backup, a.ctx.dbPath);
  }
  assert.throws(() => createDshCollaboration({ sessionId: 'retire/retry', cwd: root }), { code: 'DSH_COLLABORATION_CONFLICT' });
  a.dispose();
  const resumed = session(t, root, 'retire/retry');
  assert.equal(resumed.peer, a.peer);
});

test('a crashed Cordis owner can be resumed only with complete dead-process evidence', t => {
  const root = project(t);
  const script = `import { createDshCollaboration } from ${JSON.stringify(new URL('../lib/integrations/dsh-collaboration.mjs', import.meta.url).href)};
    createDshCollaboration({ sessionId: 'crashed/A', cwd: process.env.HCC_TEST_ROOT });
    createDshCollaboration({ sessionId: 'crashed/B', cwd: process.env.HCC_TEST_ROOT });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HCC_TEST_ROOT: root }, encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);

  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const db = new DatabaseSync(dbPath);
  const stale = db.prepare("SELECT p.*, b.runtime_target FROM peers p JOIN peer_bindings b ON b.peer=p.id WHERE b.provider_session_id='crashed/A'").get();
  const unknown = db.prepare("SELECT p.id FROM peers p JOIN peer_bindings b ON b.peer=p.id WHERE b.provider_session_id='crashed/B'").get();
  assert.equal(stale.status, 'idle');
  assert.equal(stale.pid, child.pid);
  db.prepare('UPDATE peers SET pid_start_token=NULL WHERE id=?').run(unknown.id);
  db.close();

  const resumed = session(t, root, 'crashed/A');
  assert.equal(resumed.peer, stale.id);
  assert.notEqual(read(resumed, 'SELECT runtime_target FROM peer_bindings WHERE peer=?', stale.id)[0].runtime_target, stale.runtime_target);
  assert.throws(() => createDshCollaboration({ sessionId: 'crashed/B', cwd: root }), { code: 'DSH_COLLABORATION_CONFLICT' });
});

test('bounded context and tool outputs leave truncated messages unread', async t => {
  const a = session(t, project(t), 'bounded', { maxContextChars: 4096, maxToolChars: 2048 });
  await a.call('hcc_message_send', { to: a.peer, body: 'LONG_MESSAGE_' + '"\\'.repeat(7000) });
  const snapshot = a.snapshot();
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.text.length <= 4096);
  assert.deepEqual(snapshot.messages, []);
  const inbox = await a.call('hcc_inbox', {});
  assert.equal(inbox.truncated, true);
  assert.ok(JSON.stringify(inbox).length <= 2048);
  assert.equal(read(a, 'SELECT * FROM message_reads').length, 0);
});

test('cancelled Agent tools perform no business mutation', async t => {
  const a = session(t, project(t), 'cancelled');
  const controller = new AbortController(); controller.abort(new Error('cancelled by owner'));
  await assert.rejects(a.call('hcc_message_send', { to: a.peer, body: 'MUST_NOT_SEND' }, controller.signal), /cancelled by owner/);
  assert.equal(read(a, 'SELECT * FROM messages').length, 0);
});

test('plugin preserves rejected admission and permission decisions; ACK follows only the committed context', async t => {
  const root = project(t), ctx = fakeContext(), agent = fakeAgent(root, 'plugin/A');
  createDshCordisPlugin({ checkRuntime() {} })(ctx);
  cleanup(t, () => ctx.dispose());
  await ctx.emit('agent/created', { agent, signal });
  const send = ctx.catalogue.get('hcc_message_send');
  const state = ctx.catalogue.get('hcc_state');
  const first = await state.execute({}, { agent, signal });
  const peer = first.peer;
  await send.execute({ to: peer, body: 'ACK_AFTER_COMMIT' }, { agent, signal });
  const rejected = { kind: 'reject' };
  assert.equal(await ctx.waterfall('agent/pre-step', { agent, signal }, () => rejected), rejected);
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const reads = () => { const db = new DatabaseSync(dbPath); try { return db.prepare('SELECT * FROM message_reads').all().length; } finally { db.close(); } };
  assert.equal(reads(), 0);
  const decision = await ctx.waterfall('agent/pre-step', { agent, signal }, () => ({ kind: 'enter', messages: [], startsRequestSeries: true }));
  assert.equal(decision.startsRequestSeries, true);
  const message = decision.messages.at(-1);
  assert.match(message.content[0].text, /ACK_AFTER_COMMIT/);
  assert.equal(reads(), 0);
  await ctx.emit('session/event', { header: agent.session.header }, { type: 'user/message', data: message });
  assert.equal(reads(), 0, 'another Session object cannot acknowledge this Agent');
  await ctx.emit('session/event', agent.session, { type: 'user/message', data: message });
  assert.equal(reads(), 1);
  for (const kind of ['deny', 'ask', 'allow']) {
    const policy = { kind, reason: 'external policy' };
    assert.equal(await ctx.waterfall('tools/pre-execute', { agent, name: 'Bash', signal }, () => policy), policy);
  }
  await assert.rejects(state.execute({}, { signal }), /owning Agent/);
});

test('plugin disposal and reloading register one tool catalogue and cannot reuse stale execution authority', async t => {
  const root = project(t), agent = fakeAgent(root, 'reload');
  const apply = createDshCordisPlugin({ checkRuntime() {} });
  const old = fakeContext(); apply(old);
  await old.emit('agent/created', { agent, signal });
  const stale = old.catalogue.get('hcc_state');
  await old.dispose();
  await assert.rejects(stale.execute({}, { agent, signal }), /disposed/);
  const fresh = fakeContext(); apply(fresh); cleanup(t, () => fresh.dispose());
  assert.equal(fresh.catalogue.size, 10);
  // Existing agents on hot reload initialize on the awaited next pre-step.
  const decision = await fresh.waterfall('agent/pre-step', { agent, signal }, () => ({ kind: 'enter', messages: [] }));
  assert.equal(decision.kind, 'enter');
  assert.equal((await fresh.catalogue.get('hcc_state').execute({}, { agent, signal })).ok, true);
});

test('plugin cleanup failure cannot be recovered from idle, error, or a live PID without exact Agent disposal', async t => {
  const root = project(t), oldAgent = fakeAgent(root, 'retire/proof'), replacement = fakeAgent(root, 'retire/proof');
  let blocked = true, first = null;
  const apply = createDshCordisPlugin({ checkRuntime() {}, createCollaboration(input) {
    const state = createDshCollaboration(input);
    if (first) return state;
    first = state;
    return { ...state, dispose() { if (blocked) throw new Error('retirement blocked'); state.dispose(); } };
  } });
  const old = fakeContext(); apply(old);
  await old.emit('agent/created', { agent: oldAgent, signal });
  await old.emit('agent/status', { agent: oldAgent, status: 'idle' });
  await old.emit('agent/error', { agent: oldAgent, error: new Error('turn failed') });
  await assert.rejects(old.emit('agent/created', { agent: replacement, signal }), { code: 'DSH_COLLABORATION_CONFLICT' });
  await old.dispose();

  const fresh = fakeContext(); apply(fresh); cleanup(t, () => fresh.dispose());
  blocked = false;
  await assert.rejects(fresh.emit('agent/created', { agent: replacement, signal }), { code: 'DSH_COLLABORATION_CONFLICT' });
  await fresh.emit('agent/disposed', { agent: oldAgent });
  await fresh.emit('agent/created', { agent: replacement, signal });
  assert.equal((await fresh.catalogue.get('hcc_state').execute({}, { agent: replacement, signal })).ok, true);
  await assert.rejects(fresh.catalogue.get('hcc_state').execute({}, { agent: oldAgent, signal }), /disposed/);
  assert.throws(() => first.snapshot(), { code: 'DSH_COLLABORATION_CONFLICT' });
});

test('a failed exact Agent disposal is retried before a replacement claims its session', async t => {
  const root = project(t), oldAgent = fakeAgent(root, 'retire/event'), replacement = fakeAgent(root, 'retire/event');
  let blocked = true, first = null;
  const apply = createDshCordisPlugin({ checkRuntime() {}, createCollaboration(input) {
    const state = createDshCollaboration(input);
    if (first) return state;
    first = state;
    return { ...state, dispose() { if (blocked) throw new Error('retirement blocked'); state.dispose(); } };
  } });
  const old = fakeContext(); apply(old); cleanup(t, () => old.dispose());
  await old.emit('agent/created', { agent: oldAgent, signal });
  await assert.rejects(old.emit('agent/disposed', { agent: oldAgent }), /retirement blocked/);
  await assert.rejects(old.catalogue.get('hcc_state').execute({}, { agent: oldAgent, signal }), /disposed/);
  await assert.rejects(old.emit('agent/created', { agent: replacement, signal }), { code: 'DSH_COLLABORATION_CONFLICT' });
  blocked = false;
  const fresh = fakeContext(); apply(fresh); cleanup(t, () => fresh.dispose());
  await fresh.emit('agent/created', { agent: replacement, signal });
  assert.equal((await fresh.catalogue.get('hcc_state').execute({}, { agent: replacement, signal })).ok, true);
  assert.throws(() => first.snapshot(), { code: 'DSH_COLLABORATION_CONFLICT' });
});

test('plugin compatibility or invalid bounds fail before registering listeners or tools', () => {
  const ctx = fakeContext();
  assert.throws(() => createDshCordisPlugin({ checkRuntime() { throw new Error('wrong version'); } })(ctx), /wrong version/);
  assert.equal(ctx.catalogue.size, 0);
  assert.throws(() => createDshCordisPlugin({ checkRuntime() {} })(ctx, { maxContextChars: 128 }), /2048/);
  assert.equal(ctx.catalogue.size, 0);
});
