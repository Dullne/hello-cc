import { CliError } from '../../shared/errors.mjs';
import { sanitizePeerPart } from '../peers/format.mjs';

function intTeamOpt(opts, key, fallback = null) {
  if (opts[key] === undefined || opts[key] === null || opts[key] === '') return fallback;
  const value = Number.parseInt(String(opts[key]), 10);
  if (!Number.isFinite(value)) throw new CliError('BAD_ARGS', `--${key} must be an integer`);
  return value;
}

export function splitCsvList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitCsvList(item));
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function parseTeamItems(opts) {
  const rawItems = [
    ...splitCsvList(opts.item || []),
    ...splitCsvList(opts.items || [])
  ];
  return rawItems.map((raw, index) => {
    const parts = String(raw).split(':').map((part) => part.trim());
    let assignee = null;
    let role = null;
    let title = raw.trim();
    if (parts.length >= 3) {
      assignee = parts.shift() || null;
      role = parts.shift() || null;
      title = parts.join(':').trim();
    } else if (parts.length === 2) {
      role = parts[0] || null;
      title = parts[1] || title;
    }
    if (!title) title = `subtask ${index + 1}`;
    return { title, role: role || `worker-${index + 1}`, assignee };
  });
}

export function inferTeamItems(task, opts) {
  const explicit = parseTeamItems(opts);
  if (explicit.length) return explicit;
  const count = Math.max(1, intTeamOpt(opts, 'count', 3));
  const baseTitle = task?.title || 'team task';
  return Array.from({ length: count }, (_, index) => ({
    title: `${baseTitle} / subtask ${index + 1}`,
    role: `worker-${index + 1}`,
    assignee: null
  }));
}

export function expandTeamWorkers(workers, parentId) {
  const expanded = [];
  for (const token of splitCsvList(workers || [])) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9._-]*):([1-9][0-9]*)$/);
    if (!match) {
      expanded.push(token);
      continue;
    }
    const kind = sanitizePeerPart(match[1], 'peer');
    const count = Number.parseInt(match[2], 10);
    for (let i = 1; i <= count; i += 1) expanded.push(`${kind}-team-${parentId}-${i}`);
  }
  return expanded;
}

export function assignTeamWorkers(items, workers, parentId) {
  const workerList = expandTeamWorkers(workers, parentId);
  if (!workerList.length) return items;
  return items.map((item, index) => ({
    ...item,
    assignee: item.assignee || workerList[index % workerList.length]
  }));
}
