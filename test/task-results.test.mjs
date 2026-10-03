import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { recordTaskResult, listTaskResults, summarizeTaskResults } from '../lib/core/coordination/results.mjs';
import { automaticResultKey } from '../lib/shared/automatic-result-key.mjs';
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
  f.service.observeCodexResults(f.session, f.state([turn], [started]), started);
  f.session.executorId = 'executor-a';
  f.session.adapter.snapshot = () => { throw new Error('cached executor identity must not clone retained history'); };
  f.service.observeCodexResults(f.session, f.state([turn], [started]));
  const response = f.service.readSessionResults(f.session);
  assert.equal(response.results.length, 2);
  assert.equal(response.results.find(r => r.kind === 'command').status, 'passed');
  assert.equal(response.results.find(r => r.kind === 'command').title, 'Command execution');
  assert.equal(response.results.find(r => r.kind === 'command').command, '');
  assert.equal(response.results.find(r => r.kind === 'command').details, '');
  assert.equal(response.results.find(r => r.kind === 'command').exit_code, 0);
  assert.equal(response.results.find(r => r.kind === 'diff').status, 'pending');
  assert.equal(response.results.find(r => r.kind === 'diff').diff, '');
  assert.equal(response.summary.local, null);
  assert.equal(response.results.every(r => r.thread_id === 'thread-a' && r.turn_id === 'turn-a'), true);
  assert.equal(response.results.every(r => !Object.hasOwn(r, 'task_title')), true);
  f.service.observeCodexResults(f.session, { ...f.state([{ ...turn, id: 'foreign' }], [started]), executorId: 'another-executor' });
  assert.equal(f.service.readSessionResults(f.session).results.length, 2);
});

test('automatic command, output, and diff content never enters durable result events', t => {
  const f = fixture(t);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-secret' } } };
  const canary = 'OPAQUE_CANARY_7f4a';
  const turn = { id: 'turn-secret', status: 'completed', items: [{
    id: 'cmd-secret', type: 'commandExecution', status: 'completed', exitCode: 0,
    command: `echo ${canary} --token=COMMAND_SECRET`,
    aggregatedOutput: `result=${canary}\nAuthorization: Bearer OUTPUT_SECRET`
  }], diff: `+const value = '${canary}'; // token=DIFF_SECRET` };
  f.service.observeCodexResults(f.session, f.state([turn], [started]), started);
  f.service.observeCodexResults(f.session, f.state([{ ...turn, diff: '+different contents' }], [started]));

  const stored = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded' ORDER BY id").all();
  assert.equal(stored.length, 2);
  const raw = stored.map(row => row.payload).join('\n');
  for (const secret of [canary, 'COMMAND_SECRET', 'OUTPUT_SECRET', 'DIFF_SECRET']) assert.doesNotMatch(raw, new RegExp(secret));
  const command = stored.map(row => JSON.parse(row.payload)).find(record => record.kind === 'command');
  const diff = stored.map(row => JSON.parse(row.payload)).find(record => record.kind === 'diff');
  assert.equal(command.title, 'Command execution');
  assert.equal(command.command, ''); assert.equal(command.details, '');
  assert.equal(diff.title, 'Turn changes awaiting review'); assert.equal(diff.diff, '');
  assert.equal(diff.result_key, automaticResultKey({ executorId: 'executor-a', threadId: 'thread-a',
    turnId: 'turn-secret', kind: 'diff' }));
});

test('automatic writer drops freeform fields even if a caller supplies them', t => {
  const f = fixture(t);
  const canary = 'OPAQUE_DIRECT_WRITER_SECRET';
  const record = recordTaskResult(f.db, { peer: 'codex-a', taskId: 1, source: 'executor',
    stage: 'local', kind: 'command', status: 'passed', exitCode: 0,
    executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-a', itemId: 'cmd-a',
    title: canary, details: canary, command: canary, diff: canary,
    evidence: [canary], resultKey: canary }, { now: () => 2, automatic: true });
  assert.equal(record.result_key, automaticResultKey({ executorId: 'executor-a', threadId: 'thread-a',
    turnId: 'turn-a', kind: 'command', itemId: 'cmd-a' }));
  assert.equal(record.title, 'Command execution');
  assert.equal(record.details, ''); assert.equal(record.command, '');
  assert.equal(record.diff, ''); assert.deepEqual(record.evidence, []);
  assert.doesNotMatch(f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded'").get().payload, new RegExp(canary));
});

test('v7 startup scrubs legacy automatic results once but preserves explicit evidence', t => {
  const f = fixture(t);
  const canary = 'OPAQUE_LEGACY_SECRET';
  f.record({ source: 'executor', kind: 'command', status: 'passed', evidence: [],
    title: `echo ${canary}`, command: `echo ${canary}`, details: `result=${canary}`,
    executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-old', itemId: 'cmd-old',
    resultKey: 'executor-a:turn-old:cmd-old:command' });
  f.record({ source: 'executor', kind: 'diff', status: 'pending', evidence: [],
    title: 'Turn changes awaiting review', diff: `+const value = '${canary}';`,
    executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-old',
    resultKey: `executor-a:turn-old:diff:${'a'.repeat(64)}` });
  f.record({ source: 'executor', kind: 'diff', status: 'pending', evidence: [],
    title: 'Turn changes awaiting review', diff: `+const next = '${canary}';`,
    executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-old',
    resultKey: `executor-a:turn-old:diff:${'b'.repeat(64)}` });
  f.record({ source: 'executor', kind: 'command', title: 'Explicit MCP evidence',
    details: `reviewed ${canary}`, resultKey: 'mcp-explicit' });
  f.record({ source: 'executor', kind: 'command', title: 'Explicit command evidence',
    details: `reviewed ${canary}`, executorId: 'executor-a', threadId: 'thread-a',
    turnId: 'turn-old', itemId: 'explicit-cmd', resultKey: 'explicit-command' });
  f.record({ source: 'executor', kind: 'diff', title: 'Turn changes awaiting review',
    diff: `explicit ${canary}`, executorId: 'executor-a', threadId: 'thread-a',
    turnId: 'turn-old', resultKey: 'explicit-diff' });
  f.record({ source: 'user', kind: 'verification', title: 'Human review',
    details: `reviewed ${canary}`, resultKey: 'human-explicit' });
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 7);
  f.db.prepare("DELETE FROM meta WHERE key = 'automatic_result_content_scrub_v1'").run();

  initSchema(f.db);
  const rows = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded' ORDER BY id").all().map(row => JSON.parse(row.payload));
  assert.equal(rows.length, 7);
  assert.equal(rows[0].title, 'Command execution');
  assert.equal(rows[0].command, ''); assert.equal(rows[0].details, '');
  assert.equal(rows[1].diff, '');
  assert.equal(rows[1].result_key, automaticResultKey({ executorId: 'executor-a', threadId: 'thread-a',
    turnId: 'turn-old', kind: 'diff' }));
  assert.equal(rows[2].result_key, rows[1].result_key);
  assert.equal(rows[2].diff, '');
  assert.equal(Object.hasOwn(rows[0], 'task_title'), false);
  assert.equal(rows[3].details, `reviewed ${canary}`);
  assert.equal(rows[4].details, `reviewed ${canary}`);
  assert.equal(rows[5].diff, `explicit ${canary}`);
  assert.equal(rows[6].details, `reviewed ${canary}`);
  assert.equal(rows.slice(0, 3).some(row => JSON.stringify(row).includes(canary)), false);
  const repeatedDiff = recordTaskResult(f.db, { peer: 'codex-a', taskId: 1,
    source: 'executor', stage: 'local', kind: 'diff', status: 'pending',
    executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-old'
  }, { now: () => 3, automatic: true });
  assert.equal(repeatedDiff.result_id, rows[2].result_id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.result.recorded'").get().count, 7);
  const changes = f.db.prepare('SELECT total_changes() AS count').get().count;
  initSchema(f.db);
  assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key = 'automatic_result_content_scrub_v1'").get().count, 1);
});

test('automatic result keys bound long IDs and distinguish ambiguous separators', t => {
  const f = fixture(t);
  const base = { peer: 'codex-a', taskId: 1, source: 'executor', kind: 'command',
    status: 'passed', exitCode: 0, itemId: 'item-a' };
  const long = recordTaskResult(f.db, { ...base,
    executorId: 'e'.repeat(512), threadId: 'h'.repeat(512), turnId: 't'.repeat(512)
  }, { automatic: true });
  assert.match(long.result_key, /^automatic:command:[a-f0-9]{64}$/);
  assert.ok(long.result_key.length < 700);
  const first = recordTaskResult(f.db, { ...base,
    executorId: 'a:b', threadId: 'thread', turnId: 'c'
  }, { automatic: true });
  const second = recordTaskResult(f.db, { ...base,
    executorId: 'a', threadId: 'thread', turnId: 'b:c'
  }, { automatic: true });
  assert.notEqual(first.result_key, second.result_key);
  assert.notEqual(first.id, second.id);
});

test('v7 startup scrub processes result history across multiple bounded pages', t => {
  const f = fixture(t);
  for (let index = 0; index < 205; index += 1) {
    f.record({ source: 'executor', kind: 'command', status: 'failed', evidence: [],
      title: `echo OPAQUE_PAGE_SECRET_${index}`, command: `echo OPAQUE_PAGE_SECRET_${index}`,
      executorId: 'executor-a', threadId: 'thread-a', turnId: `turn-${index}`, itemId: 'cmd',
      resultKey: `executor-a:turn-${index}:cmd:command` });
  }
  f.db.prepare("DELETE FROM meta WHERE key = 'automatic_result_content_scrub_v1'").run();
  initSchema(f.db);
  const rows = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded' ORDER BY id").all();
  assert.equal(rows.length, 205);
  assert.equal(rows.every(row => !row.payload.includes('OPAQUE_PAGE_SECRET')), true);
  assert.equal(rows.every(row => JSON.parse(row.payload).title === 'Command execution'), true);
});

test('late turn completion cannot attach evidence to a task reassigned to another peer', t => {
  const f = fixture(t);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } };
  f.service.observeCodexResults(f.session, f.state([{ id: 'turn-a', status: 'inProgress', items: [] }], [started]), started);
  f.db.prepare("UPDATE tasks SET owner='codex-b' WHERE id=1").run();
  f.service.observeCodexResults(f.session, f.state([{ id: 'turn-a', status: 'completed', items: [
    { id: 'cmd', type: 'commandExecution', status: 'completed', command: 'test', exitCode: 0 }
  ] }], [started]));
  assert.equal(listTaskResults(f.db, { peer: 'codex-a' }).length, 0);
  assert.throws(() => f.service.writeSessionResult(f.session, { taskId: 1, title: 'Passed', evidence: ['log'], status: 'passed' }),
    { code: 'TASK_OWNER_MISMATCH' });
});

test('retained start events cannot bind historical turns on the first or a later snapshot', t => {
  const f = fixture(t);
  const oldStart = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-old' } } };
  const oldTurn = { id: 'turn-old', status: 'completed', items: [
    { id: 'cmd-old', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'old task command' }
  ] };
  // The observer may first see a retained snapshot after a task switch. Its
  // events are history, not evidence of what started under the current task.
  f.db.prepare("UPDATE tasks SET status='done' WHERE id=1").run();
  f.db.prepare("UPDATE tasks SET owner='codex-a' WHERE id=2").run();
  f.service.observeCodexResults(f.session, f.state([oldTurn], [oldStart]));
  f.service.observeCodexResults(f.session, f.state([oldTurn], [oldStart]),
    { method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-old' } });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.result.recorded'").get().count, 0);

  const newStart = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-new' } } };
  const newTurn = { id: 'turn-new', status: 'completed', items: [
    { id: 'cmd-new', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'new task command' }
  ] };
  f.service.observeCodexResults(f.session, f.state([oldTurn, newTurn], [oldStart, newStart]), newStart);
  const rows = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded'").all().map(row => JSON.parse(row.payload));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, 2);
  assert.equal(rows[0].turn_id, 'turn-new');
});

test('unavailable old turn does not starve a later current-task turn in the same snapshot', t => {
  const f = fixture(t);
  const oldStart = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-old' } } };
  f.service.observeCodexResults(f.session,
    f.state([{ id: 'turn-old', status: 'inProgress', items: [] }], [oldStart]), oldStart);
  f.db.prepare("UPDATE tasks SET owner='codex-b' WHERE id=1").run();
  f.db.prepare("UPDATE tasks SET owner='codex-a' WHERE id=2").run();
  const newStart = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-new' } } };
  const completed = id => ({ id, status: 'completed', items: [
    { id: `cmd-${id}`, type: 'commandExecution', status: 'completed', exitCode: 0 }
  ] });
  f.service.observeCodexResults(f.session,
    f.state([completed('turn-old'), completed('turn-new')], [oldStart, newStart]), newStart);
  const rows = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded'").all().map(row => JSON.parse(row.payload));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, 2);
  assert.equal(rows[0].turn_id, 'turn-new');
});

test('bounded retained history cannot rebind evicted turn scopes across a task switch', t => {
  const f = fixture(t);
  const retainedEvents = [];
  const retainedTurns = [];
  for (let index = 0; index < 110; index += 1) {
    if (index === 55) {
      f.db.prepare("UPDATE tasks SET status='done' WHERE id=1").run();
      f.db.prepare("UPDATE tasks SET owner='codex-a' WHERE id=2").run();
    }
    const turnId = `turn-${index}`;
    const start = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: turnId } } };
    const turn = { id: turnId, status: 'completed', items: [
      { id: `cmd-${index}`, type: 'commandExecution', status: 'completed', exitCode: 0 }
    ] };
    retainedEvents.push(start);
    retainedTurns.push(turn);
    // Mirror the App Server adapter's retained snapshot limits.
    if (retainedEvents.length > 100) retainedEvents.shift();
    if (retainedTurns.length > 10) retainedTurns.shift();
    f.service.observeCodexResults(f.session, f.state(retainedTurns, retainedEvents), start);
  }
  f.service.observeCodexResults(f.session, f.state(retainedTurns, retainedEvents),
    { method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-109' } });
  const rows = f.db.prepare("SELECT payload FROM events WHERE type='task.result.recorded'").all().map(row => JSON.parse(row.payload));
  assert.equal(rows.length, 110);
  assert.equal(rows.filter(row => row.task_id === 1).length, 55);
  assert.equal(rows.filter(row => row.task_id === 2).length, 55);
  assert.equal(new Set(rows.map(row => row.turn_id)).size, 110);
});

test('observer rejects a replayed evicted start even if a future adapter retains over 100 turns', t => {
  const f = fixture(t);
  const starts = [];
  for (let index = 0; index < 101; index += 1) {
    const start = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: `turn-${index}` } } };
    starts.push(start);
    f.service.observeCodexResults(f.session,
      f.state([{ id: `turn-${index}`, status: 'inProgress', items: [] }], starts), start);
  }
  f.db.prepare("UPDATE tasks SET status='done' WHERE id=1").run();
  f.db.prepare("UPDATE tasks SET owner='codex-a' WHERE id=2").run();
  const evictedOldTurn = { id: 'turn-0', status: 'completed', items: [
    { id: 'cmd-old', type: 'commandExecution', status: 'completed', exitCode: 0 }
  ] };
  // This exceeds today's adapter caps, but exercises the observer's own
  // eviction boundary without assuming snapshots are incremental.
  f.service.observeCodexResults(f.session, f.state([evictedOldTurn], starts));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.result.recorded'").get().count, 0);
});

test('unexpected automatic result errors are not swallowed by the observer', t => {
  const f = fixture(t);
  const started = { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-invalid' } } };
  const turn = { id: 'turn-invalid', status: 'completed', items: [
    { type: 'commandExecution', status: 'completed', exitCode: 0 }
  ] };
  assert.throws(() => f.service.observeCodexResults(f.session, f.state([turn], [started]), started),
    { code: 'BAD_REQUEST' });
});
