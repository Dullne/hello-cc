import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { tx } from '../db/schema.mjs';

const META_KEY = 'web_agent_defaults_v1';
const PROVIDERS = ['codex', 'claude', 'dsh'];

function invalid(message) { return new CliError('BAD_REQUEST', message); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function initialDefaults() {
  return { revision: 0, defaultProvider: 'codex', providers: Object.fromEntries(PROVIDERS.map(provider => [provider, { model: null, cwd: '.' }])) };
}
function normalizeModel(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw invalid('Model must be null or a name of at most 256 characters without control characters');
  return value.trim() || null;
}
function relativeCwd(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) ||
      path.posix.isAbsolute(value.trim()) || path.win32.isAbsolute(value.trim()) || value.trim().split('/').includes('..')) {
    throw invalid('Default working directory must be a project-relative directory, using . for the project root');
  }
  return path.posix.normalize(value.trim()).replace(/\/$/, '') || '.';
}
function assertRoot(ctx) { ctx.rootIdentity?.assertUnchanged(); }
function existingCwd(ctx, relative) {
  assertRoot(ctx);
  let root, target;
  try {
    root = fs.realpathSync(ctx.root); target = fs.realpathSync(path.resolve(root, relative));
    if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
  } catch { throw invalid('Default working directory must already exist inside the selected project'); }
  assertRoot(ctx);
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) {
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Default working directory must stay inside the selected project');
  }
  const canonical = fromRoot.split(path.sep).join('/') || '.';
  if (relativeCwd(canonical) !== canonical) throw invalid('The resolved default directory cannot be represented as a stable project-relative setting');
  return canonical;
}
function validateDocument(value) {
  if (!exactKeys(value, ['revision', 'defaultProvider', 'providers']) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || Object.is(value.revision, -0) ||
      !PROVIDERS.includes(value.defaultProvider) || !exactKeys(value.providers, PROVIDERS)) {
    throw invalid('Agent defaults require a safe revision, a native provider and complete codex, claude and dsh settings');
  }
  const providers = {};
  for (const provider of PROVIDERS) {
    const setting = value.providers[provider];
    if (!exactKeys(setting, ['model', 'cwd'])) throw invalid('Each provider setting accepts only model and cwd');
    providers[provider] = { model: normalizeModel(setting.model), cwd: relativeCwd(setting.cwd) };
  }
  return { revision: value.revision, defaultProvider: value.defaultProvider, providers };
}
function storedDefaults(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(META_KEY);
  if (!row) return initialDefaults();
  try {
    if (typeof row.value !== 'string' || row.value.length > 16384) throw new Error('invalid settings');
    const value = validateDocument(JSON.parse(row.value));
    if (value.revision === 0) throw new Error('invalid saved revision');
    return value;
  } catch {
    throw new CliError('AGENT_DEFAULTS_INVALID', 'Saved Agent defaults are invalid; inspect the project configuration before saving or creating a worker');
  }
}

/** HCC project settings only. Provider accounts, processes and config files are never touched. */
export function createAgentDefaults({ connectWebProject }) {
  function readAgentDefaults(ctx) {
    assertRoot(ctx);
    const db = connectWebProject(ctx);
    try { const value = storedDefaults(db); assertRoot(ctx); return value; }
    finally { db.close(); }
  }
  function saveAgentDefaults(ctx, input) {
    const requested = validateDocument(input);
    if (requested.revision === Number.MAX_SAFE_INTEGER) throw invalid('Agent defaults revision is exhausted');
    assertRoot(ctx);
    const db = connectWebProject(ctx);
    try {
      return tx(db, () => {
        assertRoot(ctx);
        const current = storedDefaults(db);
        if (requested.revision !== current.revision) throw new CliError('AGENT_DEFAULTS_CONFLICT', 'Agent defaults changed in another view; reload them before saving your draft');
        const providers = {};
        for (const provider of PROVIDERS) providers[provider] = { model: requested.providers[provider].model,
          cwd: existingCwd(ctx, requested.providers[provider].cwd) };
        const saved = { revision: current.revision + 1, defaultProvider: requested.defaultProvider, providers };
        assertRoot(ctx);
        db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(META_KEY, JSON.stringify(saved));
        assertRoot(ctx);
        return saved;
      });
    } finally { db.close(); }
  }
  function resolveNativeDefaults(ctx, input) {
    const saved = readAgentDefaults(ctx), kind = input.kind === undefined ? saved.defaultProvider : input.kind;
    if (!PROVIDERS.includes(kind)) throw invalid('Use native provider codex, claude or dsh');
    const setting = saved.providers[kind], model = input.model === undefined ? setting.model : normalizeModel(input.model);
    return { ...input, kind, cwd: input.cwd === undefined ? setting.cwd : input.cwd, model: model === null ? undefined : model };
  }
  return { readAgentDefaults, saveAgentDefaults, resolveNativeDefaults };
}
