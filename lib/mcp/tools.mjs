import { CliError } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';
import { parseOpts, intOpt, required, positiveSafeIntOpt, wantsHelp } from '../cli-args.mjs';
import { positiveIntOpt } from '../task-cli.mjs';
import { tx } from '../db/schema.mjs';
import { createMsgCommands } from '../cli/commands/msg.mjs';
import { createTaskCommands } from '../cli/commands/task.mjs';
import { createLockCommands } from '../cli/commands/lock.mjs';
import { createCoordinationCommands } from '../cli/commands/coordination.mjs';
import { createCoordinationState } from '../coordination-state.mjs';
import { createMessageStore } from '../core/coordination/messages.mjs';
import { createTaskStore } from '../core/coordination/tasks.mjs';
import { createEvidenceRuntime } from '../core/peers/evidence-runtime.mjs';
import { annotateTasksWithLiveness } from '../core/peers/liveness.mjs';
import { clockGraceSuppressed, readClockGraceUntil } from '../shared/clock-grace.mjs';
import { clockSafetyUnavailable } from '../core/coordination/clock-safety.mjs';
import { leaseDeadline } from '../core/coordination/lease-renewal.mjs';
import { scopedLockResource, lockLabel, lockScope, locksConflict } from '../core/coordination/locks.mjs';
import { captureLockAcquireSubject, sameLockAcquireSubject, observeLockOwnerEvidence } from '../core/coordination/lock-evidence.mjs';
import { runOptimisticEvidenceMutation } from '../core/coordination/optimistic-evidence.mjs';
import { normalizeListText } from '../handoff.mjs';
import { listTaskResults, recordTaskResult } from '../core/coordination/results.mjs';

const string = (maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength });
const integer = (maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: 1, maximum });
const strings = { type: 'array', maxItems: 50, items: string() };
const definitions = [
  ['hcc_state', 'Read coordination state for this project and peer.', {}, [], true],
  ['hcc_task_list', 'List tasks visible to this peer, with owner evidence.',
    { limit: integer(100), all: { type: 'boolean' } }, [], true],
  ['hcc_inbox', 'Read this peer inbox without acknowledging messages.',
    { limit: integer(100), all: { type: 'boolean' } }, [], true],
  ['hcc_message_send', 'Send a coordination message as this executor peer.',
    { to: string(256), body: string(16000), task_id: integer(), kind: { type: 'string', enum: ['note', 'ask', 'progress'] } }, ['to', 'body'], false],
  ['hcc_task_next', 'Return the current task or claim one pending task. Never completes a task.', {}, [], false],
  ['hcc_handoff', 'Record work, tests and risks for an owned task without completing it.',
    { task_id: integer(), summary: string(16000), to: string(256), changed_files: strings, tests: strings, risks: strings }, ['task_id', 'summary'], false],
  ['hcc_lock_acquire', 'Acquire a scoped resource lock for this peer and its task.',
    { resource: string(1024), task_id: integer(), scope: string(256), ttl: integer(86400), reason: string(4096) }, ['resource', 'task_id'], false],
  ['hcc_lock_release', 'Release this peer own lock; cannot force another owner lock.',
    { resource: string(1024), scope: string(256) }, ['resource'], false],
  ['hcc_result_list', 'Read evidence records submitted by this peer.',
    { task_id: integer(), limit: integer(200) }, [], true],
  ['hcc_result_record', 'Record local evidence for an owned task. Does not record publication, business acceptance, or task completion.',
    { task_id: integer(), kind: { type: 'string', enum: ['verification', 'command', 'diff'] },
      title: string(300), details: string(64000), evidence: { ...strings, maxItems: 20, items: string(2000) },
      status: { type: 'string', enum: ['passed', 'failed', 'pending'] }, result_key: string(300) },
    ['task_id', 'title', 'status'], false]
];

// Pure catalogue shared by MCP and the Cordis tool registry.
export function scopedMcpToolDefinitions() {
  return definitions.map(([name, description, properties, required, readOnly]) => ({
    name, description, inputSchema: structuredClone({ type: 'object', properties, required, additionalProperties: false }),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false }
  }));
}

function validate(value, schema, label) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('BAD_ARGS', `${label} must be an object`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new CliError('BAD_ARGS', `Unknown argument: ${key}`);
      validate(value[key], schema.properties[key], key);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new CliError('BAD_ARGS', `Missing argument: ${key}`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength || 0) ||
        value.length > schema.maxLength || value.includes('\0') || (schema.enum && !schema.enum.includes(value))) {
      throw new CliError('BAD_ARGS', `${label} must be a valid bounded string`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) throw new CliError('BAD_ARGS', `${label} must be a positive bounded integer`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new CliError('BAD_ARGS', `${label} must be boolean`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new CliError('BAD_ARGS', `${label} must be a bounded array`);
    for (const item of value) validate(item, schema.items, label);
  }
}

export function createScopedMcpTools({ ctx, authority, connect: baseConnect, touchPeer, now, addEvent }) {
  const peer = authority.scope.peer, scopedCtx = { ...ctx, cwd: authority.scope.root,
    root: authority.scope.root, dbPath: authority.scope.dbPath, json: true };
  let captured, databases = [], active = false, taskGuard = null;
  function assertWrite(db) {
    authority.assertOwnership(db);
    if (taskGuard !== null) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskGuard);
      if (!row || row.owner !== peer) throw new CliError('TASK_OWNED', 'Task ownership changed before recording work');
    }
  }
  function connect() {
    const db = baseConnect(scopedCtx, { create: false, migrateRegistered: false });
    databases.push(db);
    authority.assertOwnership(db);
    // Existing business functions keep their transactions. Guard each write
    // inside that transaction, including commands that normally autocommit.
    return new Proxy(db, { get(target, key) {
      if (key === 'prepare') return sql => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(stmt, property) {
          if (property === 'run') return (...params) => {
            const run = () => { assertWrite(target); return stmt.run(...params); };
            return target.isTransaction ? run() : tx(target, run);
          };
          const value = stmt[property]; return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  const evidence = createEvidenceRuntime({ now });
  const messages = createMessageStore({ now, addEvent });
  const tasks = createTaskStore({ now, addEvent, sendMessage: messages.sendMessage,
    activePeerTtl: 600, observeClockSafety: evidence.observeTaskTakeoverClockSafety });
  const dependencies = { connect, now, tx, addEvent, CliError, parseOpts, intOpt, required,
    positiveSafeIntOpt, positiveIntOpt, wantsHelp, ACTIVE_PEER_TTL: 600, DEFAULT_LOCK_TTL: 900,
    printResult: (_ctx, result) => { captured = result; },
    resolveCurrentPeer: () => ({ id: peer, auto: false }),
    touchCurrentPeer: (db, _ctx, identity, status) => {
      if (identity.id !== peer) throw new CliError('MCP_SCOPE_INVALID', 'Peer identity changed');
      authority.assertOwnership(db); touchPeer(db, peer, status);
    },
    iso: timestamp => new Date(timestamp * 1000).toISOString(),
    ...messages, ...tasks, ...evidence,
    annotateTasksWithLiveness, clockGraceSuppressed, readClockGraceUntil,
    leaseDeadline, scopedLockResource, lockLabel, lockScope, locksConflict,
    clockSafetyUnavailable, captureLockAcquireSubject, sameLockAcquireSubject,
    observeLockOwnerEvidence, runOptimisticEvidenceMutation, normalizeListText
  };
  const { cmdTask, notifyTaskOwnerConflict } = createTaskCommands(dependencies);
  const { cmdLock } = createLockCommands({ ...dependencies, notifyTaskOwnerConflict });
  const { cmdMsg } = createMsgCommands(dependencies);
  const { cmdHandoff } = createCoordinationCommands(dependencies);
  const { statusSnapshot } = createCoordinationState({ connect, now, ...messages, ...tasks,
    observePeerEvidence: evidence.observePeerEvidence });
  const tools = scopedMcpToolDefinitions();
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const option = (key, value) => `--${key}=${value}`;
  function assertTask(taskId, action) {
    const db = connect();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!row) throw new CliError('NOT_FOUND', 'Task does not exist');
    tasks.assertTaskOwnerForMutation(db, peer, row, action);
    if (row.owner !== peer) throw new CliError('TASK_OWNED', 'Claim this task before recording work or acquiring its locks');
    taskGuard = taskId;
  }
  async function execute(name, args) {
    if (name === 'hcc_state') return statusSnapshot(scopedCtx, peer);
    if (name === 'hcc_inbox') return messages.queryInbox(connect(), peer, args.all === true, args.limit || 20);
    if (name === 'hcc_task_list') return cmdTask(scopedCtx, ['list', option('peer', peer), option('limit', args.limit || 50), ...(args.all ? ['--all'] : [])]);
    if (name === 'hcc_task_next') return cmdTask(scopedCtx, ['next', option('peer', peer), '--count=1']);
    if (name === 'hcc_result_list') return listTaskResults(connect(), { peer, taskId: args.task_id || null, limit: args.limit || 100 });
    if (name === 'hcc_result_record') {
      assertTask(args.task_id, 'result-record');
      if (args.status === 'passed' && !args.evidence?.length) throw new CliError('BAD_ARGS', 'A passed result needs an evidence reference');
      return recordTaskResult(connect(), { peer, taskId: args.task_id,
        executorId: authority.scope.executorId, kind: args.kind, title: args.title,
        details: args.details, evidence: args.evidence, status: args.status,
        resultKey: args.result_key, stage: 'local', source: 'executor' }, { now, addEvent });
    }
    if (name === 'hcc_message_send') return cmdMsg(scopedCtx, ['send', option('from', peer), option('to', args.to),
      option('body', args.body), option('kind', args.kind || 'note'), ...(args.task_id ? [option('task', args.task_id)] : [])]);
    if (name === 'hcc_handoff') {
      assertTask(args.task_id, 'handoff');
      return cmdHandoff(scopedCtx, ['create', option('from', peer), option('task', args.task_id), option('summary', args.summary),
        option('changed-files', JSON.stringify(args.changed_files || [])), option('tests', JSON.stringify(args.tests || [])),
        option('risks', JSON.stringify(args.risks || [])), ...(args.to ? [option('to', args.to)] : [])]);
    }
    if (name === 'hcc_lock_acquire') assertTask(args.task_id, 'lock-acquire');
    return cmdLock(scopedCtx, [name === 'hcc_lock_acquire' ? 'acquire' : 'release', option('peer', peer), option('resource', args.resource),
      ...(args.scope ? [option('scope', args.scope)] : []), ...(args.task_id ? [option('task', args.task_id)] : []),
      ...(args.ttl ? [option('ttl', args.ttl)] : []), ...(args.reason ? [option('reason', args.reason)] : [])]);
  }
  return {
    list: () => tools.map(tool => structuredClone(tool)), has: name => byName.has(name),
    async call(name, args) {
      if (active) return { isError: true, content: [{ type: 'text', text: 'A scoped tool call is already running' }] };
      active = true; captured = undefined; databases = []; taskGuard = null;
      try {
        if (!byName.has(name)) throw new CliError('BAD_ARGS', 'Unknown scoped tool');
        validate(args, byName.get(name).inputSchema, 'arguments');
        authority.assertValid();
        const direct = await execute(name, args);
        const structuredContent = redactSecrets({ ok: true, peer, data: captured === undefined ? direct : captured });
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
      } catch (error) {
        const structuredContent = redactSecrets({ ok: false, peer, error: {
          code: error instanceof CliError ? error.code : 'MCP_TOOL_FAILED',
          message: error instanceof CliError ? error.message : 'The scoped tool call failed'
        } });
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
      } finally { for (const db of databases) { try { db.close(); } catch {} } active = false; }
    }
  };
}
