import { createHash } from 'node:crypto';
import { selectCurrentTask } from '../core/coordination/automation.mjs';
import { listTaskResults, recordTaskResult, summarizeTaskResults } from '../core/coordination/results.mjs';
import { CliError } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';

export function createTaskResults({ connectWebProject, resolveSessionPeerId, now, addEvent }) {
  const turnScopes = new WeakMap();
  function currentTask(db, peer) {
    return selectCurrentTask(db.prepare(`SELECT id,title,status,owner,priority FROM tasks
      WHERE owner = ? AND status NOT IN ('done','abandoned')`).all(peer), peer);
  }
  function readSessionResults(session) {
    const db = connectWebProject(session.ctx);
    try {
      const peer = resolveSessionPeerId(db, session);
      const task = currentTask(db, peer);
      const results = listTaskResults(db, { peer });
      return { results, current_task: task, summary: summarizeTaskResults(results.filter(r => r.task_id === task?.id)) };
    } finally { db.close(); }
  }
  function writeSessionResult(session, input) {
    const db = connectWebProject(session.ctx);
    try {
      const peer = resolveSessionPeerId(db, session);
      const state = session.adapter?.snapshot() || session.nativeSnapshot?.() || {};
      const result = recordTaskResult(db, { peer, taskId: input.taskId, kind: 'verification',
        source: 'user', stage: input.stage, status: input.status, title: input.title,
        details: input.details, evidence: input.evidence, executorId: state.executorId,
        threadId: state.threadId || state.sessionId, turnId: state.turnId }, { now, addEvent });
      return { result };
    } finally { db.close(); }
  }
  function observeCodexResults(session, state) {
    if (!session.binding?.provider_session_id || state.executorId !== (session.executorId || session.adapter?.snapshot().executorId)) return;
    const thread = state.threads?.find(t => t.id === session.binding.provider_session_id);
    if (!thread?.turns?.length) return;
    const db = connectWebProject(session.ctx);
    try {
      const peer = resolveSessionPeerId(db, session);
      let scopes = turnScopes.get(session);
      if (!scopes) { scopes = new Map(); turnScopes.set(session, scopes); }
      for (const event of state.events || []) {
        if (event.method === 'turn/started' && event.params?.threadId === thread.id && event.params.turn?.id && !scopes.has(event.params.turn.id)) {
          scopes.set(event.params.turn.id, currentTask(db, peer)?.id || null);
        }
      }
      for (const turn of thread.turns) {
        const taskId = scopes.get(turn.id);
        if (!taskId) continue;
        const common = { peer, taskId, executorId: state.executorId, threadId: thread.id,
          turnId: turn.id, source: 'executor', stage: 'local' };
        for (const item of turn.items || []) {
          if (item.type !== 'commandExecution' || !['completed', 'failed', 'declined'].includes(item.status)) continue;
          const exitCode = item.exitCode;
          const status = exitCode === 0 && item.status === 'completed' ? 'passed'
            : item.status === 'failed' || item.status === 'declined' || (Number.isSafeInteger(exitCode) && exitCode !== 0) ? 'failed' : 'pending';
          const command = redactSecrets(String(item.command || ''));
          const output = redactSecrets(String(item.aggregatedOutput || ''));
          recordTaskResult(db, { ...common, itemId: item.id, kind: 'command', status, exitCode,
            resultKey: `${state.executorId}:${turn.id}:${item.id}:command`,
            title: (command || 'Command execution').slice(0, 300),
            command: command.slice(0, 64000),
            details: output.slice(0, 64000), evidence: [] }, { now, addEvent });
        }
        if (turn.diff && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
          const diff = redactSecrets(String(turn.diff)).slice(0, 64000);
          recordTaskResult(db, { ...common, kind: 'diff', status: 'pending', title: 'Turn changes awaiting review', diff,
            resultKey: `${state.executorId}:${turn.id}:diff:${createHash('sha256').update(diff).digest('hex')}` }, { now, addEvent });
        }
      }
      while (scopes.size > 100) scopes.delete(scopes.keys().next().value);
    } catch (error) {
      // A delayed executor result must not attach to a task after ownership changed.
      if (!(error instanceof CliError) || !['TASK_OWNER_MISMATCH', 'NOT_FOUND'].includes(error.code)) throw error;
    } finally { db.close(); }
  }
  return { readSessionResults, writeSessionResult, observeCodexResults };
}
