import { shellQuoteArg } from '../../format.mjs';
import {
  lockArgv,
  lockBaseResource,
  lockLabel,
  lockScope,
  locksConflict,
  normalizeLockScope,
  scopedLockResource
} from './locks.mjs';
import {
  shouldHideTimelineMessage,
  uniqueList
} from './timeline.mjs';
import { summarizeTask } from '../peers/liveness.mjs';

const DEFAULT_CLI_NAME = 'hcc';
const DEFAULT_ACTIVE_PEER_TTL = 600;
const DEFAULT_LOCK_TTL = 900;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function actionCommand(argv, cliName = DEFAULT_CLI_NAME) {
  if (!argv?.length) return '';
  return [cliName, ...argv].map(shellQuoteArg).join(' ');
}

export function makeAction(kind, argv, reason, mutates = true, extra = {}, config = {}) {
  return {
    kind,
    reason,
    mutates,
    argv,
    command: actionCommand(argv, config.cliName || DEFAULT_CLI_NAME),
    ...extra
  };
}

export function looksLikeMultiTask(task) {
  if (!task) return false;
  const text = `${task.title || ''}\n${task.body || ''}`;
  const bullets = text.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S+/.test(line)).length;
  const separators = (text.match(/[,，;；、]/g) || []).length;
  return bullets >= 2 || separators >= 3 || /多任务|并行|团队|分工|several tasks|multiple tasks|parallel|team/i.test(text);
}

export function selectCurrentTask(tasks, peerId) {
  if (!peerId) return null;
  const statusRank = { running: 0, claimed: 1, review: 2, blocked: 3 };
  const openTasks = (tasks || []).filter((task) => !['done', 'abandoned'].includes(task.status));
  const ownedTasks = openTasks
    .filter((task) => task.owner === peerId)
    .sort((a, b) =>
      (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
      Number(a.priority || 0) - Number(b.priority || 0) ||
      Number(a.id || 0) - Number(b.id || 0));
  return ownedTasks.find((task) => ['running', 'claimed', 'review', 'blocked'].includes(task.status)) || ownedTasks[0] || null;
}

export function deriveAutomation(snapshot, peer = null, opts = {}, config = {}) {
  const cliName = config.cliName || DEFAULT_CLI_NAME;
  const activePeerTtl = Number(config.activePeerTtl ?? snapshot.active_peer_ttl ?? DEFAULT_ACTIVE_PEER_TTL);
  const defaultLockTtl = Number(config.defaultLockTtl ?? DEFAULT_LOCK_TTL);
  const makeAutomationAction = (kind, argv, reason, mutates = true, extra = {}) =>
    makeAction(kind, argv, reason, mutates, extra, { cliName });

  const peerId = peer || '';
  const t = Number(snapshot.now || nowSec());
  const peerRow = peerId ? snapshot.peers.find((row) => row.id === peerId) : null;
  const openTasks = (snapshot.tasks || []).filter((task) => !['done', 'abandoned'].includes(task.status));
  const assignedTasks = peerId ? openTasks.filter((task) => !task.owner && task.assignee === peerId) : [];
  const availableTasks = openTasks.filter((task) => !task.owner && !task.assignee);
  const ownedTask = selectCurrentTask(openTasks, peerId);
  const takeoverReadyTasks = peerId
    ? openTasks.filter((task) => task.owner && task.owner !== peerId && task.takeover_ready)
    : [];
  const intent = String(opts.intent || 'work').toLowerCase();
  const scope = normalizeLockScope(opts.scope || opts.lock_scope);
  const resources = uniqueList(Array.isArray(opts.resources) ? opts.resources : (opts.resource ? [opts.resource] : []));
  const ownLocks = peerId ? (snapshot.locks || []).filter((lock) => lock.owner === peerId) : [];
  const requestedLocks = resources.map((resource) => {
    const requested = scopedLockResource(resource, scope);
    const lock = (snapshot.locks || []).find((row) => Number(row.expires_at || 0) > t && locksConflict(row, requested));
    const exact = (snapshot.locks || []).find((row) => Number(row.expires_at || 0) > t && lockBaseResource(row) === requested.base_resource && lockScope(row) === requested.scope);
    return { ...requested, lock, exact };
  });
  const conflict = requestedLocks.find((entry) => entry.lock && entry.lock.owner !== peerId);
  const missingLock = requestedLocks.find((entry) => !entry.lock);
  const unread = peerId ? (snapshot.messages || []).filter((message) =>
    message.read_at === null || message.read_at === undefined) : [];
  const warnings = [];
  if (peerId && !peerRow) warnings.push(`peer ${peerId} is not registered in this project`);
  const lockActions = [];
  const messageActions = [];
  const taskActions = [];
  const automation = {
    schema_version: 1,
    peer: peerId ? {
      id: peerId,
      known: Boolean(peerRow),
      active: Boolean(peerRow && Number(peerRow.age_sec || 0) <= activePeerTtl),
      age_sec: peerRow ? Number(peerRow.age_sec || 0) : null
    } : null,
    current_task: summarizeTask(ownedTask),
    phase: 'idle',
    next_action: makeAutomationAction('none', [], 'no immediate coordination action', false),
    actions: [],
    finish_actions: [],
    warnings
  };

  const orderedUnread = unread
    .filter((message) => message.sender !== peerId)
    .filter((message) => !shouldHideTimelineMessage(message))
    .sort((a, b) => (a.kind === 'task' ? 1 : 0) - (b.kind === 'task' ? 1 : 0) || a.id - b.id);
  for (const message of orderedUnread) {
    if (ownedTask && message.kind === 'task') continue;
    const kind = message.kind === 'task' ? 'msg.inbox' : 'msg.reply';
    const argv = kind === 'msg.reply'
      ? ['msg', 'reply', '--from', peerId, '--id', String(message.id), '--body', '<answer>']
      : ['msg', 'inbox', '--peer', peerId];
    messageActions.push(makeAutomationAction(kind, argv, `unread message #${message.id} from ${message.sender}`, kind !== 'msg.inbox', {
      message_id: message.id,
      task_id: message.task_id || null
    }));
  }

  if (!ownedTask && assignedTasks.length) {
    const task = assignedTasks[0];
    taskActions.push(makeAutomationAction('task.claim', ['task', 'claim', '--peer', peerId, '--id', String(task.id)], `assigned task #${task.id}`, true, { task_id: task.id }));
  } else if (!ownedTask && takeoverReadyTasks.length) {
    const task = takeoverReadyTasks[0];
    taskActions.push(makeAutomationAction(
      'task.takeover',
      ['task', 'takeover', '--peer', peerId, '--id', String(task.id), '--reason', 'owner stale and no active related locks', '--policy', 'stale'],
      `task #${task.id} owner ${task.owner} is stale and has no active related locks`,
      true,
      { task_id: task.id, owner: task.owner, owner_age_sec: task.owner_age_sec ?? null }
    ));
  } else if (!ownedTask && availableTasks.length) {
    taskActions.push(makeAutomationAction('task.next', ['task', 'next', '--peer', peerId], 'available pending task exists', true));
  }

  if (ownedTask) {
    const readOnlyIntent = ['read', 'review', 'inspect'].includes(intent);
    if (readOnlyIntent && resources.length) {
      warnings.push(`intent=${intent} is read-only; do not acquire file locks for snapshot inspection`);
    } else if (conflict) {
      const requestedLabel = lockLabel(conflict);
      const heldLabel = lockLabel(conflict.lock);
      lockActions.push(makeAutomationAction(
        'msg.send',
        ['msg', 'send', '--from', peerId, '--to', conflict.lock.owner, '--task', String(ownedTask.id), '--body', `Please coordinate ${requestedLabel}; ${heldLabel} is locked by ${conflict.lock.owner}. If our edits are separate, split to scoped locks before final tests/commit.`],
        `${requestedLabel} conflicts with ${heldLabel} held by ${conflict.lock.owner}`,
        true,
        { task_id: ownedTask.id, resource: conflict.base_resource, scope: conflict.scope, lock_owner: conflict.lock.owner, lock_resource: conflict.lock.resource, lock_scope: lockScope(conflict.lock) }
      ));
    } else if (missingLock) {
      lockActions.push(makeAutomationAction(
        'lock.acquire',
        ['lock', 'acquire', '--peer', peerId, '--task', String(ownedTask.id), ...lockArgv(missingLock.base_resource, missingLock.scope), '--ttl', String(defaultLockTtl), '--reason', '<work>'],
        `task #${ownedTask.id} needs ${lockLabel(missingLock)} lock`,
        true,
        { task_id: ownedTask.id, resource: missingLock.base_resource, scope: missingLock.scope }
      ));
    }
    if (ownedTask.status === 'claimed') {
      taskActions.push(makeAutomationAction('task.update', ['task', 'update', '--peer', peerId, '--id', String(ownedTask.id), '--status', 'running', '--summary', '<started>'], `task #${ownedTask.id} is claimed but not running`, true, { task_id: ownedTask.id }));
    }
    if (!ownedTask.parent_id && looksLikeMultiTask(ownedTask)) {
      const childCount = openTasks.filter((task) => task.parent_id === ownedTask.id && !['done', 'abandoned'].includes(task.status)).length;
      if (!childCount) {
        taskActions.push(makeAutomationAction('team.plan', ['team', 'plan', '--from-task', String(ownedTask.id)], `task #${ownedTask.id} looks splittable; plan explicit team subtasks`, false, { task_id: ownedTask.id }));
      }
    }
    automation.finish_actions.push(makeAutomationAction('handoff.create', ['handoff', 'create', '--from', peerId, '--task', String(ownedTask.id), '--summary', '<summary>', '--tests', '<tests>', '--risks', '<risks>'], `handoff task #${ownedTask.id} before stopping`, true, { task_id: ownedTask.id }));
    automation.finish_actions.push(makeAutomationAction('task.done', ['task', 'done', '--peer', peerId, '--id', String(ownedTask.id), '--summary', '<summary>'], `mark task #${ownedTask.id} done after handoff`, true, { task_id: ownedTask.id }));
    for (const lock of ownLocks) {
      automation.finish_actions.push(makeAutomationAction('lock.release', ['lock', 'release', '--peer', peerId, ...lockArgv(lockBaseResource(lock), lockScope(lock))], `release ${lockLabel(lock)}`, true, { task_id: lock.task_id || null, resource: lockBaseResource(lock), scope: lockScope(lock) }));
    }
  }
  automation.actions.push(...lockActions, ...messageActions, ...taskActions);

  if (opts.intent === 'finish' || opts.intent === 'stop') {
    automation.phase = ownedTask ? 'handoff' : 'idle';
    automation.next_action = automation.finish_actions[0] || automation.next_action;
    return automation;
  }
  automation.next_action = automation.actions[0] || (ownedTask
    ? makeAutomationAction('none', [], `continue task #${ownedTask.id}`, false, { task_id: ownedTask.id })
    : automation.next_action);
  if (automation.next_action.kind === 'msg.reply' || automation.next_action.kind === 'msg.inbox') automation.phase = 'reply_message';
  else if (automation.next_action.kind === 'task.claim' || automation.next_action.kind === 'task.next') automation.phase = 'claim_task';
  else if (automation.next_action.kind === 'task.takeover') automation.phase = 'takeover_task';
  else if (automation.next_action.kind === 'lock.acquire') automation.phase = 'acquire_lock';
  else if (automation.next_action.kind === 'msg.send') automation.phase = 'coordinate_lock';
  else if (automation.next_action.kind === 'team.plan') automation.phase = 'team_plan';
  else if (ownedTask) automation.phase = ownedTask.status === 'review' ? 'handoff' : 'work';
  return automation;
}

export function renderAutomationContext(automation) {
  if (!automation) return '';
  const lines = [
    '[hello-cc next action]',
    `phase: ${automation.phase}`,
    automation.current_task ? `current_task: #${automation.current_task.id} ${automation.current_task.status} ${automation.current_task.title}` : null,
    `next: ${automation.next_action.command || automation.next_action.kind}`,
    `why: ${automation.next_action.reason}`
  ].filter(Boolean);
  if (automation.finish_actions?.length) {
    lines.push('finish:');
    for (const action of automation.finish_actions.slice(0, 4)) lines.push(`- ${action.command}`);
  }
  if (automation.warnings?.length) {
    lines.push('warnings:');
    for (const warning of automation.warnings.slice(0, 4)) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}
