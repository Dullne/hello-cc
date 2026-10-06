import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { resolvePeerEvidence } from '../lib/core/peers/evidence.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import { initSchema, tx } from '../lib/db/schema.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { createTmuxSessions } from '../lib/web/tmux-sessions.mjs';
import { shellQuoteArg } from '../lib/format.mjs';

function fixture(t, { command = 'node', onStreamStart, paneInfo, inspectProcess, scheduleExitPoller } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-attach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { root, dbPath: path.join(root, 'mesh.db') };
  const connect = () => {
    const db = new DatabaseSync(ctx.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };
  const db = connect();
  initSchema(db);
  db.close();
  const fakeTmux = path.join(root, 'tmux');
  // This fixture models an external tmux executable. A shell avoids booting
  // another Node runtime for every pane read during the concurrent test suite.
  // NUL-separated counts and arguments preserve the exact invocation log.
  fs.writeFileSync(fakeTmux, [
    '#!/bin/sh', 'set -eu',
    'fixture_root=' + shellQuoteArg(root),
    'fixture_command=' + shellQuoteArg(command),
    String.raw`printf '%s\0' "$#" "$@" >> ` + shellQuoteArg(fakeTmux + '.calls'),
    'case "${1-}" in',
    '  hcc-fixture-ready) exit 0 ;;',
    '  display-message)',
    '    last=""; for arg do last="$arg"; done',
    `    if [ "$last" = '#{session_name}' ]; then printf '%s' service;`,
    `    else printf '%s' "%service|0|77|$fixture_command|$fixture_root"; fi ;;`,
    `  show-environment) printf '%s' "HCC_ROOT=$fixture_root" ;;`,
    String.raw`  capture-pane) printf '%s\n' 'service output' ;;`,
    String.raw`  *) printf '%s\n' "Unexpected tmux operation: $*" >&2; exit 1 ;;`,
    'esac'
  ].join('\n'), { mode: 0o755 });
  // First execution of a newly written macOS executable may take seconds.
  // Initialize the test-owned script before applying the product's 5s tmux
  // command deadline; its invocation log still contains only product calls.
  const ready = spawnSync(fakeTmux, ['hcc-fixture-ready'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(ready.error, undefined, 'tmux fixture must initialize');
  assert.equal(ready.status, 0, 'tmux fixture must be ready');
  fs.rmSync(fakeTmux + '.calls', { force: true });
  const oldPath = process.env.PATH;
  process.env.PATH = root + path.delimiter + oldPath;
  const now = () => 1000;
  const events = createEventHelpers({ now });
  const identity = (pid) => ({ pid, startToken: 'start-' + pid, commandHash: 'a'.repeat(64) });
  const peers = createPeerHelpers({ now, addEvent: events.addEvent, liveProcessIdentity: identity });
  const bindings = createPeerBindingStore({ now, addEvent: events.addEvent });
  const sessions = new Map();
  const streams = [];
  const calls = { streamStarts: 0, streamStops: 0, broadcasts: 0, clientCloses: 0 };
  const read = (fn) => {
    const db = connect();
    try { return fn(db); } finally { db.close(); }
  };
  const runtime = createTmuxSessions({
    ctx, sessions, now, tx, ...events, ...peers, ...bindings,
    connectWebProject: connect,
    sessionKey: (_ctx, id) => id,
    sessionsForProject: () => [...sessions.values()],
    resolveSessionPeerId: (_db, session) => session.peerId || session.id,
    canonicalRoot: (value) => path.resolve(value),
    liveProcessIdentity: identity,
    ...(paneInfo ? { tmuxPaneInfo: paneInfo } : {}),
    ...(inspectProcess ? { inspectProcessIdentity: inspectProcess } : {}),
    ...(scheduleExitPoller ? { scheduleTmuxExitPoller: scheduleExitPoller } : {}),
    tmuxSessionCreationToken: () => 'created-one',
    tmuxSessionId: () => '$1',
    strictTmuxClientObservation: () => ({ state: 'known', count: 0 }),
    detectBranch: () => 'test-branch',
    startTmuxStream(session) {
      streams.push(session);
      calls.streamStarts++;
      session.streamPoller = { tracking: true };
      onStreamStart?.({ read, peers, bindings });
    },
    stopTmuxStream(session) { calls.streamStops++; session.streamPoller = null; },
    broadcast() { calls.broadcasts++; },
    closeSessionClients() { calls.clientCloses++; }
  });
  t.after(() => {
    for (const session of streams) if (session.exitPoller) clearInterval(session.exitPoller);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  });
  const add = (id, kind, transport = 'hook', target = null) => read((db) => {
    peers.upsertPeer(db, { id, kind, role: 'original-owner', worktree: root, pid: 77, status: 'working' });
    bindings.upsertPeerBinding(db, {
      peer: id, provider: kind, provider_session_id: 'session/' + id,
      resume_mode: 'detected', command: 'original command',
      transport, runtime_session_id: id, runtime_target: target
    });
  });
  const state = () => read((db) => Object.fromEntries(['peers', 'peer_bindings', 'events']
    .map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])));
  const tmuxCalls = () => {
    if (!fs.existsSync(fakeTmux + '.calls')) return [];
    const fields = fs.readFileSync(fakeTmux + '.calls', 'utf8').split('\0'), calls = [];
    for (let i = 0; i < fields.length - 1;) {
      const count = Number(fields[i++]); calls.push(fields.slice(i, i + count)); i += count;
    }
    return calls;
  };
  return { root, runtime, sessions, calls, add, state, read, tmuxCalls };
}

const unsupported = (error) => error.code === 'DSH_SESSION_CONTROL_UNSUPPORTED' && /hcc dsh web/.test(error.message);

for (const [label, observation, expectedEvidence] of [
  ['live', { state: 'live', identity: { pid: 77, startToken: 'start-77', commandHash: 'a'.repeat(64) } }, 'live'],
  ['unknown', { state: 'unknown', identity: null }, 'unknown']
]) {
  test(`lost tmux pane with ${label} original process keeps durable peer evidence after Web detach`, (t) => {
    let tick;
    const f = fixture(t, {
      paneInfo() { throw Object.assign(new Error("can't find pane: %service"), { code: 'TMUX_ERROR' }); },
      inspectProcess: () => observation,
      scheduleExitPoller(callback) { tick = callback; return { scheduled: true }; }
    });
    const attached = f.runtime.attachTmuxSession({ id: `lost-${label}`, pane: '%service', kind: 'shell' });
    const before = f.state();
    assert.equal(before.peers[0].status, 'running');
    tick(); tick();
    assert.equal(attached.status, 'running');
    tick();
    const after = f.state();
    assert.equal(attached.status, 'detached');
    assert.equal(f.sessions.size, 0);
    assert.equal(after.peers[0].status, 'detached');
    assert.equal(after.peer_bindings[0].runtime_target, null);
    assert.deepEqual(after.events.map((event) => event.type), ['tmux.session.attached', 'tmux.session.detached']);
    assert.deepEqual(
      [after.peers[0].pid, after.peers[0].pid_start_token, after.peers[0].pid_command_hash],
      [before.peers[0].pid, before.peers[0].pid_start_token, before.peers[0].pid_command_hash]
    );
    const storedIdentity = {
      pid: after.peers[0].pid,
      startToken: after.peers[0].pid_start_token,
      commandHash: after.peers[0].pid_command_hash
    };
    assert.equal(resolvePeerEvidence({ peer: after.peers[0],
      processes: [{ storedIdentity, current: observation }] }).state, expectedEvidence);
  });
}

for (const transport of ['native', 'app-server']) {
  test(`${transport} ownership rejects terminal adoption before pane access or force replacement`, t => {
    const f = fixture(t);
    f.add('structured-worker', 'codex', transport, transport + ':owner');
    const before = f.state();
    assert.throws(() => f.runtime.attachTmuxSession({ id: 'structured-worker', pane: '%service', kind: 'shell', force: true }),
      { code: 'STRUCTURED_SESSION_NO_TERMINAL' });
    assert.deepEqual(f.state(), before); assert.deepEqual(f.tmuxCalls(), []);
    assert.equal(f.sessions.size, 0); assert.equal(f.calls.streamStarts, 0);
    assert.throws(() => f.runtime.attachTmuxSession({ id: 'new-alias', pane: '%service', kind: 'shell', force: true,
      binding: { provider: 'codex', provider_session_id: 'session/structured-worker' } }),
      { code: 'STRUCTURED_SESSION_NO_TERMINAL' });
    assert.deepEqual(f.state(), before); assert.deepEqual(f.tmuxCalls(), []);
  });
}

test('manual attach preserves existing dsh hook bindings and both sessions before force can detach a pane', (t) => {
  const f = fixture(t);
  f.add('dsh-agent', 'dsh');
  f.add('service-log', 'shell', 'tmux', '%service');
  const existing = { id: 'service-log', pane: '%service', type: 'tmux', status: 'running' };
  const logical = { id: 'dsh-agent', pane: '%other', type: 'tmux', status: 'running' };
  f.sessions.set(existing.id, existing);
  f.sessions.set(logical.id, logical);
  const before = f.state();
  for (const force of [false, true]) {
    assert.throws(() => f.runtime.attachTmuxSession({
      id: 'dsh-agent', pane: '%service', kind: 'shell', force, providerForce: true
    }), unsupported);
    assert.deepEqual(f.state(), before);
    assert.deepEqual([...f.sessions.entries()], [[existing.id, existing], [logical.id, logical]]);
    assert.equal(existing.status, 'running');
    assert.equal(logical.status, 'running');
    assert.deepEqual(f.calls, { streamStarts: 0, streamStops: 0, broadcasts: 0, clientCloses: 0 });
    assert.deepEqual(f.tmuxCalls(), []);
  }
});

for (const [name, command, input] of [
  ['explicit kind', 'node', { id: 'new-agent', kind: 'dsh' }],
  ['explicit provider', 'node', { id: 'new-agent', kind: 'shell', binding: { provider: 'dsh' } }],
  ['pane command inference', 'dsh', { id: 'new-agent' }],
  ['peer ID inference', 'node', { id: 'dsh-new-agent' }]
]) {
  test('manual attach rejects dsh ' + name + ' before detaching an occupied pane', (t) => {
    const f = fixture(t, { command });
    f.add('service-log', 'shell', 'tmux', '%service');
    const existing = { id: 'service-log', pane: '%service', type: 'tmux', status: 'running' };
    f.sessions.set(existing.id, existing);
    const before = f.state();
    assert.throws(() => f.runtime.attachTmuxSession({ ...input, pane: '%service', force: true }), unsupported);
    assert.deepEqual(f.state(), before);
    assert.deepEqual([...f.sessions.entries()], [[existing.id, existing]]);
    assert.deepEqual(f.calls, { streamStarts: 0, streamStops: 0, broadcasts: 0, clientCloses: 0 });
    assert.ok(f.tmuxCalls().every((args) => args[0] === 'display-message'));
  });
}

for (const [kind, command, explicitKind] of [
  ['claude', 'claude', undefined],
  ['codex', 'codex', undefined],
  ['shell', 'dsh', 'shell']
]) {
  test('manual attach still supports ' + kind + (kind === 'shell' ? ' service log panels' : ' agent terminals'), (t) => {
    const f = fixture(t, { command });
    const id = 'new-' + kind;
    const session = f.runtime.attachTmuxSession({ id, pane: '%service', kind: explicitKind });
    assert.equal(session.kind, kind);
    assert.equal(session.status, 'running');
    assert.equal(session.buffer, 'service output');
    assert.equal(f.sessions.get(id), session);
    assert.equal(f.calls.streamStarts, 1);
    const state = f.state();
    assert.equal(state.peers[0].kind, kind);
    assert.equal(state.peer_bindings[0].provider, kind);
    assert.equal(state.peer_bindings[0].transport, 'tmux');
    assert.equal(state.peer_bindings[0].runtime_target, '%service');
    assert.deepEqual(state.events.map((event) => event.type), ['tmux.session.attached']);
  });
}

test('write transaction rechecks a dsh hook binding introduced after preflight and cleans up its stream', (t) => {
  let concurrentState;
  const f = fixture(t, {
    command: 'claude',
    onStreamStart({ read, peers, bindings }) {
      read((db) => {
        peers.upsertPeer(db, { id: 'race-agent', kind: 'dsh', worktree: f.root, status: 'working', pid: 77 });
        bindings.upsertPeerBinding(db, {
          peer: 'race-agent', provider: 'dsh', provider_session_id: 'session/race',
          resume_mode: 'detected', transport: 'hook', runtime_session_id: 'race-agent'
        });
      });
      concurrentState = f.state();
    }
  });
  assert.throws(() => f.runtime.attachTmuxSession({ id: 'race-agent', pane: '%service', force: true }), unsupported);
  assert.deepEqual(f.state(), concurrentState);
  assert.equal(f.sessions.size, 0);
  assert.deepEqual(f.calls, { streamStarts: 1, streamStops: 1, broadcasts: 0, clientCloses: 0 });
});
