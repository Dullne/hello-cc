import { randomUUID } from 'node:crypto';
import { tx } from '../../db/schema.mjs';
import { automaticResultKey } from '../../shared/automatic-result-key.mjs';
import { CliError } from '../../shared/errors.mjs';

export const RESULT_EVENT = 'task.result.recorded';
const STAGES = new Set(['local', 'publication', 'business']);
const STATUSES = new Set(['passed', 'failed', 'pending']);
const KINDS = new Set(['verification', 'command', 'diff']);

function text(value, field, max, required = false) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new CliError('BAD_REQUEST', `${field} must be text`);
  }
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) throw new CliError('BAD_REQUEST', `${field} must contain ${required ? '1' : '0'} to ${max} characters`);
  return result;
}

// Evidence records do not mutate task status. The owner is checked in the same
// transaction as the insert, including after a concurrent task takeover.
export function recordTaskResult(db, input, { now = () => Math.floor(Date.now() / 1000), addEvent, automatic = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('BAD_REQUEST', 'A result object is required');
  const peer = text(input.peer, 'peer', 200, true);
  const taskId = input.taskId;
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new CliError('BAD_REQUEST', 'taskId must be a positive integer');
  const stage = input.stage || 'local', status = input.status || 'pending';
  const kind = input.kind || 'verification', source = input.source || 'user';
  if (!STAGES.has(stage) || !STATUSES.has(status) || !KINDS.has(kind) || !['user', 'executor'].includes(source)) {
    throw new CliError('BAD_REQUEST', 'Unsupported result stage, status, kind or source');
  }
  if (source === 'executor' && stage !== 'local') throw new CliError('BAD_REQUEST', 'Executor records can only report local evidence');
  if (automatic && (source !== 'executor' || !['command', 'diff'].includes(kind))) {
    throw new CliError('BAD_REQUEST', 'Automatic results must be local executor commands or diffs');
  }
  const evidence = input.evidence || [];
  if (!Array.isArray(evidence) || evidence.length > 20) throw new CliError('BAD_REQUEST', 'evidence must contain up to 20 text references');
  const references = evidence.map((entry) => text(entry, 'evidence', 2000, true));
  if (source === 'user' && status === 'passed' && !references.length) {
    throw new CliError('BAD_REQUEST', 'A passed verification needs an evidence reference');
  }
  const executorId = text(input.executorId, 'executorId', 512) || null;
  const threadId = text(input.threadId, 'threadId', 512) || null;
  const turnId = text(input.turnId, 'turnId', 512) || null;
  const itemId = text(input.itemId, 'itemId', 512) || null;
  if (automatic && (!executorId || !threadId || !turnId || (kind === 'command' && !itemId))) {
    throw new CliError('BAD_REQUEST', 'Automatic results require executor, thread, turn and command item identities');
  }
  const resultKey = automatic
    ? automaticResultKey({ executorId, threadId, turnId, kind, itemId: kind === 'command' ? itemId : null })
    : input.resultKey;
  const record = {
    result_id: randomUUID(), result_key: text(resultKey, 'resultKey', 700) || randomUUID(),
    peer, task_id: taskId, stage, status, kind, source,
    title: automatic ? (kind === 'command' ? 'Command execution' : 'Turn changes awaiting review')
      : text(input.title, 'title', 300, true),
    details: automatic ? '' : text(input.details, 'details', 64000),
    evidence: automatic ? [] : references,
    command: automatic ? '' : text(input.command, 'command', 64000),
    diff: automatic ? '' : text(input.diff, 'diff', 64000),
    executor_id: executorId, thread_id: threadId, turn_id: turnId, item_id: itemId,
    exit_code: Number.isSafeInteger(input.exitCode) ? input.exitCode : null,
    created_at: now()
  };
  return tx(db, () => {
    const task = db.prepare('SELECT id, owner, title, status FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new CliError('NOT_FOUND', 'Task not found');
    if (task.owner !== peer) throw new CliError('TASK_OWNER_MISMATCH', 'This task belongs to a different peer');
    const previous = db.prepare(`SELECT id, payload, created_at FROM events WHERE type = ?
      AND task_id = ? AND actor = ? AND json_valid(payload) AND json_extract(payload, '$.result_key') = ?
      ORDER BY id DESC LIMIT 1`).get(RESULT_EVENT, taskId, peer, record.result_key);
    if (previous) return { ...JSON.parse(previous.payload), id: previous.id, created_at: previous.created_at };
    if (!automatic) {
      record.task_title = task.title;
      record.task_status = task.status;
    }
    if (addEvent) addEvent(db, RESULT_EVENT, peer, taskId, record);
    else db.prepare('INSERT INTO events(type,actor,task_id,payload,created_at) VALUES(?,?,?,?,?)')
      .run(RESULT_EVENT, peer, taskId, JSON.stringify(record), record.created_at);
    return { ...record, id: Number(db.prepare('SELECT last_insert_rowid() AS id').get().id) };
  });
}

export function listTaskResults(db, { peer, taskId = null, limit = 100 } = {}) {
  if (!peer || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new CliError('BAD_REQUEST', 'peer and a limit from 1 to 200 are required');
  if (taskId !== null && (!Number.isSafeInteger(taskId) || taskId < 1)) throw new CliError('BAD_REQUEST', 'taskId must be a positive integer');
  return db.prepare(`SELECT id,payload,created_at FROM events
    WHERE type = ? AND actor = ? AND (? IS NULL OR task_id = ?) AND json_valid(payload)
    ORDER BY id DESC LIMIT ?`).all(RESULT_EVENT, peer, taskId, taskId, limit)
    .map((row) => ({ ...JSON.parse(row.payload), id: row.id, created_at: row.created_at }));
}

export function summarizeTaskResults(results) {
  return Object.fromEntries([...STAGES].map((stage) => [stage,
    results.find((record) => record.stage === stage && record.kind === 'verification') || null]));
}
