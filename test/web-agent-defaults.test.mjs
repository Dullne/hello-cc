import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';
import { createAgentDefaults } from '../lib/web/agent-defaults.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-agent-defaults-')));
  const databases = new Set();
  const context = (name = 'mesh.db', selectedRoot = root) => {
    const dbPath = path.join(selectedRoot, name), db = new DatabaseSync(dbPath); initSchema(db); db.close();
    return { root: selectedRoot, dbPath };
  };
  const connectWebProject = ctx => {
    ctx.rootIdentity?.assertUnchanged();
    const db = new DatabaseSync(ctx.dbPath); databases.add(db); return db;
  };
  const ctx = context(), settings = createAgentDefaults({ connectWebProject });
  t.after(() => { for (const db of databases) { try { db.close(); } catch {} } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, ctx, context, settings, connectWebProject,
    rows() { const db = connectWebProject(ctx); try { return db.prepare('SELECT * FROM meta ORDER BY key').all(); } finally { db.close(); } },
    corrupt(value) { const db = connectWebProject(ctx); try { db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('web_agent_defaults_v1', value); } finally { db.close(); } }
  };
}

test('missing project defaults return revision zero without writing a meta row', t => {
  const f = fixture(t), before = f.rows();
  const settings = f.settings.readAgentDefaults(f.ctx);
  assert.equal(settings.revision, 0); assert.equal(settings.defaultProvider, 'codex');
  for (const provider of ['codex', 'claude', 'dsh']) assert.deepEqual(settings.providers[provider], { model: null, cwd: '.' });
  assert.deepEqual(f.rows(), before);
  settings.providers.codex.model = 'local mutation';
  assert.equal(f.settings.readAgentDefaults(f.ctx).providers.codex.model, null);
});

test('revision compare-and-swap rejects stale writers and preserves other meta keys', t => {
  const f = fixture(t), before = f.rows(), original = f.settings.readAgentDefaults(f.ctx);
  const first = structuredClone(original), second = structuredClone(original);
  first.defaultProvider = 'claude'; first.providers.claude.model = '  selected-model  ';
  const saved = f.settings.saveAgentDefaults(f.ctx, first);
  assert.equal(saved.revision, 1); assert.equal(saved.providers.claude.model, 'selected-model');
  second.defaultProvider = 'dsh';
  assert.throws(() => f.settings.saveAgentDefaults(f.ctx, second), { code: 'AGENT_DEFAULTS_CONFLICT' });
  assert.deepEqual(f.settings.readAgentDefaults(f.ctx), saved);
  assert.deepEqual(f.rows().filter(row => row.key !== 'web_agent_defaults_v1'), before);
  saved.providers.claude.model = '   ';
  const cleared = f.settings.saveAgentDefaults(f.ctx, saved);
  assert.equal(cleared.revision, 2); assert.equal(cleared.providers.claude.model, null);
});

test('provider structure, injected fields, model names and revision bounds fail without persistence', t => {
  const f = fixture(t), original = f.settings.readAgentDefaults(f.ctx), before = f.rows();
  for (const change of [null, [], { ...original, revision: -1 }, { ...original, revision: -0 },
    { ...original, revision: 1.5 }, { ...original, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...original, revision: Number.MAX_SAFE_INTEGER }, { ...original, revision: '0' },
    { ...original, defaultProvider: 'shell' }, { ...original, root: f.root }, { ...original, db: f.ctx.dbPath },
    { ...original, env: {} }, { ...original, apiKey: 'not allowed' },
    { ...original, providers: { codex: { model: null, cwd: '.' } } }]) {
    assert.throws(() => f.settings.saveAgentDefaults(f.ctx, change), { code: 'BAD_REQUEST' });
  }
  for (const value of [{ model: null, cwd: '.', binary: 'custom' }, { model: false, cwd: '.' },
    { model: 'x'.repeat(257), cwd: '.' }, { model: 'bad\nmodel', cwd: '.' }, { model: null, cwd: null }]) {
    assert.throws(() => f.settings.saveAgentDefaults(f.ctx, { ...original, providers: { ...original.providers, codex: value } }), { code: 'BAD_REQUEST' });
  }
  assert.deepEqual(f.rows(), before);
});

test('corrupted or malformed stored settings cannot silently reset or overwrite project defaults', t => {
  const f = fixture(t), original = f.settings.readAgentDefaults(f.ctx);
  for (const value of ['not JSON', '{}', JSON.stringify(original), JSON.stringify({ ...original, revision: 1, secret: 'unknown field' })]) {
    f.corrupt(value);
    assert.throws(() => f.settings.readAgentDefaults(f.ctx), { code: 'AGENT_DEFAULTS_INVALID' });
    assert.throws(() => f.settings.saveAgentDefaults(f.ctx, original), { code: 'AGENT_DEFAULTS_INVALID' });
    assert.equal(f.rows().find(row => row.key === 'web_agent_defaults_v1').value, value);
  }
});

test('saved cwd is canonical and project relative; stale directories remain inspectable while new saves validate them', t => {
  const f = fixture(t), input = f.settings.readAgentDefaults(f.ctx);
  fs.mkdirSync(path.join(f.root, 'sub')); fs.symlinkSync('sub', path.join(f.root, 'alias'));
  input.providers.codex.cwd = './alias/';
  const saved = f.settings.saveAgentDefaults(f.ctx, input);
  assert.equal(saved.providers.codex.cwd, 'sub');
  fs.rmdirSync(path.join(f.root, 'sub'));
  assert.deepEqual(f.settings.readAgentDefaults(f.ctx), saved);
  assert.throws(() => f.settings.saveAgentDefaults(f.ctx, saved), { code: 'BAD_REQUEST' });
  const repaired = { ...saved, providers: { ...saved.providers, codex: { model: null, cwd: '.' } } };
  assert.equal(f.settings.saveAgentDefaults(f.ctx, repaired).revision, 2);
});

test('default cwd cannot escape the project or refer to files and missing directories', t => {
  const f = fixture(t), original = f.settings.readAgentDefaults(f.ctx);
  fs.writeFileSync(path.join(f.root, 'file'), 'not directory'); fs.symlinkSync(os.tmpdir(), path.join(f.root, 'outside'));
  for (const cwd of ['', 'missing', 'file', '../parent', 'sub/../x', '/tmp', 'C:/temp', 'sub\\directory', 'x\0y']) {
    const input = structuredClone(original); input.providers.codex.cwd = cwd;
    assert.throws(() => f.settings.saveAgentDefaults(f.ctx, input), { code: 'BAD_REQUEST' });
  }
  const outside = structuredClone(original); outside.providers.codex.cwd = 'outside';
  assert.throws(() => f.settings.saveAgentDefaults(f.ctx, outside), { code: 'PROJECT_PATH_FORBIDDEN' });
});

test('a symlink cannot save a canonical directory name that defaults cannot round-trip', t => {
  const f = fixture(t), original = f.settings.readAgentDefaults(f.ctx);
  for (const [index, name] of ['generated:build', 'trailing-space ', ' leading-space'].entries()) {
    fs.mkdirSync(path.join(f.root, name)); fs.symlinkSync(name, path.join(f.root, 'alias-' + index));
    const input = structuredClone(original); input.providers.codex.cwd = 'alias-' + index;
    assert.throws(() => f.settings.saveAgentDefaults(f.ctx, input), { code: 'BAD_REQUEST' });
    assert.deepEqual(f.settings.readAgentDefaults(f.ctx), original);
  }
});

test('defaults are scoped by selected project and mesh database with no cross-project cache', t => {
  const f = fixture(t), alternative = f.context('other.db');
  fs.mkdirSync(path.join(f.root, 'other-project')); const other = f.context('mesh.db', path.join(f.root, 'other-project'));
  const first = f.settings.readAgentDefaults(f.ctx); first.defaultProvider = 'claude'; f.settings.saveAgentDefaults(f.ctx, first);
  for (const ctx of [alternative, other]) assert.equal(f.settings.readAgentDefaults(ctx).revision, 0);
  const second = f.settings.readAgentDefaults(alternative); second.defaultProvider = 'dsh'; f.settings.saveAgentDefaults(alternative, second);
  assert.equal(f.settings.readAgentDefaults(f.ctx).defaultProvider, 'claude');
  assert.equal(f.settings.readAgentDefaults(alternative).defaultProvider, 'dsh');
  assert.equal(f.settings.readAgentDefaults(other).defaultProvider, 'codex');
});

test('stale selected root identity is rejected before reading or writing defaults', t => {
  const f = fixture(t), selected = path.join(f.root, 'selected'); fs.mkdirSync(selected);
  const ctx = f.context('mesh.db', selected), binding = captureSelectedCwdIdentity(selected); ctx.rootIdentity = binding;
  const input = f.settings.readAgentDefaults(ctx);
  fs.renameSync(selected, selected + '-old'); fs.mkdirSync(selected);
  try {
    assert.throws(() => f.settings.readAgentDefaults(ctx), { code: 'PROJECT_PATH_CHANGED' });
    assert.throws(() => f.settings.saveAgentDefaults(ctx, input), { code: 'PROJECT_PATH_CHANGED' });
    assert.equal(fs.existsSync(path.join(selected, 'mesh.db')), false);
  } finally { binding.release(); }
});

test('native resolution uses the selected provider and distinguishes inheritance from explicit provider defaults', t => {
  const f = fixture(t), input = f.settings.readAgentDefaults(f.ctx);
  fs.mkdirSync(path.join(f.root, 'work')); input.defaultProvider = 'dsh'; input.providers.dsh = { model: 'project-model', cwd: 'work' };
  f.settings.saveAgentDefaults(f.ctx, input);
  assert.deepEqual(f.settings.resolveNativeDefaults(f.ctx, { transport: 'native' }), { transport: 'native', kind: 'dsh', cwd: 'work', model: 'project-model' });
  for (const model of [null, '', '   ']) assert.equal(f.settings.resolveNativeDefaults(f.ctx, { kind: 'dsh', model }).model, undefined);
  assert.equal(f.settings.resolveNativeDefaults(f.ctx, { kind: 'dsh', model: ' chosen ' }).model, 'chosen');
  assert.equal(f.settings.resolveNativeDefaults(f.ctx, { kind: 'codex' }).model, undefined);
  assert.equal(f.settings.resolveNativeDefaults(f.ctx, { cwd: '.' }).cwd, '.');
});
