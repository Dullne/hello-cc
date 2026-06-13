import { table } from './format.mjs';
import { uniqueList } from './timeline.mjs';

function iso(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

export function renderStatusSummary(s, peer = null) {
  const taskSummary = s.tasks.length ? s.tasks.map((r) => `${r.status}:${r.n}`).join(', ') : 'none';
  return [
    `root: ${s.root}`,
    `db: ${s.db}`,
    `peers: active=${s.active_peers}, stale=${s.stale_peers}`,
    `tasks: ${taskSummary}`,
    `locks: active=${s.active_locks}`,
    peer ? `inbox(${peer}): unread=${s.unread}` : null,
    '',
    'recent events:',
    table(s.recent_events, [
      { label: 'id', value: (r) => `#${r.id}` },
      { label: 'type', value: (r) => r.type },
      { label: 'actor', value: (r) => r.actor || '' },
      { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
      { label: 'time', value: (r) => iso(r.created_at) }
    ])
  ].filter((line) => line !== null).join('\n');
}

export function normalizeStateResources(values) {
  const list = Array.isArray(values) ? values : [values];
  return uniqueList(list.flatMap((value) => String(value || '').split(',').map((part) => part.trim())));
}

export function renderStateSummary(data, peer, opts = {}) {
  const timelineLimit = Number(opts.timelineLimit || 8);
  const automation = data.automation;
  const lines = [
    `root: ${data.root}`,
    `peer: ${peer}`,
    automation.current_task ? `current task: #${automation.current_task.id} ${automation.current_task.status} ${automation.current_task.title}` : null,
    `phase: ${automation.phase}`,
    `next: ${automation.next_action.command || automation.next_action.kind}`,
    `why: ${automation.next_action.reason}`
  ].filter(Boolean);
  if (automation.finish_actions.length) {
    lines.push('', 'finish actions:');
    lines.push(...automation.finish_actions.map((action) => `- ${action.command}`));
  }
  if (automation.warnings.length) {
    lines.push('', 'warnings:');
    lines.push(...automation.warnings.map((warning) => `- ${warning}`));
  }
  if (data.timeline.length) {
    lines.push('', 'timeline:');
    for (const item of data.timeline.slice(-timelineLimit)) {
      lines.push(`- ${iso(item.ts)} ${item.source}:${item.source_id} ${item.title}${item.text ? ` — ${item.text}` : ''}`);
    }
  }
  return lines.join('\n');
}
