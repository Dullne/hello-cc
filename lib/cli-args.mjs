import process from 'node:process';
import { CliError } from './errors.mjs';

export function splitGlobalArgs(argv) {
  const global = { json: false, root: null, db: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      global.json = true;
    } else if (arg === '--root') {
      global.root = argv[++i];
    } else if (arg.startsWith('--root=')) {
      global.root = arg.slice('--root='.length);
    } else if (arg === '--db') {
      global.db = argv[++i];
    } else if (arg.startsWith('--db=')) {
      global.db = arg.slice('--db='.length);
    } else {
      rest.push(arg);
    }
  }
  return { global, rest };
}

export function parseOpts(args, spec = {}) {
  const booleans = new Set(spec.booleans || []);
  const arrays = new Set(spec.arrays || []);
  const opts = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--') || arg === '--') {
      opts._.push(arg);
      continue;
    }
    let key;
    let value;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      if (booleans.has(key)) {
        value = true;
      } else {
        value = args[++i];
      }
    }
    if (!key) throw new CliError('BAD_ARGS', `Invalid option: ${arg}`);
    if (value === undefined) throw new CliError('BAD_ARGS', `Missing value for --${key}`);
    if (arrays.has(key)) {
      if (!opts[key]) opts[key] = [];
      opts[key].push(value);
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

export function wantsHelp(args) {
  const stop = args.indexOf('--');
  const scan = stop >= 0 ? args.slice(0, stop) : args;
  const index = scan.findIndex((arg) => arg === '--help' || arg === '-h');
  if (index < 0) return false;
  return index <= 1 || !String(scan[index - 1] || '').startsWith('--');
}

export function validateOpts(command, opts, allowed = []) {
  const allowedSet = new Set(['_', ...allowed]);
  for (const key of Object.keys(opts)) {
    if (!allowedSet.has(key)) throw new CliError('BAD_ARGS', `${command}: unknown option --${key}`);
  }
  if (opts._?.length) throw new CliError('BAD_ARGS', `${command}: unexpected argument ${opts._[0]}`);
}

export function required(opts, key, envName = null) {
  const value = opts[key] || (envName ? process.env[envName] : null);
  if (!value) throw new CliError('BAD_ARGS', `Missing --${key}${envName ? ` or $${envName}` : ''}`);
  return value;
}

export function intOpt(opts, key, fallback = null) {
  if (opts[key] === undefined || opts[key] === null || opts[key] === '') return fallback;
  const value = Number.parseInt(String(opts[key]), 10);
  if (!Number.isFinite(value)) throw new CliError('BAD_ARGS', `--${key} must be an integer`);
  return value;
}
