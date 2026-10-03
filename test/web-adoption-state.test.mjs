import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { adoptionPaused, writeAdoptionState } from '../lib/web/adoption-state.mjs';
import { createAutoAttach } from '../lib/web/auto-attach.mjs';
import { createTmuxSessions } from '../lib/web/tmux-sessions.mjs';

const noop = () => {};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-adoption-test-'));
  const filename = path.join(root, 'mesh.db');
  let db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, actor TEXT,
      task_id INTEGER, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE peers (
      id TEXT PRIMARY KEY, kind TEXT, role TEXT, status TEXT, worktree TEXT,
      pid INTEGER, pid_start_token TEXT, pid_command_hash TEXT, last_seen_at INTEGER
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY, provider TEXT, provider_session_id TEXT,
      provider_session_name TEXT, resume_mode TEXT, resume_arg TEXT,
      command TEXT, transport TEXT, runtime_session_id TEXT, runtime_target TEXT
    );
    INSERT INTO peers VALUES ('codex-a', 'codex', 'peer', 'running', '${root}', 123, 'start-one', 'command-one', 100);
    INSERT INTO peer_bindings VALUES ('codex-a', 'codex', 'thread-one', NULL, 'attached', '%7', 'codex', 'tmux', 'codex-a', '%7');
  `);
  const session = {
    id: 'codex-a', peerId: 'codex-a', pane: '%7', pid: 123,
    adoptionIdentity: {
      process_identity: { pid: 123, startToken: 'start-one' },
      tmux_session_created: 'created-one', tmux_session_id: '$1'
    }
  };
  const observed = {
    peer: 'codex-a', pane: '%7', pid: 123,
    process_identity: { pid: 123, startToken: 'start-one' },
    tmux_session_created: 'created-one', tmux_session_id: '$1'
  };
  return {
    root, filename, session, observed,
    get db() { return db; },
    connect: () => ({ prepare: db.prepare.bind(db), close: noop }),
    reopen() { db.close(); db = new DatabaseSync(filename); },
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}

function recoveryRuntime(f, changes = {}) {
  const attached = [];
  const sessions = new Map();
  const runtime = createTmuxSessions({
    ctx: { root: f.root }, sessions,
    connectWebProject: f.connect,
    now: () => 100,
    sessionsForProject: () => [...sessions.values()],
    tmuxPaneInfo: () => ({ pane: '%7', pid: 123, dead: false, cwd: f.root }),
    tmuxListSessionNames: () => ['hcc-test-codex-a'],
    tmuxSessionEnvironmentValue: () => f.root,
    tmuxManagedSessionNameMatches: (_ctx, _name, peer) => peer === 'codex-a',
    isProjectManagedTmuxSession: () => true,
    rootEvidence: () => ({ state: 'match' }),
    observePeerEvidence: () => ({ state: 'live' }),
    liveProcessIdentity: (pid) => ({ pid, startToken: 'start-one' }),
    tmuxSessionCreationToken: () => 'created-one',
    tmuxSessionId: () => '$1',
    attachTmuxSession: (input) => {
      attached.push(input);
      const session = { ...input, type: 'tmux', status: 'running' };
      sessions.set(input.id, session);
      return session;
    },
    ...changes
  });
  return { runtime, attached };
}

test('pause is durable in the existing events table across database reopen and explicit resume', () => {
  const f = fixture();
  try {
    assert.equal(adoptionPaused(f.db, f.observed), false);
    writeAdoptionState(f.db, f.session, true, 100);
    f.reopen();
    assert.equal(adoptionPaused(f.db, f.observed), true);
    assert.equal(adoptionPaused(f.db, { peer: 'codex-a' }), true);
    // Audit insertion order, not wall-clock time, decides the latest intent.
    writeAdoptionState(f.db, f.session, false, 50);
    f.reopen();
    assert.equal(adoptionPaused(f.db, f.observed), false);
    assert.deepEqual(f.db.prepare('SELECT type FROM events ORDER BY id').all().map((r) => r.type),
      ['web.adoption.paused', 'web.adoption.resumed']);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%adoption%'").all().length, 0);
  } finally {
    f.close();
  }
});

test('pause does not transfer to another peer, pane, PID, or immutable session identity', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    assert.equal(adoptionPaused(f.db, { ...f.observed, peer: 'codex-b' }), false);
    assert.equal(adoptionPaused(f.db, { ...f.observed, pane: '%8' }), false);
    assert.equal(adoptionPaused(f.db, { ...f.observed, pid: 124 }), false);
    assert.equal(adoptionPaused(f.db, { ...f.observed, process_identity: { pid: 123, startToken: 'start-two' } }), false);
    assert.equal(adoptionPaused(f.db, { ...f.observed, tmux_session_created: 'created-two' }), false);
    assert.equal(adoptionPaused(f.db, { ...f.observed, tmux_session_id: '$2' }), false);
    assert.equal(adoptionPaused(f.db, { peer: 'codex-a', pane: '%7' }), true);
  } finally {
    f.close();
  }
});

test('resuming a different pane cannot erase the original pane pause', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    writeAdoptionState(f.db, { ...f.session, pane: '%8' }, false, 101);
    assert.equal(adoptionPaused(f.db, f.observed), true);
    assert.equal(adoptionPaused(f.db, { ...f.observed, pane: '%8' }), false);
  } finally {
    f.close();
  }
});

test('a new runtime restores neither a paused binding nor its detached managed orphan', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    f.reopen();
    const restored = recoveryRuntime(f);
    restored.runtime.restoreTmuxManagedSessions();
    assert.equal(restored.attached.length, 0);
    assert.deepEqual([...restored.runtime.reAdoptOrphanManagedTmuxSessions()], ['codex-a']);

    // Web detach clears runtime_target. A subsequent runtime discovers it by
    // tmux name, and must still keep it out of the Web while preserving live.
    f.db.prepare('UPDATE peer_bindings SET runtime_target = NULL WHERE peer = ?').run('codex-a');
    f.reopen();
    const orphan = recoveryRuntime(f);
    orphan.runtime.restoreTmuxManagedSessions();
    assert.equal(orphan.attached.length, 0);
    assert.deepEqual([...orphan.runtime.reAdoptOrphanManagedTmuxSessions()], ['codex-a']);
  } finally {
    f.close();
  }
});

test('explicit resume permits recovery on a later runtime', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    writeAdoptionState(f.db, f.session, false, 101);
    f.reopen();
    const restored = recoveryRuntime(f);
    restored.runtime.restoreTmuxManagedSessions();
    assert.equal(restored.attached.length, 1);
    assert.equal(restored.attached[0].id, 'codex-a');
    assert.equal(restored.attached[0].pane, '%7');
  } finally {
    f.close();
  }
});

test('recycled pane with changed immutable identity is recoverable for its current live peer', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    f.reopen();
    const restored = recoveryRuntime(f, { tmuxSessionCreationToken: () => 'created-two' });
    restored.runtime.restoreTmuxManagedSessions();
    assert.equal(restored.attached.length, 1);
  } finally {
    f.close();
  }
});

test('automatic detected-peer scans respect persisted pause while preserving the managed live set', () => {
  const f = fixture();
  try {
    writeAdoptionState(f.db, f.session, true, 100);
    f.reopen();
    const attached = [];
    const liveSets = [];
    const deps = {
      ctx: { root: f.root }, sessions: new Map(),
      connectWebProject: f.connect,
      now: () => 100,
      addEvent: noop,
      reconcileRunningPeerBindings: noop,
      ACTIVE_PEER_TTL: 600,
      redactedLogText: (value) => value,
      sessionsForProject: () => [],
      attachTmuxSession: (input) => { attached.push(input); return { id: input.id }; },
      latestHookProviderSession: noop,
      resolveSessionPeerId: noop,
      reAdoptOrphanManagedTmuxSessions: () => new Set(['codex-a']),
      reapDeadPeersForProject: (_ctx, live) => liveSets.push([...live]),
      runTmux: () => `%7|123|codex|${f.root}`,
      inspectProcessIdentity: (pid) => ({ state: 'live', identity: { pid, startToken: 'start-one' } })
    };
    const paused = createAutoAttach(deps);
    clearInterval(paused.autoAttachPoller);
    assert.equal(attached.length, 0);
    assert.deepEqual(liveSets, [['codex-a']]);

    writeAdoptionState(f.db, f.session, false, 101);
    const resumed = createAutoAttach(deps);
    clearInterval(resumed.autoAttachPoller);
    assert.equal(attached.length, 1);
  } finally {
    f.close();
  }
});
