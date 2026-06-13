import { intOpt } from './cli-args.mjs';
import { CliError } from './errors.mjs';

export function parseTaskIds(opts) {
  const values = [];
  const addValue = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) addValue(item);
      return;
    }
    if (value === undefined || value === null || value === '') return;
    for (const part of String(value).split(',')) {
      const text = part.trim();
      if (text) values.push(text);
    }
  };
  addValue(opts.id);
  addValue(opts.ids);
  addValue(opts._ || []);
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    if (!/^\d+$/.test(value)) throw new CliError('BAD_ARGS', `task id must be an integer: ${value}`);
    const id = Number.parseInt(value, 10);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length) throw new CliError('BAD_ARGS', 'Missing --id');
  return ids;
}

export function positiveIntOpt(opts, key, fallback, { max = 50 } = {}) {
  const value = intOpt(opts, key, fallback);
  if (value < 1) throw new CliError('BAD_ARGS', `--${key} must be >= 1`);
  if (value > max) throw new CliError('BAD_ARGS', `--${key} must be <= ${max}`);
  return value;
}

export function taskRowsText(tasks, verb = 'claimed') {
  const rows = Array.isArray(tasks) ? tasks : [tasks].filter(Boolean);
  if (!rows.length) return 'no pending task';
  return rows.map((task) => `${verb} task #${task.id}: ${task.title}`).join('\n');
}
