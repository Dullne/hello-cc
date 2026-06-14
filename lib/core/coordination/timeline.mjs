import { compactText } from '../../format.mjs';
import { lockLabel } from './locks.mjs';

export function parseEventPayload(row) {
  try {
    return row?.payload ? JSON.parse(row.payload) : {};
  } catch {
    return {};
  }
}

export function uniqueList(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function messageParticipants(message) {
  const participants = [message.sender];
  if (message.recipient && !['all', ''].includes(message.recipient)) participants.push(message.recipient);
  return uniqueList(participants);
}

export function taskParticipants(task) {
  return uniqueList([task.created_by, task.owner, task.assignee]);
}

export function payloadParticipants(payload) {
  const values = [];
  for (const key of ['peer', 'from_peer', 'to_peer', 'assignee', 'owner', 'recipient', 'kept_peer', 'removed_peer', 'previous_owner']) {
    if (payload?.[key] && payload[key] !== 'all') values.push(payload[key]);
  }
  return uniqueList(values);
}

export function peerMatchesTimelineItem(item, peer) {
  if (!peer) return true;
  if (item.broadcast) return true;
  return (item.peers || []).includes(peer);
}

export function shouldHideTimelineMessage(message) {
  if (message.kind === 'task' && /^Task #\d+ assigned: /.test(message.body || '')) return true;
  if (message.kind === 'handoff' && /^Handoff #\d+: /.test(message.body || '')) return true;
  return false;
}

const TIMELINE_EVENT_ALLOW = new Set([
  'task.created',
  'task.claimed',
  'task.pending',
  'task.running',
  'task.review',
  'task.blocked',
  'task.done',
  'task.abandoned',
  'task.takeover',
  'team.started',
  'lock.acquired',
  'lock.released',
  'peer.registered',
  'peer.joined',
  'peer.auto_joined',
  'peer.stopped',
  'provider.session.merged',
  'web.session.started',
  'web.session.exited',
  'tmux.session.attached',
  'tmux.session.detached',
  'tmux.session.exited',
  'run.session.started',
  'run.session.exited'
]);

export function shouldHideTimelineEvent(event) {
  if (['message.sent', 'message.ack', 'handoff.created', 'lock.renewed'].includes(event.type)) return true;
  if (event.type && event.type.startsWith('hook.')) return true;
  if (event.type && event.type.startsWith('web.session.input')) return true;
  return !TIMELINE_EVENT_ALLOW.has(event.type);
}

export function timelineDirection(message, peer) {
  if (!peer) return message.recipient === 'all' ? 'broadcast' : 'project';
  if (message.sender === peer && message.recipient === peer) return 'self';
  if (message.sender === peer) return 'out';
  if (message.recipient === 'all') return 'broadcast';
  if (message.recipient === peer) return 'in';
  return 'project';
}

export function timelineFromRows({ messages = [], handoffs = [], tasks = [], locks = [], events = [] }, peer = null) {
  const items = [];
  for (const message of messages) {
    if (shouldHideTimelineMessage(message)) continue;
    const item = {
      id: `message:${message.id}`,
      source: 'message',
      source_id: message.id,
      ts: message.created_at,
      actor: message.sender,
      peers: messageParticipants(message),
      task_id: message.task_id || null,
      kind: message.kind || 'note',
      title: `${message.sender} -> ${message.recipient || 'all'}`,
      text: compactText(message.body),
      unread: message.read_at === null || message.read_at === undefined,
      direction: timelineDirection(message, peer),
      thread_id: message.thread_id || message.id,
      reply_to: message.reply_to || null,
      broadcast: !message.recipient || message.recipient === 'all'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const handoff of handoffs) {
    const item = {
      id: `handoff:${handoff.id}`,
      source: 'handoff',
      source_id: handoff.id,
      ts: handoff.created_at,
      actor: handoff.from_peer,
      peers: uniqueList([handoff.from_peer, handoff.to_peer]),
      task_id: handoff.task_id || null,
      kind: 'handoff',
      title: `handoff ${handoff.from_peer}${handoff.to_peer ? ` -> ${handoff.to_peer}` : ''}`,
      text: compactText(handoff.summary),
      direction: 'project',
      broadcast: !handoff.to_peer,
      tests: handoff.tests || '',
      risks: handoff.risks || ''
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const task of tasks) {
    const item = {
      id: `task:${task.id}`,
      source: 'task',
      source_id: task.id,
      ts: task.updated_at || task.created_at,
      actor: task.owner || task.created_by || task.assignee || '',
      peers: taskParticipants(task),
      task_id: task.id,
      kind: task.status,
      title: `task #${task.id} ${task.status}${task.parent_id ? ` child of #${task.parent_id}` : ''}`,
      text: compactText(task.title),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const lock of locks) {
    const item = {
      id: `lock:${lock.resource}`,
      source: 'lock',
      source_id: lock.resource,
      ts: lock.created_at,
      actor: lock.owner,
      peers: uniqueList([lock.owner]),
      task_id: lock.task_id || null,
      kind: 'active',
      title: `lock ${lockLabel(lock)}`,
      text: compactText(lock.reason || `owner=${lock.owner}`),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  for (const event of events) {
    if (shouldHideTimelineEvent(event)) continue;
    const payload = parseEventPayload(event);
    const item = {
      id: `event:${event.id}`,
      source: 'event',
      source_id: event.id,
      ts: event.created_at,
      actor: event.actor || '',
      peers: uniqueList([event.actor, ...payloadParticipants(payload)]),
      task_id: event.task_id || null,
      kind: event.type,
      title: event.type,
      text: compactText(payload.summary || payload.reason || payload.title || payload.resource || payload.peer || ''),
      direction: 'project'
    };
    if (peerMatchesTimelineItem(item, peer)) items.push(item);
  }
  const order = { message: 10, handoff: 20, task: 30, lock: 40, event: 50 };
  items.sort((a, b) =>
    (a.ts || 0) - (b.ts || 0) ||
    (order[a.source] || 99) - (order[b.source] || 99) ||
    String(a.source_id).localeCompare(String(b.source_id), undefined, { numeric: true }));
  return items.slice(-120);
}
