import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { recordTaskResult, listTaskResults, summarizeTaskResults } from '../lib/core/coordination/results.mjs';
import { createTaskResults } from '../lib/web/task-results.mjs';
import { pruneOldEventsPreservingTmuxAuthority } from '../lib/core/coordination/event-retention.mjs';
import { createHistoryGcSnapshot, captureHistoryGcPlan, dropHistoryGcSnapshot } from '../lib/core/coordination/gc-plan.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); initSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO tasks(id,title,status,owner,created_at,updated_at) VALUES(1,'Fix','running','codex-a',1,1)`).run();
  db.prepare(`INSERT INTO tasks(id,title,status,owner,created_at,updated_at) VALUES(2,'Other','running','codex-b',1,1)`).run();
  const record = (input = {}) => recordTaskResult(db, { peer: 'codex-a', taskId: 1, title: 'Unit tests',
    stage: 'local', status: 'passed', evidence: ['test.log'], source: 'user', ...input }, { now: () => 2 });
  const session = { peerId: 'codex-a', ctx: { root: '/results' }, binding: { provider_session_id: 'thread-a' },
    adapter: { snapshot: () => ({ executorId: 'executor-a' }) } };
  const service = createTaskResults({ connectWebProject: () => ({ prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} }),
    resolveSessionPeerId: (_db, s) => s.peerId, now: () => 2 });
  const state = (turns, events = []) => ({ executorId: 'executor-a', threads: [{ id: 'thread-a', turns }], events });
  return { db, record, session, service, state };
}

test('results retain task ownership, evidence, independent stages, and no task completion side effect', t => {
  const f = fixture(t);
  assert.throws(() => f.record({ taskId: 2 }), { code: 'TASK_OWNER_MISMATCH' });
  assert.throws(() => f.record({ status: 'passed', evidence: [] }), { code: 'BAD_REQUEST' });
  assert.throws(() => f.record({ source: 'executor', stage: 'publication' }), { code: 'BAD_REQUEST' });
  f.record();
  f.record({ stage: 'publication', status: 'pending', evidence: [], title: 'Unpublished' });
  const results = listTaskResults(f.db, { peer: 'codex-a' });
  const summary = summarizeTaskResults(results);
  assert.equal(summary.local.status, 'passed'); assert.equal(summary.publication.status, 'pending');
  assert.equal(summary.business, null);
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=1').get().status, 'running');
  assert.deepEqual(listTaskResults(f.db, { peer: 'codex-b' }), []);
});

test('stable executor result keys deduplicate snapshot rereads and survive both history GC paths', t => {
  const f = fixture(t);
  const a = f.record({ resultKey: 'executor:turn:command' });
  const b = f.record({ resultKey: 'executor:turn:command' });
  assert.equal(a.id, b.id);
  f.db.prepare("INSERT INTO events(type,payload,created_at) VALUES('diagnostic','{}',2)").run();
  const snapshot = createHistoryGcSnapshot(f.db, 10, { categories: ['events'] });
  const plan = captureHistoryGcPlan(f.db, 10, { snapshot });
  assert.deepEqual(plan.events.map(e => e.type), ['diagnostic']); dropHistoryGcSnapshot(f.db, snapshot);
  assert.equal(pruneOldEventsPreservingTmuxAuthority(f.db, 10), 1);
  assert.equal(listTaskResults(f.db, { peer: 'codex-a' }).length, 1);
});

test('automatic commands and diff use a live turn task scope; historical reads never invent test acceptance', t => {
  const f = fixture(t);
  const command = { id: 'cmd1', type: 'commandExecution', status: 'completed', command: 'node --test', exitCode: 0, aggregatedOutput: 'passed' };
  const turn = { id: 'turn-a', status: 'completed', items: [command], diff: '+fixed' };
  f.service.observeCodexResults(f.session, f.state([turn]));
  assert.equal(listTaskResults(f.db, { peer: 'codex-a' }).length, 0);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } };
  f.service.observeCodexResults(f.session, f.state([turn], [started]));
  f.session.executorId = 'executor-a';
  f.session.adapter.snapshot = () => { throw new Error('cached executor identity must not clone retained history'); };
  f.service.observeCodexResults(f.session, f.state([turn], [started]));
  const response = f.service.readSessionResults(f.session);
  assert.equal(response.results.length, 2);
  assert.equal(response.results.find(r => r.kind === 'command').status, 'passed');
  assert.equal(response.results.find(r => r.kind === 'command').command, 'node --test');
  assert.equal(response.results.find(r => r.kind === 'command').exit_code, 0);
  assert.equal(response.results.find(r => r.kind === 'diff').status, 'pending');
  assert.equal(response.results.find(r => r.kind === 'diff').diff, '+fixed');
  assert.equal(response.summary.local, null);
  assert.equal(response.results.every(r => r.thread_id === 'thread-a' && r.turn_id === 'turn-a'), true);
  f.service.observeCodexResults(f.session, { ...f.state([{ ...turn, id: 'foreign' }], [started]), executorId: 'another-executor' });
  assert.equal(f.service.readSessionResults(f.session).results.length, 2);
});

test('automatic command, output, and diff secrets are redacted before event persistence', t => {
  const f = fixture(t);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-secret' } } };
  const turn = { id: 'turn-secret', status: 'completed', items: [{
    id: 'cmd-secret', type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'curl --token=COMMAND_SECRET https://example.test',
    aggregatedOutput: 'Authorization: Bearer OUTPUT_SECRET'
  }], diff: '+url = https://example.test/?token=DIFF_SECRET' };
  f.service.observeCodexResults(f.session, f.state([turn], [started]));

  const stored = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded' ORDER BY id").all();
  assert.equal(stored.length, 2);
  const raw = stored.map(row => row.payload).join('\n');
  for (const secret of ['COMMAND_SECRET', 'OUTPUT_SECRET', 'DIFF_SECRET']) assert.doesNotMatch(raw, new RegExp(secret));
  const command = stored.map(row => JSON.parse(row.payload)).find(record => record.kind === 'command');
  const diff = stored.map(row => JSON.parse(row.payload)).find(record => record.kind === 'diff');
  assert.match(command.title, /--token=\[REDACTED\]/);
  assert.match(command.command, /--token=\[REDACTED\]/);
  assert.match(command.details, /Bearer \[REDACTED\]/);
  assert.match(diff.diff, /token=\[REDACTED\]/);
});

test('late turn completion cannot attach evidence to a task reassigned to another peer', t => {
  const f = fixture(t);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } };
  f.service.observeCodexResults(f.session, f.state([{ id: 'turn-a', status: 'inProgress', items: [] }], [started]));
  f.db.prepare("UPDATE tasks SET owner='codex-b' WHERE id=1").run();
  f.service.observeCodexResults(f.session, f.state([{ id: 'turn-a', status: 'completed', items: [
    { id: 'cmd', type: 'commandExecution', status: 'completed', command: 'test', exitCode: 0 }
  ] }], [started]));
  assert.equal(listTaskResults(f.db, { peer: 'codex-a' }).length, 0);
  assert.throws(() => f.service.writeSessionResult(f.session, { taskId: 1, title: 'Passed', evidence: ['log'], status: 'passed' }),
    { code: 'TASK_OWNER_MISMATCH' });
});
