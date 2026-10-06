import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initSchema, tx } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { assertCodexTerminalLaunch, recordCodexThreadRoot } from '../lib/core/sessions/codex-thread-root.mjs';
import { buildCodexCommand, buildPeerCommand, inferPeerKind } from '../lib/integrations/providers.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { createTmuxSessions } from '../lib/web/tmux-sessions.mjs';
import { createPeerCommands } from '../lib/cli/commands/peer.mjs';
import { parseOpts } from '../lib/cli-args.mjs';
import { CliError } from '../lib/shared/errors.mjs';

test('Codex terminal resume and fork require the launch command and original directory identity', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-terminal-root-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const db = new DatabaseSync(path.join(base, 'mesh.db'));
  initSchema(db);
  t.after(() => { db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const original = captureSelectedCwdSnapshot(root);
  const events = createEventHelpers({ now: () => 1 });
  recordCodexThreadRoot(db, events.addEvent, 'source-thread', original, 'new');
  const check = (binding, command = binding.command, selected = original) =>
    assertCodexTerminalLaunch(db, binding, { command, root, rootIdentity: selected,
      cwd: root, cwdIdentity: selected });

  const resume = buildCodexCommand('peer', { resume: 'source-thread' });
  const fork = buildCodexCommand('peer', { fork: true, resume: 'source-thread' });
  assert.equal(check(resume.binding), null);
  assert.equal(check(fork.binding), 'fork');
  assert.equal(check(buildCodexCommand('peer', {}).binding), 'new');
  assert.throws(() => check(resume.binding, 'codex resume another-thread'),
    { code: 'CODEX_HISTORY_COMMAND_UNVERIFIED' });
  assert.throws(() => check(buildCodexCommand('peer', { last: true }).binding),
    { code: 'CODEX_HISTORY_ID_REQUIRED' });
  assert.throws(() => check(buildCodexCommand('peer', { fork: true }).binding),
    { code: 'CODEX_HISTORY_ID_REQUIRED' });
  assert.throws(() => check(buildCodexCommand('peer', { resume: 'legacy-thread' }).binding),
    { code: 'CODEX_HISTORY_UNVERIFIED' });
  db.prepare('INSERT INTO events(type,actor,payload,created_at) VALUES(?,?,?,?)').run(
    'codex.thread.root-bound', 'numeric-identity',
    JSON.stringify({ version: 1, thread_id: 'numeric-identity', root: {
      canonical: original.canonical,
      identity: { dev: 1, ino: original.identity.ino, birthtimeNs: original.identity.birthtimeNs }
    }, origin: 'new' }), 1);
  assert.throws(() => check(buildCodexCommand('peer', { resume: 'numeric-identity' }).binding),
    { code: 'CODEX_HISTORY_BINDING_INVALID' });

  const tmuxSessions = new Map();
  const tmux = createTmuxSessions({ ctx: { root, dbPath: path.join(base, 'mesh.db') },
    sessions: tmuxSessions, connectWebProject: () => new DatabaseSync(path.join(base, 'mesh.db')),
    nextProjectSessionId: () => 'new-peer', requestActorPeer: (_input, id) => id,
    requestSource: () => 'test', findProviderSessionBinding: () => null });
  const tmuxStart = built => tmux.startTmuxManagedSession({ id: 'tmux-peer', kind: 'codex',
    command: built.command, binding: built.binding });
  assert.throws(() => tmuxStart(buildCodexCommand('tmux-peer', { last: true })),
    { code: 'CODEX_HISTORY_ID_REQUIRED' });
  assert.throws(() => tmuxStart(buildCodexCommand('tmux-peer', { resume: 'legacy-thread' })),
    { code: 'CODEX_HISTORY_UNVERIFIED' });
  assert.equal(tmuxSessions.size, 0, 'rejected history must not attach or create a pane');
  assert.equal(db.prepare('SELECT count(*) AS n FROM peers').get().n, 0);

  fs.renameSync(root, path.join(base, 'original-project'));
  fs.mkdirSync(root);
  const replacement = captureSelectedCwdSnapshot(root);
  assert.throws(() => check(resume.binding, resume.command, replacement),
    { code: 'PROJECT_PATH_FORBIDDEN' });
});

test('CLI peer start rejects Codex --last and unverified resume before runtime POST or peer write', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-cli-root-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const dbPath = path.join(base, 'mesh.db');
  const db = new DatabaseSync(dbPath); initSchema(db);
  t.after(() => { db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const requests = [];
  const { cmdPeer } = createPeerCommands({
    connect: () => new DatabaseSync(dbPath), tx, parseOpts, CliError, buildPeerCommand,
    inferPeerKind, path, process, Map, CLI_NAME: 'hcc',
    resolveCurrentPeer: () => ({ id: 'requester' }), wantsHelp: () => false,
    readRuntime: () => ({}), runtimeRequest: async (_ctx, method, route) => { requests.push([method, route]); return {}; },
    findProviderSessionBinding: () => null, bindingHasRuntime: () => false,
    upsertPeer: () => { throw new Error('peer write must not run'); },
    now: () => 1, auditPayload: value => value, printResult: () => {},
    childSessionEnv: () => ({}), detectBranch: () => '', storedPeerIdentity: () => null,
    addEvent: () => { throw new Error('event write must not run'); }
  });
  const ctx = { root, dbPath, initialRootIdentity: captureSelectedCwdSnapshot(root) };
  await assert.rejects(cmdPeer(ctx, ['start', 'codex-peer', '--kind', 'codex', '--last']),
    { code: 'CODEX_HISTORY_ID_REQUIRED' });
  await assert.rejects(cmdPeer(ctx, ['start', 'codex-peer', '--kind', 'codex', '--resume', 'legacy-thread']),
    { code: 'CODEX_HISTORY_UNVERIFIED' });
  assert.equal(requests.some(([method]) => method === 'POST'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM peers').get().n, 0);
});
