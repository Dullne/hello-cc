#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { applyBufferPlan, planBufferFiles } from '../lib/runtime/buffer-gc.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const testId = `${process.pid}-${Date.now()}`;
const root = path.join(os.tmpdir(), `hcc-reg-root-${testId}`);
const home = path.join(os.tmpdir(), `hcc-reg-home-${testId}`);
const fakeBin = path.join(os.tmpdir(), `hcc-reg-bin-${testId}`);
const outDir = path.join(os.tmpdir(), `hcc-reg-out-${testId}`);
const tmuxSession = `hcc-reg-${process.pid}`;
const tmuxSocketName = `hcc-reg-${testId}`.replace(/[^A-Za-z0-9_-]/g, '-');
const secondProjectRoot = path.join(root, 'second-project');
const realHome = process.env.HOME || os.homedir();
const realRegistryFile = path.join(realHome, '.hello-cc', 'projects.json');
const realTmuxBin = spawnSync('sh', ['-lc', 'command -v tmux || true'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore']
}).stdout.trim();
const port = 22000 + (process.pid % 10000);

let tmuxStarted = false;
let runtimePid = null;
const managedTmuxSessions = new Set();

const env = {
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  SHELL: '/bin/bash'
};
for (const key of Object.keys(env)) {
  if (key.startsWith('HCC_')) delete env[key];
}
if (process.env.HCC_REGRESSION_DEBUG === '1') env.HCC_DEBUG = '1';
delete env.TMUX;
delete env.TMUX_PANE;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = String(message)
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
    process.stderr.write(`::error::${escaped}\n`);
  }
  throw new Error(message);
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function canonicalPath(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
}

function samePath(a, b) {
  return canonicalPath(a) === canonicalPath(b);
}

function statusValue(output, key) {
  const match = String(output || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}

function sanitizePeerPart(value, fallback = 'peer') {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function tmuxManagedSession(projectRoot, peer) {
  return `hcc-${shortHash(canonicalPath(projectRoot))}-${sanitizePeerPart(peer, 'peer')}`.slice(0, 80);
}

function tmuxManagedSessionPrefix(projectRoot) {
  return `hcc-${shortHash(canonicalPath(projectRoot))}-`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${commandText(command, args)} failed${output ? `\n${output}` : ''}`);
  }
  return result.stdout || '';
}

function runMaybe(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
}

function hcc(args, options = {}) {
  return run(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccJson(args, options = {}) {
  const output = hcc(['--json', ...args], options);
  const parsed = JSON.parse(output);
  if (!parsed.ok) fail(`hcc json command failed: ${output}`);
  return parsed.data;
}

function hccMaybe(args, options = {}) {
  return runMaybe(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccFrom(args, cwd, options = {}) {
  return run(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function hccFromMaybe(args, cwd, options = {}) {
  return runMaybe(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function withMeshDb(fn) {
  // Match production connect(): a busy timeout so read-during-write (the runtime
  // holds the WAL) does not fail fast with SQLITE_BUSY on Linux.
  const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function assertPersistedLockRenewal(resource, {
  ttlSec,
  createdAt,
  before,
  after,
  renewalSec = ttlSec,
  expectedExpiresAt = null,
  label = resource
}) {
  const row = withMeshDb((db) => db.prepare(`
    SELECT resource, owner, created_at, expires_at, ttl_sec
    FROM locks
    WHERE resource = ?
  `).get(resource));
  if (!row ||
      row.ttl_sec !== ttlSec ||
      row.created_at !== createdAt ||
      (expectedExpiresAt === null
        ? row.expires_at < before + renewalSec || row.expires_at > after + renewalSec
        : row.expires_at !== expectedExpiresAt)) {
    fail(`${label} renewal changed, shortened, or inflated its persisted TTL:\n${JSON.stringify({ row, ttlSec, createdAt, before, after, renewalSec, expectedExpiresAt }, null, 2)}`);
  }
  return row;
}

function providerBindingRows(provider, sessionName) {
  return withMeshDb((db) => db.prepare(`
    SELECT
      peer, provider, provider_session_id, provider_session_name,
      resume_mode, resume_arg, command, transport, runtime_target
    FROM peer_bindings
    WHERE provider = ? AND provider_session_name = ?
    ORDER BY peer
  `).all(provider, sessionName));
}

function parsePayloadJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function eventPayloads(type, limit = 20, dbPath = path.join(root, '.hello-cc', 'mesh.db')) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return db.prepare(`
      SELECT actor, payload
      FROM events
      WHERE type = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(type, limit).map((row) => ({
      actor: row.actor,
      payload: parsePayloadJson(row.payload)
    }));
  } finally {
    db.close();
  }
}

function peerBindingIndexNames(dbPath = path.join(root, '.hello-cc', 'mesh.db')) {
  const db = new DatabaseSync(dbPath);
  try {
    return new Set(db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'peer_bindings'
    `).all().map((row) => row.name));
  } finally {
    db.close();
  }
}

function assertPeerBindingIndexes(dbPath) {
  const indexes = peerBindingIndexNames(dbPath);
  for (const name of [
    'idx_peer_bindings_provider_session_id_unique',
    'idx_peer_bindings_provider_session_name_unique',
    'idx_peer_bindings_runtime_target_unique'
  ]) {
    if (!indexes.has(name)) fail(`missing peer binding uniqueness index: ${name}`);
  }
}

function insertStaleProviderBinding(peer, provider, sessionName) {
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, 'peer', ?, '', NULL, 'idle', 'regression-stale', ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(peer, provider, root, t, t);
    db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, 'detected', NULL, NULL, 'detected', ?, NULL, ?, ?)
      ON CONFLICT(peer) DO UPDATE SET
        provider = excluded.provider,
        provider_session_name = excluded.provider_session_name,
        transport = excluded.transport,
        runtime_target = excluded.runtime_target,
        updated_at = excluded.updated_at
    `).run(peer, provider, sessionName, peer, t, t);
  });
}

function insertRuntimeTargetBinding(peer, provider, sessionName, runtimeTarget) {
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, 'peer', ?, '', NULL, 'idle', 'regression-runtime', ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(peer, provider, root, t, t);
    db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, 'resume', ?, ?, 'tmux', ?, ?, ?, ?)
    `).run(peer, provider, sessionName, sessionName, `${provider} resume ${sessionName}`, peer, runtimeTarget, t, t);
  });
}

function peerBindingRow(peer) {
  return withMeshDb((db) => db.prepare(`
    SELECT peer, transport, runtime_target, updated_at
    FROM peer_bindings
    WHERE peer = ?
  `).get(peer));
}

function moveRuntimeBindingPeer(fromPeer, toPeer) {
  withMeshDb((db) => {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(fromPeer);
    if (!peer) fail(`cannot move missing peer ${fromPeer}`);
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(fromPeer);
    if (!binding) fail(`cannot move missing peer binding ${fromPeer}`);
    const t = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        role = excluded.role,
        worktree = excluded.worktree,
        branch = excluded.branch,
        pid = excluded.pid,
        status = excluded.status,
        capabilities = excluded.capabilities,
        last_seen_at = excluded.last_seen_at
    `).run(
      toPeer,
      peer.kind,
      peer.role,
      peer.worktree,
      peer.branch,
      peer.pid,
      peer.status,
      peer.capabilities,
      t,
      t
    );
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(toPeer);
    db.prepare('UPDATE peer_bindings SET peer = ?, updated_at = ? WHERE peer = ?').run(toPeer, t, fromPeer);
  });
}

function assertSqliteUniqueFailure(label, fn) {
  try {
    fn();
  } catch (err) {
    if (String(err?.message || err).includes('UNIQUE constraint failed')) return;
    throw err;
  }
  fail(`${label} did not fail with a SQLite UNIQUE constraint`);
}

function cleanupBindingPeers(prefix) {
  withMeshDb((db) => {
    db.prepare('DELETE FROM peer_bindings WHERE peer LIKE ?').run(`${prefix}%`);
    db.prepare('DELETE FROM peers WHERE id LIKE ?').run(`${prefix}%`);
  });
}

function assertPeerBindingUniqueConstraints() {
  assertPeerBindingIndexes();
  const providerPrefix = 'unique-provider-';
  const runtimePrefix = 'unique-runtime-';
  cleanupBindingPeers(providerPrefix);
  cleanupBindingPeers(runtimePrefix);

  insertStaleProviderBinding(`${providerPrefix}a`, 'codex', 'unique-provider-session');
  assertSqliteUniqueFailure('duplicate provider session binding', () => {
    insertStaleProviderBinding(`${providerPrefix}b`, 'codex', 'unique-provider-session');
  });
  const providerRows = providerBindingRows('codex', 'unique-provider-session');
  if (providerRows.length !== 1 || providerRows[0].peer !== `${providerPrefix}a`) {
    fail(`provider session unique constraint left unexpected rows:\n${JSON.stringify(providerRows, null, 2)}`);
  }

  insertRuntimeTargetBinding(`${runtimePrefix}a`, 'claude', 'unique-runtime-session-a', '%unique-runtime-target');
  assertSqliteUniqueFailure('duplicate runtime target binding', () => {
    insertRuntimeTargetBinding(`${runtimePrefix}b`, 'codex', 'unique-runtime-session-b', '%unique-runtime-target');
  });
  const runtimeRows = withMeshDb((db) => db.prepare(`
    SELECT peer, provider, provider_session_name, transport, runtime_target
    FROM peer_bindings
    WHERE runtime_target = '%unique-runtime-target'
    ORDER BY peer
  `).all());
  if (runtimeRows.length !== 1 || runtimeRows[0].peer !== `${runtimePrefix}a`) {
    fail(`runtime target unique constraint left unexpected rows:\n${JSON.stringify(runtimeRows, null, 2)}`);
  }

  cleanupBindingPeers(providerPrefix);
  cleanupBindingPeers(runtimePrefix);
}

async function assertTmuxGcPolicy() {
  const stalePeer = 'tmux-gc-stale';
  const peerFilterPeer = 'tmux-gc-peer-filter';
  const attachedPeer = 'tmux-gc-attached';
  const deadBindingPeer = 'tmux-gc-binding-dead';
  const reusedBindingPeer = 'tmux-gc-binding-reused';
  const clientUnknownBindingPeer = 'tmux-gc-binding-client-unknown';
  const eventPeer = 'tmux-gc-event';
  const deadEventPeer = 'tmux-gc-event-dead';
  const reusedEventPeer = 'tmux-gc-event-reused';
  const reusedProcessEventPeer = 'tmux-gc-event-reused-process';
  const clientUnknownEventPeer = 'tmux-gc-event-client-unknown';
  const rootEventPeer = 'tmux-gc-event-root';
  const legacyEventPeer = 'tmux-gc-event-legacy';
  const manualSession = `hcc-${shortHash(root)}-manual-lookalike`;
  const staleSession = tmuxManagedSession(root, stalePeer);
  const peerFilterSession = tmuxManagedSession(root, peerFilterPeer);
  const attachedSession = tmuxManagedSession(root, attachedPeer);
  const deadBindingSession = tmuxManagedSession(root, deadBindingPeer);
  const reusedBindingSession = tmuxManagedSession(root, reusedBindingPeer);
  const clientUnknownBindingSession = tmuxManagedSession(root, clientUnknownBindingPeer);
  const eventSession = `${tmuxManagedSession(root, eventPeer)}-old-regression`;
  const deadEventSession = `${tmuxManagedSession(root, deadEventPeer)}-old-regression`;
  const reusedEventSession = tmuxManagedSession(root, reusedEventPeer);
  const reusedProcessEventSession = tmuxManagedSession(root, reusedProcessEventPeer);
  const clientUnknownEventSession = tmuxManagedSession(root, clientUnknownEventPeer);
  const rootEventSession = tmuxManagedSession(root, rootEventPeer);
  for (const session of [staleSession, peerFilterSession, attachedSession, deadBindingSession, reusedBindingSession, clientUnknownBindingSession, eventSession, deadEventSession, reusedEventSession, reusedProcessEventSession, clientUnknownEventSession, rootEventSession, manualSession]) {
    runMaybe('tmux', ['kill-session', '-t', session]);
  }
  cleanupBindingPeers('tmux-gc-');
  managedTmuxSessions.add(peerFilterSession);
  managedTmuxSessions.add(attachedSession);
  managedTmuxSessions.add(deadBindingSession);
  managedTmuxSessions.add(reusedBindingSession);
  managedTmuxSessions.add(clientUnknownBindingSession);
  managedTmuxSessions.add(eventSession);
  managedTmuxSessions.add(deadEventSession);
  managedTmuxSessions.add(reusedEventSession);
  managedTmuxSessions.add(reusedProcessEventSession);
  managedTmuxSessions.add(clientUnknownEventSession);
  managedTmuxSessions.add(rootEventSession);
  managedTmuxSessions.add(manualSession);

  run('tmux', ['new-session', '-d', '-s', staleSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', peerFilterSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', attachedSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', deadBindingSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'sleep', '300']);
  run('tmux', ['set-option', '-t', deadBindingSession, 'remain-on-exit', 'on']);
  run('tmux', ['new-session', '-d', '-s', reusedBindingSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', clientUnknownBindingSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', eventSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', deadEventSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'sleep', '300']);
  run('tmux', ['set-option', '-t', deadEventSession, 'remain-on-exit', 'on']);
  run('tmux', ['new-session', '-d', '-s', reusedEventSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', reusedProcessEventSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', clientUnknownEventSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'sleep', '300']);
  run('tmux', ['set-option', '-t', clientUnknownEventSession, 'remain-on-exit', 'on']);
  run('tmux', ['new-session', '-d', '-s', rootEventSession, '-e', `HCC_ROOT=${root}-other`, '-c', root, 'bash', '--noprofile', '--norc']);
  run('tmux', ['new-session', '-d', '-s', manualSession, '-e', `HCC_ROOT=${root}`, '-c', root, 'bash', '--noprofile', '--norc']);
  const stalePane = run('tmux', ['display-message', '-p', '-t', `${staleSession}:0.0`, '#{pane_id}']).trim();
  const peerFilterPane = run('tmux', ['display-message', '-p', '-t', `${peerFilterSession}:0.0`, '#{pane_id}']).trim();
  const attachedPane = run('tmux', ['display-message', '-p', '-t', `${attachedSession}:0.0`, '#{pane_id}']).trim();
  const deadBindingPane = run('tmux', ['display-message', '-p', '-t', `${deadBindingSession}:0.0`, '#{pane_id}']).trim();
  const reusedBindingPane = run('tmux', ['display-message', '-p', '-t', `${reusedBindingSession}:0.0`, '#{pane_id}']).trim();
  const clientUnknownBindingPane = run('tmux', ['display-message', '-p', '-t', `${clientUnknownBindingSession}:0.0`, '#{pane_id}']).trim();
  const eventPane = run('tmux', ['display-message', '-p', '-t', `${eventSession}:0.0`, '#{pane_id}']).trim();
  const deadEventPane = run('tmux', ['display-message', '-p', '-t', `${deadEventSession}:0.0`, '#{pane_id}']).trim();
  const reusedEventPane = run('tmux', ['display-message', '-p', '-t', `${reusedEventSession}:0.0`, '#{pane_id}']).trim();
  const reusedProcessEventPane = run('tmux', ['display-message', '-p', '-t', `${reusedProcessEventSession}:0.0`, '#{pane_id}']).trim();
  const clientUnknownEventPane = run('tmux', ['display-message', '-p', '-t', `${clientUnknownEventSession}:0.0`, '#{pane_id}']).trim();
  const rootEventPane = run('tmux', ['display-message', '-p', '-t', `${rootEventSession}:0.0`, '#{pane_id}']).trim();
  const manualPane = run('tmux', ['display-message', '-p', '-t', `${manualSession}:0.0`, '#{pane_id}']).trim();
  const tmuxEventEvidence = (session, pane) => {
    const pid = Number(run('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}']).trim());
    return {
      old_process_identity: inspectProcessIdentity(pid).identity,
      old_hcc_root: canonicalPath(root),
      old_tmux_session_created: run('tmux', ['display-message', '-p', '-t', session, '#{session_created}']).trim(),
      old_tmux_session_id: run('tmux', ['display-message', '-p', '-t', session, '#{session_id}']).trim(),
      old_pane: pane
    };
  };
  const eventEvidence = tmuxEventEvidence(eventSession, eventPane);
  const deadEventEvidence = tmuxEventEvidence(deadEventSession, deadEventPane);
  const reusedEventEvidence = tmuxEventEvidence(reusedEventSession, reusedEventPane);
  const reusedProcessEventEvidence = tmuxEventEvidence(reusedProcessEventSession, reusedProcessEventPane);
  const clientUnknownEventEvidence = tmuxEventEvidence(clientUnknownEventSession, clientUnknownEventPane);
  const rootEventEvidence = tmuxEventEvidence(rootEventSession, rootEventPane);
  const staleEvidence = tmuxEventEvidence(staleSession, stalePane);
  const peerFilterEvidence = tmuxEventEvidence(peerFilterSession, peerFilterPane);
  const attachedEvidence = tmuxEventEvidence(attachedSession, attachedPane);
  const deadBindingEvidence = tmuxEventEvidence(deadBindingSession, deadBindingPane);
  const reusedBindingEvidence = tmuxEventEvidence(reusedBindingSession, reusedBindingPane);
  const clientUnknownBindingEvidence = tmuxEventEvidence(clientUnknownBindingSession, clientUnknownBindingPane);
  insertRuntimeTargetBinding(stalePeer, 'shell', 'tmux-gc-stale-session', stalePane);
  insertRuntimeTargetBinding(peerFilterPeer, 'shell', 'tmux-gc-peer-filter-session', peerFilterPane);
  insertRuntimeTargetBinding(attachedPeer, 'shell', 'tmux-gc-attached-session', attachedPane);
  insertRuntimeTargetBinding(deadBindingPeer, 'shell', 'tmux-gc-binding-dead-session', deadBindingPane);
  insertRuntimeTargetBinding(reusedBindingPeer, 'shell', 'tmux-gc-binding-reused-session', reusedBindingPane);
  insertRuntimeTargetBinding(clientUnknownBindingPeer, 'shell', 'tmux-gc-binding-client-unknown-session', clientUnknownBindingPane);
  const eventActivePane = parsePane(hcc(['peer', 'start', eventPeer, '--kind', 'shell', '--', 'bash', '--noprofile', '--norc']));
  const eventActiveSession = run('tmux', ['display-message', '-p', '-t', eventActivePane, '#{session_name}']).trim();
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 30 * 86400;
    db.prepare('UPDATE peers SET last_seen_at = ? WHERE id IN (?, ?, ?)').run(t, stalePeer, peerFilterPeer, attachedPeer);
    db.prepare("UPDATE peers SET status = 'exited' WHERE id IN (?, ?)").run(stalePeer, peerFilterPeer);
    db.prepare('UPDATE peer_bindings SET updated_at = ? WHERE peer IN (?, ?, ?)').run(t, stalePeer, peerFilterPeer, attachedPeer);
    db.prepare('UPDATE peers SET last_seen_at = ? WHERE id IN (?, ?, ?)').run(t, deadBindingPeer, reusedBindingPeer, clientUnknownBindingPeer);
    db.prepare("UPDATE peers SET status = 'exited' WHERE id IN (?, ?)").run(reusedBindingPeer, clientUnknownBindingPeer);
    db.prepare('UPDATE peer_bindings SET updated_at = ? WHERE peer IN (?, ?, ?)').run(t, deadBindingPeer, reusedBindingPeer, clientUnknownBindingPeer);
    for (const [peer, session, pane, evidence] of [
      [stalePeer, staleSession, stalePane, staleEvidence],
      [peerFilterPeer, peerFilterSession, peerFilterPane, peerFilterEvidence],
      [attachedPeer, attachedSession, attachedPane, attachedEvidence],
      [deadBindingPeer, deadBindingSession, deadBindingPane, deadBindingEvidence],
      [reusedBindingPeer, reusedBindingSession, reusedBindingPane, {
        ...reusedBindingEvidence,
        old_process_identity: {
          ...reusedBindingEvidence.old_process_identity,
          startToken: `${reusedBindingEvidence.old_process_identity.startToken}:reused`
        }
      }],
      [clientUnknownBindingPeer, clientUnknownBindingSession, clientUnknownBindingPane, clientUnknownBindingEvidence]
    ]) {
      db.prepare(`
        INSERT INTO events(type, actor, task_id, payload, created_at)
        VALUES ('tmux.session.attached', ?, NULL, ?, ?)
      `).run(peer, JSON.stringify({
        actor_peer: peer,
        target_peer: peer,
        pane,
        tmux_session: session,
        tmux_session_created: evidence.old_tmux_session_created,
        tmux_session_id: evidence.old_tmux_session_id,
        hcc_root: evidence.old_hcc_root,
        process_identity: evidence.old_process_identity
      }), t);
    }
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(eventPeer, JSON.stringify({
      reason: 'has_clients',
      old_peer: eventPeer,
      old_runtime_target: eventPane,
      new_runtime_target: eventActivePane,
      old_tmux_session: eventSession,
      ...eventEvidence
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(deadEventPeer, JSON.stringify({
      reason: 'cleanup_failed',
      old_peer: deadEventPeer,
      old_runtime_target: deadEventPane,
      new_runtime_target: `%new-dead-${process.pid}`,
      old_tmux_session: deadEventSession,
      ...deadEventEvidence
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(reusedEventPeer, JSON.stringify({
      reason: 'has_clients',
      old_peer: reusedEventPeer,
      old_runtime_target: reusedEventPane,
      new_runtime_target: `%new-${process.pid}`,
      old_tmux_session: reusedEventSession,
      ...reusedEventEvidence,
      old_tmux_session_created: '1'
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(reusedProcessEventPeer, JSON.stringify({
      reason: 'cleanup_failed',
      old_peer: reusedProcessEventPeer,
      old_runtime_target: reusedProcessEventPane,
      new_runtime_target: `%new-reused-process-${process.pid}`,
      old_tmux_session: reusedProcessEventSession,
      ...reusedProcessEventEvidence,
      old_process_identity: {
        ...reusedProcessEventEvidence.old_process_identity,
        startToken: `${reusedProcessEventEvidence.old_process_identity.startToken}:reused`
      }
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(clientUnknownEventPeer, JSON.stringify({
      reason: 'cleanup_failed',
      old_peer: clientUnknownEventPeer,
      old_runtime_target: clientUnknownEventPane,
      new_runtime_target: `%new-client-unknown-${process.pid}`,
      old_tmux_session: clientUnknownEventSession,
      ...clientUnknownEventEvidence
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(rootEventPeer, JSON.stringify({
      reason: 'hcc_root_mismatch',
      old_peer: rootEventPeer,
      old_runtime_target: rootEventPane,
      new_runtime_target: `%new-root-${process.pid}`,
      old_tmux_session: rootEventSession,
      ...rootEventEvidence
    }), t);
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES ('tmux.session.rebind_cleanup_failed', ?, NULL, ?, ?)
    `).run(legacyEventPeer, JSON.stringify({
      reason: 'legacy',
      old_peer: legacyEventPeer,
      old_runtime_target: manualPane,
      new_runtime_target: `%new-legacy-${process.pid}`,
      old_tmux_session: manualSession
    }), t);
  });
  process.kill(deadEventEvidence.old_process_identity.pid, 'SIGKILL');
  process.kill(clientUnknownEventEvidence.old_process_identity.pid, 'SIGKILL');
  process.kill(deadBindingEvidence.old_process_identity.pid, 'SIGKILL');
  await waitFor(() => run('tmux', ['display-message', '-p', '-t', deadEventPane, '#{pane_dead}']).trim() === '1', 'dead event pane');
  await waitFor(() => run('tmux', ['display-message', '-p', '-t', clientUnknownEventPane, '#{pane_dead}']).trim() === '1', 'client-unknown dead event pane');
  await waitFor(() => run('tmux', ['display-message', '-p', '-t', deadBindingPane, '#{pane_dead}']).trim() === '1', 'dead binding pane');

  const attachTmux = realTmuxBin ? `${sh(realTmuxBin)} -L ${sh(tmuxSocketName)}` : 'tmux';
  const client = spawnSync('tmux', ['new-session', '-d', '-s', `${tmuxSession}-gc-client`, '-e', `HCC_ROOT=${root}`, 'sh', '-lc', `unset TMUX; exec ${attachTmux} attach-session -t ${sh(attachedSession)}`], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (client.status !== 0) fail(`could not attach client for tmux gc policy test:\n${client.stderr || client.stdout}`);
  try {
    await waitFor(() => Boolean(run('tmux', ['list-clients', '-t', attachedSession, '-F', '#{client_tty}']).trim()), 'tmux gc attached-client setup');
    const gcOutputHasPeer = (output, peer) => String(output).split('\n')
      .some((line) => line.trim().split(/\s+/)[0] === peer);
    const gcEnv = {
      ...env,
      HCC_REGRESSION_TMUX_FAIL_CLIENT_SESSIONS: [clientUnknownEventSession, clientUnknownBindingSession].join(' ')
    };
    const dryRun = hcc(['tmux', 'gc', '--older-than', '14'], { env: gcEnv });
    if (!gcOutputHasPeer(dryRun, stalePeer) || !dryRun.includes('stale_hcc_managed_session') ||
        !gcOutputHasPeer(dryRun, peerFilterPeer) ||
        !gcOutputHasPeer(dryRun, deadBindingPeer) ||
        !gcOutputHasPeer(dryRun, deadEventPeer) || !dryRun.includes('stale_rebind_cleanup_failed_session')) {
      fail(`tmux gc dry-run did not list stale DB-proven managed session:\n${dryRun}`);
    }
    for (const protectedPeer of [reusedBindingPeer, clientUnknownBindingPeer, eventPeer, reusedEventPeer, reusedProcessEventPeer, clientUnknownEventPeer, rootEventPeer, legacyEventPeer]) {
      if (gcOutputHasPeer(dryRun, protectedPeer)) {
        fail(`tmux gc dry-run treated live/unknown event evidence as removable (${protectedPeer}):\n${dryRun}`);
      }
    }
    const dryRunJson = hccJson(['tmux', 'gc', '--older-than', '14'], { env: gcEnv });
    const candidateModes = new Map(dryRunJson.candidates.map((candidate) => [candidate.peer, candidate.gc_validation_mode]));
    if (candidateModes.get(stalePeer) !== 'explicit_exit_live' ||
        candidateModes.get(deadBindingPeer) !== 'dead_process') {
      fail(`tmux gc did not record strict binding validation modes:\n${JSON.stringify(dryRunJson.candidates, null, 2)}`);
    }
    if (runMaybe('tmux', ['has-session', '-t', staleSession]).status !== 0) {
      fail('tmux gc dry-run deleted stale managed session');
    }
    const filteredDryRun = hcc(['tmux', 'gc', '--older-than', '14', '--peer', peerFilterPeer], { env: gcEnv });
    if (!filteredDryRun.includes(peerFilterPeer) || filteredDryRun.includes(stalePeer) || filteredDryRun.includes(eventPeer)) {
      fail(`tmux gc --peer dry-run did not filter to requested peer:\n${filteredDryRun}`);
    }
    const filteredRemoved = hcc(['tmux', 'gc', '--older-than', '14', '--peer', peerFilterPeer, '--yes'], { env: gcEnv });
    if (!filteredRemoved.includes(peerFilterPeer) || filteredRemoved.includes(stalePeer) || filteredRemoved.includes(eventPeer)) {
      fail(`tmux gc --peer --yes did not remove only requested peer:\n${filteredRemoved}`);
    }
    if (runMaybe('tmux', ['has-session', '-t', peerFilterSession]).status === 0) {
      fail('tmux gc --peer --yes did not delete requested stale managed session');
    }
    if (runMaybe('tmux', ['has-session', '-t', staleSession]).status !== 0 ||
        runMaybe('tmux', ['has-session', '-t', eventSession]).status !== 0) {
      fail('tmux gc --peer --yes deleted an unrequested stale managed session');
    }

    const removed = hcc(['tmux', 'gc', '--older-than', '14', '--yes'], { env: gcEnv });
    if (!gcOutputHasPeer(removed, stalePeer) || !gcOutputHasPeer(removed, deadBindingPeer) || !gcOutputHasPeer(removed, deadEventPeer) ||
        gcOutputHasPeer(removed, reusedBindingPeer) || gcOutputHasPeer(removed, clientUnknownBindingPeer) ||
        gcOutputHasPeer(removed, eventPeer) || gcOutputHasPeer(removed, reusedEventPeer) ||
        gcOutputHasPeer(removed, reusedProcessEventPeer) || gcOutputHasPeer(removed, clientUnknownEventPeer) ||
        gcOutputHasPeer(removed, rootEventPeer) || gcOutputHasPeer(removed, legacyEventPeer) ||
        gcOutputHasPeer(removed, peerFilterPeer) || gcOutputHasPeer(removed, attachedPeer) || removed.includes(manualPane)) {
      fail(`tmux gc --yes output wrong:\n${removed}`);
    }
    if (runMaybe('tmux', ['has-session', '-t', staleSession]).status === 0) {
      fail('tmux gc --yes did not delete stale DB-proven managed session');
    }
    if (runMaybe('tmux', ['has-session', '-t', deadBindingSession]).status === 0) {
      fail('tmux gc --yes did not delete a truly dead exact binding session');
    }
    if (runMaybe('tmux', ['has-session', '-t', deadEventSession]).status === 0) {
      fail('tmux gc --yes did not delete a confirmed-dead rebind cleanup session listed by dry-run');
    }
    for (const protectedSession of [reusedBindingSession, clientUnknownBindingSession, eventSession, reusedEventSession, reusedProcessEventSession, clientUnknownEventSession, rootEventSession, manualSession]) {
      if (runMaybe('tmux', ['has-session', '-t', protectedSession]).status !== 0) {
        fail(`tmux gc deleted live/unknown event session: ${protectedSession}`);
      }
    }
    if (runMaybe('tmux', ['has-session', '-t', eventActiveSession]).status !== 0) {
      fail('tmux gc deleted the active replacement session for the same peer');
    }
    if (runMaybe('tmux', ['has-session', '-t', reusedEventSession]).status !== 0) {
      fail('tmux gc deleted a same-name session whose old runtime target no longer matched');
    }
    if (run('tmux', ['display-message', '-p', '-t', `${reusedEventSession}:0.0`, '#{pane_id}']).trim() !== reusedEventPane) {
      fail('tmux gc touched the wrong same-name rebind cleanup session');
    }
    if (runMaybe('tmux', ['has-session', '-t', attachedSession]).status !== 0) {
      fail('tmux gc deleted managed session with attached tmux client');
    }
    if (runMaybe('tmux', ['has-session', '-t', manualSession]).status !== 0) {
      fail('tmux gc deleted manual lookalike tmux session without DB binding');
    }
    const staleBinding = peerBindingRow(stalePeer);
    if (!staleBinding || staleBinding.transport !== 'detached' || staleBinding.runtime_target !== null) {
      fail(`tmux gc did not detach deleted binding:\n${JSON.stringify(staleBinding, null, 2)}`);
    }
    const peerFilterBinding = peerBindingRow(peerFilterPeer);
    if (!peerFilterBinding || peerFilterBinding.transport !== 'detached' || peerFilterBinding.runtime_target !== null) {
      fail(`tmux gc --peer did not detach requested deleted binding:\n${JSON.stringify(peerFilterBinding, null, 2)}`);
    }
    const attachedBinding = peerBindingRow(attachedPeer);
    if (!attachedBinding || attachedBinding.runtime_target !== attachedPane) {
      fail(`tmux gc changed attached-client binding:\n${JSON.stringify(attachedBinding, null, 2)}`);
    }
    const deadBinding = peerBindingRow(deadBindingPeer);
    if (!deadBinding || deadBinding.transport !== 'detached' || deadBinding.runtime_target !== null) {
      fail(`tmux gc did not detach truly dead binding:\n${JSON.stringify(deadBinding, null, 2)}`);
    }
    for (const [peer, pane] of [
      [reusedBindingPeer, reusedBindingPane],
      [clientUnknownBindingPeer, clientUnknownBindingPane]
    ]) {
      const protectedBinding = peerBindingRow(peer);
      if (!protectedBinding || protectedBinding.runtime_target !== pane) {
        fail(`tmux gc changed protected binding ${peer}:\n${JSON.stringify(protectedBinding, null, 2)}`);
      }
    }
    const eventBinding = peerBindingRow(eventPeer);
    if (!eventBinding || eventBinding.runtime_target !== eventActivePane) {
      fail(`tmux gc changed active replacement binding for event-backed stale session:\n${JSON.stringify(eventBinding, null, 2)}`);
    }
  } finally {
    hccMaybe(['peer', 'stop', eventPeer, '--kill-tmux']);
    runMaybe('tmux', ['kill-session', '-t', `${tmuxSession}-gc-client`]);
    runMaybe('tmux', ['kill-session', '-t', peerFilterSession]);
    runMaybe('tmux', ['kill-session', '-t', attachedSession]);
    runMaybe('tmux', ['kill-session', '-t', deadBindingSession]);
    runMaybe('tmux', ['kill-session', '-t', reusedBindingSession]);
    runMaybe('tmux', ['kill-session', '-t', clientUnknownBindingSession]);
    runMaybe('tmux', ['kill-session', '-t', eventSession]);
    runMaybe('tmux', ['kill-session', '-t', deadEventSession]);
    runMaybe('tmux', ['kill-session', '-t', reusedEventSession]);
    runMaybe('tmux', ['kill-session', '-t', reusedProcessEventSession]);
    runMaybe('tmux', ['kill-session', '-t', clientUnknownEventSession]);
    runMaybe('tmux', ['kill-session', '-t', rootEventSession]);
    runMaybe('tmux', ['kill-session', '-t', eventActiveSession]);
    runMaybe('tmux', ['kill-session', '-t', manualSession]);
    runMaybe('tmux', ['kill-session', '-t', staleSession]);
    cleanupBindingPeers('tmux-gc-');
  }
}

function createLegacyBindingDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 3600;
    const newTime = oldTime + 60;
    db.exec(`
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        runtime_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'legacy-provider-detected', 'claude', 'legacy-provider-session', 'detected',
      null, null, 'detected', 'legacy-provider-detected', null, oldTime, oldTime
    );
    insert.run(
      'legacy-provider-live', 'claude', 'legacy-provider-session', 'resume',
      'legacy-provider-session', 'claude --resume legacy-provider-session', 'tmux',
      'legacy-provider-live', '%legacy-provider-pane', oldTime, newTime
    );
    insert.run(
      'legacy-runtime-old', 'codex', 'legacy-runtime-old-session', 'resume',
      'legacy-runtime-old-session', 'codex resume legacy-runtime-old-session', 'tmux',
      'legacy-runtime-old', '%legacy-runtime-pane', oldTime, oldTime
    );
    insert.run(
      'legacy-runtime-new', 'shell', 'legacy-runtime-new-session', 'command',
      null, 'bash', 'tmux', 'legacy-runtime-new', '%legacy-runtime-pane', oldTime, newTime
    );
  } finally {
    db.close();
  }
}

function createLegacySchemaDb(dbPath, version) {
  if (version !== 5 && version !== 6) fail(`unsupported legacy schema fixture version: ${version}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const t = Math.floor(Date.now() / 1000) - 3600;
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('schema_version', '${version}');

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        role TEXT,
        worktree TEXT,
        branch TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'idle',
        capabilities TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        runtime_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        assignee TEXT,
        owner TEXT,
        parent_id INTEGER,
        team_role TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_by TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT,
        task_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'note',
        body TEXT NOT NULL,
        reply_to INTEGER,
        thread_id INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE message_reads (
        message_id INTEGER NOT NULL,
        peer TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, peer)
      );

      CREATE TABLE locks (
        resource TEXT PRIMARY KEY,
        base_resource TEXT,
        scope TEXT NOT NULL DEFAULT '*',
        owner TEXT NOT NULL,
        task_id INTEGER,
        reason TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL${version >= 6 ? ',\n        ttl_sec INTEGER NOT NULL DEFAULT 900' : ''}
      );

      CREATE TABLE handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        from_peer TEXT NOT NULL,
        to_peer TEXT,
        summary TEXT NOT NULL,
        changed_files TEXT,
        tests TEXT,
        risks TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor TEXT,
        task_id INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_tasks_status_priority ON tasks(status, priority, id);
      CREATE INDEX idx_tasks_owner ON tasks(owner);
      CREATE INDEX idx_messages_recipient_id ON messages(recipient, id);
      CREATE INDEX idx_events_id ON events(id);
      CREATE INDEX idx_locks_expires ON locks(expires_at);

      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES ('legacy-peer', 'codex', 'peer', '${root.replace(/'/g, "''")}', '', NULL, 'idle', 'legacy', ${t}, ${t});
      INSERT INTO peer_bindings(peer, provider, provider_session_id, provider_session_name, resume_mode, resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at)
      VALUES ('legacy-peer', 'codex', NULL, 'legacy-session', 'detected', NULL, NULL, 'detected', 'legacy-peer', NULL, ${t}, ${t});
      INSERT INTO messages(sender, recipient, task_id, kind, body, reply_to, thread_id, created_at)
      VALUES ('legacy-peer', 'all', NULL, 'note', 'legacy-message', NULL, NULL, ${t});
      UPDATE messages SET thread_id = id WHERE body = 'legacy-message';
      INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at${version >= 6 ? ', ttl_sec' : ''})
      VALUES
        ('legacy-lock-capped', 'legacy-lock-capped', '*', 'legacy-peer', NULL, 'legacy excessive ttl', ${t + 7200}, ${t}${version >= 6 ? ', 3600' : ''}),
        ('legacy-lock-derived', 'legacy-lock-derived', '*', 'legacy-peer', NULL, 'legacy positive ttl', ${t + 120}, ${t}${version >= 6 ? ', 120' : ''}),
        ('legacy-lock-fallback', 'legacy-lock-fallback', '*', 'legacy-peer', NULL, 'legacy invalid ttl', ${t}, ${t}${version >= 6 ? ', 900' : ''});

      PRAGMA user_version = ${version};
    `);
    const migrationNames = [
      'baseline',
      'peer binding runtime targets',
      'threaded messages',
      'team task hierarchy',
      'scoped advisory locks',
      'persist lock ttl'
    ];
    const insertMigration = db.prepare(`
      INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (?, ?, ?)
    `);
    for (let migration = 1; migration <= version; migration += 1) {
      insertMigration.run(migration, migrationNames[migration - 1], t);
    }
  } finally {
    db.close();
  }
}

function assertPreV7MigrationBackup(dbPath, fromVersion) {
  const prefix = `${path.basename(dbPath)}.pre-v${fromVersion}-to-v7.`;
  const backups = fs.readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'));
  if (backups.length !== 1) {
    fail(`expected one v${fromVersion} migration backup beside ${dbPath}, found ${backups.length}`);
  }
  const backupPath = path.join(path.dirname(dbPath), backups[0]);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const quickCheck = backup.prepare('PRAGMA quick_check').get()?.quick_check;
    const metaVersion = backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    const userVersion = backup.prepare('PRAGMA user_version').get()?.user_version;
    const peer = backup.prepare('SELECT capabilities FROM peers WHERE id = ?').get('legacy-peer');
    const peerColumns = new Set(backup.prepare('PRAGMA table_info(peers)').all().map((row) => row.name));
    const lockColumns = new Set(backup.prepare('PRAGMA table_info(locks)').all().map((row) => row.name));
    if (quickCheck !== 'ok' || metaVersion !== String(fromVersion) || userVersion !== fromVersion ||
        peer?.capabilities !== 'legacy' || peerColumns.has('pid_start_token') || peerColumns.has('pid_command_hash') ||
        lockColumns.has('ttl_sec') !== (fromVersion >= 6)) {
      fail(`v${fromVersion} migration backup did not preserve its original state:\n${JSON.stringify({
        quickCheck,
        metaVersion,
        userVersion,
        peer,
        peerColumns: [...peerColumns],
        lockColumns: [...lockColumns]
      }, null, 2)}`);
    }
  } finally {
    backup.close();
  }
}

function assertLegacySchemaMigration() {
  for (const fromVersion of [5, 6]) {
    const legacyRoot = path.join(os.tmpdir(), `hcc-reg-legacy-schema-v${fromVersion}-root-${testId}`);
    const legacyDb = path.join(legacyRoot, '.hello-cc', 'mesh.db');
    try {
      createLegacySchemaDb(legacyDb, fromVersion);
      run(process.execPath, [hccBin, '--root', legacyRoot, 'status', '--peer', `legacy-v${fromVersion}-check`], { env });
      assertPreV7MigrationBackup(legacyDb, fromVersion);
      const db = new DatabaseSync(legacyDb);
      try {
        const peerColumns = new Set(db.prepare('PRAGMA table_info(peers)').all().map((row) => row.name));
        for (const column of ['pid_start_token', 'pid_command_hash']) {
          if (!peerColumns.has(column)) fail(`v${fromVersion} migration did not add peers.${column}`);
        }
        const lockColumns = new Set(db.prepare('PRAGMA table_info(locks)').all().map((row) => row.name));
        if (!lockColumns.has('ttl_sec')) fail(`v${fromVersion} migration did not add locks.ttl_sec`);
        const migratedLocks = db.prepare(`
          SELECT resource, ttl_sec
          FROM locks
          WHERE resource LIKE 'legacy-lock-%'
          ORDER BY resource
        `).all();
        if (migratedLocks.length !== 3 ||
            migratedLocks[0].resource !== 'legacy-lock-capped' || migratedLocks[0].ttl_sec !== 3600 ||
            migratedLocks[1].resource !== 'legacy-lock-derived' || migratedLocks[1].ttl_sec !== 120 ||
            migratedLocks[2].resource !== 'legacy-lock-fallback' || migratedLocks[2].ttl_sec !== 900) {
          fail(`v${fromVersion} lock TTL migration wrong:\n${JSON.stringify(migratedLocks, null, 2)}`);
        }
        const metaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
        const pragmaVersion = db.prepare('PRAGMA user_version').get().user_version;
        if (metaVersion !== '7' || pragmaVersion !== 7) {
          fail(`schema version not synchronized: meta=${metaVersion} pragma=${pragmaVersion}`);
        }
        const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
        if (migrations.length !== 7 || migrations[6].version !== 7 || migrations[6].name !== 'peer process identity fingerprints') {
          fail(`schema migrations history wrong:\n${JSON.stringify(migrations, null, 2)}`);
        }
      } finally {
        db.close();
      }
    } finally {
      try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

function assertRegisteredProjectDbMigration() {
  const otherRoot = path.join(os.tmpdir(), `hcc-reg-registered-legacy-root-${testId}`);
  const otherDb = path.join(otherRoot, '.hello-cc', 'mesh.db');
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  try {
    createLegacySchemaDb(otherDb, 6);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      projects: [
        { root, db: path.join(root, '.hello-cc', 'mesh.db'), name: 'current', last_seen_at: 2 },
        { root: otherRoot, db: otherDb, name: 'registered-legacy', last_seen_at: 1 }
      ]
    }, null, 2));
    hcc(['status', '--peer', 'registered-migration-check']);
    const db = new DatabaseSync(otherDb);
    try {
      const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
      if (!taskColumns.has('parent_id') || !taskColumns.has('team_role')) {
        fail(`registered project DB was not migrated:\n${JSON.stringify([...taskColumns], null, 2)}`);
      }
      const lockColumns = new Set(db.prepare('PRAGMA table_info(locks)').all().map((row) => row.name));
      if (!lockColumns.has('ttl_sec')) {
        fail(`registered project DB did not add locks.ttl_sec:\n${JSON.stringify([...lockColumns], null, 2)}`);
      }
      const peerColumns = new Set(db.prepare('PRAGMA table_info(peers)').all().map((row) => row.name));
      if (!peerColumns.has('pid_start_token') || !peerColumns.has('pid_command_hash')) {
        fail(`registered project DB did not add peer identity columns:\n${JSON.stringify([...peerColumns], null, 2)}`);
      }
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 7) fail(`registered project DB user_version wrong: ${version}`);
    } finally {
      db.close();
    }
    assertPreV7MigrationBackup(otherDb, 6);
  } finally {
    try { fs.rmSync(otherRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertRegisteredProjectDbMigrationBackupFailure() {
  const siblingRoot = path.join(os.tmpdir(), `hcc-reg-registered-backup-failure-root-${testId}`);
  const siblingDb = path.join(siblingRoot, '.hello-cc', 'mesh.db');
  const preloadFile = path.join(siblingRoot, 'fail-migration-backup.mjs');
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  try {
    createLegacySchemaDb(siblingDb, 6);
    fs.writeFileSync(preloadFile, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalMkdtempSync = fs.mkdtempSync;
      fs.mkdtempSync = function (prefix, ...args) {
        if (String(prefix).includes('.migration-backup-')) {
          throw Object.assign(new Error('injected migration backup staging failure'), { code: 'EACCES' });
        }
        return originalMkdtempSync.call(this, prefix, ...args);
      };
      syncBuiltinESMExports();
    `);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({
      projects: [
        { root, db: path.join(root, '.hello-cc', 'mesh.db'), name: 'current', last_seen_at: 2 },
        { root: siblingRoot, db: siblingDb, name: 'registered-backup-failure', last_seen_at: 1 }
      ]
    }, null, 2));

    const nodeOptions = [env.NODE_OPTIONS, `--import=${pathToFileURL(preloadFile).href}`]
      .filter(Boolean)
      .join(' ');
    const result = hccMaybe(['status', '--peer', 'registered-backup-failure-check'], {
      env: { ...env, NODE_OPTIONS: nodeOptions }
    });
    if (result.status !== 0) {
      fail(`sibling backup failure aborted the active command:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }
    if (!String(result.stderr || '').includes('skipping registered project DB migration') ||
        !String(result.stderr || '').includes(siblingDb) ||
        !String(result.stderr || '').includes('injected migration backup staging failure')) {
      fail(`sibling backup failure was not logged:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }

    const db = new DatabaseSync(siblingDb, { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      const peerColumns = new Set(db.prepare('PRAGMA table_info(peers)').all().map((row) => row.name));
      if (version !== 6 || peerColumns.has('pid_start_token') || peerColumns.has('pid_command_hash')) {
        fail(`sibling changed after its backup failure: ${JSON.stringify({ version, peerColumns: [...peerColumns] })}`);
      }
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(siblingRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertFutureSchemaMigrationHistoryRejected() {
  const futureRoot = path.join(os.tmpdir(), `hcc-reg-future-schema-root-${testId}`);
  const futureDb = path.join(futureRoot, '.hello-cc', 'mesh.db');
  try {
    fs.mkdirSync(path.dirname(futureDb), { recursive: true });
    const db = new DatabaseSync(futureDb);
    try {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta(key, value) VALUES ('schema_version', '5');
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations(version, name, applied_at)
        VALUES (999, 'future migration', 1);
      `);
    } finally {
      db.close();
    }
    const result = runMaybe(process.execPath, [hccBin, '--root', futureRoot, 'status', '--peer', 'future-schema-check'], { env });
    if (result.status === 0 || !`${result.stdout}\n${result.stderr}`.includes('Database schema version 999 is newer than this hcc (7)')) {
      fail(`future schema migration history was not rejected:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    }
  } finally {
    try { fs.rmSync(futureRoot, { recursive: true, force: true }); } catch {}
  }
}

function assertLegacyBindingRepair() {
  const legacyRoot = path.join(os.tmpdir(), `hcc-reg-legacy-root-${testId}`);
  const legacyDb = path.join(legacyRoot, '.hello-cc', 'mesh.db');
  try {
    createLegacyBindingDb(legacyDb);
    run(process.execPath, [hccBin, '--root', legacyRoot, 'status', '--peer', 'legacy-check'], { env });
    assertPeerBindingIndexes(legacyDb);
    const db = new DatabaseSync(legacyDb);
    try {
      const providerRows = db.prepare(`
        SELECT peer, transport, runtime_target
        FROM peer_bindings
        WHERE provider = 'claude' AND provider_session_name = 'legacy-provider-session'
        ORDER BY peer
      `).all();
      if (providerRows.length !== 1 || providerRows[0].peer !== 'legacy-provider-live') {
        fail(`legacy provider duplicate was not repaired:\n${JSON.stringify(providerRows, null, 2)}`);
      }
      const runtimeRows = db.prepare(`
        SELECT peer, transport, runtime_target
        FROM peer_bindings
        WHERE runtime_target = '%legacy-runtime-pane'
        ORDER BY peer
      `).all();
      if (runtimeRows.length !== 1 || runtimeRows[0].peer !== 'legacy-runtime-new') {
        fail(`legacy runtime duplicate was not repaired:\n${JSON.stringify(runtimeRows, null, 2)}`);
      }
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
  }
}

function tmuxAvailable() {
  return runMaybe('tmux', ['-V']).status === 0;
}

function tmuxCleanupEndpoints() {
  if (!realTmuxBin) return [{ label: 'default', command: 'tmux', args: [] }];
  return [
    { label: 'test-socket', command: realTmuxBin, args: ['-L', tmuxSocketName] },
    { label: 'default', command: realTmuxBin, args: [] }
  ];
}

function runMaybeTmuxEndpoint(endpoint, args) {
  return runMaybe(endpoint.command, [...endpoint.args, ...args]);
}

function listTmuxSessionsMatching(prefixes, endpoint) {
  const output = runMaybeTmuxEndpoint(endpoint, ['list-sessions', '-F', '#{session_name}']);
  if (output.status !== 0) return [];
  return (output.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((session) => prefixes.some((prefix) => session.startsWith(prefix)));
}

function killTmuxSessionOnEndpoint(endpoint, session) {
  runMaybeTmuxEndpoint(endpoint, ['kill-session', '-t', session]);
}

function assertNoRegressionTmuxSessionLeak() {
  const prefixes = [
    tmuxManagedSessionPrefix(root),
    tmuxManagedSessionPrefix(secondProjectRoot)
  ];
  const leaks = [];
  for (const endpoint of tmuxCleanupEndpoints()) {
    for (const session of listTmuxSessionsMatching(prefixes, endpoint)) {
      leaks.push(`${endpoint.label}:${session}`);
    }
  }
  if (leaks.length) {
    fail(`regression leaked hcc-managed tmux sessions:\n${leaks.join('\n')}`);
  }
}

function trackTmuxPane(pane) {
  if (!pane) return;
  const result = runMaybe('tmux', ['display-message', '-p', '-t', pane, '#S']);
  if (result.status === 0) managedTmuxSessions.add(result.stdout.trim());
}

function tmuxEnvironmentValue(session, key) {
  const result = runMaybe('tmux', ['show-environment', '-t', session, key]);
  if (result.status !== 0) return null;
  const line = (result.stdout || '').trim();
  const prefix = `${key}=`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

function assertHccManagedTmuxEnv(pane, expectedRoot = root) {
  const session = run('tmux', ['display-message', '-p', '-t', pane, '#{session_name}']).trim();
  const hccRoot = tmuxEnvironmentValue(session, 'HCC_ROOT');
  const hccDb = tmuxEnvironmentValue(session, 'HCC_DB');
  const expectedDb = path.join(expectedRoot, '.hello-cc', 'mesh.db');
  if (!samePath(hccRoot, expectedRoot) || !samePath(hccDb, expectedDb)) {
    fail(`hcc-managed tmux session missing root/db markers: ${session} HCC_ROOT=${hccRoot} HCC_DB=${hccDb}`);
  }
  return session;
}

function parsePane(output) {
  const match = String(output).match(/\bpane=(%\d+)/);
  if (!match) fail(`cannot parse tmux pane from:\n${output}`);
  trackTmuxPane(match[1]);
  return match[1];
}

function envWithoutPeer(extra = {}) {
  const next = { ...env, ...extra };
  delete next.HCC_PEER;
  delete next.HCC_ROOT;
  delete next.HCC_DB;
  return next;
}

function envWithoutProvider(extra = {}) {
  const next = envWithoutPeer();
  for (const key of Object.keys(next)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) delete next[key];
  }
  return { ...next, ...extra };
}

function envAsCodex(extra = {}) {
  const next = envWithoutPeer({
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_THREAD_ID: `codex-thread-${testId}`,
    ...extra
  });
  delete next.CLAUDE_CODE_SESSION_ID;
  delete next.CLAUDECODE;
  return next;
}

function parseSentPeer(output) {
  const match = String(output).match(/^sent message #\d+ (.+) -> /m);
  if (!match) fail(`cannot parse sender from: ${output}`);
  return match[1];
}

function hasTask(rows, taskId) {
  return rows.some((row) => String(row.id) === String(taskId));
}

function hasInstalledHook(config, event) {
  const entries = config?.hooks?.[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((hook) => /\bhcc\.mjs\b.*\bhook\b/.test(String(hook?.command || '')))
  );
}

function hookContext(output, expectedEvent) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`hook output is not JSON:\n${output}`);
  }
  const specific = parsed?.hookSpecificOutput;
  if (specific?.hookEventName !== expectedEvent) {
    fail(`hookEventName mismatch for ${expectedEvent}:\n${output}`);
  }
  return String(specific.additionalContext || '');
}

function ensureFile(file, expected = null) {
  if (!fs.existsSync(file)) fail(`missing file: ${file}`);
  if (expected !== null) {
    const actual = fs.readFileSync(file, 'utf8').trim();
    if (actual !== expected) fail(`unexpected content in ${file}: ${actual}`);
  }
}

function assertGuidanceLockPolicy(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const expected of [
    'Read-only work:',
    'do not require locks',
    'For read-only review, do not acquire file locks',
    'not a final commit-ready verdict',
    'Review and monitoring:',
    "Reviewing another peer's work is a read-only activity",
    'proactively send that',
    'affected file or behavior',
    'Do not silently treat a snapshot review as final approval',
    'Before mutating work:',
    'Before editing or mutating shared resources:',
    'module scope',
    'Locks are coordination signals',
    '--scope db-schema',
    '--scope web-ui',
    'narrower scoped locks',
    'Commit-readiness checks are read-only until staging begins',
    'lock `.git/index` only while staging and'
  ]) {
    if (!text.includes(expected)) fail(`guidance lock policy missing ${expected} in ${file}`);
  }
}

function runtimeUrl(runtime, route, params = {}) {
  const url = new URL(route, runtime.base_url || `http://127.0.0.1:${port}`);
  if (runtime.token) url.searchParams.set('token', runtime.token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function currentRuntime() {
  return JSON.parse(fs.readFileSync(path.join(root, '.hello-cc', 'runtime.json'), 'utf8'));
}

function currentRuntimeUrl(route, params = {}) {
  return runtimeUrl(currentRuntime(), route, params);
}

function runtimeFetch(route, options = {}, params = {}) {
  const runtime = currentRuntime();
  const headers = { ...(options.headers || {}), 'X-HCC-API-Version': '2' };
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  return fetch(runtimeUrl(runtime, route, params), { ...options, headers });
}

function directTlsRequest(runtime, route, options = {}) {
  const url = new URL(route, runtime.base_url);
  const body = options.body === undefined || options.body === null ? null : String(options.body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: options.method || 'GET',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: options.headers || {},
      ca: runtime.tls_cert,
      rejectUnauthorized: true
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('direct TLS regression request timeout')));
    if (body !== null) req.write(body);
    req.end();
  });
}

function nonLoopbackIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function runtimeWsUrl(peer) {
  const runtime = currentRuntime();
  const url = new URL(`/ws/terminal/${encodeURIComponent(peer)}`, runtime.base_url || `http://127.0.0.1:${port}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('api_version', '2');
  return url.toString();
}

// ?token= is no longer accepted on API/WS routes (v1-token-query-csrf-bypass);
// WS clients authenticate with Authorization: Bearer.
function runtimeWsOptions() {
  const runtime = currentRuntime();
  const headers = {};
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  return { headers };
}

async function websocketUpgradeStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, options);
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(null, new Error(`websocket upgrade timeout: ${url}`)), 5000);
    ws.once('open', () => finish(101));
    ws.once('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      res.resume();
      finish(status);
    });
    ws.once('error', (error) => {
      const status = Number(String(error?.message || '').match(/response:\s*(\d+)/i)?.[1]);
      if (status) finish(status);
      else finish(null, error);
    });
  });
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  fail(`timed out waiting for ${label}`);
}

async function waitForFile(file, expected, label = file) {
  await waitFor(() => fs.existsSync(file), label);
  ensureFile(file, expected);
}

async function waitForFileContent(file, expected, label = file) {
  const deadline = Date.now() + 10000;
  let actual = '(missing)';
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      actual = fs.readFileSync(file, 'utf8').trim();
      if (actual === expected) break;
    }
    await sleep(100);
  }
  if (actual !== expected) {
    fail(`timed out waiting for ${label}\nexpected: ${expected}\nactual: ${actual}`);
  }
  ensureFile(file, expected);
}

async function waitForFileLineCount(file, expected, label = file) {
  const deadline = Date.now() + 10000;
  let actual = '(missing)';
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      actual = fs.readFileSync(file, 'utf8').trim();
      const lines = actual.split('\n').filter(Boolean);
      if (lines.length === expected) return;
    }
    await sleep(100);
  }
  const count = actual === '(missing)' ? 0 : actual.split('\n').filter(Boolean).length;
  fail(`timed out waiting for ${label}\nexpected lines: ${expected}\nactual lines: ${count}\nactual: ${actual}`);
}

async function waitRuntime() {
  const runtimeFile = path.join(root, '.hello-cc', 'runtime.json');
  await waitFor(async () => {
    if (!fs.existsSync(runtimeFile)) return false;
    try {
      const response = await runtimeFetch('/api/runtime');
      return response.ok;
    } catch {
      return false;
    }
  }, 'runtime');
}

function assertHtmlCsp(response, html, label) {
  const policy = response.headers.get('content-security-policy') || '';
  const nonce = policy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || '';
  const expected = nonce
    ? "default-src 'self'; " +
      `script-src 'self' 'nonce-${nonce}'; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    : '';
  if (!nonce || policy !== expected) {
    fail(`${label} missing complete nonce CSP: ${policy || '(missing)'}`);
  }
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]));
  if (!inlineScripts.length || inlineScripts.some((match) => !match[1].includes(`nonce="${nonce}"`))) {
    fail(`${label} has an inline script without the response nonce`);
  }
  return nonce;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    // Linux keeps an exited child addressable until PID 1 reaps its zombie.
    // Product liveness treats that state as dead, and the regression wait must
    // use the same semantic boundary instead of waiting forever on kill(0).
    return process.platform !== 'linux' || inspectProcessIdentity(pid).state !== 'dead';
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, label, timeoutMs = 5000) {
  await waitFor(() => !processIsAlive(pid), label, timeoutMs);
}

async function expectWebSocketMarker(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    let sawMarker = false;
    const ws = new WebSocket(runtimeWsUrl(peer), runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} websocket timeout`)), 5000);
    ws.on('open', () => {
      const result = hccMaybe(['inject', peer, `echo ${marker}`]);
      if (result.status !== 0) reject(new Error(result.stderr || result.stdout || 'inject failed'));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') sawSnapshot = true;
      if (['snapshot', 'data', 'replace'].includes(msg.type) && String(msg.data || '').includes(marker)) {
        sawMarker = true;
      }
      if (sawSnapshot && sawMarker) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function openTerminalWebSocket(peer) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(runtimeWsUrl(peer), runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} websocket open timeout`)), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Each terminal connection receives its own action token. Keep the connection
// open while HTTP peer actions use that token; closing it revokes the token.
async function openSessionActionChannel(peer, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(runtimeWsUrl(peer));
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const ws = new WebSocket(url, runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} action token fetch timeout`)), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') {
        clearTimeout(timer);
        resolve({ token: msg.action_token || '', ws });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function fetchSessionActionToken(peer, params = {}) {
  return (await openSessionActionChannel(peer, params)).token;
}

async function closeTerminalWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve();
    }, 2000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try { ws.close(); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function fetchTerminalSnapshot(peer, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(runtimeWsUrl(peer));
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const ws = new WebSocket(url, runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} terminal snapshot timeout`)), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'snapshot') return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(String(msg.data || ''));
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function issueBrowserSessionCookie() {
  const runtime = currentRuntime();
  const baseUrl = runtime.base_url || `http://127.0.0.1:${port}`;
  const response = await fetch(new URL('/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: runtime.token || '' }),
    redirect: 'manual'
  });
  const setCookie = response.headers.get('set-cookie') || '';
  const sid = setCookie.match(/hcc_sid=([^;]+)/)?.[1] || '';
  if (response.status !== 302 || !sid) {
    fail(`browser session login failed: status=${response.status} cookie=${setCookie}`);
  }
  return { baseUrl, origin: new URL(baseUrl).origin, sid };
}

async function cookieRuntimeFetch(route, auth, options = {}, params = {}) {
  const url = new URL(route, auth.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return fetch(url, {
    ...options,
    headers: {
      Cookie: `hcc_sid=${auth.sid}`,
      Origin: auth.origin,
      'X-HCC-API-Version': '2',
      ...(options.headers || {})
    }
  });
}

async function cookieRuntimeFetchWithoutOrigin(route, auth, options = {}, params = {}) {
  const url = new URL(route, auth.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return fetch(url, {
    ...options,
    headers: {
      Cookie: `hcc_sid=${auth.sid}`,
      'X-HCC-API-Version': '2',
      ...(options.headers || {})
    }
  });
}

async function expectSocketMarkerAfter(ws, marker, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal websocket did not show ${marker}`)), 5000);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!['data', 'replace'].includes(message.type) || !String(message.data || '').includes(marker)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve();
    };
    ws.on('message', onMessage);
    Promise.resolve().then(action).catch((err) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(err);
    });
  });
}

async function openCookieTerminalWebSocket(peer, sid, params = {}) {
  const runtime = currentRuntime();
  const baseUrl = runtime.base_url || `http://127.0.0.1:${port}`;
  const url = new URL(`/ws/terminal/${encodeURIComponent(peer)}`, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('api_version', '2');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, {
      headers: {
        Cookie: `hcc_sid=${sid}`,
        Origin: new URL(baseUrl).origin
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error(`${peer} cookie websocket snapshot timeout`));
    }, 5000);
    const rejectBeforeSnapshot = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type !== 'snapshot' || settled) return;
      settled = true;
      clearTimeout(timer);
      ws.hccActionToken = message.action_token || '';
      resolve(ws);
    });
    ws.on('error', rejectBeforeSnapshot);
    ws.on('close', (code) => rejectBeforeSnapshot(new Error(`${peer} cookie websocket closed before snapshot: ${code}`)));
  });
}

async function assertLogoutClosesCookieWebSocket(peer, params = {}) {
  const runtime = currentRuntime();
  const baseUrl = runtime.base_url || `http://127.0.0.1:${port}`;
  const origin = new URL(baseUrl).origin;
  const login = await fetch(new URL('/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: runtime.token || '' }),
    redirect: 'manual'
  });
  const setCookie = login.headers.get('set-cookie') || '';
  const sid = setCookie.match(/hcc_sid=([^;]+)/)?.[1] || '';
  if (login.status !== 302 || !sid) {
    fail(`cookie websocket login failed: status=${login.status} cookie=${setCookie}`);
  }

  const ws = await openCookieTerminalWebSocket(peer, sid, params);
  try {
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${peer} cookie websocket logout close timeout`)), 5000);
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: String(reason || '') });
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const [logout, closeResult] = await Promise.all([
      fetch(new URL('/logout', baseUrl), {
        method: 'POST',
        headers: {
          Cookie: `hcc_sid=${sid}`,
          Origin: origin
        }
      }),
      closed
    ]);
    if (logout.status !== 204 || !(logout.headers.get('set-cookie') || '').includes('Max-Age=0')) {
      fail(`cookie websocket logout did not expire its session: status=${logout.status}`);
    }
    if (closeResult.code !== 4001 || ws.readyState !== WebSocket.CLOSED) {
      fail(`cookie websocket logout did not close the established socket with 4001:\n${JSON.stringify({ closeResult, readyState: ws.readyState }, null, 2)}`);
    }
    const revoked = await fetch(new URL('/api/runtime', baseUrl), {
      headers: { Cookie: `hcc_sid=${sid}`, 'X-HCC-API-Version': '2' }
    });
    if (revoked.status !== 401) {
      fail(`cookie websocket logout left the old cookie authorized: ${revoked.status}`);
    }
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); } catch {}
    }
  }
}

async function assertEvictionClosesCookieWebSocket(peer, params = {}) {
  const auth = await issueBrowserSessionCookie();
  const ws = await openCookieTerminalWebSocket(peer, auth.sid, params);
  try {
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${peer} cookie websocket eviction close timeout`)), 10000);
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: String(reason || '') });
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    for (let offset = 0; offset < 256; offset += 32) {
      await Promise.all(Array.from({ length: 32 }, () => issueBrowserSessionCookie()));
    }
    const closeResult = await closed;
    if (closeResult.code !== 4001 || !closeResult.reason.includes('session limit reached')) {
      fail(`cookie websocket eviction did not close with 4001:\n${JSON.stringify(closeResult, null, 2)}`);
    }
    const revoked = await fetch(new URL('/api/runtime', auth.baseUrl), {
      headers: { Cookie: `hcc_sid=${auth.sid}`, 'X-HCC-API-Version': '2' }
    });
    if (revoked.status !== 401) fail(`evicted cookie remained authorized: ${revoked.status}`);
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); } catch {}
    }
  }
}

async function expectResizeReplaceSnapshot(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    const ws = new WebSocket(runtimeWsUrl(peer), runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} resize replace timeout`)), 5000);
    ws.on('open', () => {
      const result = hccMaybe(['inject', peer, `echo ${marker}`]);
      if (result.status !== 0) reject(new Error(result.stderr || result.stdout || 'inject failed'));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') {
        sawSnapshot = true;
        ws.send(JSON.stringify({ type: 'resize', cols: 96, rows: 28 }));
      }
      if (sawSnapshot && msg.type === 'replace' && String(msg.data || '').includes(marker)) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function expectWebSocketInputVisible(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    let sent = false;
    let sawMarkerAfterInput = false;
    let sawFrameAfterInput = false;
    let actionToken = '';
    const ws = new WebSocket(runtimeWsUrl(peer), runtimeWsOptions());
    const timer = setTimeout(() => reject(new Error(`${peer} websocket input visibility timeout`)), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const data = String(msg.data || '');
      if (msg.type === 'snapshot') {
        sawSnapshot = true;
        if (msg.action_token) actionToken = msg.action_token;
        if (!sent) {
          sent = true;
          ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r`, action_token: actionToken }));
        }
        return;
      }
      if (sent && ['data', 'replace'].includes(msg.type)) {
        sawFrameAfterInput = true;
        if (data.includes(marker)) sawMarkerAfterInput = true;
      }
      if (sawSnapshot && sawFrameAfterInput && sawMarkerAfterInput) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

async function assertTerminalInputTokenRejected(peer, suppliedToken, params = {}, label = 'invalid token') {
  return new Promise((resolve, reject) => {
    const url = new URL(runtimeWsUrl(peer));
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const ws = new WebSocket(url, runtimeWsOptions());
    const rejectedMarker = `REJECTED_${testId}_${Math.random().toString(16).slice(2)}`;
    const acceptedMarker = `ACCEPTED_${testId}_${Math.random().toString(16).slice(2)}`;
    let snapshotToken = '';
    let output = '';
    let checkedRejected = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error(`${peer} ${label} input rejection timeout`));
    }, 6000);
    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      output += String(message.data || '');
      if (message.type === 'snapshot' && !snapshotToken) {
        snapshotToken = message.action_token || '';
        const frame = { type: 'input', data: `echo ${rejectedMarker}\r` };
        if (suppliedToken !== undefined) frame.action_token = suppliedToken;
        ws.send(JSON.stringify(frame));
        setTimeout(() => {
          if (output.includes(rejectedMarker)) {
            finish(new Error(`${peer} accepted ${label} action token`));
            return;
          }
          checkedRejected = true;
          ws.send(JSON.stringify({
            type: 'input',
            data: `echo ${acceptedMarker}\r`,
            action_token: snapshotToken
          }));
        }, 350);
      }
      if (checkedRejected && output.includes(acceptedMarker)) finish();
    });
    ws.on('error', (err) => finish(err));
  });
}

function tmuxStreamNodes() {
  const dir = path.join(root, '.hello-cc', 'bufs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('tmux-') && name.endsWith('.pipe'))
    .map((name) => path.join(dir, name));
}

function libModuleFiles() {
  return fs.readdirSync(path.join(repoRoot, 'lib'))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join('lib', name));
}

function assertShimRuntimeUnavailableFallback(generateShim) {
  const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-shim-fallback-${testId}-`));
  try {
    const fakeHcc = path.join(fallbackDir, 'hcc');
    fs.writeFileSync(fakeHcc, `#!/usr/bin/env bash
case "\${1:-}" in
  shim)
    exit 64
    ;;
  find-root)
    if [ -n "\${HCC_FAKE_ROOT:-}" ]; then
      printf '%s\\n' "$HCC_FAKE_ROOT"
      exit 0
    fi
    exit 1
    ;;
  web)
    exit 1
    ;;
  peer)
    if [ "\${2:-}" = "start" ]; then
      printf '%s\\n' "hcc: No running web runtime found. Start hcc web first, then hcc peer start \${3:-peer}" >&2
      exit 1
    fi
    exit 1
    ;;
esac
exit 1
`, { mode: 0o755 });

    const cases = [
      {
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        args: ['--resume', 'missing-web-session'],
        expected: 'real-claude --resume missing-web-session'
      },
      {
        tool: { name: 'codex', kind: 'codex' },
        args: ['resume', 'missing-web-session'],
        expected: 'real-codex resume missing-web-session'
      }
    ];

    for (const entry of cases) {
      const realBin = path.join(fallbackDir, `real-${entry.tool.name}`);
      const shimBin = path.join(fallbackDir, entry.tool.name);
      const logFile = path.join(fallbackDir, `${entry.tool.name}.log`);
      fs.writeFileSync(realBin, `#!/usr/bin/env bash
printf 'real-${entry.tool.name}'
for arg in "$@"; do printf ' %s' "$arg"; done
printf '\\n'
if [ -n "\${HCC_FAKE_LOG:-}" ]; then
  printf 'real-${entry.tool.name}' >> "$HCC_FAKE_LOG"
  for arg in "$@"; do printf ' %s' "$arg" >> "$HCC_FAKE_LOG"; done
  printf '\\n' >> "$HCC_FAKE_LOG"
fi
`, { mode: 0o755 });
      fs.writeFileSync(shimBin, generateShim(fakeHcc, realBin, entry.tool), { mode: 0o755 });

      const result = runMaybe(shimBin, entry.args, {
        cwd: fallbackDir,
        env: {
          ...env,
          HCC_FAKE_ROOT: fallbackDir,
          HCC_FAKE_LOG: logFile
        }
      });
      if (result.status !== 0) {
        fail(`${entry.tool.name} shim did not fall back when runtime was unavailable:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
      if (!String(result.stdout || '').includes(entry.expected)) {
        fail(`${entry.tool.name} shim fallback did not launch the real provider:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
      const logOutput = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (!logOutput.includes(entry.expected)) {
        fail(`${entry.tool.name} shim fallback did not preserve provider argv:\n${logOutput}`);
      }
      if (String(result.stderr || '').includes('No running web runtime found')) {
        fail(`${entry.tool.name} shim leaked hcc runtime failure instead of transparent fallback:\n${result.stderr}`);
      }
    }
  } finally {
    try { fs.rmSync(fallbackDir, { recursive: true, force: true }); } catch {}
  }
}

function assertGeneratedShimPeerHash(generateShim, providerSessionPeerId) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-shim-peer-hash-${testId}-`));
  try {
    const hashBin = path.join(testDir, 'bin');
    const fakeHcc = path.join(testDir, 'hcc');
    const realBin = path.join(testDir, 'real-provider');
    const opensslLog = path.join(testDir, 'openssl.log');
    const injectionMarker = path.join(testDir, 'argv-command-substitution-ran');
    const specialProviderId = `provider with spaces "double" 'single' $(touch ${injectionMarker})`;
    fs.mkdirSync(hashBin, { recursive: true });
    fs.writeFileSync(fakeHcc, `#!/usr/bin/env bash
case "\${1:-}" in
  find-root)
    printf '%s\\n' "$HCC_FAKE_ROOT"
    exit 0
    ;;
  peer)
    if [ "\${2:-}" = "start" ]; then
      printf '%s\\n' 'hcc: No running web runtime found. Start hcc web first.' >&2
      exit 1
    fi
    ;;
esac
exit 1
`, { mode: 0o755 });
    // Absolute node shebang so the invalid-hash passthrough below can fake a
    // `node` on PATH without hijacking this provider's shebang lookup.
    fs.writeFileSync(realBin, `#!${process.execPath}
process.stdout.write(JSON.stringify({
  peer: process.env.HCC_PEER || null,
  argv: process.argv.slice(2)
}) + '\\n');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(hashBin, 'sha1sum'), '#!/usr/bin/env bash\nexit 97\n', { mode: 0o755 });
    fs.writeFileSync(path.join(hashBin, 'shasum'), '#!/usr/bin/env bash\nexit 97\n', { mode: 0o755 });
    fs.writeFileSync(path.join(hashBin, 'openssl'), `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  const digest = crypto.createHash('sha1').update(input).digest('hex').toUpperCase();
  process.stdout.write('SHA1(stdin)= ' + digest + '\\n');
  fs.appendFileSync(process.env.HCC_OPENSSL_LOG, process.argv.slice(2).join(' ') + '\\t' + input.toString('hex') + '\\n');
});
`, { mode: 0o755 });

    const identityCases = [
      {
        label: 'claude --resume',
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        providerId: '123e4567-e89b-12d3-a456-426614174000',
        args(providerId) { return ['--resume', providerId, 'prompt with spaces', '"quoted"']; },
        extraEnv: {}
      },
      {
        label: 'claude --session-id',
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        providerId: specialProviderId,
        args(providerId) { return ['--session-id', providerId, "'single quoted argument'"]; },
        extraEnv: {}
      },
      {
        label: 'claude CLAUDE_CODE_SESSION_ID',
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        providerId: 'feature-login',
        args() { return ['prompt with spaces', 'literal $(printf not-executed)', '']; },
        extraEnv: { CLAUDE_CODE_SESSION_ID: 'feature-login' }
      },
      {
        label: 'claude --name',
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        providerId: 'feature-logout',
        args(providerId) { return ['--name', providerId, 'semi;colon', 'back\\slash']; },
        extraEnv: {}
      },
      {
        label: 'codex resume',
        tool: { name: 'codex', kind: 'codex' },
        providerId: specialProviderId,
        args(providerId) { return ['resume', providerId, '--model', 'model with spaces', 'literal $(printf not-executed)']; },
        extraEnv: {}
      }
    ];

    for (const [index, entry] of identityCases.entries()) {
      const shimBin = path.join(testDir, `${entry.tool.name}-${index}`);
      fs.writeFileSync(shimBin, generateShim(fakeHcc, realBin, entry.tool), { mode: 0o755 });
      const args = entry.args(entry.providerId);
      const result = runMaybe(shimBin, args, {
        cwd: testDir,
        env: {
          ...env,
          PATH: `${hashBin}${path.delimiter}${env.PATH || ''}`,
          HCC_FAKE_ROOT: testDir,
          HCC_OPENSSL_LOG: opensslLog,
          HCC_SHIM_ENSURED: '1',
          HCC_SHIM_NO_ATTACH: '1',
          CLAUDE_CODE_SESSION_ID: '',
          ...entry.extraEnv
        }
      });
      const expected = providerSessionPeerId(entry.tool.kind, entry.providerId);
      let providerOutput = null;
      try { providerOutput = JSON.parse(String(result.stdout || '').trim()); } catch {}
      if (result.status !== 0 ||
          providerOutput?.peer !== expected ||
          JSON.stringify(providerOutput?.argv) !== JSON.stringify(args)) {
        fail(`${entry.label} generated shim did not preserve the JS identity and argv bytes:\nexpected=${JSON.stringify({ peer: expected, argv: args })}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
    }
    const opensslCalls = fs.existsSync(opensslLog)
      ? fs.readFileSync(opensslLog, 'utf8').trim().split('\n').map((line) => line.split('\t'))
      : [];
    if (opensslCalls.length !== identityCases.length || opensslCalls.some((call, index) =>
      call[0] !== 'dgst -sha1' || call[1] !== Buffer.from(identityCases[index].providerId).toString('hex'))) {
      fail(`generated shims did not hash the full provider id through OpenSSL:\n${JSON.stringify(opensslCalls, null, 2)}`);
    }
    if (fs.existsSync(injectionMarker)) {
      fail('generated shim executed command substitution from a provider id instead of treating it as literal data');
    }

    // A hashing command that exits successfully can still be unusable. Every
    // candidate — including the node fallback — emits a malformed digest here,
    // so strict validation must reject all of them and preserve provider
    // usability with the original argv.
    for (const command of ['openssl', 'sha1sum', 'shasum', 'node']) {
      fs.writeFileSync(path.join(hashBin, command), '#!/usr/bin/env bash\nprintf \'not-a-sha1\\n\'\n', { mode: 0o755 });
    }
    for (const [index, entry] of identityCases.entries()) {
      const shimBin = path.join(testDir, `${entry.tool.name}-${index}-no-hash`);
      fs.writeFileSync(shimBin, generateShim(fakeHcc, realBin, entry.tool), { mode: 0o755 });
      const args = entry.args(entry.providerId);
      const result = runMaybe(shimBin, args, {
        cwd: testDir,
        env: {
          ...env,
          PATH: `${hashBin}${path.delimiter}${env.PATH || ''}`,
          HCC_FAKE_ROOT: testDir,
          HCC_SHIM_ENSURED: '1',
          HCC_SHIM_NO_ATTACH: '1',
          CLAUDE_CODE_SESSION_ID: '',
          ...entry.extraEnv
        }
      });
      let providerOutput = null;
      try { providerOutput = JSON.parse(String(result.stdout || '').trim()); } catch {}
      if (result.status !== 0 ||
          providerOutput?.peer !== null ||
          JSON.stringify(providerOutput?.argv) !== JSON.stringify(args)) {
        fail(`${entry.label} shim did not preserve argv boundaries during invalid-hash passthrough:\nexpected=${JSON.stringify({ peer: null, argv: args })}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
    }
    if (fs.existsSync(injectionMarker)) {
      fail('invalid-hash passthrough executed command substitution from provider argv');
    }

    // Node-fallback path: with every standalone hashing tool emitting a
    // malformed digest (and node NOT faked), the shim must still derive the
    // exact JS peer id through node's crypto — a hello-cc environment always
    // has node on PATH.
    const nodeFallbackBin = path.join(testDir, 'node-fallback-bin');
    fs.mkdirSync(nodeFallbackBin, { recursive: true });
    for (const command of ['openssl', 'sha1sum', 'shasum']) {
      fs.writeFileSync(path.join(nodeFallbackBin, command), '#!/usr/bin/env bash\nprintf \'not-a-sha1\\n\'\n', { mode: 0o755 });
    }
    for (const [index, entry] of identityCases.entries()) {
      const shimBin = path.join(testDir, `${entry.tool.name}-${index}-node-fallback`);
      fs.writeFileSync(shimBin, generateShim(fakeHcc, realBin, entry.tool), { mode: 0o755 });
      const args = entry.args(entry.providerId);
      const result = runMaybe(shimBin, args, {
        cwd: testDir,
        env: {
          ...env,
          PATH: `${nodeFallbackBin}${path.delimiter}${env.PATH || ''}`,
          HCC_FAKE_ROOT: testDir,
          HCC_SHIM_ENSURED: '1',
          HCC_SHIM_NO_ATTACH: '1',
          CLAUDE_CODE_SESSION_ID: '',
          ...entry.extraEnv
        }
      });
      const expected = providerSessionPeerId(entry.tool.kind, entry.providerId);
      let providerOutput = null;
      try { providerOutput = JSON.parse(String(result.stdout || '').trim()); } catch {}
      if (result.status !== 0 || providerOutput?.peer !== expected) {
        fail(`${entry.label} node-fallback shim did not derive the JS identity:\nexpected=${JSON.stringify({ peer: expected })}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
    }
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

async function assertShimIgnoresGlobalRuntime(generateShim) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-shim-global-runtime-${testId}-`));
  const fakeHome = path.join(testDir, 'home');
  const projectRoot = path.join(testDir, 'project-without-runtime');
  const requests = [];
  let server = null;
  try {
    fs.mkdirSync(path.join(fakeHome, '.hello-cc'), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/api/runtime')) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/api/sessions')) {
        res.end(JSON.stringify({ session: {
          id: 'global-runtime-session',
          kind: 'claude',
          role: 'peer',
          status: 'running',
          pane: '%900'
        } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const globalRuntime = {
      product: 'hello-cc',
      version: 'regression',
      pid: process.pid,
      root: testDir,
      db: path.join(testDir, '.hello-cc', 'mesh.db'),
      host: '127.0.0.1',
      port: address.port,
      base_url: `http://127.0.0.1:${address.port}`,
      token: '',
      started_at: Math.floor(Date.now() / 1000),
      global_runtime: true
    };
    fs.writeFileSync(path.join(fakeHome, '.hello-cc', 'runtime.json'), JSON.stringify(globalRuntime, null, 2));

    const hccWrapper = path.join(testDir, 'hcc-wrapper');
    fs.writeFileSync(hccWrapper, `#!/usr/bin/env bash\nexec ${sh(process.execPath)} ${sh(hccBin)} "$@"\n`, { mode: 0o755 });

    const cases = [
      {
        tool: { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
        args: ['--resume', 'global-runtime-session'],
        expected: 'real-claude --resume global-runtime-session'
      },
      {
        tool: { name: 'codex', kind: 'codex' },
        args: ['resume', 'global-runtime-session'],
        expected: 'real-codex resume global-runtime-session'
      }
    ];

    for (const entry of cases) {
      requests.length = 0;
      fs.rmSync(path.join(projectRoot, '.hello-cc'), { recursive: true, force: true });
      const realBin = path.join(testDir, `real-${entry.tool.name}`);
      const shimBin = path.join(testDir, entry.tool.name);
      fs.writeFileSync(realBin, `#!/usr/bin/env bash
printf 'real-${entry.tool.name}'
for arg in "$@"; do printf ' %s' "$arg"; done
printf '\\n'
`, { mode: 0o755 });
      fs.writeFileSync(shimBin, generateShim(hccWrapper, realBin, entry.tool), { mode: 0o755 });
      const result = runMaybe(shimBin, entry.args, {
        cwd: projectRoot,
        env: {
          ...env,
          HOME: fakeHome,
          HCC_SHIM_ENSURED: '1',
          HCC_SHIM_NO_ATTACH: '1'
        }
      });
      if (result.status !== 0) {
        fail(`${entry.tool.name} shim failed while ignoring global runtime:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
      if (!String(result.stdout || '').includes(entry.expected)) {
        fail(`${entry.tool.name} shim used global runtime instead of falling back:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      }
      if (requests.length) {
        fail(`${entry.tool.name} shim contacted global runtime despite project-local restriction:\n${JSON.stringify(requests, null, 2)}`);
      }
      if (fs.existsSync(path.join(projectRoot, '.hello-cc', 'mesh.db'))) {
        fail(`${entry.tool.name} shim created a project database while only a global runtime existed`);
      }
    }
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

async function expectBoundedTmuxStream(label) {
  let nodes = [];
  await waitFor(() => {
    nodes = tmuxStreamNodes();
    return nodes.some((file) => {
      try { return fs.lstatSync(file).isFIFO(); } catch { return false; }
    });
  }, label);
  const bad = nodes.filter((file) => {
    try {
      const stat = fs.lstatSync(file);
      return !stat.isFIFO() || stat.size !== 0;
    } catch {
      return true;
    }
  });
  if (bad.length) fail(`tmux stream used growable regular files:\n${bad.join('\n')}`);
}

function writeFakeTools() {
  fs.mkdirSync(fakeBin, { recursive: true });
  if (realTmuxBin) {
    const tmuxWrapper = path.join(fakeBin, 'tmux');
    fs.writeFileSync(tmuxWrapper, `#!/usr/bin/env bash\nif [ "\${1:-}" = "list-clients" ] && [ -n "\${HCC_REGRESSION_TMUX_FAIL_CLIENT_SESSIONS:-}" ]; then\n  for failed_session in $HCC_REGRESSION_TMUX_FAIL_CLIENT_SESSIONS; do\n    for arg in "$@"; do\n      if [ "$arg" = "$failed_session" ]; then exit 1; fi\n    done\n  done\nfi\nexec ${sh(realTmuxBin)} -L ${sh(tmuxSocketName)} "$@"\n`, { mode: 0o755 });
  }
  for (const name of ['claude', 'codex']) {
    const file = path.join(fakeBin, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho fake-${name} "$@"\nif [ -n "\${HCC_FAKE_LOG:-}" ]; then echo fake-${name} "$@" >> "$HCC_FAKE_LOG"; fi\nif [ "\${HCC_FAKE_STAY_ALIVE:-}" = "1" ]; then exec bash --noprofile --norc; fi\n`, { mode: 0o755 });
  }
}

function startRuntime(options = {}) {
  const runtimeEnv = options.env || env;
  const upOutput = hcc(['up', '--no-discover', '--no-guidance'], { env: runtimeEnv });
  if (!upOutput.includes('local coordination ready')) fail(`hcc up did not report local coordination:\n${upOutput}`);
  if (fs.existsSync(path.join(root, '.hello-cc', 'runtime.json'))) fail('hcc up should not start web runtime');

  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], { env: runtimeEnv });
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  if (!output.includes('web started in background')) fail(`hcc web did not report background start:\n${output}`);
}

async function cookieSessionExpiryWorkflow() {
  const expirySessionId = `cookie-expiry-${testId}`;
  const marker = `EXPIRED_COOKIE_INPUT_${testId}`;
  let ws = null;

  startRuntime({
    env: {
      ...env,
      HCC_REGRESSION_TEST: '1',
      HCC_REGRESSION_WEB_SESSION_TTL_SEC: '1'
    }
  });
  try {
    await waitRuntime();
    const create = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: expirySessionId,
        kind: 'shell',
        backend: 'pty',
        command: 'bash --noprofile --norc',
        env: {
          HOME: home,
          PATH: env.PATH,
          SHELL: '/bin/bash'
        }
      })
    }, { root });
    const created = await create.json();
    if (!create.ok || created.session?.id !== expirySessionId) {
      fail(`short-TTL cookie test could not create its PTY session:\n${JSON.stringify(created, null, 2)}`);
    }

    const auth = await issueBrowserSessionCookie();
    ws = await openCookieTerminalWebSocket(expirySessionId, auth.sid, { root });
    if (!ws.hccActionToken) fail('short-TTL cookie terminal snapshot omitted its action token');
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('expired cookie websocket close timeout')), 5000);
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: String(reason || '') });
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await sleep(1200);
    ws.send(JSON.stringify({
      type: 'input',
      data: `echo ${marker}\r`,
      action_token: ws.hccActionToken
    }));
    const closeResult = await closed;
    if (closeResult.code !== 4001 || !closeResult.reason.includes('session expired')) {
      fail(`expired cookie websocket did not close with 4001/session expired:\n${JSON.stringify(closeResult, null, 2)}`);
    }

    const expiredHttp = await cookieRuntimeFetch('/api/runtime', auth);
    if (expiredHttp.status !== 401) {
      fail(`expired browser cookie remained authorized over HTTP: ${expiredHttp.status}`);
    }
    const snapshot = await fetchTerminalSnapshot(expirySessionId, { root });
    if (snapshot.includes(marker)) {
      fail(`expired browser cookie executed terminal input after expiry:\n${snapshot}`);
    }
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); } catch {}
    }
    try {
      await runtimeFetch(`/api/sessions/${encodeURIComponent(expirySessionId)}/stop`, { method: 'POST' }, { root });
    } catch {}
    await stopRuntime();
  }
}

async function webSecretRedactionWorkflow() {
  const secretParts = [
    `HCC_REDACTION_SECRET_${testId}`,
    crypto.randomBytes(12).toString('hex')
  ];
  const secret = secretParts.join(' ');
  const sessionId = `redaction-session-${testId}`;
  let terminalWs = null;
  const output = hcc([
    'web', '--local', '--port', String(port), '--token', secret,
    '--no-discover', '--no-guidance'
  ]);
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`redaction web did not print background pid`);
  runtimePid = Number.parseInt(match[1], 10);

  try {
    await waitRuntime();
    const runtime = currentRuntime();
    if (runtime.token !== secret) fail('redaction web did not use its explicit test token');

    const login = await fetch(new URL('/login', runtime.base_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secret }),
      redirect: 'manual'
    });
    const sid = (login.headers.get('set-cookie') || '').match(/hcc_sid=([^;]+)/)?.[1] || '';
    if (login.status !== 302 || !sid) fail(`redaction login failed with status ${login.status}`);

    const create = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sessionId,
        kind: 'shell',
        backend: 'pty',
        command: 'bash --noprofile --norc',
        env: { HOME: home, PATH: env.PATH, SHELL: '/bin/bash' }
      })
    }, { root });
    if (!create.ok) fail(`redaction PTY create failed with status ${create.status}`);
    terminalWs = await openCookieTerminalWebSocket(sessionId, sid, { root });
    terminalWs.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));

    const badProject = await fetch(new URL(`/api/projects?token=${encodeURIComponent(secret)}`, runtime.base_url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'X-HCC-API-Version': '2'
      },
      body: JSON.stringify({ root: path.join(os.tmpdir(), `missing-${secret}`) })
    });
    if (badProject.status < 400) fail(`redaction error request unexpectedly returned ${badProject.status}`);

    const invalidCookie = await fetch(new URL('/api/runtime', runtime.base_url), {
      headers: {
        Cookie: `hcc_sid=${secret}`,
        'X-HCC-API-Version': '2'
      }
    });
    if (invalidCookie.status !== 401) fail(`redaction invalid-cookie request returned ${invalidCookie.status}`);

    const errorUrl = new URL('/ws/terminal/%', runtime.base_url);
    errorUrl.protocol = 'ws:';
    errorUrl.searchParams.set('api_version', '2');
    errorUrl.searchParams.set('token', secret);
    await new Promise((resolve) => {
      const ws = new WebSocket(errorUrl, {
        headers: { Authorization: `Bearer ${secret}` }
      });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        resolve();
      }, 2000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.once('error', done);
      ws.once('close', done);
    });
  } finally {
    if (terminalWs && terminalWs.readyState !== WebSocket.CLOSED) {
      try { terminalWs.terminate(); } catch {}
    }
    try {
      await runtimeFetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' }, { root });
    } catch {}
    await stopRuntime();
  }

  const logFile = path.join(root, '.hello-cc', 'web.log');
  const logs = [logFile, `${logFile}.1`]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  if (secretParts.some((part) => logs.includes(part))) {
    fail('Web startup or error logs retained part of the unique redaction secret');
  }
}

async function assertWebWrapperParentSurvives() {
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-reg-wrapper-root-${testId}-`));
  const wrapperPort = port + 101;
  let wrapperPid = null;
  try {
    const script = [
      'set -e',
      `out=$(${sh(process.execPath)} ${sh(hccBin)} --root ${sh(wrapperRoot)} web --local --port ${wrapperPort} --no-discover --no-guidance)`,
      `printf '%s\\n' "$out"`
    ].join('\n');
    const result = runMaybe('bash', ['-lc', script], { env });
    if (result.status !== 0) {
      fail(`hcc web killed or failed inside a wrapper shell:\nstdout=${result.stdout}\nstderr=${result.stderr}\nstatus=${result.status}\nsignal=${result.signal}`);
    }
    const match = String(result.stdout || '').match(/^pid:\s*(\d+)/m);
    if (!match) fail(`wrapper hcc web did not print background pid:\n${result.stdout}`);
    wrapperPid = Number.parseInt(match[1], 10);
    ensureFile(path.join(wrapperRoot, '.hello-cc', 'runtime.json'));
  } finally {
    runMaybe(process.execPath, [hccBin, '--root', wrapperRoot, 'down'], { env });
    if (wrapperPid) {
      try {
        await waitForProcessExit(wrapperPid, 'wrapper runtime process exit', 5000);
      } catch {
        try { process.kill(wrapperPid, 'SIGTERM'); } catch {}
        try { await waitForProcessExit(wrapperPid, 'wrapper runtime process exit after SIGTERM', 2000); } catch {}
      }
    }
    try { fs.rmSync(wrapperRoot, { recursive: true, force: true }); } catch {}
  }
}

async function stopRuntime() {
  if (!runtimePid) return;
  const pid = runtimePid;
  hccMaybe(['down']);
  try {
    await waitForProcessExit(pid, 'runtime process exit', 5000);
  } catch (err) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    try {
      await waitForProcessExit(pid, 'runtime process exit after SIGTERM', 2000);
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { await waitForProcessExit(pid, 'runtime process exit after SIGKILL', 2000); } catch {}
      throw err;
    }
  }
  runtimePid = null;
}

function cleanup() {
  try { hccMaybe(['down']); } catch {}
  if (runtimePid) {
    try { process.kill(runtimePid, 'SIGTERM'); } catch {}
  }
  const managedPrefixes = [
    tmuxManagedSessionPrefix(root),
    tmuxManagedSessionPrefix(secondProjectRoot)
  ];
  for (const endpoint of tmuxCleanupEndpoints()) {
    for (const session of listTmuxSessionsMatching(managedPrefixes, endpoint)) {
      managedTmuxSessions.add(session);
    }
    if (tmuxStarted) {
      killTmuxSessionOnEndpoint(endpoint, tmuxSession);
    }
    for (const session of managedTmuxSessions) {
      killTmuxSessionOnEndpoint(endpoint, session);
    }
  }
  if (fs.existsSync(path.join(fakeBin, 'tmux'))) {
    runMaybe('tmux', ['kill-server']);
  }
  for (const dir of [root, home, fakeBin, outDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function assertNoRealProjectRegistryLeak() {
  const after = fs.existsSync(realRegistryFile)
    ? fs.readFileSync(realRegistryFile, 'utf8')
    : null;
  if (!after) return;

  let parsed = null;
  try {
    parsed = JSON.parse(after);
  } catch {
    fail(`regression changed real project registry with invalid JSON: ${realRegistryFile}`);
  }
  const leakedRoots = (parsed?.projects || [])
    .map((project) => String(project?.root || ''))
    .filter((projectRoot) => {
      if (!projectRoot) return false;
      if (projectRoot === root || projectRoot === home || projectRoot === fakeBin || projectRoot === outDir) return true;
      return projectRoot.startsWith(`${root}${path.sep}`) ||
        projectRoot.startsWith(`${home}${path.sep}`) ||
        projectRoot.startsWith(`${fakeBin}${path.sep}`) ||
        projectRoot.startsWith(`${outDir}${path.sep}`) ||
        projectRoot.includes(`hcc-reg-${testId}`);
    });
  if (leakedRoots.length) {
    fail(`regression leaked temporary projects into real registry ${realRegistryFile}:\n${leakedRoots.join('\n')}`);
  }
}

async function setupRegression() {
  log('[1/13] web bootstrap/hooks/shims');
  writeFakeTools();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.profile'), 'if [ "$BASH" ]; then . "$HOME/.bashrc"; fi\n');
  fs.writeFileSync(path.join(home, '.bashrc'), '# regression rc\n[ -z "$PS1" ] && return\nexport PATH="/late:$PATH"\n');
  // A quiet external session may have old mtimes even while its wrapper is
  // alive. Startup auto-GC must adopt and protect all of its buffer files.
  const liveBufferId = `auto-gc-live-${testId}`;
  const liveBufferDir = path.join(root, '.hello-cc', 'bufs');
  fs.mkdirSync(liveBufferDir, { recursive: true });
  const liveBufferFiles = ['out', 'in', 'resize', 'meta']
    .map((suffix) => path.join(liveBufferDir, `${liveBufferId}.${suffix}`));
  fs.writeFileSync(liveBufferFiles[0], 'quiet but live\n');
  fs.writeFileSync(liveBufferFiles[1], '');
  fs.writeFileSync(liveBufferFiles[2], '');
  fs.writeFileSync(liveBufferFiles[3], JSON.stringify({
    id: liveBufferId,
    kind: 'shell',
    role: 'peer',
    command: 'regression probe',
    cwd: root,
    pid: process.pid,
    wrapper_pid: process.pid,
    child_identity: inspectProcessIdentity(process.pid).identity,
    wrapper_identity: inspectProcessIdentity(process.pid).identity,
    cols: 120,
    rows: 40
  }));
  const oldBufferTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  for (const file of liveBufferFiles) fs.utimesSync(file, oldBufferTime, oldBufferTime);
  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance']);
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid during bootstrap:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  await waitRuntime();
  for (const file of liveBufferFiles) ensureFile(file);
  for (const file of liveBufferFiles) fs.rmSync(file, { force: true });
  ensureFile(path.join(root, '.hello-cc', 'mesh.db'));
  if (fs.existsSync(path.join(root, '.hello-cc', 'HCC.md'))) fail('web --no-guidance should not write HCC.md');
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) fail('web --no-guidance should not write CLAUDE.md');
  if (fs.existsSync(path.join(root, 'AGENTS.md'))) fail('web --no-guidance should not write AGENTS.md');
  ensureFile(path.join(home, '.claude', 'settings.json'));
  ensureFile(path.join(home, '.codex', 'hooks.json'));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse']) {
    if (!hasInstalledHook(claudeHooks, event)) fail(`Claude hook missing ${event}`);
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']) {
    if (!hasInstalledHook(codexHooks, event)) fail(`Codex hook missing ${event}`);
  }
  ensureFile(path.join(home, '.hcc-shims', 'claude'));
  ensureFile(path.join(home, '.hcc-shims', 'codex'));
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  const shimIndex = bashrc.indexOf('.hcc-shims');
  const guardIndex = bashrc.indexOf('[ -z "$PS1" ] && return');
  if (shimIndex < 0 || guardIndex < 0 || shimIndex > guardIndex) {
    fail(`shim PATH was not installed before bash early return:\n${bashrc}`);
  }
  const latePathIndex = bashrc.indexOf('export PATH="/late:$PATH"');
  const lastShimIndex = bashrc.lastIndexOf('.hcc-shims');
  if (latePathIndex < 0 || lastShimIndex < latePathIndex) {
    fail(`shim PATH was not reasserted after late PATH edits:\n${bashrc}`);
  }
  const nonInteractiveCodex = run('bash', ['-lc', 'command -v codex'], { env }).trim();
  if (nonInteractiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`non-interactive bash did not resolve codex shim: ${nonInteractiveCodex}`);
  }
  const interactiveCodex = run('bash', ['-ic', 'command -v codex'], { env }).trim();
  if (interactiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`interactive bash did not keep codex shim first: ${interactiveCodex}`);
  }
  if (!hcc(['install-hooks', '--status']).includes('claude=yes codex=yes')) fail('hooks not installed');
  const shimStatusOutput = hcc(['shim', 'status']);
  if (!shimStatusOutput.includes('claude: installed') ||
      !shimStatusOutput.includes('codex: installed') ||
      !shimStatusOutput.includes('status: complete')) {
    fail(`shims not fully installed:\n${shimStatusOutput}`);
  }
  const staleShim = path.join(home, '.hcc-shims', 'claude');
  fs.writeFileSync(staleShim, '#!/usr/bin/env bash\necho stale --web-managed\n', { mode: 0o755 });
  const ensured = hccMaybe(['shim', 'ensure', 'claude', staleShim]);
  if (ensured.status !== 75) {
    fail(`shim ensure did not request re-exec for stale shim:\n${ensured.stdout}\n${ensured.stderr}`);
  }
  const refreshedShim = fs.readFileSync(staleShim, 'utf8');
  if (!refreshedShim.includes('shim ensure "claude"') || refreshedShim.includes('stale --web-managed')) {
    fail(`shim ensure did not refresh stale shim:\n${refreshedShim}`);
  }
  const deadRealBin = path.join(outDir, 'removed-claude');
  fs.rmSync(deadRealBin, { force: true });
  fs.writeFileSync(staleShim, [
    '#!/usr/bin/env bash',
    '# hello-cc shim for claude (auto-generated; do not edit manually)',
    `# Real binary: ${deadRealBin}`,
    `REAL_BIN=${sh(deadRealBin)}`,
    'exec "$REAL_BIN" "$@"',
    ''
  ].join('\n'), { mode: 0o755 });
  const rediscovered = hccMaybe(['shim', 'ensure', 'claude', staleShim, deadRealBin]);
  if (rediscovered.status !== 75) {
    fail(`shim ensure did not request re-exec for stale real binary:\n${rediscovered.stdout}\n${rediscovered.stderr}`);
  }
  const rediscoveredShim = fs.readFileSync(staleShim, 'utf8');
  const expectedRealBin = path.join(fakeBin, 'claude');
  if (!rediscoveredShim.includes(`# Real binary: ${expectedRealBin}`) || rediscoveredShim.includes(deadRealBin)) {
    fail(`shim ensure preserved stale real binary instead of rediscovering PATH binary:\n${rediscoveredShim}`);
  }
  await stopRuntime();

  const directTlsOutput = hcc(['web', '--local', '--tls', '--port', String(port), '--no-discover', '--no-guidance']);
  const directTlsMatch = directTlsOutput.match(/^pid:\s*(\d+)/m);
  if (!directTlsMatch) fail(`direct TLS web did not print background pid:\n${directTlsOutput}`);
  runtimePid = Number.parseInt(directTlsMatch[1], 10);
  await waitFor(async () => {
    const runtimeFile = path.join(root, '.hello-cc', 'runtime.json');
    if (!fs.existsSync(runtimeFile)) return false;
    try {
      const runtime = currentRuntime();
      const response = await directTlsRequest(runtime, '/api/runtime', {
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          'X-HCC-API-Version': '2'
        }
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }, 'direct TLS runtime');
  const directTlsRuntime = currentRuntime();
  if (directTlsRuntime.tls !== true ||
      !String(directTlsRuntime.base_url || '').startsWith('https://') ||
      !String(directTlsRuntime.tls_cert || '').includes('BEGIN CERTIFICATE')) {
    fail(`direct TLS runtime metadata was incomplete:\n${JSON.stringify(directTlsRuntime, null, 2)}`);
  }
  const directTlsExchange = await directTlsRequest(
    directTlsRuntime,
    `/?token=${encodeURIComponent(directTlsRuntime.token)}`,
    { headers: { Accept: 'text/html' } }
  );
  const directTlsSetCookie = String(directTlsExchange.headers['set-cookie']?.[0] || '');
  const directTlsSid = directTlsSetCookie.match(/hcc_sid=([^;]+)/)?.[1] || '';
  if (directTlsExchange.status !== 302 || !directTlsSid || !directTlsSetCookie.includes('Secure')) {
    fail(`direct TLS login did not issue a Secure cookie: status=${directTlsExchange.status} cookie=${directTlsSetCookie}`);
  }
  const directTlsLogout = await directTlsRequest(directTlsRuntime, '/logout', {
    method: 'POST',
    headers: {
      Cookie: `hcc_sid=${directTlsSid}`,
      Origin: new URL(directTlsRuntime.base_url).origin
    }
  });
  const directTlsLogoutCookie = String(directTlsLogout.headers['set-cookie']?.[0] || '');
  if (directTlsLogout.status !== 204 ||
      !directTlsLogoutCookie.includes('Max-Age=0') ||
      !directTlsLogoutCookie.includes('Secure')) {
    fail(`direct TLS logout did not expire a Secure cookie: status=${directTlsLogout.status} cookie=${directTlsLogoutCookie}`);
  }
  await stopRuntime();

  await assertWebWrapperParentSurvives();
  assertPeerBindingUniqueConstraints();
  assertLegacySchemaMigration();
  assertRegisteredProjectDbMigration();
  assertRegisteredProjectDbMigrationBackupFailure();
  assertFutureSchemaMigrationHistoryRejected();
  assertLegacyBindingRepair();

  const tokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const tokenMatch = tokenOutput.match(/^pid:\s*(\d+)/m);
  if (!tokenMatch) fail(`token web did not print background pid:\n${tokenOutput}`);
  runtimePid = Number.parseInt(tokenMatch[1], 10);
  if (!tokenOutput.includes('token=') || !tokenOutput.includes('open: http://<machine-ip>:')) {
    fail(`default web output did not include remote token URL:\n${tokenOutput}`);
  }
  await waitRuntime();
  const tokenRuntime = currentRuntime();
  if (tokenRuntime.host !== '0.0.0.0' || tokenRuntime.trust_proxy === true || !tokenRuntime.token || tokenRuntime.token.length < 24) {
    fail(`default web runtime did not store remote token data:\n${JSON.stringify(tokenRuntime, null, 2)}`);
  }
  const apiVersionMissing = await fetch(`${tokenRuntime.base_url}/api/runtime`, {
    headers: { Authorization: `Bearer ${tokenRuntime.token}` }
  });
  const apiVersionMissingBody = await apiVersionMissing.json();
  if (apiVersionMissing.status !== 426 ||
      apiVersionMissingBody?.error?.code !== 'API_VERSION_UNSUPPORTED' ||
      apiVersionMissingBody?.error?.supported_version !== 2) {
    fail(`protected API did not reject a missing Runtime API version:\n${JSON.stringify({ status: apiVersionMissing.status, body: apiVersionMissingBody }, null, 2)}`);
  }
  const apiVersionOld = await fetch(`${tokenRuntime.base_url}/api/runtime`, {
    headers: {
      Authorization: `Bearer ${tokenRuntime.token}`,
      'X-HCC-API-Version': '1'
    }
  });
  const apiVersionOldBody = await apiVersionOld.json();
  if (apiVersionOld.status !== 426 || apiVersionOldBody?.error?.code !== 'API_VERSION_UNSUPPORTED') {
    fail(`protected API did not reject Runtime API v1:\n${JSON.stringify({ status: apiVersionOld.status, body: apiVersionOldBody }, null, 2)}`);
  }
  const apiVersionCurrent = await fetch(`${tokenRuntime.base_url}/api/runtime`, {
    headers: {
      Authorization: `Bearer ${tokenRuntime.token}`,
      'X-HCC-API-Version': '2'
    }
  });
  const apiVersionCurrentBody = await apiVersionCurrent.json();
  if (!apiVersionCurrent.ok || apiVersionCurrentBody.api_version !== 2 ||
      !Number.isInteger(tokenRuntime.process_identity?.pid) ||
      !tokenRuntime.process_identity?.startToken ||
      !tokenRuntime.process_identity?.commandHash ||
      apiVersionCurrentBody.pid !== tokenRuntime.pid ||
      apiVersionCurrentBody.process_identity?.pid !== tokenRuntime.process_identity?.pid ||
      apiVersionCurrentBody.process_identity?.startToken !== tokenRuntime.process_identity?.startToken ||
      apiVersionCurrentBody.process_identity?.commandHash !== tokenRuntime.process_identity?.commandHash) {
    fail(`protected API did not accept or advertise Runtime API v2:\n${JSON.stringify({ status: apiVersionCurrent.status, body: apiVersionCurrentBody }, null, 2)}`);
  }
  for (const publicPath of ['/', '/login', '/assets/xterm.css']) {
    const publicResponse = await fetch(new URL(publicPath, tokenRuntime.base_url));
    if (publicResponse.status === 426) fail(`public route unexpectedly required Runtime API v2: ${publicPath}`);
  }
  const indexCspResponse = await fetch(new URL('/', tokenRuntime.base_url));
  const indexCspHtml = await indexCspResponse.text();
  const firstIndexNonce = assertHtmlCsp(indexCspResponse, indexCspHtml, 'web index');
  const secondIndexCspResponse = await fetch(new URL('/', tokenRuntime.base_url));
  const secondIndexCspHtml = await secondIndexCspResponse.text();
  const secondIndexNonce = assertHtmlCsp(secondIndexCspResponse, secondIndexCspHtml, 'second web index');
  if (firstIndexNonce === secondIndexNonce) fail('web index reused its CSP nonce across responses');

  const loginCspResponse = await fetch(new URL('/', tokenRuntime.base_url), {
    headers: { Accept: 'text/html' }
  });
  const loginCspHtml = await loginCspResponse.text();
  assertHtmlCsp(loginCspResponse, loginCspHtml, 'web login');
  const wsProbe = new URL('/ws/terminal/api-version-probe', tokenRuntime.base_url);
  wsProbe.protocol = wsProbe.protocol === 'https:' ? 'wss:' : 'ws:';
  if (await websocketUpgradeStatus(wsProbe) !== 426) {
    fail('WebSocket missing api_version was not rejected before authentication');
  }
  wsProbe.searchParams.set('api_version', '1');
  if (await websocketUpgradeStatus(wsProbe, runtimeWsOptions()) !== 426) {
    fail('WebSocket api_version=1 was not rejected before session lookup');
  }
  wsProbe.searchParams.set('api_version', '2');
  if (await websocketUpgradeStatus(wsProbe, runtimeWsOptions()) !== 404) {
    fail('WebSocket api_version=2 did not proceed to session lookup');
  }

  const unauthorizedResponse = await fetch(`${tokenRuntime.base_url}/api/runtime`, {
    headers: { 'X-HCC-API-Version': '2' }
  });
  if (unauthorizedResponse.status !== 401) fail(`default web API allowed missing token: ${unauthorizedResponse.status}`);
  const tokenResponse = await runtimeFetch('/api/runtime');
  if (!tokenResponse.ok) fail(`default web API rejected runtime token: ${tokenResponse.status}`);

  // net-02: a browser-style navigation with ?token is exchanged once for an
  // HttpOnly SameSite cookie; API/WS then authenticate via that cookie.
  const cookieToken = tokenRuntime.token;
  const baseUrl = tokenRuntime.base_url;
  // (a) browser navigation with ?token → 302 + Set-Cookie (token stripped from URL)
  const exchange = await fetch(`${baseUrl}/?token=${encodeURIComponent(cookieToken)}`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual'
  });
  if (exchange.status !== 302) fail(`browser-nav ?token did not exchange to a cookie redirect: ${exchange.status}`);
  const setCookie = exchange.headers.get('set-cookie') || '';
  if (!setCookie.includes('hcc_sid=') || !setCookie.includes('HttpOnly') || !setCookie.includes('SameSite=Lax')) {
    fail(`exchange did not set an HttpOnly SameSite cookie: ${setCookie}`);
  }
  if (setCookie.includes('Secure')) fail(`plaintext LAN exchange issued a Secure cookie: ${setCookie}`);
  const sidMatch = setCookie.match(/hcc_sid=([^;]+)/);
  if (!sidMatch) fail(`exchange did not return a session id: ${setCookie}`);
  const sid = sidMatch[1];
  // (b) API with the session cookie → 200
  const withCookie = await fetch(`${baseUrl}/api/runtime`, { headers: { Cookie: `hcc_sid=${sid}`, 'X-HCC-API-Version': '2' } });
  if (!withCookie.ok) fail(`API with session cookie required auth: ${withCookie.status}`);
  // (c) API with a bogus session cookie → 401
  const bogusCookie = await fetch(`${baseUrl}/api/runtime`, { headers: { Cookie: 'hcc_sid=bogus', 'X-HCC-API-Version': '2' } });
  if (bogusCookie.status !== 401) fail(`API with bogus session cookie did not 401: ${bogusCookie.status}`);
  // (d) cookie-authenticated writes require an exact same-origin Origin header.
  const crossOriginCookieWrite = await fetch(`${baseUrl}/api/csrf-probe`, {
    method: 'POST',
    headers: {
      Cookie: `hcc_sid=${sid}`,
      Origin: `http://127.0.0.1:${port + 1}`,
      'X-HCC-API-Version': '2',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (crossOriginCookieWrite.status !== 403) {
    fail(`cross-origin cookie write was not rejected: ${crossOriginCookieWrite.status}`);
  }
  const crossOriginCookieBody = await crossOriginCookieWrite.json();
  if (crossOriginCookieBody?.error?.code !== 'CSRF_ORIGIN') {
    fail(`cross-origin cookie write did not return CSRF_ORIGIN:\n${JSON.stringify(crossOriginCookieBody, null, 2)}`);
  }
  const sameOriginCookieWrite = await fetch(`${baseUrl}/api/csrf-probe`, {
    method: 'POST',
    headers: {
      Cookie: `hcc_sid=${sid}`,
      Origin: new URL(baseUrl).origin,
      'X-HCC-API-Version': '2',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (sameOriginCookieWrite.status !== 404) {
    fail(`same-origin cookie write did not pass the CSRF gate: ${sameOriginCookieWrite.status}`);
  }
  // (e) API-style fetch of /?token (Accept: */*) → HTML directly, no redirect
  const apiStyle = await fetch(`${baseUrl}/?token=${encodeURIComponent(cookieToken)}`);
  if (apiStyle.status !== 200 || !(await apiStyle.text()).includes('<html')) {
    fail(`API-style /?token did not serve HTML directly: ${apiStyle.status}`);
  }
  // (f) browser-style bare / with no cookie → login page
  const loginPage = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
  if (loginPage.status !== 200 || !(await loginPage.text()).includes('Access token')) {
    fail(`bare browser navigation did not serve the login page: ${loginPage.status}`);
  }
  // (g) POST /login with the token → 302 + cookie
  const loginPost = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cookieToken }),
    redirect: 'manual'
  });
  if (loginPost.status !== 302 || !(loginPost.headers.get('set-cookie') || '').includes('hcc_sid=')) {
    fail(`POST /login did not issue a session cookie: ${loginPost.status}`);
  }

  // (h) logout revokes the opaque session and expires the browser cookie.
  const logout = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    headers: {
      Cookie: `hcc_sid=${sid}`,
      Origin: new URL(baseUrl).origin
    }
  });
  const logoutCookie = logout.headers.get('set-cookie') || '';
  if (logout.status !== 204 || !logoutCookie.includes('hcc_sid=') || !logoutCookie.includes('Max-Age=0')) {
    fail(`logout did not revoke and expire the session cookie: status=${logout.status} cookie=${logoutCookie}`);
  }
  const revokedCookie = await fetch(`${baseUrl}/api/runtime`, { headers: { Cookie: `hcc_sid=${sid}`, 'X-HCC-API-Version': '2' } });
  if (revokedCookie.status !== 401) fail(`logout left the old session cookie authorized: ${revokedCookie.status}`);

  // (i) trusted loopback reverse-proxy headers mark issued and expired cookies
  // Secure. The same headers are ignored unless --trust-proxy was explicit.
  const proxyOrigin = 'https://public.example.test:9443';
  await stopRuntime();
  const proxyOutput = hcc([
    'web', '--host', '0.0.0.0', '--port', String(port), '--token', cookieToken,
    '--trust-proxy', '--proxy-origin', proxyOrigin, '--no-discover', '--no-guidance'
  ]);
  const proxyPidMatch = proxyOutput.match(/^pid:\s*(\d+)/m);
  if (!proxyPidMatch) fail(`trusted-proxy web did not print background pid:\n${proxyOutput}`);
  runtimePid = Number.parseInt(proxyPidMatch[1], 10);
  await waitRuntime();
  const proxyRuntime = currentRuntime();
  if (proxyRuntime.proxy_origin !== proxyOrigin || proxyRuntime.trust_proxy !== true) {
    fail(`trusted-proxy runtime did not pin its public origin:\n${JSON.stringify(proxyRuntime, null, 2)}`);
  }
  const proxyHeaders = {
    Accept: 'text/html',
    'X-Forwarded-Host': 'public.example.test:9443',
    'X-Forwarded-Proto': 'https'
  };
  const proxyExchange = await fetch(`${baseUrl}/?token=${encodeURIComponent(cookieToken)}`, {
    headers: proxyHeaders,
    redirect: 'manual'
  });
  const proxySetCookie = proxyExchange.headers.get('set-cookie') || '';
  const proxySid = proxySetCookie.match(/hcc_sid=([^;]+)/)?.[1] || '';
  if (proxyExchange.status !== 302 || !proxySid || !proxySetCookie.includes('Secure')) {
    fail(`trusted proxy login did not issue a Secure cookie: status=${proxyExchange.status} cookie=${proxySetCookie}`);
  }
  const proxyLogout = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    headers: {
      Cookie: `hcc_sid=${proxySid}`,
      Origin: proxyOrigin,
      'X-Forwarded-Host': 'public.example.test:9443',
      'X-Forwarded-Proto': 'https'
    }
  });
  const proxyLogoutCookie = proxyLogout.headers.get('set-cookie') || '';
  if (proxyLogout.status !== 204 || !proxyLogoutCookie.includes('Max-Age=0') || !proxyLogoutCookie.includes('Secure')) {
    fail(`trusted proxy logout did not expire a Secure cookie: status=${proxyLogout.status} cookie=${proxyLogoutCookie}`);
  }
  const revokedProxyCookie = await fetch(`${baseUrl}/api/runtime`, { headers: { Cookie: `hcc_sid=${proxySid}`, 'X-HCC-API-Version': '2' } });
  if (revokedProxyCookie.status !== 401) fail(`trusted proxy logout left the old cookie authorized: ${revokedProxyCookie.status}`);

  // A forwarded authority other than the pinned public origin is untrusted.
  const defaultPortProxyHeaders = {
    Accept: 'text/html',
    'X-Forwarded-Host': 'public.example.test:443',
    'X-Forwarded-Proto': 'https'
  };
  const defaultPortProxyExchange = await fetch(`${baseUrl}/?token=${encodeURIComponent(cookieToken)}`, {
    headers: defaultPortProxyHeaders,
    redirect: 'manual'
  });
  const defaultPortProxySetCookie = defaultPortProxyExchange.headers.get('set-cookie') || '';
  if (defaultPortProxyExchange.status !== 403 || defaultPortProxySetCookie) {
    fail(`unpinned proxy authority received a session: status=${defaultPortProxyExchange.status} cookie=${defaultPortProxySetCookie}`);
  }
  const unpinnedProxyLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { ...defaultPortProxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cookieToken }),
    redirect: 'manual'
  });
  if (unpinnedProxyLogin.status !== 403 || unpinnedProxyLogin.headers.get('set-cookie')) {
    fail(`unpinned proxy POST /login received a session: status=${unpinnedProxyLogin.status}`);
  }

  const lanAddress = nonLoopbackIpv4();
  if (lanAddress) {
    const lanBaseUrl = `http://${lanAddress}:${port}`;
    const spoofedLanExchange = await fetch(`${lanBaseUrl}/?token=${encodeURIComponent(cookieToken)}`, {
      headers: {
        Accept: 'text/html',
        'X-Forwarded-Host': 'spoofed.example.test',
        'X-Forwarded-Proto': 'https'
      },
      redirect: 'manual'
    });
    const spoofedLanCookie = spoofedLanExchange.headers.get('set-cookie') || '';
    if (spoofedLanExchange.status !== 403 || spoofedLanCookie) {
      fail(`non-loopback forwarded spoof received a session: status=${spoofedLanExchange.status} cookie=${spoofedLanCookie}`);
    }
  } else {
    log('non-loopback forwarded spoof: no non-loopback IPv4 interface; focused boundary coverage retained');
  }

  await stopRuntime();
  const restoredOutput = hcc([
    'web', '--host', '0.0.0.0', '--port', String(port), '--token', cookieToken,
    '--no-discover', '--no-guidance'
  ]);
  const restoredPidMatch = restoredOutput.match(/^pid:\s*(\d+)/m);
  if (!restoredPidMatch) fail(`post-proxy web did not print background pid:\n${restoredOutput}`);
  runtimePid = Number.parseInt(restoredPidMatch[1], 10);
  await waitRuntime();

  const badJsonResponse = await runtimeFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  });
  if (badJsonResponse.status !== 400) {
    fail(`bad JSON request returned ${badJsonResponse.status}, expected 400:\n${await badJsonResponse.text()}`);
  }
  const badJsonBody = await badJsonResponse.json();
  if (badJsonBody?.error?.code !== 'BAD_REQUEST') {
    fail(`bad JSON request did not return BAD_REQUEST:\n${JSON.stringify(badJsonBody, null, 2)}`);
  }
  const tokenFile = path.join(home, '.hello-cc', 'web-token');
  if (fs.existsSync(tokenFile)) fail('generated web token was persisted outside the runtime pointer');
  const existingTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  if (!existingTokenOutput.includes('web already running in background')) {
    fail(`web did not reuse existing token runtime:\n${existingTokenOutput}`);
  }
  if (fs.existsSync(tokenFile)) fail('reusing a live runtime persisted its generated token');
  await stopRuntime();

  const stableTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const stableTokenMatch = stableTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!stableTokenMatch) fail(`stable-token web did not print background pid:\n${stableTokenOutput}`);
  runtimePid = Number.parseInt(stableTokenMatch[1], 10);
  await waitRuntime();
  const stableTokenRuntime = currentRuntime();
  if (stableTokenRuntime.token === tokenRuntime.token) {
    fail(`default web token was reused across runtime restart:\nfirst=${tokenRuntime.token}\nsecond=${stableTokenRuntime.token}`);
  }
  await stopRuntime();

  const fixedToken = `fixed-token-${testId}`;
  const fixedTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance'], {
    env: { ...env, HCC_WEB_TOKEN: fixedToken }
  });
  const fixedTokenMatch = fixedTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!fixedTokenMatch) fail(`fixed-token web did not print background pid:\n${fixedTokenOutput}`);
  runtimePid = Number.parseInt(fixedTokenMatch[1], 10);
  await waitRuntime();
  const fixedTokenRuntime = currentRuntime();
  if (fixedTokenRuntime.token !== fixedToken || !fixedTokenOutput.includes(`token=${encodeURIComponent(fixedToken)}`)) {
    fail(`explicit stable token was not used:\n${fixedTokenOutput}\n${JSON.stringify(fixedTokenRuntime, null, 2)}`);
  }
  await stopRuntime();

  const postFixedOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const postFixedMatch = postFixedOutput.match(/^pid:\s*(\d+)/m);
  if (!postFixedMatch) fail(`post-fixed-token web did not print background pid:\n${postFixedOutput}`);
  runtimePid = Number.parseInt(postFixedMatch[1], 10);
  await waitRuntime();
  const postFixedRuntime = currentRuntime();
  if (postFixedRuntime.token === fixedToken || fs.existsSync(tokenFile)) {
    fail(`explicit token leaked into a later runtime:\n${JSON.stringify(postFixedRuntime, null, 2)}`);
  }
  await stopRuntime();

  // --no-token is only permitted on a loopback bind (a tokenless writable
  // terminal on a non-loopback address is remotely exploitable).
  const noTokenOutput = hcc(['web', '--local', '--port', String(port), '--no-token', '--no-discover', '--no-guidance']);
  const noTokenMatch = noTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!noTokenMatch) fail(`explicit no-token web did not print background pid:\n${noTokenOutput}`);
  runtimePid = Number.parseInt(noTokenMatch[1], 10);
  if (noTokenOutput.includes('token=')) {
    fail(`explicit no-token web output included token:\n${noTokenOutput}`);
  }
  await waitRuntime();
  const noTokenRuntime = currentRuntime();
  if (noTokenRuntime.token) fail(`explicit no-token runtime stored token:\n${JSON.stringify(noTokenRuntime, null, 2)}`);
  const noTokenResponse = await fetch(`${noTokenRuntime.base_url}/api/runtime`, { headers: { 'X-HCC-API-Version': '2' } });
  if (!noTokenResponse.ok) fail(`explicit no-token web API required token: ${noTokenResponse.status}`);
  await stopRuntime();

  // A tokenless bind to a non-loopback address must be refused outright.
  const exposedNoToken = hccMaybe(['web', '--host', '0.0.0.0', '--port', String(port), '--no-token', '--no-discover', '--no-guidance']);
  if (exposedNoToken.status === 0 || !String(exposedNoToken.stderr || exposedNoToken.stdout).includes('without a token')) {
    fail(`web allowed a tokenless non-loopback bind:\n${exposedNoToken.stdout}\n${exposedNoToken.stderr}`);
  }

  const conflictingToken = hccMaybe(['web', '--local', '--port', String(port), '--token', 'abc', '--no-token', '--no-discover', '--no-guidance']);
  if (conflictingToken.status === 0 || !String(conflictingToken.stderr || conflictingToken.stdout).includes('--no-token cannot be combined')) {
    fail(`web accepted conflicting --token and --no-token:\n${conflictingToken.stdout}\n${conflictingToken.stderr}`);
  }

  const childDir = path.join(root, 'packages', 'child');
  fs.mkdirSync(childDir, { recursive: true });
  const childFindRoot = hccFrom(['find-root'], childDir).trim();
  if (!samePath(childFindRoot, childDir)) fail(`child find-root mismatch: ${childFindRoot} !== ${childDir}`);
  const childStatus = hccFrom(['status'], childDir);
  if (!samePath(statusValue(childStatus, 'root'), childDir) ||
      !samePath(statusValue(childStatus, 'db'), path.join(childDir, '.hello-cc', 'mesh.db'))) {
    fail(`child command did not stay on current path:\n${childStatus}`);
  }
  ensureFile(path.join(childDir, '.hello-cc', 'mesh.db'));
  const explicitChildRoot = hccFrom(['--root', root, 'find-root'], childDir).trim();
  if (!samePath(explicitChildRoot, root)) fail(`explicit child find-root mismatch: ${explicitChildRoot} !== ${root}`);
  const explicitChildStatus = hccFrom(['--root', root, 'status'], childDir);
  if (!samePath(statusValue(explicitChildStatus, 'root'), root) ||
      !samePath(statusValue(explicitChildStatus, 'db'), path.join(root, '.hello-cc', 'mesh.db'))) {
    fail(`explicit child command did not use requested root:\n${explicitChildStatus}`);
  }
  const childHookPayload = JSON.stringify({ session_id: 'child-hook-session', cwd: childDir, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  hccFrom(['hook', 'userpromptsubmit'], childDir, { input: childHookPayload, env: envWithoutPeer({ CODEX_THREAD_ID: 'child-hook-thread' }) });
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  ensureFile(registryFile);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!(registry.projects || []).some((p) => samePath(p.root, childDir))) {
    fail(`hook project was not auto-registered:\n${JSON.stringify(registry, null, 2)}`);
  }

  const joinOut = hcc(['join', '--peer', 'join-a', '--kind', 'codex']);
  if (!joinOut.includes('export HCC_PEER=join-a')) fail(`bad join output: ${joinOut}`);
  const envOut = hcc(['env', '--peer', 'env-a']);
  if (!envOut.includes('export HCC_PEER=env-a')) fail(`bad env output: ${envOut}`);
  run('bash', ['-lc', [
    `eval "$(${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} join --peer eval-a --kind codex)"`,
    'test "$HCC_PEER" = eval-a',
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg send --from "$HCC_PEER" --to "$HCC_PEER" --body eval-ok >/dev/null`,
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg inbox --peer "$HCC_PEER" --all | grep -q eval-ok`
  ].join('; ')]);
}

async function dbWorkflow() {
  log('[3/13] db workflow');
  hcc(['register', '--peer', 'human', '--kind', 'human', '--role', 'operator']);
  const created = hcc(['task', 'create', '--from', 'human', '--to', 'codex-a', '--title', 'full regression task', '--body', 'exercise hcc bus']);
  const taskMatch = created.match(/created task #(\d+):/);
  if (!taskMatch) fail(`cannot parse task id: ${created}`);
  const taskId = taskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-a', '--id', taskId]);
  hcc(['task', 'running', '--peer', 'codex-a', '--id', taskId, '--summary', 'started']);
  const runningTasksForOtherPeer = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (!hasTask(runningTasksForOtherPeer, taskId)) {
    fail(`running task hidden from default list for another peer: #${taskId}`);
  }
  hcc(['lock', 'acquire', '--peer', 'codex-a', '--task', taskId, '--resource', 'src/router', '--ttl', '60', '--reason', 'regression']);
  hcc(['lock', 'renew', '--peer', 'codex-a', '--resource', 'src/router', '--ttl', '60']);

  // hb-06: heartbeat renewal uses the lock's persisted TTL, not its age or
  // the default TTL. Repeated renewals must never compound the expiry.
  const heartbeatPeer = 'heartbeat-ttl-peer';
  const heartbeatResource = 'src/heartbeat-ttl';
  hcc(['lock', 'acquire', '--peer', heartbeatPeer, '--resource', heartbeatResource, '--ttl', '60']);
  const heartbeatCreatedAt = Math.floor(Date.now() / 1000) - 7200;
  withMeshDb((db) => db.prepare('UPDATE locks SET created_at = ? WHERE resource = ?').run(heartbeatCreatedAt, heartbeatResource));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = Math.floor(Date.now() / 1000);
    const output = hcc(['heartbeat', '--peer', heartbeatPeer, '--renew-locks']);
    const after = Math.floor(Date.now() / 1000);
    if (!output.includes('renewed locks: 1')) fail(`heartbeat did not renew the persisted-TTL lock:\n${output}`);
    assertPersistedLockRenewal(heartbeatResource, {
      ttlSec: 60,
      createdAt: heartbeatCreatedAt,
      before,
      after,
      label: `heartbeat attempt ${attempt}`
    });
  }
  const overrideBefore = Math.floor(Date.now() / 1000);
  hcc(['heartbeat', '--peer', heartbeatPeer, '--renew-locks', '--ttl', '75']);
  const overrideAfter = Math.floor(Date.now() / 1000);
  assertPersistedLockRenewal(heartbeatResource, {
    ttlSec: 75,
    createdAt: heartbeatCreatedAt,
    before: overrideBefore,
    after: overrideAfter,
    label: 'heartbeat TTL override'
  });
  const retainedBefore = Math.floor(Date.now() / 1000);
  hcc(['heartbeat', '--peer', heartbeatPeer, '--renew-locks']);
  const retainedAfter = Math.floor(Date.now() / 1000);
  assertPersistedLockRenewal(heartbeatResource, {
    ttlSec: 75,
    createdAt: heartbeatCreatedAt,
    before: retainedBefore,
    after: retainedAfter,
    label: 'heartbeat persisted TTL after override'
  });
  hcc(['lock', 'release', '--peer', heartbeatPeer, '--resource', heartbeatResource]);

  hcc(['msg', 'send', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--body', 'please review']);
  const inbox = hcc(['msg', 'inbox', '--peer', 'claude-a', '--wait', '0']);
  if (!inbox.includes('please review')) fail('inbox did not include message');
  const msgMatch = inbox.match(/^#(\d+)/m);
  if (!msgMatch) fail(`cannot parse message id: ${inbox}`);
  const msgId = msgMatch[1];
  const reply = hcc(['msg', 'reply', '--from', 'claude-a', '--id', msgId, '--body', 'review reply']);
  const replyMatch = reply.match(/sent reply #(\d+) to #(\d+)/);
  if (!replyMatch || replyMatch[2] !== msgId) fail(`cannot parse reply output: ${reply}`);
  const thread = hcc(['msg', 'thread', '--id', msgId]);
  if (!thread.includes(`thread #${msgId}`) || !thread.includes('please review') || !thread.includes('review reply')) {
    fail(`thread output missing original or reply:\n${thread}`);
  }
  const replyInbox = hcc(['msg', 'inbox', '--peer', 'codex-a']);
  if (!replyInbox.includes('review reply') || !replyInbox.includes(`#${msgId}`)) {
    fail(`reply did not reach original sender inbox with thread context:\n${replyInbox}`);
  }
  const stateBeforeAck = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/router']);
  if (stateBeforeAck.automation?.schema_version !== 1 || stateBeforeAck.automation.phase !== 'reply_message') {
    fail(`state automation did not prioritize unread reply:\n${JSON.stringify(stateBeforeAck, null, 2)}`);
  }
  if (stateBeforeAck.automation.next_action.kind !== 'msg.reply' || !stateBeforeAck.automation.next_action.argv.includes(replyMatch[1])) {
    fail(`state next action did not target unread reply:\n${JSON.stringify(stateBeforeAck.automation, null, 2)}`);
  }
  const timelineIds = new Set((stateBeforeAck.timeline || []).map((item) => item.id));
  if (!timelineIds.has(`message:${msgId}`) || !timelineIds.has(`message:${replyMatch[1]}`)) {
    fail(`state timeline missing message thread entries:\n${JSON.stringify(stateBeforeAck.timeline, null, 2)}`);
  }
  if ([...(stateBeforeAck.timeline || [])].some((item) => item.kind === 'message.sent' || item.kind === 'message.ack')) {
    fail(`state timeline includes noisy message events:\n${JSON.stringify(stateBeforeAck.timeline, null, 2)}`);
  }
  hcc(['msg', 'ack', '--peer', 'claude-a', '--id', msgId]);
  hcc(['msg', 'ack', '--peer', 'codex-a', '--id', replyMatch[1]]);
  const stateAfterAck = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/new-lock']);
  if (stateAfterAck.automation.next_action.kind !== 'lock.acquire') {
    fail(`state automation did not suggest lock acquire after ack:\n${JSON.stringify(stateAfterAck.automation, null, 2)}`);
  }
  const readOnlyState = hccJson(['state', '--peer', 'codex-a', '--resource', 'src/read-only', '--intent', 'review']);
  if (readOnlyState.automation.next_action.kind === 'lock.acquire' || readOnlyState.automation.phase === 'acquire_lock') {
    fail(`read-only state suggested acquiring a lock:\n${JSON.stringify(readOnlyState.automation, null, 2)}`);
  }
  if (!(readOnlyState.automation.warnings || []).some((warning) => warning.includes('read-only'))) {
    fail(`read-only state did not explain no-lock behavior:\n${JSON.stringify(readOnlyState.automation, null, 2)}`);
  }
  const queuedTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-a', '--title', 'queued while busy']);
  const queuedTaskMatch = queuedTask.match(/created task #(\d+):/);
  if (!queuedTaskMatch) fail(`cannot parse queued task id: ${queuedTask}`);
  const queuedTaskId = queuedTaskMatch[1];
  const busyState = hccJson(['state', '--peer', 'codex-a']);
  if (String(busyState.automation.current_task?.id) !== String(taskId)) {
    fail(`state did not preserve current task while another task was assigned:\n${JSON.stringify(busyState.automation, null, 2)}`);
  }
  if (['task.claim', 'task.next', 'msg.inbox'].includes(busyState.automation.next_action.kind)) {
    fail(`state let a new assigned task interrupt current work:\n${JSON.stringify(busyState.automation, null, 2)}`);
  }
  const busyHookPayload = JSON.stringify({ session_id: 'codex-busy-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'new user prompt while busy' });
  const busyHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: { ...env, HCC_PEER: 'codex-a' }, input: busyHookPayload }), 'UserPromptSubmit');
  if (!busyHook.includes('[hello-cc current task]') || !busyHook.includes(`#${taskId} running`)) {
    fail(`hook did not preserve current task while another task was assigned:\n${busyHook}`);
  }
  if (busyHook.includes(`hcc task claim --peer codex-a --id ${queuedTaskId}`)) {
    fail(`hook suggested claiming a new task while current task was active:\n${busyHook}`);
  }
  const nextAgain = hcc(['task', 'next', '--peer', 'codex-a']);
  if (!nextAgain.includes(`current task #${taskId}`)) {
    fail(`task next did not preserve current task:\n${nextAgain}`);
  }
  const nextAgainJson = hccJson(['task', 'next', '--peer', 'codex-a']);
  if (String(nextAgainJson.id) !== String(taskId) || nextAgainJson.current !== true || nextAgainJson.tasks) {
    fail(`task next --json current task shape changed:\n${JSON.stringify(nextAgainJson, null, 2)}`);
  }
  const batchClaimIds = [];
  for (const title of ['batch claim one', 'batch claim two']) {
    const out = hcc(['task', 'create', '--from', 'human', '--title', title]);
    const match = out.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse batch task id: ${out}`);
    batchClaimIds.push(match[1]);
  }
  const batchClaim = hccJson(['task', 'claim', '--peer', 'batch-a', '--ids', batchClaimIds.join(',')]);
  if (!Array.isArray(batchClaim) || batchClaim.length !== 2 || !batchClaim.every((task) => task.owner === 'batch-a')) {
    fail(`batch claim did not claim both tasks:\n${JSON.stringify(batchClaim, null, 2)}`);
  }
  for (const task of batchClaim) {
    hcc(['task', 'done', '--peer', 'batch-a', '--id', String(task.id), '--summary', 'batch claim cleanup']);
  }
  const batchNextIds = [];
  for (const title of ['batch next one', 'batch next two', 'batch next three']) {
    const out = hcc(['task', 'create', '--from', 'human', '--title', title]);
    const match = out.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse batch next task id: ${out}`);
    batchNextIds.push(match[1]);
  }
  const batchNext = hccJson(['task', 'next', '--peer', 'batch-b', '--force', '--count', '2']);
  if (!batchNext?.tasks || batchNext.tasks.length !== 2 || !batchNext.tasks.every((task) => task.owner === 'batch-b')) {
    fail(`task next --count did not claim two tasks:\n${JSON.stringify(batchNext, null, 2)}`);
  }
  for (const task of batchNext.tasks) {
    hcc(['task', 'done', '--peer', 'batch-b', '--id', String(task.id), '--summary', 'batch next cleanup']);
  }
  hcc(['task', 'update', '--peer', 'human', '--id', batchNextIds[2], '--status', 'abandoned', '--summary', 'batch next leftover cleanup']);

  for (const status of ['running', 'review', 'blocked', 'abandoned']) {
    const peer = `shortcut-${status}`;
    const out = hcc(['task', 'create', '--from', 'human', '--to', peer, '--title', `shortcut ${status}`]);
    const match = out.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse shortcut task id: ${out}`);
    const shortcutTaskId = match[1];
    hcc(['task', 'claim', '--peer', peer, '--id', shortcutTaskId]);
    hcc(['task', status, '--peer', peer, '--id', shortcutTaskId, '--summary', `${status} shortcut`]);
    const row = hccJson(['task', 'list', '--all']).find((task) => String(task.id) === String(shortcutTaskId));
    if (!row || row.status !== status) {
      fail(`task ${status} shortcut did not set status ${status}:\n${JSON.stringify(row, null, 2)}`);
    }
    if (!['done', 'abandoned'].includes(status)) {
      hcc(['task', 'done', '--peer', peer, '--id', shortcutTaskId, '--summary', `${status} shortcut cleanup`]);
    }
  }

  const dispatched = hccJson(['task', 'dispatch', '--from', 'human', '--to', 'dispatch-a', '--title', 'dispatch new task', '--body', 'dispatch body', '--no-inject']);
  if (!dispatched.task || dispatched.task.assignee !== 'dispatch-a' || dispatched.task.owner ||
      dispatched.injected !== false || dispatched.injection_reason !== 'no_inject' || !dispatched.message_id) {
    fail(`task dispatch did not create message-only assigned task:\n${JSON.stringify(dispatched, null, 2)}`);
  }
  const dispatchInbox = hcc(['msg', 'inbox', '--peer', 'dispatch-a', '--all']);
  if (!dispatchInbox.includes(`task #${dispatched.task.id}`) || !dispatchInbox.includes('dispatch new task')) {
    fail(`task dispatch durable message missing:\n${dispatchInbox}`);
  }
  const dispatchAudit = eventPayloads('task.dispatched', 20)
    .find((event) => Number(event.payload?.message_id) === Number(dispatched.message_id));
  if (!dispatchAudit ||
      dispatchAudit.actor !== 'human' ||
      dispatchAudit.payload.actor_peer !== 'human' ||
      dispatchAudit.payload.target_peer !== 'dispatch-a' ||
      dispatchAudit.payload.source !== 'cli' ||
      dispatchAudit.payload.injected !== false ||
      dispatchAudit.payload.injection_reason !== 'no_inject') {
    fail(`task dispatch audit payload wrong:\n${JSON.stringify(dispatchAudit, null, 2)}`);
  }
  const dispatchExistingCreated = hcc(['task', 'create', '--from', 'human', '--title', 'dispatch existing task']);
  const dispatchExistingMatch = dispatchExistingCreated.match(/created task #(\d+):/);
  if (!dispatchExistingMatch) fail(`cannot parse dispatch existing task id: ${dispatchExistingCreated}`);
  const dispatchExisting = hccJson(['task', 'dispatch', '--from', 'human', '--to', 'dispatch-b', '--id', dispatchExistingMatch[1], '--message', 'custom dispatch existing', '--no-inject']);
  if (String(dispatchExisting.task?.id) !== dispatchExistingMatch[1] ||
      dispatchExisting.task.assignee !== 'dispatch-b' ||
      dispatchExisting.message !== 'custom dispatch existing' ||
      dispatchExisting.injected !== false) {
    fail(`task dispatch --id did not assign existing task:\n${JSON.stringify(dispatchExisting, null, 2)}`);
  }

  const takeoverOpen = hcc(['task', 'create', '--from', 'human', '--to', 'takeover-owner', '--title', 'takeover open']);
  const takeoverOpenMatch = takeoverOpen.match(/created task #(\d+):/);
  if (!takeoverOpenMatch) fail(`cannot parse takeover open id: ${takeoverOpen}`);
  const takeoverOpenId = takeoverOpenMatch[1];
  hcc(['task', 'claim', '--peer', 'takeover-owner', '--id', takeoverOpenId]);
  const blockedPolicyReject = hccMaybe(['task', 'takeover', '--peer', 'takeover-a', '--id', takeoverOpenId, '--reason', 'blocked policy smoke', '--policy', 'blocked']);
  if (blockedPolicyReject.status === 0 || !String(blockedPolicyReject.stderr || blockedPolicyReject.stdout).includes('does not match takeover policy blocked')) {
    fail(`takeover --policy blocked accepted non-blocked task:\n${blockedPolicyReject.stdout}\n${blockedPolicyReject.stderr}`);
  }
  hcc(['task', 'update', '--peer', 'takeover-owner', '--id', takeoverOpenId, '--status', 'blocked', '--summary', 'blocked for takeover smoke']);
  const blockedTakeover = hccJson(['task', 'takeover', '--peer', 'takeover-a', '--id', takeoverOpenId, '--reason', 'blocked takeover smoke', '--policy', 'blocked']);
  if (String(blockedTakeover.owner) !== 'takeover-a') {
    fail(`blocked takeover did not transfer owner:\n${JSON.stringify(blockedTakeover, null, 2)}`);
  }
  hcc(['task', 'done', '--peer', 'takeover-a', '--id', takeoverOpenId, '--summary', 'blocked takeover cleanup']);
  const staleOut = hcc(['task', 'create', '--from', 'human', '--to', 'stale-owner', '--title', 'stale takeover']);
  const staleMatch = staleOut.match(/created task #(\d+):/);
  if (!staleMatch) fail(`cannot parse stale takeover id: ${staleOut}`);
  const staleTaskId = staleMatch[1];
  hcc(['task', 'claim', '--peer', 'stale-owner', '--id', staleTaskId]);
  withMeshDb((db) => {
    const staleAt = Math.floor(Date.now() / 1000) - 7200;
    db.prepare(`
      UPDATE peers
      SET pid = NULL, pid_start_token = NULL, pid_command_hash = NULL, last_seen_at = ?
      WHERE id = ?
    `).run(staleAt, 'stale-owner');
    // This fixture tests ordinary stale policy, not an unconsumed wall-clock
    // interval. Establish that the backdated state has already been observed.
    db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
  });
  const staleTakeover = hccJson(['task', 'takeover', '--peer', 'takeover-b', '--id', staleTaskId, '--reason', 'stale takeover smoke', '--policy', 'stale', '--stale-after', '60']);
  if (String(staleTakeover.owner) !== 'takeover-b') {
    fail(`stale takeover did not transfer owner:\n${JSON.stringify(staleTakeover, null, 2)}`);
  }
  const takeoverInbox = hcc(['msg', 'inbox', '--peer', 'stale-owner', '--all']);
  if (!takeoverInbox.includes(`Task #${staleTaskId} taken over by takeover-b`)) {
    fail(`stale takeover did not notify previous owner:\n${takeoverInbox}`);
  }
  hcc(['task', 'done', '--peer', 'takeover-b', '--id', staleTaskId, '--summary', 'stale takeover cleanup']);
  const staleLivenessOut = hcc(['task', 'create', '--from', 'human', '--to', 'stale-liveness-owner', '--title', 'stale liveness task']);
  const staleLivenessMatch = staleLivenessOut.match(/created task #(\d+):/);
  if (!staleLivenessMatch) fail(`cannot parse stale liveness task id: ${staleLivenessOut}`);
  const staleLivenessTaskId = staleLivenessMatch[1];
  hcc(['task', 'claim', '--peer', 'stale-liveness-owner', '--id', staleLivenessTaskId]);
  withMeshDb((db) => {
    const staleAt = Math.floor(Date.now() / 1000) - 7200;
    db.prepare(`
      UPDATE peers
      SET pid = NULL, pid_start_token = NULL, pid_command_hash = NULL, last_seen_at = ?
      WHERE id = ?
    `).run(staleAt, 'stale-liveness-owner');
  });
  const staleLivenessList = hcc(['task', 'list', '--status', 'claimed']);
  if (!staleLivenessList.includes(`#${staleLivenessTaskId}`) || !staleLivenessList.includes('stale/no-lock')) {
    fail(`task list did not surface stale/no-lock owner state:\n${staleLivenessList}`);
  }
  const staleLivenessState = hccJson(['state', '--peer', 'takeover-ready-peer']);
  if (staleLivenessState.automation?.phase !== 'takeover_task' ||
      staleLivenessState.automation?.next_action?.kind !== 'task.takeover' ||
      !staleLivenessState.automation.next_action.argv.includes('--policy') ||
      !staleLivenessState.automation.next_action.argv.includes('stale')) {
    fail(`state automation did not suggest stale takeover:\n${JSON.stringify(staleLivenessState.automation, null, 2)}`);
  }
  hcc(['task', 'takeover', '--peer', 'human', '--id', staleLivenessTaskId, '--reason', 'stale liveness cleanup', '--policy', 'stale', '--stale-after', '60']);
  hcc(['task', 'update', '--peer', 'human', '--id', staleLivenessTaskId, '--status', 'abandoned', '--summary', 'stale liveness cleanup']);
  hcc(['task', 'update', '--peer', 'human', '--id', queuedTaskId, '--status', 'abandoned', '--summary', 'queued task cleanup']);
  hcc(['handoff', 'create', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--summary', 'handoff summary', '--tests', 'full script', '--risks', 'none']);
  if (!hcc(['handoff', 'list', '--task', taskId]).includes('handoff summary')) fail('handoff missing');
  const stateAfterHandoff = hccJson(['state', '--peer', 'claude-a']);
  if (!(stateAfterHandoff.timeline || []).some((item) => item.id.startsWith('handoff:') && item.text.includes('handoff summary'))) {
    fail(`state timeline missing handoff item:\n${JSON.stringify(stateAfterHandoff.timeline, null, 2)}`);
  }
  if ((stateAfterHandoff.timeline || []).some((item) => item.kind === 'handoff.created')) {
    fail(`state timeline includes noisy handoff event:\n${JSON.stringify(stateAfterHandoff.timeline, null, 2)}`);
  }
  if (!hcc(['status', '--peer', 'codex-a']).includes('codex-a')) fail('status missing peer');
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'src/router']);
  hcc(['task', 'done', '--peer', 'codex-a', '--id', taskId, '--summary', 'done']);
  const doneDefaultTasks = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (hasTask(doneDefaultTasks, taskId)) fail(`done task still shown in default list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--all']), taskId)) fail(`done task missing from --all list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--status', 'done']), taskId)) fail(`done task missing from --status done list: #${taskId}`);

  const teamParent = hcc([
    'task', 'create',
    '--from', 'human',
    '--to', 'codex-team-captain',
    '--title', 'parallel release cleanup',
    '--body', '- Update docs\n- Add regression\n- Verify migration'
  ]);
  const teamParentMatch = teamParent.match(/created task #(\d+):/);
  if (!teamParentMatch) fail(`cannot parse team parent id: ${teamParent}`);
  const teamParentId = teamParentMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-team-captain', '--id', teamParentId]);
  hcc(['task', 'update', '--peer', 'codex-team-captain', '--id', teamParentId, '--status', 'running', '--summary', 'team captain']);
  const teamState = hccJson(['state', '--peer', 'codex-team-captain']);
  if (teamState.automation.phase !== 'team_plan' || teamState.automation.next_action.kind !== 'team.plan') {
    fail(`state did not suggest team plan for splittable task:\n${JSON.stringify(teamState.automation, null, 2)}`);
  }
  const teamPlan = hcc(['team', 'plan', '--from-task', teamParentId, '--item', 'docs:Update docs', '--item', 'tests:Add regression', '--workers', 'codex-worker-a,claude-worker-a']);
  if (!teamPlan.includes('team plan for task') || !teamPlan.includes('Update docs')) {
    fail(`team plan output wrong:\n${teamPlan}`);
  }
  const kindWorkerPlan = hcc(['team', 'plan', '--from-task', teamParentId, '--item', 'docs:Docs slot', '--item', 'tests:Tests slot', '--workers', 'codex:2']);
  if (!kindWorkerPlan.includes(`codex-team-${teamParentId}-1`) || !kindWorkerPlan.includes(`codex-team-${teamParentId}-2`)) {
    fail(`team workers kind-count syntax was not expanded:\n${kindWorkerPlan}`);
  }
  const childrenBeforeStart = withMeshDb((db) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?').get(teamParentId).n);
  if (childrenBeforeStart !== 0) fail(`team plan created children: ${childrenBeforeStart}`);
  const teamStart = hccJson(['team', 'start', '--from', 'codex-team-captain', '--from-task', teamParentId, '--item', 'docs:Update docs', '--item', 'tests:Add regression', '--workers', 'codex-worker-a,claude-worker-a']);
  if (teamStart.children.length !== 2) {
    fail(`team start created wrong child count:\n${JSON.stringify(teamStart, null, 2)}`);
  }
  const teamRows = withMeshDb((db) => db.prepare(`
    SELECT id, title, assignee, parent_id, team_role
    FROM tasks
    WHERE parent_id = ?
    ORDER BY id
  `).all(teamParentId));
  if (teamRows.length !== 2 ||
      teamRows[0].assignee !== 'codex-worker-a' ||
      teamRows[1].assignee !== 'claude-worker-a' ||
      teamRows.some((row) => String(row.parent_id) !== String(teamParentId) || !row.team_role)) {
    fail(`team child rows wrong:\n${JSON.stringify(teamRows, null, 2)}`);
  }
  const duplicateTeamStart = hccMaybe(['team', 'start', '--from-task', teamParentId]);
  if (duplicateTeamStart.status === 0 || !String(duplicateTeamStart.stderr || duplicateTeamStart.stdout).includes('already has')) {
    fail(`duplicate team start was not rejected:\n${duplicateTeamStart.stdout}\n${duplicateTeamStart.stderr}`);
  }
  const teamStatus = hcc(['team', 'status', '--task', teamParentId]);
  if (!teamStatus.includes('subtasks: 2') || !teamStatus.includes('codex-worker-a')) {
    fail(`team status output wrong:\n${teamStatus}`);
  }
  for (const row of teamRows) {
    hcc(['task', 'update', '--peer', 'human', '--force', '--id', String(row.id), '--status', 'abandoned', '--summary', 'team regression cleanup']);
  }
  hcc(['task', 'done', '--peer', 'codex-team-captain', '--id', teamParentId, '--summary', 'team regression done']);

  const scopedA = hcc(['lock', 'acquire', '--peer', 'codex-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema', '--ttl', '60', '--reason', 'db split']);
  const scopedB = hcc(['lock', 'acquire', '--peer', 'codex-b', '--resource', 'bin/hcc.mjs', '--scope', 'web-ui', '--ttl', '60', '--reason', 'ui split']);
  if (!scopedA.includes('bin/hcc.mjs [db-schema]') || !scopedB.includes('bin/hcc.mjs [web-ui]')) {
    fail(`scoped lock output missing labels:\n${scopedA}\n${scopedB}`);
  }
  const scopedRows = hccJson(['lock', 'list']);
  if (!scopedRows.some((row) => row.base_resource === 'bin/hcc.mjs' && row.scope === 'db-schema') ||
      !scopedRows.some((row) => row.base_resource === 'bin/hcc.mjs' && row.scope === 'web-ui')) {
    fail(`scoped locks missing from list:\n${JSON.stringify(scopedRows, null, 2)}`);
  }
  const duplicateScope = hccMaybe(['lock', 'acquire', '--peer', 'claude-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema', '--ttl', '60', '--reason', 'same scope']);
  if (duplicateScope.status === 0 || !`${duplicateScope.stdout}\n${duplicateScope.stderr}`.includes('conflicts with lock bin/hcc.mjs [db-schema]')) {
    fail(`same-scope lock was not rejected:\n${duplicateScope.stdout}\n${duplicateScope.stderr}`);
  }
  const wholeResource = hccMaybe(['lock', 'acquire', '--peer', 'claude-a', '--resource', 'bin/hcc.mjs', '--ttl', '60', '--reason', 'whole file']);
  if (wholeResource.status === 0 || !`${wholeResource.stdout}\n${wholeResource.stderr}`.includes('conflicts with lock bin/hcc.mjs [db-schema]')) {
    fail(`whole-resource lock did not conflict with scoped locks:\n${wholeResource.stdout}\n${wholeResource.stderr}`);
  }
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'bin/hcc.mjs', '--scope', 'db-schema']);
  hcc(['lock', 'release', '--peer', 'codex-b', '--resource', 'bin/hcc.mjs', '--scope', 'web-ui']);

  const conflictTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-b', '--title', 'conflict automation task']);
  const conflictTaskMatch = conflictTask.match(/created task #(\d+):/);
  if (!conflictTaskMatch) fail(`cannot parse conflict task id: ${conflictTask}`);
  const conflictTaskId = conflictTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-b', '--id', conflictTaskId]);
  hcc(['lock', 'acquire', '--peer', 'codex-a', '--resource', 'src/conflict', '--ttl', '60', '--reason', 'held by other peer']);
  const conflictState = hccJson(['state', '--peer', 'codex-b', '--resource', 'src/conflict']);
  if (conflictState.automation.phase !== 'coordinate_lock' || conflictState.automation.next_action.kind !== 'msg.send') {
    fail(`state automation did not suggest lock coordination:\n${JSON.stringify(conflictState.automation, null, 2)}`);
  }
  if (conflictState.automation.next_action.argv.includes('--force')) {
    fail(`state automation suggested forcing a lock:\n${JSON.stringify(conflictState.automation, null, 2)}`);
  }
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'src/conflict']);
  hcc(['task', 'done', '--peer', 'codex-b', '--id', conflictTaskId, '--summary', 'conflict done']);

  const takeoverTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-owner', '--title', 'takeover regression task']);
  const takeoverTaskMatch = takeoverTask.match(/created task #(\d+):/);
  if (!takeoverTaskMatch) fail(`cannot parse takeover task id: ${takeoverTask}`);
  const takeoverTaskId = takeoverTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-owner', '--id', takeoverTaskId]);
  // Default takeover policy is now blocked-or-stale: an active owner's task
  // must not be taken over silently (hb-07/conc-04). codex-owner just claimed,
  // so it is active and the default takeover must be rejected.
  const rejectedTakeover = hccMaybe(['task', 'takeover', '--peer', 'codex-taker', '--id', takeoverTaskId, '--reason', 'owner active']);
  if (rejectedTakeover.status === 0 || !String(rejectedTakeover.stderr || rejectedTakeover.stdout).includes('does not match takeover policy')) {
    fail(`default takeover was not rejected against an active owner:\n${rejectedTakeover.stdout}\n${rejectedTakeover.stderr}`);
  }
  // --force restores unconditional takeover of an active owner's task.
  const takeoverOutput = hcc(['task', 'takeover', '--peer', 'codex-taker', '--id', takeoverTaskId, '--reason', 'forced', '--force']);
  if (!takeoverOutput.includes(`took over task #${takeoverTaskId}`)) fail(`takeover output wrong:\n${takeoverOutput}`);
  const takeoverRow = hccJson(['task', 'list', '--all']).find((row) => String(row.id) === String(takeoverTaskId));
  if (!takeoverRow || takeoverRow.owner !== 'codex-taker' || takeoverRow.status !== 'claimed') {
    fail(`takeover task row wrong:\n${JSON.stringify(takeoverRow, null, 2)}`);
  }
  const takeoverOwnerInbox = hcc(['msg', 'inbox', '--peer', 'codex-owner']);
  if (!takeoverOwnerInbox.includes(`Task #${takeoverTaskId} taken over by codex-taker`)) {
    fail(`takeover did not notify previous owner:\n${takeoverOwnerInbox}`);
  }
  hcc(['task', 'done', '--peer', 'codex-taker', '--id', takeoverTaskId, '--summary', 'takeover done']);

  // hb-05: a persisted clock grace window (written by the runtime after a
  // wall-clock jump) suppresses age-based staleness — a genuinely old owner is
  // NOT stale during grace, so `takeover --policy stale` must be rejected.
  const graceDbPath = path.join(root, '.hello-cc', 'mesh.db');
  const graceNow = Math.floor(Date.now() / 1000);
  const graceTask = hcc(['task', 'create', '--from', 'human', '--to', 'grace-owner', '--title', 'clock grace task']);
  const graceTaskMatch = graceTask.match(/created task #(\d+):/);
  if (!graceTaskMatch) fail(`cannot parse grace task id: ${graceTask}`);
  const graceTaskId = graceTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'grace-owner', '--id', graceTaskId]);
  // Make the owner old by age (would normally be stale) for a baseline.
  const graceDb = new DatabaseSync(graceDbPath, { timeout: 5000 });
  graceDb.exec('PRAGMA foreign_keys = ON;');
  graceDb.prepare(`
    UPDATE peers
    SET pid = NULL, pid_start_token = NULL, pid_command_hash = NULL, last_seen_at = ?
    WHERE id = ?
  `).run(graceNow - 1000, 'grace-owner');
  graceDb.close();
  const graceBaseline = hccMaybe(['task', 'takeover', '--peer', 'grace-taker', '--id', graceTaskId, '--reason', 'baseline', '--policy', 'stale']);
  if (graceBaseline.status !== 0 || !graceBaseline.stdout.includes('took over task')) {
    fail(`grace baseline: stale owner should be takeable without grace:\n${graceBaseline.stdout}\n${graceBaseline.stderr}`);
  }
  // Give the task back, re-age the owner (takeover refreshes last_seen_at),
  // and set the grace window → takeover must be rejected.
  hcc(['task', 'takeover', '--peer', 'grace-owner', '--id', graceTaskId, '--reason', 'give back', '--force']);
  const graceDb2 = new DatabaseSync(graceDbPath, { timeout: 5000 });
  graceDb2.exec('PRAGMA foreign_keys = ON;');
  graceDb2.prepare(`
    UPDATE peers
    SET pid = NULL, pid_start_token = NULL, pid_command_hash = NULL, last_seen_at = ?
    WHERE id = ?
  `).run(graceNow - 1000, 'grace-owner');
  graceDb2.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(graceNow + 60));
  graceDb2.close();
  const graceRejected = hccMaybe(['task', 'takeover', '--peer', 'grace-taker', '--id', graceTaskId, '--reason', 'during grace', '--policy', 'stale']);
  if (graceRejected.status === 0 || !String(graceRejected.stderr || graceRejected.stdout).includes('does not match takeover policy')) {
    fail(`takeover during clock grace window was not rejected:\n${graceRejected.stdout}\n${graceRejected.stderr}`);
  }
  // Removing the grace window → takeover succeeds again.
  const graceDb3 = new DatabaseSync(graceDbPath, { timeout: 5000 });
  graceDb3.exec('PRAGMA foreign_keys = ON;');
  graceDb3.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
  graceDb3.close();
  const graceAfter = hcc(['task', 'takeover', '--peer', 'grace-taker', '--id', graceTaskId, '--reason', 'grace over', '--policy', 'stale']);
  if (!graceAfter.includes('took over task')) fail(`takeover after grace window should succeed:\n${graceAfter}`);
  hcc(['task', 'done', '--peer', 'grace-taker', '--id', graceTaskId, '--summary', 'grace done']);

  // hb-05: lock acquire during grace treats an expired conflicting lock as held.
  hcc(['lock', 'acquire', '--peer', 'grace-lock-owner', '--resource', 'src/grace-lock', '--ttl', '900']);
  const lockDb = new DatabaseSync(graceDbPath, { timeout: 5000 });
  lockDb.exec('PRAGMA foreign_keys = ON;');
  lockDb.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?').run(graceNow - 3600, 'src/grace-lock');
  lockDb.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(graceNow + 60));
  lockDb.close();
  const graceLockList = hccJson(['lock', 'list']);
  if (!graceLockList.some((row) => row.resource === 'src/grace-lock')) {
    fail(`default lock list hid a retained lock during clock grace:\n${JSON.stringify(graceLockList, null, 2)}`);
  }
  const graceGc = hcc(['gc', '--older-than', '9999', '--yes']);
  if (!graceGc.includes('expired locks deferred by clock grace')) {
    fail(`gc did not report the clock-grace lock deferral:\n${graceGc}`);
  }
  const retainedGraceLock = withMeshDb((db) => db.prepare('SELECT owner FROM locks WHERE resource = ?').get('src/grace-lock'));
  if (retainedGraceLock?.owner !== 'grace-lock-owner') {
    fail(`gc deleted the retained lock during clock grace: ${JSON.stringify(retainedGraceLock)}`);
  }
  const graceLockTask = hcc(['task', 'create', '--from', 'human', '--to', 'grace-lock-taker', '--title', 'clock grace lock automation']);
  const graceLockTaskMatch = graceLockTask.match(/created task #(\d+):/);
  if (!graceLockTaskMatch) fail(`cannot parse grace lock task id: ${graceLockTask}`);
  const graceLockTaskId = graceLockTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'grace-lock-taker', '--id', graceLockTaskId]);
  const graceConflictState = hccJson(['state', '--peer', 'grace-lock-taker', '--resource', 'src/grace-lock']);
  if (graceConflictState.clock_grace_active !== true ||
      !graceConflictState.locks.some((row) => row.resource === 'src/grace-lock') ||
      graceConflictState.automation.phase !== 'coordinate_lock' ||
      graceConflictState.automation.next_action.kind !== 'msg.send' ||
      graceConflictState.automation.next_action.lock_owner !== 'grace-lock-owner') {
    fail(`state automation did not preserve the expired lock conflict during grace:\n${JSON.stringify(graceConflictState, null, 2)}`);
  }
  const lockDuringGrace = hccMaybe(['lock', 'acquire', '--peer', 'grace-lock-taker', '--task', graceLockTaskId, '--resource', 'src/grace-lock', '--ttl', '900']);
  if (lockDuringGrace.status === 0 || !String(lockDuringGrace.stderr || lockDuringGrace.stdout).includes('conflicts with lock')) {
    fail(`lock acquire during grace window should see the expired lock as held:\n${lockDuringGrace.stdout}\n${lockDuringGrace.stderr}`);
  }
  // After grace, process evidence still protects the expired lock: age alone
  // cannot release ownership held by a verified-live peer.
  const lockDb2 = new DatabaseSync(graceDbPath, { timeout: 5000 });
  lockDb2.exec('PRAGMA foreign_keys = ON;');
  lockDb2.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
  lockDb2.close();
  const graceEndedState = hccJson(['state', '--peer', 'grace-lock-taker', '--resource', 'src/grace-lock']);
  if (graceEndedState.clock_grace_active !== false) {
    fail(`clock grace did not end:\n${JSON.stringify(graceEndedState, null, 2)}`);
  }
  const lockAfterGrace = hccMaybe(['lock', 'acquire', '--peer', 'grace-lock-taker', '--task', graceLockTaskId, '--resource', 'src/grace-lock', '--ttl', '900']);
  if (lockAfterGrace.status === 0 || !String(lockAfterGrace.stderr || lockAfterGrace.stdout).includes('conflicts with lock')) {
    fail(`verified-live lock owner was released after clock grace:\n${lockAfterGrace.stdout}\n${lockAfterGrace.stderr}`);
  }
  withMeshDb((db) => db.prepare(`
    UPDATE peers
    SET status = 'exited', pid = NULL, pid_start_token = NULL, pid_command_hash = NULL
    WHERE id = ?
  `).run('grace-lock-owner'));
  hcc(['lock', 'acquire', '--peer', 'grace-lock-taker', '--task', graceLockTaskId, '--resource', 'src/grace-lock', '--ttl', '900']);
  hcc(['lock', 'release', '--peer', 'grace-lock-taker', '--resource', 'src/grace-lock']);
  hcc(['task', 'done', '--peer', 'grace-lock-taker', '--id', graceLockTaskId, '--summary', 'grace lock automation done']);

  const abandoned = hcc(['task', 'create', '--from', 'human', '--title', 'abandoned regression task']);
  const abandonedMatch = abandoned.match(/created task #(\d+):/);
  if (!abandonedMatch) fail(`cannot parse abandoned task id: ${abandoned}`);
  const abandonedTaskId = abandonedMatch[1];
  hcc(['task', 'update', '--peer', 'human', '--id', abandonedTaskId, '--status', 'abandoned', '--summary', 'not needed']);
  if (hasTask(hccJson(['task', 'list']), abandonedTaskId)) {
    fail(`abandoned task still shown in default list: #${abandonedTaskId}`);
  }
  if (!hasTask(hccJson(['task', 'list', '--status', 'abandoned']), abandonedTaskId)) {
    fail(`abandoned task missing from --status abandoned list: #${abandonedTaskId}`);
  }

  const hookTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-hook', '--title', 'hook visible task']);
  const hookTaskMatch = hookTask.match(/created task #(\d+):/);
  if (!hookTaskMatch) fail(`cannot parse hook task id: ${hookTask}`);
  const hookTaskId = hookTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-hook', '--id', hookTaskId]);
  hcc(['task', 'update', '--peer', 'codex-hook', '--id', hookTaskId, '--status', 'running', '--summary', 'hook visible']);
  hcc(['msg', 'send', '--from', 'human', '--to', 'claude-hook', '--task', hookTaskId, '--body', 'hook-only-message']);
  const hookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  const hookEnv = { ...env, HCC_PEER: 'claude-hook' };
  const hookTtlResource = 'src/hook-ttl';
  const hookTtlSec = 60;
  const hookCappedTtlResource = 'src/hook-capped-ttl';
  const hookCappedTtlSec = 7200;
  hcc(['lock', 'acquire', '--peer', 'claude-hook', '--resource', hookTtlResource, '--ttl', String(hookTtlSec)]);
  hcc(['lock', 'acquire', '--peer', 'claude-hook', '--resource', hookCappedTtlResource, '--ttl', String(hookCappedTtlSec)]);
  const hookLockCreatedAt = Math.floor(Date.now() / 1000) - 7200;
  const hookCappedLockCreatedAt = hookLockCreatedAt - 60;
  withMeshDb((db) => {
    const updateCreatedAt = db.prepare('UPDATE locks SET created_at = ? WHERE resource = ?');
    updateCreatedAt.run(hookLockCreatedAt, hookTtlResource);
    updateCreatedAt.run(hookCappedLockCreatedAt, hookCappedTtlResource);
  });
  const runHookWithStableTtl = (args, input, label) => {
    const cappedExpiresAt = withMeshDb((db) => db.prepare(
      'SELECT expires_at FROM locks WHERE resource = ?'
    ).get(hookCappedTtlResource)?.expires_at ?? null);
    const before = Math.floor(Date.now() / 1000);
    const output = hcc(args, { env: hookEnv, input });
    const after = Math.floor(Date.now() / 1000);
    assertPersistedLockRenewal(hookTtlResource, {
      ttlSec: hookTtlSec,
      createdAt: hookLockCreatedAt,
      before,
      after,
      label
    });
    assertPersistedLockRenewal(hookCappedTtlResource, {
      ttlSec: hookCappedTtlSec,
      createdAt: hookCappedLockCreatedAt,
      before,
      after,
      expectedExpiresAt: cappedExpiresAt,
      label: `${label} capped TTL`
    });
    return output;
  };
  const firstHook = hookContext(runHookWithStableTtl(['hook', 'userpromptsubmit'], hookPayload, 'first active hook'), 'UserPromptSubmit');
  if (!firstHook.includes('[hello-cc coordination]') || !firstHook.includes('[hello-cc open tasks]') || !firstHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook did not include open task snapshot:\n${firstHook}`);
  }
  if (!firstHook.includes('[hello-cc known peers]') || !firstHook.includes('do not say sessions are isolated')) {
    fail(`UserPromptSubmit hook missing strong cross-session instruction:\n${firstHook}`);
  }
  if (!firstHook.includes('hcc task list') || !firstHook.includes('hcc msg reply --id <message-id>') || !firstHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook missing instructions or unread message:\n${firstHook}`);
  }
  if (!firstHook.includes('[hello-cc next action]') || !firstHook.includes('phase: reply_message') || !firstHook.includes('hcc msg reply')) {
    fail(`UserPromptSubmit hook missing executable next action:\n${firstHook}`);
  }
  const secondHook = hookContext(runHookWithStableTtl(['hook', 'userpromptsubmit'], hookPayload, 'second active hook'), 'UserPromptSubmit');
  if (!secondHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook stopped showing open task after first read:\n${secondHook}`);
  }
  if (secondHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook repeated acked unread message:\n${secondHook}`);
  }
  if (!secondHook.includes('[hello-cc next action]')) {
    fail(`UserPromptSubmit hook dropped next action after ack:\n${secondHook}`);
  }
  const sessionHookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
  const sessionHook = hookContext(runHookWithStableTtl(['hook', 'sessionstart'], sessionHookPayload, 'session-start hook'), 'SessionStart');
  if (!sessionHook.includes(`#${hookTaskId} running`) || sessionHook.includes('hook-only-message')) {
    fail(`SessionStart hook context wrong:\n${sessionHook}`);
  }
  // A clock jump can leave a retained lock apparently expired. An active hook
  // during the grace window must recover it using the persisted TTL.
  const hookGraceNow = Math.floor(Date.now() / 1000);
  withMeshDb((db) => {
    db.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?').run(hookGraceNow - 120, hookTtlResource);
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(hookGraceNow + 60));
  });
  let graceRecoveryHook;
  try {
    graceRecoveryHook = hookContext(runHookWithStableTtl(
      ['hook', 'userpromptsubmit'],
      hookPayload,
      'clock-grace expired-lock hook'
    ), 'UserPromptSubmit');
  } finally {
    withMeshDb((db) => db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run());
  }
  if (!graceRecoveryHook.includes(`#${hookTaskId} running`)) {
    fail(`clock-grace hook recovery lost coordination context:\n${graceRecoveryHook}`);
  }
  const hookRenewals = eventPayloads('lock.renewed_by_hook', 20)
    .filter((event) => event.actor === 'claude-hook');
  if (hookRenewals.length < 4 || hookRenewals.slice(0, 4).some((event) => Number(event.payload?.renewed || 0) < 2)) {
    fail(`active hooks did not report persisted-TTL lock renewal:\n${JSON.stringify(hookRenewals, null, 2)}`);
  }
  hcc(['lock', 'release', '--peer', 'claude-hook', '--resource', hookTtlResource]);
  hcc(['lock', 'release', '--peer', 'claude-hook', '--resource', hookCappedTtlResource]);
  hcc(['task', 'done', '--peer', 'codex-hook', '--id', hookTaskId, '--summary', 'hook regression done']);
  hcc(['event', 'tail', '--limit', '5']);

  const autoEnv = envWithoutPeer();
  const autoSent = hcc(['msg', 'send', '--to', 'all', '--body', 'auto-join-ok'], { env: autoEnv });
  const autoPeer = parseSentPeer(autoSent);
  const autoPeers = hcc(['peers']);
  if (!autoPeers.includes(autoPeer)) fail(`auto peer missing from peers: ${autoPeer}\n${autoPeers}`);
  const autoInbox = hcc(['msg', 'inbox', '--all'], { env: autoEnv });
  if (!autoInbox.includes('auto-join-ok')) fail(`auto inbox missing message:\n${autoInbox}`);
  const autoTask = hcc(['task', 'create', '--title', 'auto join task', '--body', 'auto workflow'], { env: autoEnv });
  const autoTaskMatch = autoTask.match(/created task #(\d+):/);
  if (!autoTaskMatch) fail(`cannot parse auto task id: ${autoTask}`);
  const autoTaskId = autoTaskMatch[1];
  hcc(['task', 'claim', '--id', autoTaskId], { env: autoEnv });
  hcc(['task', 'update', '--id', autoTaskId, '--status', 'running', '--summary', 'auto running'], { env: autoEnv });
  const autoState = hccJson(['state'], { env: autoEnv });
  if (autoState.automation.peer?.id !== autoPeer) {
    fail(`auto state used wrong peer: ${autoPeer}\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  if (String(autoState.automation.current_task?.id) !== String(autoTaskId)) {
    fail(`auto state lost current task #${autoTaskId}:\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  if (autoState.automation.next_action.kind === 'task.next') {
    fail(`auto state suggested task.next while current task was active:\n${JSON.stringify(autoState.automation, null, 2)}`);
  }
  hcc(['lock', 'acquire', '--resource', 'auto/resource', '--task', autoTaskId, '--ttl', '60'], { env: autoEnv });
  hcc(['lock', 'renew', '--resource', 'auto/resource', '--ttl', '60'], { env: autoEnv });
  hcc(['handoff', 'create', '--summary', 'auto handoff', '--tests', 'auto test', '--risks', 'none'], { env: autoEnv });
  hcc(['lock', 'release', '--resource', 'auto/resource'], { env: autoEnv });
  hcc(['task', 'done', '--id', autoTaskId, '--summary', 'auto done'], { env: autoEnv });
  const autoEvents = hcc(['event', 'tail', '--limit', '200']);
  if (!autoEvents.includes('peer.auto_joined') || !autoEvents.includes(autoPeer)) {
    fail(`auto join event missing for ${autoPeer}:\n${autoEvents}`);
  }

  const codexEnv = envAsCodex();
  const codexPeer = parseSentPeer(hcc(['msg', 'send', '--to', 'all', '--body', 'auto-codex-ok'], { env: codexEnv }));
  if (!codexPeer.startsWith('codex-')) fail(`CODEX_THREAD_ID did not produce codex peer: ${codexPeer}`);
  if (!hcc(['msg', 'inbox', '--all'], { env: codexEnv }).includes('auto-codex-ok')) {
    fail('codex auto peer inbox did not include message');
  }
}

async function multiProjectWebWorkflow() {
  log('[4/13] multi-project web');
  const otherRoot = secondProjectRoot;
  fs.mkdirSync(otherRoot, { recursive: true });
  const output = hccFrom(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], otherRoot);
  if (!output.includes('web already running in background')) fail(`second project did not reuse global web:\n${output}`);
  const outputRoot = statusValue(output, 'project');
  if (!samePath(outputRoot, otherRoot)) fail(`second project output did not show its root:\n${output}`);
  if (!output.includes(encodeURIComponent(outputRoot))) fail(`second project URL did not include project query:\n${output}`);

  const otherRuntimeFile = path.join(otherRoot, '.hello-cc', 'runtime.json');
  ensureFile(otherRuntimeFile);
  const otherRuntime = JSON.parse(fs.readFileSync(otherRuntimeFile, 'utf8'));
  if (otherRuntime.pid !== runtimePid || otherRuntime.port !== port) {
    fail(`second project runtime did not point at global runtime:\n${JSON.stringify(otherRuntime, null, 2)}`);
  }

  const projectsResponse = await runtimeFetch('/api/projects', {}, { root: otherRoot });
  const projects = await projectsResponse.json();
  if (!projectsResponse.ok) fail(`projects API failed: ${JSON.stringify(projects)}`);
  const roots = (projects.projects || []).map((p) => p.root);
  if (!roots.some((projectRoot) => samePath(projectRoot, root)) ||
      !roots.some((projectRoot) => samePath(projectRoot, otherRoot))) {
    fail(`projects API did not include both roots:\n${JSON.stringify(projects, null, 2)}`);
  }

  const pathFixture = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-reg-project-path-${testId}-`));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-reg-project-outside-${testId}-`));
  try {
    const arbitraryRoot = path.join(pathFixture, 'arbitrary-project');
    fs.mkdirSync(arbitraryRoot);
    const arbitraryResponse = await runtimeFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: arbitraryRoot })
    });
    const arbitraryBody = await arbitraryResponse.json();
    if (!arbitraryResponse.ok || !samePath(arbitraryBody?.project?.root, fs.realpathSync(arbitraryRoot))) {
      fail(`authenticated arbitrary project root was rejected:\n${JSON.stringify(arbitraryBody, null, 2)}`);
    }
    const arbitraryDb = path.join(arbitraryRoot, '.hello-cc', 'mesh.db');
    if (!fs.lstatSync(arbitraryDb).isFile()) fail('arbitrary project did not create a regular mesh database');
    const arbitraryRuntime = JSON.parse(fs.readFileSync(
      path.join(arbitraryRoot, '.hello-cc', 'runtime.json'),
      'utf8'
    ));
    if (arbitraryRuntime.process_identity?.pid !== runtimePid ||
        arbitraryRuntime.process_identity?.startToken !== otherRuntime.process_identity?.startToken ||
        !arbitraryRuntime.process_identity?.commandHash) {
      fail(`project API runtime pointer omitted the shared runtime fingerprint:\n${JSON.stringify(arbitraryRuntime, null, 2)}`);
    }
    fs.rmSync(path.join(arbitraryRoot, '.hello-cc'), { recursive: true, force: true });
    await sleep(1250);
    if (fs.existsSync(path.join(arbitraryRoot, '.hello-cc'))) {
      fail('background external-session scan recreated a deleted project state directory');
    }

    const assertRejected = async (label, input) => {
      const response = await runtimeFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      const body = await response.json();
      if (response.status !== 403 || body?.error?.code !== 'PROJECT_PATH_FORBIDDEN') {
        fail(`${label} returned ${response.status} instead of PROJECT_PATH_FORBIDDEN:\n${JSON.stringify(body, null, 2)}`);
      }
    };

    const outsideBeforeCreateRoot = path.join(pathFixture, 'outside-before-create-project');
    fs.mkdirSync(outsideBeforeCreateRoot);
    await assertRejected('outside database before state creation', {
      root: outsideBeforeCreateRoot,
      db: path.join(outside, 'outside-before-create.sqlite')
    });
    if (fs.existsSync(path.join(outsideBeforeCreateRoot, '.hello-cc'))) {
      fail('outside database request created the project state directory before rejection');
    }

    const stateLinkRoot = path.join(pathFixture, 'state-link-project');
    const stateLinkOutside = path.join(outside, 'state-link-target');
    fs.mkdirSync(stateLinkRoot);
    fs.mkdirSync(stateLinkOutside);
    fs.symlinkSync(stateLinkOutside, path.join(stateLinkRoot, '.hello-cc'), 'dir');
    await assertRejected('state directory symlink escape', { root: stateLinkRoot });
    if (fs.existsSync(path.join(stateLinkOutside, 'mesh.db'))) {
      fail('state directory symlink escape created an outside database');
    }

    const parentLinkRoot = path.join(pathFixture, 'parent-link-project');
    const parentLinkState = path.join(parentLinkRoot, '.hello-cc');
    const parentLinkOutside = path.join(outside, 'parent-link-target');
    fs.mkdirSync(parentLinkState, { recursive: true });
    fs.mkdirSync(parentLinkOutside);
    fs.symlinkSync(parentLinkOutside, path.join(parentLinkState, 'nested'), 'dir');
    await assertRejected('nested database parent symlink escape', {
      root: parentLinkRoot,
      db: path.join(parentLinkState, 'nested', 'escape.sqlite')
    });
    if (fs.existsSync(path.join(parentLinkOutside, 'escape.sqlite'))) {
      fail('nested parent symlink escape created an outside database');
    }

    const fileLinkRoot = path.join(pathFixture, 'file-link-project');
    const fileLinkState = path.join(fileLinkRoot, '.hello-cc');
    const outsideDb = path.join(outside, 'outside.sqlite');
    fs.mkdirSync(fileLinkState, { recursive: true });
    fs.writeFileSync(outsideDb, 'outside-sentinel');
    fs.symlinkSync(outsideDb, path.join(fileLinkState, 'mesh.db'), 'file');
    await assertRejected('database file symlink escape', { root: fileLinkRoot });
    if (fs.readFileSync(outsideDb, 'utf8') !== 'outside-sentinel') {
      fail('database file symlink escape modified the outside target');
    }

    const reboundRoot = path.join(pathFixture, 'body-rebind-project');
    const reboundState = path.join(reboundRoot, '.hello-cc');
    const reboundStateBefore = path.join(reboundRoot, '.hello-cc-before-rebind');
    const reboundOutside = path.join(outside, 'body-rebind-target');
    fs.mkdirSync(reboundRoot);
    fs.mkdirSync(reboundOutside);
    const reboundCreate = await runtimeFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: reboundRoot })
    });
    if (!reboundCreate.ok) fail(`cannot create body-rebind project: ${await reboundCreate.text()}`);

    const reboundBody = JSON.stringify({ body: 'must not reach rebound database' });
    const reboundRuntime = currentRuntime();
    const reboundUrl = runtimeUrl(
      reboundRuntime,
      '/api/detected/body-rebind-peer/msg',
      { root: reboundRoot }
    );
    let reboundRequest;
    const reboundResponse = new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reboundBody),
        'X-HCC-API-Version': '2'
      };
      if (reboundRuntime.token) headers.Authorization = `Bearer ${reboundRuntime.token}`;
      reboundRequest = http.request(reboundUrl, { method: 'POST', headers }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      reboundRequest.on('error', reject);
    });
    const splitAt = Math.max(1, Math.floor(reboundBody.length / 2));
    reboundRequest.write(reboundBody.slice(0, splitAt));
    await sleep(250);
    fs.renameSync(reboundState, reboundStateBefore);
    fs.symlinkSync(reboundOutside, reboundState, 'dir');
    reboundRequest.end(reboundBody.slice(splitAt));
    const reboundResult = await reboundResponse;
    let reboundPayload = null;
    try { reboundPayload = JSON.parse(reboundResult.text); } catch {}
    if (reboundResult.status !== 403 || reboundPayload?.error?.code !== 'PROJECT_PATH_FORBIDDEN') {
      fail(`body-time state rebind returned ${reboundResult.status} instead of PROJECT_PATH_FORBIDDEN:\n${reboundResult.text}`);
    }
    if (fs.existsSync(path.join(reboundOutside, 'mesh.db'))) {
      fail('body-time state rebind opened a database outside the project');
    }
    fs.unlinkSync(reboundState);
    fs.renameSync(reboundStateBefore, reboundState);

    const migrationBusyRoot = path.join(pathFixture, 'migration-busy-project');
    const migrationTargetRoot = path.join(pathFixture, 'migration-target-project');
    const migrationTargetState = path.join(migrationTargetRoot, '.hello-cc');
    const migrationTargetStateBefore = path.join(migrationTargetRoot, '.hello-cc-before-rebind');
    const migrationOutside = path.join(outside, 'migration-target');
    const migrationBusyDb = path.join(migrationBusyRoot, '.hello-cc', 'mesh.db');
    const migrationTargetDb = path.join(migrationTargetState, 'mesh.db');
    const migrationOutsideDb = path.join(migrationOutside, 'mesh.db');
    const migrationRegistry = path.join(home, '.hello-cc', 'projects.json');
    const migrationReady = path.join(outDir, 'migration-busy-ready');
    const migrationRelease = path.join(outDir, 'migration-busy-release');
    createLegacySchemaDb(migrationBusyDb, 6);
    createLegacySchemaDb(migrationTargetDb, 6);
    fs.mkdirSync(migrationOutside);
    const registryBeforeMigrationRace = fs.readFileSync(migrationRegistry, 'utf8');
    const migrationHolderSource = String.raw`
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const [dbPath, ready, release] = process.argv.slice(1);
      const db = new DatabaseSync(dbPath, { timeout: 5000 });
      db.exec('BEGIN EXCLUSIVE');
      fs.writeFileSync(ready, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
      db.exec('ROLLBACK');
      db.close();
    `;
    const migrationHolder = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      migrationHolderSource,
      migrationBusyDb,
      migrationReady,
      migrationRelease
    ], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await waitForFile(migrationReady, 'ready', 'registered migration busy holder');
    try {
      const registryPayload = JSON.parse(registryBeforeMigrationRace);
      const t = Math.floor(Date.now() / 1000);
      registryPayload.projects = [
        { root: migrationBusyRoot, db: migrationBusyDb, name: 'migration-busy', last_seen_at: t + 2 },
        { root: migrationTargetRoot, db: migrationTargetDb, name: 'migration-target', last_seen_at: t + 1 },
        ...(registryPayload.projects || []).filter((project) =>
          !samePath(project.root, migrationBusyRoot) && !samePath(project.root, migrationTargetRoot))
      ];
      fs.writeFileSync(migrationRegistry, JSON.stringify(registryPayload, null, 2));

      const migrationRequest = runtimeFetch('/api/sessions', {}, { root });
      await sleep(750);
      fs.renameSync(migrationTargetState, migrationTargetStateBefore);
      fs.symlinkSync(migrationOutside, migrationTargetState, 'dir');
      fs.writeFileSync(migrationRelease, 'go');
      await waitForProcessExit(migrationHolder.pid, 'registered migration busy holder exit');
      const migrationResponse = await migrationRequest;
      if (!migrationResponse.ok) {
        fail(`registered migration race request returned ${migrationResponse.status}: ${await migrationResponse.text()}`);
      }
      // A periodic scan may own that fan-out instead of this request.
      await sleep(1000);
      if (fs.existsSync(migrationOutsideDb)) {
        fail('registered project migration followed a rebound state directory outside the project');
      }
    } finally {
      if (!fs.existsSync(migrationRelease)) fs.writeFileSync(migrationRelease, 'go');
      await waitForProcessExit(migrationHolder.pid, 'registered migration busy holder exit');
      fs.writeFileSync(migrationRegistry, registryBeforeMigrationRace);
      if (fs.lstatSync(migrationTargetState).isSymbolicLink()) fs.unlinkSync(migrationTargetState);
      if (fs.existsSync(migrationTargetStateBefore)) {
        fs.renameSync(migrationTargetStateBefore, migrationTargetState);
      }
    }

    if (process.platform === 'linux') {
      await assertRejected('proc pseudo-file target', { root: '/', db: '/proc/self/status' });
    }
  } finally {
    fs.rmSync(pathFixture, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  const activityLockReady = path.join(outDir, 'web-activity-lock-ready');
  const activityLockRelease = path.join(outDir, 'web-activity-lock-release');
  const busyRegistrationRoot = path.join(outDir, 'web-busy-registration-project');
  fs.mkdirSync(busyRegistrationRoot, { recursive: true });
  const registryPath = path.join(home, '.hello-cc', 'projects.json');
  const lockModuleUrl = pathToFileURL(path.join(repoRoot, 'lib/shared/file-lock.mjs')).href;
  const activityHolderSource = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, target, ready, release] = process.argv.slice(1);
    const { withFileLock } = await import(moduleUrl);
    withFileLock(target, () => {
      fs.writeFileSync(ready, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
    });
  `;
  const activityHolder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    activityHolderSource,
    lockModuleUrl,
    registryPath,
    activityLockReady,
    activityLockRelease
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  await waitForFile(activityLockReady, 'ready', 'web activity registry lock');
  try {
    const activityStarted = Date.now();
    const activityResponses = await Promise.all([
      runtimeFetch('/api/runtime', {}, { root: otherRoot }),
      runtimeFetch('/api/runtime', {}, { root: otherRoot }),
      runtimeFetch('/api/runtime', {}, { root: otherRoot })
    ]);
    const activityElapsed = Date.now() - activityStarted;
    if (activityResponses.some((response) => !response.ok)) {
      fail(`busy registry blocked a Web activity request: ${activityResponses.map((response) => response.status).join(', ')}`);
    }
    if (activityElapsed >= 750) {
      fail(`busy registry delayed repeated Web activity requests by ${activityElapsed}ms`);
    }
    const registrationStarted = Date.now();
    const busyRegistration = await runtimeFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: busyRegistrationRoot })
    });
    if (busyRegistration.status !== 503 || Date.now() - registrationStarted >= 750) {
      fail(`busy registry did not fail Web registration quickly: ${busyRegistration.status}`);
    }
  } finally {
    fs.writeFileSync(activityLockRelease, 'go');
    await waitForProcessExit(activityHolder.pid, 'web activity lock holder exit');
  }
  const retriedRegistration = await runtimeFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: busyRegistrationRoot })
  });
  if (!retriedRegistration.ok) {
    fail(`Web registration did not recover after registry contention: ${await retriedRegistration.text()}`);
  }

  const detectedResponse = await runtimeFetch('/api/detected', {}, { root });
  const detectedJson = await detectedResponse.json();
  if (!detectedResponse.ok || typeof detectedJson.active_peer_ttl !== 'number' || typeof detectedJson.now !== 'number' || !Array.isArray(detectedJson.detected)) {
    fail(`detected API did not return liveness metadata:\n${JSON.stringify(detectedJson, null, 2)}`);
  }

  const htmlResponse = await fetch(currentRuntimeUrl('/'));
  const html = await htmlResponse.text();
  for (const forbidden of ['Alias optional', 'Role tag', 'Command<input', 'Working directory', 'commandbar', 'lineInput', 'Send text to active terminal']) {
    if (html.includes(forbidden)) fail(`web form still exposes ${forbidden}`);
  }
  for (const expected of [
    'id="projectSelect"',
    'id="projectPath"',
    'id="addProjectBtn"',
    'id="startForm"',
    'id="kind"',
    'id="sessionKindFilter"',
    'id="sessions"'
  ]) {
    if (!html.includes(expected)) fail(`web form missing simplified project/session control: ${expected}`);
  }
  for (const expected of [
    'id="langSelect"',
    "localStorage.getItem('hcc.lang')",
    "localStorage.setItem('hcc.lang', lang)",
    "document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'",
    "zh: {",
    "language: '语言'",
    "projectState: '项目状态'",
    "noSessionSelected: '未选择会话'",
    "sendMessage: '发送消息'",
    "peers: '协作方'",
    "noPeers: '没有协作方。'",
    "'status.active': '活跃'",
    "data-i18n=\"language\"",
    "data-i18n-placeholder=\"projectPathPlaceholder\"",
    "data-i18n-title=\"collapseSidebar\"",
    "function applyLanguage()",
    "function tr(key",
    "function statusText(status)",
    "function sessionMetaText(session)",
    "connText('attached')",
    "connText('coordinationOnly')",
    "tr('noActiveSessions')",
    "tr('nextAction')",
    "tr('detectedSession')",
    "tr('messageBodyPlaceholder')",
    "activeType === 'detected' && activeDetected",
    "const draft = document.getElementById('detMsg')?.value || ''",
    "statusText(state.label)",
    "statusText(automation.phase || 'idle')",
    "tr('runtime')"
  ]) {
    if (!html.includes(expected)) fail(`web UI missing i18n support: ${expected}`);
  }
  if (!html.includes('id="logoutBtn"') ||
      !html.includes("fetch('/logout', { method: 'POST', headers })")) {
    fail('web UI missing logout control or session revocation request');
  }
  if (!html.includes('id="startMode"') || !html.includes('id="resumeArg"') || !html.includes('syncStartModeOptions') || !html.includes("mode === 'resume'")) {
    fail('web form missing provider resume controls');
  }
  for (const expected of [
    '--left-width',
    '--right-width',
    'hcc.sidebar.left.width',
    'hcc.sidebar.right.width',
    'class="edge-resizer edge-resizer-left"',
    'class="edge-resizer edge-resizer-right"',
    'id="resizeLeft"',
    'id="resizeRight"',
    'role="separator"',
    'aria-orientation="vertical"',
    'bindSideHandle(resizeLeftHandle',
    'bindSideHandle(resizeRightHandle',
    'bindSideHandle(toggleLeftBtn',
    'bindSideHandle(toggleRightBtn',
    'setPointerCapture',
    'sideIsCollapsed(opposite) ? 0',
    'Math.abs(delta) <= 3',
    "localStorage.setItem('hcc.collapse.' + side, on ? '1' : '0');\n      applySideWidths();",
    'cursor: col-resize'
  ]) {
    if (!html.includes(expected)) fail(`web layout missing resizable sidebar support: ${expected}`);
  }
  if (!html.includes('state-card') || !html.includes('peerStateView') || !html.includes('savedCardScroll') || !html.includes('lastStateRoot') || !html.includes("stateCardHtml('peers'")) {
    fail('web state panel missing scrollable peer state UI');
  }
  for (const expected of [
    'function stateCardCollapsed(section)',
    "localStorage.getItem('hcc.stateCard.' + section + '.collapsed')",
    'function stateCardHtml(section, title, count, bodyHtml)',
    'state-card-toggle',
    'aria-expanded=',
    'state-card-collapsed',
    'function bindStateCardToggles()',
    "localStorage.setItem('hcc.stateCard.' + section + '.collapsed'",
    "stateCardHtml('automation'",
    "stateCardHtml('timeline'",
    "stateCardHtml('messages'",
    "stateCardHtml('peers'",
    "stateCardHtml('tasks'",
    "stateCardHtml('locks'",
    'bindStateCardToggles();'
  ]) {
    if (!html.includes(expected)) fail(`web state panel missing collapsible card support: ${expected}`);
  }
  for (const expected of [
    'id="actionResult"',
    'data-action="state"',
    'data-action="status"',
    'data-action="inbox"',
    'data-action="task-next"',
    'data-action="heartbeat"',
    'data-action="register"',
    'data-terminal-action="status"',
    'function runPeerAction(action)',
    "'/api/peers/' + encodeURIComponent(info.peerId) + '/actions/' + encodeURIComponent(action)",
    'showActionResult(result)'
  ]) {
    if (!html.includes(expected)) fail(`web actions missing API result UI: ${expected}`);
  }
  if (html.includes('data-send=') || html.includes("document.querySelectorAll('[data-send]')")) {
    fail('web actions still use implicit terminal command injection');
  }
  for (const expected of [
    'term.onData((data) => {',
    'sendTerminalInput(data);',
    'function flushPendingTerminalInput(id, socket)',
    "socket.send(JSON.stringify({ type: 'input', data, action_token: actionToken }))"
  ]) {
    if (!html.includes(expected)) fail(`web terminal input forwarding missing: ${expected}`);
  }
  if (!html.includes("stateCardHtml('timeline'") || !html.includes('renderTimelineItem') || !html.includes('bodyPinned') || !html.includes('refreshCurrentState')) {
    fail('web state panel missing collaboration timeline or refresh routing');
  }
  if (!html.includes("stateCardHtml('messages'") || !html.includes('messagesData.length')) {
    fail('web state panel missing dedicated messages card');
  }

  if (!tmuxAvailable()) return;
  const started = hccFrom(['peer', 'start', 'other-shell', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], otherRoot);
  parsePane(started);
  const rootList = hcc(['peer', 'list']);
  const otherList = hccFrom(['peer', 'list'], otherRoot);
  if (rootList.includes('other-shell')) fail(`root project saw second project session:\n${rootList}`);
  if (!otherList.includes('other-shell')) fail(`second project did not see its session:\n${otherList}`);

  const rootSessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  const otherSessions = await (await runtimeFetch('/api/sessions', {}, { root: otherRoot })).json();
  if (JSON.stringify(rootSessions).includes('action_token') || JSON.stringify(otherSessions).includes('action_token')) {
    fail(`GET /api/sessions leaked a session action token:\n${JSON.stringify({ rootSessions, otherSessions }, null, 2)}`);
  }
  if ((rootSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`root API saw second project session:\n${JSON.stringify(rootSessions)}`);
  }
  if (!(otherSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`second project API did not see its session:\n${JSON.stringify(otherSessions)}`);
  }
  const otherShellSession = (otherSessions.sessions || []).find((s) => s.id === 'other-shell');
  if (!otherShellSession?.binding || otherShellSession.binding.runtime_target !== otherShellSession.pane ||
      otherShellSession.provider_session_known !== false || otherShellSession.provider_session_label !== null) {
    fail(`sessions API did not expose unknown provider binding without marking it shared/known:\n${JSON.stringify(otherShellSession, null, 2)}`);
  }

  const startProvider = async (payload, projectRoot = root) => {
    const response = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        env: {
          HOME: home,
          PATH: env.PATH,
          SHELL: process.env.SHELL || 'bash',
          HCC_FAKE_STAY_ALIVE: '1'
        },
        ...payload
      })
    }, { root: projectRoot });
    const json = await response.json();
    if (!response.ok) fail(`web provider session start failed: ${JSON.stringify(json)}`);
    return json.session;
  };
  const stopSession = async (id, payload = null, projectRoot = root) => {
    const options = payload
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      : { method: 'POST' };
    const response = await runtimeFetch(`/api/sessions/${encodeURIComponent(id)}/stop`, options, { root: projectRoot });
    const json = await response.json();
    if (!response.ok) fail(`web provider session stop failed: ${JSON.stringify(json)}`);
    return json.session;
  };

  const canonicalRegressionRoot = fs.realpathSync(root);
  if (canonicalRegressionRoot !== root) {
    const legacyAliasPeer = 'legacy-alias-restart';
    const legacyAliasSession = `hcc-${shortHash(root)}-${legacyAliasPeer}`;
    const canonicalAliasSession = tmuxManagedSession(root, legacyAliasPeer);
    if (legacyAliasSession === canonicalAliasSession) {
      fail('legacy alias session fixture did not produce a distinct pre-upgrade name');
    }
    managedTmuxSessions.add(legacyAliasSession);
    run('tmux', [
      'new-session', '-d', '-s', legacyAliasSession,
      '-e', `HCC_ROOT=${root}`, '-c', root,
      'bash', '--noprofile', '--norc'
    ]);
    const legacyAliasPane = run('tmux', [
      'display-message', '-p', '-t', `${legacyAliasSession}:0.0`, '#{pane_id}'
    ]).trim();
    const legacyAliasPid = Number(run('tmux', [
      'display-message', '-p', '-t', legacyAliasPane, '#{pane_pid}'
    ]).trim());
    const legacyAliasIdentity = inspectProcessIdentity(legacyAliasPid).identity;
    if (!legacyAliasIdentity) fail('cannot inspect legacy alias pane identity');
    withMeshDb((db) => {
      const t = Math.floor(Date.now() / 1000);
      const staleLastSeenAt = t - 3600;
      db.prepare(`
        INSERT INTO peers(id, kind, role, worktree, pid, pid_start_token, pid_command_hash,
                          status, capabilities, created_at, last_seen_at)
        VALUES (?, 'shell', 'peer', ?, ?, ?, ?, 'working', 'tmux', ?, ?)
        ON CONFLICT(id) DO UPDATE SET worktree = excluded.worktree, pid = excluded.pid,
          pid_start_token = excluded.pid_start_token, pid_command_hash = excluded.pid_command_hash,
          status = excluded.status, capabilities = excluded.capabilities, last_seen_at = excluded.last_seen_at
      `).run(legacyAliasPeer, root, legacyAliasPid, legacyAliasIdentity.startToken,
        legacyAliasIdentity.commandHash, t, staleLastSeenAt);
      db.prepare(`
        INSERT INTO peer_bindings(peer, provider, resume_mode, command, transport,
                                  runtime_session_id, runtime_target, created_at, updated_at)
        VALUES (?, 'shell', 'attached', 'bash --noprofile --norc', 'tmux', ?, NULL, ?, ?)
        ON CONFLICT(peer) DO UPDATE SET transport = 'tmux', runtime_session_id = excluded.runtime_session_id,
          runtime_target = NULL, updated_at = excluded.updated_at
      `).run(legacyAliasPeer, legacyAliasPeer, t, t);
      const initialBinding = db.prepare(`
        SELECT runtime_target FROM peer_bindings WHERE peer = ?
      `).get(legacyAliasPeer);
      if (!initialBinding || initialBinding.runtime_target !== null) {
        fail(`legacy alias fixture did not start detached:\n${JSON.stringify(initialBinding, null, 2)}`);
      }
    });
    let observedSessions = [];
    let observedBinding = null;
    try {
      await waitFor(async () => {
        const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
        observedSessions = data.sessions || [];
        withMeshDb((db) => {
          observedBinding = db.prepare(`
            SELECT transport, runtime_session_id, runtime_target
            FROM peer_bindings WHERE peer = ?
          `).get(legacyAliasPeer) || null;
        });
        return observedSessions.some((session) =>
          session.id === legacyAliasPeer && session.pane === legacyAliasPane) &&
          observedBinding?.runtime_target === legacyAliasPane;
      }, 'legacy alias detached tmux re-adoption', 12000);
    } catch (error) {
      fail(`legacy alias detached tmux was not re-adopted: ${error.message}\n${JSON.stringify({
        legacyAliasSession,
        canonicalAliasSession,
        legacyAliasPane,
        session_visible: observedSessions.some((session) => session.id === legacyAliasPeer),
        binding: observedBinding
      }, null, 2)}`);
    }
    await stopSession(legacyAliasPeer, { kill_tmux: true });
    if (runMaybe('tmux', ['has-session', '-t', legacyAliasSession]).status === 0) {
      fail('legacy alias detached tmux session survived DB-proven kill');
    }
  }

  const cookieAdmin = await issueBrowserSessionCookie();
  const crossOrigin = `http://127.0.0.1:${port + 1}`;
  const cookieAdminId = `cookie-admin-${testId}`;
  const cookieAdminBody = JSON.stringify({
    id: cookieAdminId,
    kind: 'shell',
    command: 'bash --noprofile --norc',
    env: {
      HOME: home,
      PATH: env.PATH,
      SHELL: process.env.SHELL || 'bash'
    }
  });
  const crossCreate = await cookieRuntimeFetch('/api/sessions', cookieAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: crossOrigin },
    body: cookieAdminBody
  }, { root });
  if (crossCreate.status !== 403) fail(`cross-origin cookie administrator create returned ${crossCreate.status}`);
  const missingOriginCreate = await cookieRuntimeFetchWithoutOrigin('/api/sessions', cookieAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cookieAdminBody
  }, { root });
  if (missingOriginCreate.status !== 403) {
    fail(`missing-Origin cookie administrator create returned ${missingOriginCreate.status}`);
  }

  const cookieCreate = await cookieRuntimeFetch('/api/sessions', cookieAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cookieAdminBody
  }, { root });
  const cookieCreated = await cookieCreate.json();
  if (!cookieCreate.ok || cookieCreated.session?.id !== cookieAdminId || cookieCreated.session?.action_token) {
    fail(`same-origin cookie administrator create failed or leaked its action token:\n${JSON.stringify(cookieCreated, null, 2)}`);
  }

  const cookieAdminWs = await openCookieTerminalWebSocket(cookieAdminId, cookieAdmin.sid, { root });
  try {
    if (!cookieAdminWs.hccActionToken) fail('cookie administrator terminal snapshot omitted its action token');
    const inputRoute = `/api/sessions/${encodeURIComponent(cookieAdminId)}/input`;
    const stopRoute = `/api/sessions/${encodeURIComponent(cookieAdminId)}/stop`;
    const crossInput = await cookieRuntimeFetch(inputRoute, cookieAdmin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: crossOrigin },
      body: JSON.stringify({ data: 'echo should-not-run\r' })
    }, { root });
    if (crossInput.status !== 403) fail(`cross-origin cookie administrator input returned ${crossInput.status}`);
    const missingOriginInput = await cookieRuntimeFetchWithoutOrigin(inputRoute, cookieAdmin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'echo should-not-run\r' })
    }, { root });
    if (missingOriginInput.status !== 403) {
      fail(`missing-Origin cookie administrator input returned ${missingOriginInput.status}`);
    }

    const marker = `COOKIE_ADMIN_INPUT_${testId}`;
    await expectSocketMarkerAfter(cookieAdminWs, marker, async () => {
      const inputResponse = await cookieRuntimeFetch(inputRoute, cookieAdmin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: `echo ${marker}\r` })
      }, { root });
      if (!inputResponse.ok) fail(`same-origin cookie administrator input returned ${inputResponse.status}`);
    });

    const crossStop = await cookieRuntimeFetch(stopRoute, cookieAdmin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: crossOrigin },
      body: '{}'
    }, { root });
    if (crossStop.status !== 403) fail(`cross-origin cookie administrator stop returned ${crossStop.status}`);
    const missingOriginStop = await cookieRuntimeFetchWithoutOrigin(stopRoute, cookieAdmin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }, { root });
    if (missingOriginStop.status !== 403) {
      fail(`missing-Origin cookie administrator stop returned ${missingOriginStop.status}`);
    }

    const cookieStop = await cookieRuntimeFetch(stopRoute, cookieAdmin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }, { root });
    if (!cookieStop.ok) fail(`same-origin cookie administrator stop returned ${cookieStop.status}`);
  } finally {
    if (cookieAdminWs.readyState !== WebSocket.CLOSED) {
      try { cookieAdminWs.terminate(); } catch {}
    }
  }

  const auditSpoofSession = await startProvider({
    kind: 'shell',
    command: 'bash --noprofile --norc',
    auditActorPeer: 'spoofed-web-actor',
    auditSource: 'spoofed-source'
  });
  const auditSpoofPeer = auditSpoofSession.peer_id || auditSpoofSession.id;
  const attachAudit = eventPayloads('tmux.session.attached', 80)
    .find((event) => event.payload?.target_peer === auditSpoofPeer);
  if (!attachAudit ||
      attachAudit.actor !== 'web' ||
      attachAudit.payload.actor_peer !== 'web' ||
      attachAudit.payload.source !== 'web' ||
      attachAudit.payload.actor_peer === 'spoofed-web-actor' ||
      attachAudit.payload.source === 'spoofed-source') {
    fail(`web start audit allowed spoofed actor/source:\n${JSON.stringify({ auditSpoofSession, attachAudit }, null, 2)}`);
  }
  await stopSession(auditSpoofSession.id, {
    auditActorPeer: 'spoofed-stop-actor',
    auditSource: 'spoofed-source'
  });
  const stopAudit = eventPayloads('web.session.stop_requested', 80)
    .find((event) => event.payload?.target_peer === auditSpoofPeer);
  if (!stopAudit ||
      stopAudit.actor !== 'web' ||
      stopAudit.payload.actor_peer !== 'web' ||
      stopAudit.payload.target_peer !== auditSpoofPeer ||
      stopAudit.payload.source !== 'web' ||
      stopAudit.payload.admin !== true ||
      stopAudit.payload.actor_peer === 'spoofed-stop-actor' ||
      stopAudit.payload.source === 'spoofed-source') {
    fail(`web stop audit allowed spoofed actor/source:\n${JSON.stringify({ auditSpoofSession, stopAudit }, null, 2)}`);
  }

  hcc(['register', '--peer', 'web-action-peer', '--kind', 'codex', '--role', 'peer']);
  hcc(['msg', 'send', '--from', 'human', '--to', 'web-action-peer', '--body', 'web action inbox ok']);
  const actionStatus = await (await runtimeFetch('/api/peers/web-action-peer/actions/status', {}, { root })).json();
  if (!actionStatus.ok || actionStatus.action !== 'status' || actionStatus.peer !== 'web-action-peer' || !actionStatus.data || typeof actionStatus.data.unread !== 'number') {
    fail(`web status action did not return structured status:\n${JSON.stringify(actionStatus, null, 2)}`);
  }
  const actionInbox = await (await runtimeFetch('/api/peers/web-action-peer/actions/inbox', {}, { root })).json();
  if (!actionInbox.ok || actionInbox.action !== 'inbox' || !(actionInbox.data?.messages || []).some((m) => m.body === 'web action inbox ok')) {
    fail(`web inbox action did not return unread messages:\n${JSON.stringify(actionInbox, null, 2)}`);
  }
  const actionState = await (await runtimeFetch('/api/peers/web-action-peer/actions/state', {}, { root })).json();
  if (!actionState.ok || actionState.action !== 'state' || actionState.data?.automation?.peer?.id !== 'web-action-peer') {
    fail(`web state action did not return peer automation:\n${JSON.stringify(actionState, null, 2)}`);
  }
  const taskOutput = hcc(['task', 'create', '--title', 'web action task', '--body', 'claim through web action']);
  const taskMatch = taskOutput.match(/created task #(\d+):/);
  if (!taskMatch) fail(`cannot parse web action task id:\n${taskOutput}`);
  const rejectedActionNextResponse = await runtimeFetch('/api/peers/web-action-peer/actions/task-next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }, { root });
  const rejectedActionNext = await rejectedActionNextResponse.json();
  if (rejectedActionNextResponse.ok || rejectedActionNext.error?.code !== 'PEER_IDENTITY_REQUIRED') {
    fail(`web task-next accepted unmanaged peer identity:\n${JSON.stringify(rejectedActionNext, null, 2)}`);
  }
  const unmanagedTaskAfterReject = hccJson(['task', 'list', '--all']).find((task) => String(task.id) === taskMatch[1]);
  if (!unmanagedTaskAfterReject || unmanagedTaskAfterReject.owner) {
    fail(`rejected web task-next still changed task owner:\n${JSON.stringify(unmanagedTaskAfterReject, null, 2)}`);
  }

  const managedActionSession = await startProvider({ kind: 'shell', command: 'bash --noprofile --norc' });
  const managedActionPeer = managedActionSession.peer_id || managedActionSession.id;
  // net-05: the action token is no longer in the session response; fetch it
  // from the terminal WS snapshot frame.
  const managedActionChannel = await openSessionActionChannel(managedActionPeer);
  const managedActionToken = managedActionChannel.token;
  if (!managedActionToken) {
    fail(`managed web session did not deliver an action token over the WS snapshot:\n${JSON.stringify(managedActionSession, null, 2)}`);
  }
  const runtimeActionToken = currentRuntime().token || '';
  if (managedActionToken === runtimeActionToken || managedActionToken.length < 32) {
    fail(`managed web session action token is not an independent session token:\n${JSON.stringify({ runtimeActionToken, managedActionToken }, null, 2)}`);
  }
  if (managedActionSession.action_token || JSON.stringify(managedActionSession).includes('action_token')) {
    fail(`session create response leaked its action token:\n${JSON.stringify(managedActionSession, null, 2)}`);
  }

  const encodedActionId = `web action encoded/${testId}`;
  const encodedActionSession = await startProvider({
    id: encodedActionId,
    kind: 'shell',
    command: 'bash --noprofile --norc'
  });
  const encodedActionToken = await fetchSessionActionToken(encodedActionId, { root });
  const siblingActionId = `web-action-sibling-${testId}`;
  const siblingActionSession = await startProvider({
    id: siblingActionId,
    kind: 'shell',
    command: 'bash --noprofile --norc'
  }, otherRoot);
  const siblingActionToken = await fetchSessionActionToken(siblingActionId, { root: otherRoot });
  if (!encodedActionToken || !siblingActionToken) {
    fail(`alternate sessions did not deliver action tokens:\n${JSON.stringify({ encodedActionSession, siblingActionSession }, null, 2)}`);
  }

  const sameLengthWrongToken = managedActionToken.slice(0, -1) +
    (managedActionToken.endsWith('A') ? 'B' : 'A');
  await assertTerminalInputTokenRejected(managedActionPeer, undefined, { root }, 'missing');
  await assertTerminalInputTokenRejected(managedActionPeer, sameLengthWrongToken, { root }, 'same-length wrong');
  await assertTerminalInputTokenRejected(managedActionPeer, encodedActionToken, { root }, 'another session');
  await assertTerminalInputTokenRejected(managedActionPeer, siblingActionToken, { root }, 'sibling project');
  await assertTerminalInputTokenRejected(encodedActionId, managedActionToken, { root }, 'URL-encoded peer with foreign');

  const expectActionTokenRejected = async (provided, label) => {
    const response = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/lock-acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_token: provided, resource: `rejected/${label}/${testId}`, ttl: 60 })
    }, { root });
    const body = await response.json();
    if (response.ok || body.error?.code !== 'PEER_IDENTITY_REQUIRED') {
      fail(`web action accepted ${label} token:\n${JSON.stringify(body, null, 2)}`);
    }
  };
  await expectActionTokenRejected(sameLengthWrongToken, 'same-length-wrong');
  await expectActionTokenRejected(encodedActionToken, 'other-session');
  await expectActionTokenRejected(siblingActionToken, 'sibling-project');
  const secondManagedChannel = await openSessionActionChannel(managedActionPeer, { root });
  if (!secondManagedChannel.token || secondManagedChannel.token === managedActionToken) {
    fail('two terminal connections shared an action token');
  }
  await closeTerminalWebSocket(secondManagedChannel.ws);
  await expectActionTokenRejected(secondManagedChannel.token, 'closed-connection');
  const encodedPeerAction = await runtimeFetch(`/api/peers/${encodeURIComponent(encodedActionId)}/actions/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: encodedActionToken, renew_locks: false })
  }, { root });
  if (!encodedPeerAction.ok) {
    fail(`URL-encoded peer action rejected its own token:\n${await encodedPeerAction.text()}`);
  }

  const actionNext = await (await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionSession.peer_id || managedActionSession.id)}/actions/task-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: managedActionToken })
  }, { root })).json();
  if (!actionNext.ok || actionNext.action !== 'task-next' || String(actionNext.data?.task?.id) !== taskMatch[1]) {
    fail(`web task-next action did not claim pending task #${taskMatch[1]}:\n${JSON.stringify(actionNext, null, 2)}`);
  }
  await stopSession(encodedActionSession.id);
  await stopSession(siblingActionSession.id, null, otherRoot);
  // Cookie-authenticated terminal sockets are tied to the opaque browser
  // session and must be revoked immediately on logout.
  await assertLogoutClosesCookieWebSocket(managedActionPeer, { root });
  await assertEvictionClosesCookieWebSocket(managedActionPeer, { root });
  // The web heartbeat path is independent from the CLI command. Verify it also
  // renews from ttl_sec without compounding, including an explicit override.
  const webTtlResource = 'web/persisted-ttl-lock';
  const webLockResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/lock-acquire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action_token: managedActionToken,
      resource: webTtlResource,
      task: Number(taskMatch[1]),
      ttl: 60
    })
  }, { root });
  const webLock = await webLockResponse.json();
  if (!webLockResponse.ok || !webLock.ok || webLock.action !== 'lock-acquire' || webLock.data?.lock?.ttl_sec !== 60) {
    fail(`web lock-acquire did not persist its TTL:\n${JSON.stringify(webLock, null, 2)}`);
  }
  const webLockCreatedAt = Math.floor(Date.now() / 1000) - 7200;
  withMeshDb((db) => db.prepare('UPDATE locks SET created_at = ? WHERE resource = ?').run(webLockCreatedAt, webTtlResource));
  const runWebHeartbeatWithStableTtl = async (ttlSec, label, ttlOverride = null) => {
    const before = Math.floor(Date.now() / 1000);
    const response = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_token: managedActionToken,
        renew_locks: true,
        ...(ttlOverride === null ? {} : { ttl: ttlOverride })
      })
    }, { root });
    const payload = await response.json();
    const after = Math.floor(Date.now() / 1000);
    if (!response.ok || !payload.ok || payload.action !== 'heartbeat' || payload.data?.renewed !== 1) {
      fail(`${label} failed to renew exactly one lock:\n${JSON.stringify(payload, null, 2)}`);
    }
    assertPersistedLockRenewal(webTtlResource, {
      ttlSec,
      createdAt: webLockCreatedAt,
      before,
      after,
      label
    });
  };
  await runWebHeartbeatWithStableTtl(60, 'first web heartbeat');
  await runWebHeartbeatWithStableTtl(60, 'second web heartbeat');
  await runWebHeartbeatWithStableTtl(75, 'web heartbeat TTL override', 75);
  await runWebHeartbeatWithStableTtl(75, 'web heartbeat persisted TTL after override');
  // A verified-live Web peer can recover its retained lock after the stored
  // expiry, matching the CLI heartbeat evidence policy outside clock grace.
  withMeshDb((db) => {
    db.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?')
      .run(Math.floor(Date.now() / 1000) - 60, webTtlResource);
  });
  await runWebHeartbeatWithStableTtl(75, 'verified-live Web expired-lock recovery');

  const managedHeartbeatIdentity = withMeshDb((db) => db.prepare(`
    SELECT pid, pid_start_token, pid_command_hash
    FROM peers WHERE id = ?
  `).get(managedActionPeer));
  withMeshDb((db) => {
    db.prepare(`
      UPDATE peers SET pid_start_token = NULL, pid_command_hash = NULL WHERE id = ?
    `).run(managedActionPeer);
    db.prepare('UPDATE locks SET expires_at = ? WHERE resource = ?')
      .run(Math.floor(Date.now() / 1000) - 60, webTtlResource);
  });
  const unknownHeartbeatResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: managedActionToken, renew_locks: true })
  }, { root });
  const unknownHeartbeat = await unknownHeartbeatResponse.json();
  if (!unknownHeartbeatResponse.ok || unknownHeartbeat.data?.renewed !== 0) {
    fail(`unknown Web peer renewed an expired lock outside grace:\n${JSON.stringify(unknownHeartbeat, null, 2)}`);
  }
  withMeshDb((db) => {
    db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(Math.floor(Date.now() / 1000) + 60));
  });
  const graceHeartbeatExpiry = withMeshDb((db) => db.prepare(
    'SELECT expires_at FROM locks WHERE resource = ?'
  ).get(webTtlResource)?.expires_at);
  const graceHeartbeatResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: managedActionToken, renew_locks: true })
  }, { root });
  const graceHeartbeat = await graceHeartbeatResponse.json();
  const graceHeartbeatState = withMeshDb((db) => ({
    expiresAt: db.prepare('SELECT expires_at FROM locks WHERE resource = ?').get(webTtlResource)?.expires_at,
    watermark: db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get()?.value
  }));
  if (!graceHeartbeatResponse.ok || graceHeartbeat.data?.renewed !== 0 ||
      graceHeartbeatState.expiresAt !== graceHeartbeatExpiry || !graceHeartbeatState.watermark) {
    fail(`clock grace renewed an unknown Web peer lock instead of retaining it unchanged:\n${JSON.stringify({ graceHeartbeat, graceHeartbeatExpiry, graceHeartbeatState }, null, 2)}`);
  }
  withMeshDb((db) => {
    db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
    db.prepare(`
      UPDATE peers SET pid = ?, pid_start_token = ?, pid_command_hash = ? WHERE id = ?
    `).run(
      managedHeartbeatIdentity.pid,
      managedHeartbeatIdentity.pid_start_token,
      managedHeartbeatIdentity.pid_command_hash,
      managedActionPeer
    );
  });
  hcc(['lock', 'release', '--peer', managedActionPeer, '--resource', webTtlResource]);

  const evidenceOwnerSession = await startProvider({ kind: 'shell', command: 'bash --noprofile --norc' });
  const evidenceOwner = evidenceOwnerSession.peer_id || evidenceOwnerSession.id;
  const evidenceOwnerPane = evidenceOwnerSession.pane;
  const evidenceOwnerPid = Number(run('tmux', ['display-message', '-p', '-t', evidenceOwnerPane, '#{pane_pid}']).trim());
  const evidenceOwnerIdentity = inspectProcessIdentity(evidenceOwnerPid).identity;
  if (!evidenceOwnerIdentity) fail('cannot inspect live web evidence owner identity');
  const evidenceTaskOutput = hcc(['task', 'create', '--from', 'human', '--to', evidenceOwner, '--title', 'web full-evidence owner']);
  const evidenceTaskMatch = evidenceTaskOutput.match(/created task #(\d+):/);
  if (!evidenceTaskMatch) fail(`cannot parse web evidence task id:\n${evidenceTaskOutput}`);
  const evidenceTaskId = Number(evidenceTaskMatch[1]);
  hcc(['task', 'claim', '--peer', evidenceOwner, '--id', String(evidenceTaskId)]);
  const staleEvidenceAt = Math.floor(Date.now() / 1000) - 7200;
  const recentEvidenceAt = Math.floor(Date.now() / 1000);
  withMeshDb((db) => db.prepare(`
    UPDATE peers
    SET pid = ?, pid_start_token = ?, pid_command_hash = ?,
        status = 'working', last_seen_at = ?
    WHERE id = ?
  `).run(
    evidenceOwnerPid,
    evidenceOwnerIdentity.startToken,
    evidenceOwnerIdentity.commandHash,
    recentEvidenceAt,
    evidenceOwner
  ));
  const evidenceOwnerBeforeReads = withMeshDb((db) => db.prepare(`
    SELECT pid, pid_start_token, pid_command_hash, status, last_seen_at
    FROM peers WHERE id = ?
  `).get(evidenceOwner));
  hccJson(['status', '--peer', evidenceOwner]);
  hccJson(['state', '--peer', evidenceOwner]);
  hccJson(['lock', 'list', '--all']);
  const evidenceOwnerAfterReads = withMeshDb((db) => db.prepare(`
    SELECT pid, pid_start_token, pid_command_hash, status, last_seen_at
    FROM peers WHERE id = ?
  `).get(evidenceOwner));
  if (JSON.stringify(evidenceOwnerAfterReads) !== JSON.stringify(evidenceOwnerBeforeReads)) {
    fail(`status/state/lock-list mutated peer evidence:\n${JSON.stringify({ evidenceOwnerBeforeReads, evidenceOwnerAfterReads }, null, 2)}`);
  }
  withMeshDb((db) => db.prepare(`
    UPDATE peers
    SET pid_start_token = 'reused:web-owner', pid_command_hash = ?,
        status = 'working', last_seen_at = ?
    WHERE id = ?
  `).run('a'.repeat(64), recentEvidenceAt, evidenceOwner));

  const reusedOwnerState = await (await runtimeFetch('/api/peers/web-action-peer/actions/state', {}, { root })).json();
  const reusedOwnerTask = (reusedOwnerState.data?.tasks || []).find((task) => Number(task.id) === evidenceTaskId);
  if (!reusedOwnerState.ok || reusedOwnerTask?.owner_evidence_state !== 'dead' ||
      !reusedOwnerTask?.owner_stale || !reusedOwnerTask?.takeover_ready) {
    fail(`state API let a live tmux target override reused owner-process evidence:\n${JSON.stringify(reusedOwnerTask, null, 2)}`);
  }
  const reusedOwnerTakeoverResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/task-takeover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action_token: managedActionToken,
      id: evidenceTaskId,
      reason: 'owner process identity was reused',
      policy: 'stale',
      stale_after: 60
    })
  }, { root });
  const reusedOwnerTakeover = await reusedOwnerTakeoverResponse.json();
  if (!reusedOwnerTakeoverResponse.ok || reusedOwnerTakeover.data?.task?.owner !== managedActionPeer) {
    fail(`web takeover let a live tmux target retain dead owner authority:\n${JSON.stringify(reusedOwnerTakeover, null, 2)}`);
  }
  hcc(['task', 'takeover', '--peer', evidenceOwner, '--id', String(evidenceTaskId),
    '--reason', 'restore verified owner fixture', '--force']);

  withMeshDb((db) => db.prepare(`
    UPDATE peers
    SET pid = ?, pid_start_token = ?, pid_command_hash = ?, last_seen_at = ?
    WHERE id = ?
  `).run(
    evidenceOwnerPid,
    evidenceOwnerIdentity.startToken,
    evidenceOwnerIdentity.commandHash,
    staleEvidenceAt,
    evidenceOwner
  ));
  const liveExpiredResource = 'web/live-expired-lock';
  withMeshDb((db) => db.prepare(`
    INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at, ttl_sec)
    VALUES (?, ?, '*', ?, ?, 'live expired evidence', ?, ?, 60)
    ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, task_id = excluded.task_id,
      reason = excluded.reason, expires_at = excluded.expires_at, created_at = excluded.created_at, ttl_sec = excluded.ttl_sec
  `).run(liveExpiredResource, liveExpiredResource, evidenceOwner, evidenceTaskId,
    Math.floor(Date.now() / 1000) - 60, staleEvidenceAt));
  const liveEvidenceState = await (await runtimeFetch('/api/peers/web-action-peer/actions/state', {}, { root })).json();
  const liveEvidenceTask = (liveEvidenceState.data?.tasks || []).find((task) => Number(task.id) === evidenceTaskId);
  const liveEvidenceLock = (liveEvidenceState.data?.locks || []).find((lock) => lock.resource === liveExpiredResource);
  if (!liveEvidenceState.ok || liveEvidenceTask?.owner_evidence_state !== 'live' ||
      liveEvidenceTask?.owner_stale || liveEvidenceTask?.takeover_ready || !liveEvidenceLock) {
    fail(`state API omitted verified-live task/expired-lock evidence:\n${JSON.stringify({ liveEvidenceTask, liveEvidenceLock }, null, 2)}`);
  }
  const liveEvidenceStatus = await (await runtimeFetch('/api/peers/web-action-peer/actions/status', {}, { root })).json();
  if (!liveEvidenceStatus.ok || Number(liveEvidenceStatus.data?.active_locks || 0) < 1) {
    fail(`status API omitted expired lock owned by a verified-live peer:\n${JSON.stringify(liveEvidenceStatus, null, 2)}`);
  }
  const evidenceHookPayload = JSON.stringify({
    session_id: 'web-evidence-hook-viewer-session',
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'inspect live evidence owner'
  });
  const evidenceHook = hookContext(hcc(['hook', 'userpromptsubmit'], {
    env: { ...env, HCC_PEER: 'web-evidence-hook-viewer' },
    input: evidenceHookPayload
  }), 'UserPromptSubmit');
  if (!evidenceHook.includes(`#${evidenceTaskId} claimed owner=${evidenceOwner} assignee=${evidenceOwner} owner_state=active`) ||
      !evidenceHook.includes(liveExpiredResource)) {
    fail(`hook snapshot omitted verified-live task/expired lock:\n${evidenceHook}`);
  }
  const liveLockResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/lock-acquire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: managedActionToken, resource: liveExpiredResource, ttl: 60 })
  }, { root });
  const liveLockResult = await liveLockResponse.json();
  if (liveLockResponse.ok || liveLockResult.error?.code !== 'LOCK_HELD') {
    fail(`web lock acquisition overwrote an expired lock owned by a verified-live peer:\n${JSON.stringify(liveLockResult, null, 2)}`);
  }

  const deadLockOwner = 'web-dead-expired-owner';
  const deadLockResource = 'web/dead-expired-lock';
  const deadLockPid = spawnSync('true', [], { stdio: 'ignore' }).pid;
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000) - 7200;
    db.prepare(`
      INSERT INTO peers(id, kind, role, pid, pid_start_token, pid_command_hash, status, created_at, last_seen_at)
      VALUES (?, 'shell', 'peer', ?, 'dead:web-lock', ?, 'working', ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, pid_start_token = excluded.pid_start_token,
        pid_command_hash = excluded.pid_command_hash, status = excluded.status, last_seen_at = excluded.last_seen_at
    `).run(deadLockOwner, deadLockPid, 'd'.repeat(64), t, t);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at, ttl_sec)
      VALUES (?, ?, '*', ?, NULL, 'dead expired evidence', ?, ?, 60)
      ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at,
        created_at = excluded.created_at, ttl_sec = excluded.ttl_sec
    `).run(deadLockResource, deadLockResource, deadLockOwner, t, t);
  });
  const deadLockResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionPeer)}/actions/lock-acquire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_token: managedActionToken, resource: deadLockResource, ttl: 60 })
  }, { root });
  const deadLockResult = await deadLockResponse.json();
  if (!deadLockResponse.ok || !deadLockResult.ok || deadLockResult.data?.lock?.owner !== managedActionPeer) {
    fail(`web lock acquisition did not replace an expired lock owned by a confirmed-dead peer:\n${JSON.stringify(deadLockResult, null, 2)}`);
  }
  hcc(['lock', 'release', '--peer', managedActionPeer, '--resource', deadLockResource]);
  hcc(['lock', 'release', '--peer', 'human', '--resource', liveExpiredResource, '--force']);
  hcc(['task', 'takeover', '--peer', 'human', '--id', String(evidenceTaskId), '--reason', 'web evidence cleanup', '--force']);
  hcc(['task', 'update', '--peer', 'human', '--id', String(evidenceTaskId), '--status', 'abandoned', '--summary', 'web evidence cleanup']);
  await stopSession(evidenceOwnerSession.id);

  const actionHeartbeat = await (await runtimeFetch('/api/peers/web-action-peer/actions/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ renew_locks: true })
  }, { root })).json();
  if (actionHeartbeat.ok || actionHeartbeat.error?.code !== 'PEER_IDENTITY_REQUIRED') {
    fail(`web heartbeat accepted unmanaged peer identity:\n${JSON.stringify(actionHeartbeat, null, 2)}`);
  }

  const ownerTask = hcc(['task', 'create', '--from', 'web-lock-owner', '--title', 'web lock owner task']);
  const ownerTaskMatch = ownerTask.match(/created task #(\d+):/);
  if (!ownerTaskMatch) fail(`cannot parse web lock owner task id:\n${ownerTask}`);
  hcc(['task', 'claim', '--peer', 'web-lock-owner', '--id', ownerTaskMatch[1]]);
  const rejectedLockResponse = await runtimeFetch(`/api/peers/${encodeURIComponent(managedActionSession.peer_id || managedActionSession.id)}/actions/lock-acquire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action_token: managedActionToken,
      resource: 'web/identity-spoof-lock',
      task: Number(ownerTaskMatch[1])
    })
  }, { root });
  const rejectedLock = await rejectedLockResponse.json();
  if (rejectedLockResponse.ok || rejectedLock.error?.code !== 'TASK_OWNED') {
    fail(`web lock-acquire did not enforce task owner:\n${JSON.stringify(rejectedLock, null, 2)}`);
  }
  const lockRowsAfterReject = hccJson(['lock', 'list', '--all']);
  if (lockRowsAfterReject.some((lock) => lock.resource === 'web/identity-spoof-lock')) {
    fail(`rejected web lock-acquire still inserted a lock:\n${JSON.stringify(lockRowsAfterReject, null, 2)}`);
  }
  hcc(['task', 'done', '--peer', managedActionSession.peer_id || managedActionSession.id, '--id', taskMatch[1], '--summary', 'web action cleanup'], {
    env: { ...env, HCC_PEER: managedActionSession.peer_id || managedActionSession.id }
  });
  hcc(['task', 'done', '--peer', 'web-lock-owner', '--id', ownerTaskMatch[1], '--summary', 'web lock owner cleanup'], {
    env: { ...env, HCC_PEER: 'web-lock-owner' }
  });
  await closeTerminalWebSocket(managedActionChannel.ws);
  await stopSession(managedActionSession.id);

  hcc(['register', '--peer', 'detected-msg-peer', '--kind', 'codex', '--role', 'peer']);
  const spoofedDetectedMessage = await (await runtimeFetch('/api/detected/detected-msg-peer/msg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'web-action-peer', body: 'detected sender spoof attempt' })
  }, { root })).json();
  if (!spoofedDetectedMessage.ok) fail(`detected message send failed:\n${JSON.stringify(spoofedDetectedMessage, null, 2)}`);
  const detectedInbox = hccJson(['msg', 'inbox', '--peer', 'detected-msg-peer', '--all']);
  const detectedMsg = detectedInbox.find((message) => message.body === 'detected sender spoof attempt');
  if (!detectedMsg || detectedMsg.sender !== 'web') {
    fail(`detected message sender spoof was not forced to web:\n${JSON.stringify(detectedInbox, null, 2)}`);
  }

  const claudeResumeName = `web-claude-resume-${testId}`;
  const claudeResume = await startProvider({ kind: 'claude', mode: 'resume', resume: claudeResumeName });
  const expectedClaudePeer = `claude-${shortHash(claudeResumeName)}`;
  if (!claudeResume.command.includes(`claude --resume ${claudeResumeName}`)) {
    fail(`web claude resume command wrong:\n${JSON.stringify(claudeResume, null, 2)}`);
  }
  if (claudeResume.id !== expectedClaudePeer || claudeResume.peer_id !== expectedClaudePeer) {
    fail(`web claude resume did not use canonical provider peer id ${expectedClaudePeer}:\n${JSON.stringify(claudeResume, null, 2)}`);
  }
  if (!claudeResume.binding || !claudeResume.provider_session_known || claudeResume.provider_session_label !== claudeResumeName) {
    fail(`web claude resume session response did not include known provider binding:\n${JSON.stringify(claudeResume, null, 2)}`);
  }
  const claudeRows = providerBindingRows('claude', claudeResumeName);
  if (claudeRows.length !== 1 ||
      claudeRows[0].peer !== claudeResume.peer_id ||
      claudeRows[0].resume_mode !== 'resume' ||
      claudeRows[0].resume_arg !== claudeResumeName ||
      claudeRows[0].transport !== 'tmux' ||
      !claudeRows[0].runtime_target) {
    fail(`web claude resume binding wrong:\n${JSON.stringify(claudeRows, null, 2)}`);
  }
  await stopSession(claudeResume.id);

  const codexResumeName = `web-codex-resume-${testId}`;
  const codexResume = await startProvider({ kind: 'codex', mode: 'resume', resume: codexResumeName });
  const expectedCodexPeer = `codex-${shortHash(codexResumeName)}`;
  if (!codexResume.command.includes(`codex resume ${codexResumeName}`)) {
    fail(`web codex resume command wrong:\n${JSON.stringify(codexResume, null, 2)}`);
  }
  if (codexResume.id !== expectedCodexPeer || codexResume.peer_id !== expectedCodexPeer) {
    fail(`web codex resume did not use canonical provider peer id ${expectedCodexPeer}:\n${JSON.stringify(codexResume, null, 2)}`);
  }
  if (!codexResume.binding || !codexResume.provider_session_known || codexResume.provider_session_label !== codexResumeName) {
    fail(`web codex resume session response did not include known provider binding:\n${JSON.stringify(codexResume, null, 2)}`);
  }
  const codexRows = providerBindingRows('codex', codexResumeName);
  if (codexRows.length !== 1 ||
      codexRows[0].peer !== codexResume.peer_id ||
      codexRows[0].resume_mode !== 'resume' ||
      codexRows[0].resume_arg !== codexResumeName ||
      codexRows[0].transport !== 'tmux' ||
      !codexRows[0].runtime_target) {
    fail(`web codex resume binding wrong:\n${JSON.stringify(codexRows, null, 2)}`);
  }
  await stopSession(codexResume.id);
  const codexRowsAfterStop = providerBindingRows('codex', codexResumeName);
  if (codexRowsAfterStop.length !== 1 || codexRowsAfterStop[0].peer !== expectedCodexPeer) {
    fail(`web codex resume binding was not stable after stop:\n${JSON.stringify(codexRowsAfterStop, null, 2)}`);
  }

  const resumableResponse = await runtimeFetch('/api/resumable', {}, { root });
  const resumableJson = await resumableResponse.json();
  if (!resumableResponse.ok) fail(`resumable API failed: ${JSON.stringify(resumableJson)}`);
  const resumableRows = resumableJson.resumable || [];
  const claudeResumable = resumableRows.find((row) => row.provider === 'claude' && row.resume === claudeResumeName);
  const codexResumable = resumableRows.find((row) => row.provider === 'codex' && row.resume === codexResumeName);
  if (!claudeResumable || claudeResumable.session_name !== claudeResumeName || claudeResumable.session_id !== null) {
    fail(`resumable API omitted named claude resume session:\n${JSON.stringify(resumableRows, null, 2)}`);
  }
  if (!codexResumable || codexResumable.session_name !== codexResumeName || codexResumable.session_id !== null) {
    fail(`resumable API omitted named codex resume session:\n${JSON.stringify(resumableRows, null, 2)}`);
  }

  const codexLast = await startProvider({ kind: 'codex', mode: 'last' });
  if (codexLast.command !== 'codex resume --last') {
    fail(`web codex last command wrong:\n${JSON.stringify(codexLast, null, 2)}`);
  }
  await stopSession(codexLast.id);

  const claudeContinue = await startProvider({ kind: 'claude', mode: 'continue' });
  if (claudeContinue.command !== 'claude --continue') {
    fail(`web claude continue command wrong:\n${JSON.stringify(claudeContinue, null, 2)}`);
  }
  await stopSession(claudeContinue.id);

  const badShellResume = await runtimeFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'shell', mode: 'resume', resume: 'not-supported' })
  }, { root });
  if (badShellResume.ok) {
    fail('web shell resume was accepted');
  }

  const startAuto = async () => {
    const response = await runtimeFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', command: 'bash --noprofile --norc' })
    }, { root: otherRoot });
    const json = await response.json();
    if (!response.ok) fail(`auto web session start failed: ${JSON.stringify(json)}`);
    return json.session;
  };
  const autoOne = await startAuto();
  const autoTwo = await startAuto();
  if (!autoOne.id.startsWith('shell-') || !autoTwo.id.startsWith('shell-') || autoOne.id === autoTwo.id) {
    fail(`auto web session ids were not unique: ${autoOne.id}, ${autoTwo.id}`);
  }
  await runtimeFetch(`/api/sessions/${encodeURIComponent(autoOne.id)}/stop`, { method: 'POST' }, { root: otherRoot });
  await runtimeFetch(`/api/sessions/${encodeURIComponent(autoTwo.id)}/stop`, { method: 'POST' }, { root: otherRoot });
  hccFromMaybe(['peer', 'stop', 'other-shell'], otherRoot);
}

async function statusServer(status) {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(${status}, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'RUNTIME_VERSION_UNSUPPORTED', message: 'unsupported runtime' } }));
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out starting ${status} status server`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/^(\d+)\n/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${status} status server exited early with ${code}`));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      child.kill('SIGTERM');
      try { await waitForProcessExit(child.pid, `${status} status server exit`, 3000); } catch {}
    }
  };
}

async function stalledRuntimeServer(phase) {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      if (${JSON.stringify(phase)} === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"deleted":0');
      }
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    process.on('SIGTERM', () => {
      for (const socket of sockets) socket.destroy();
      server.close(() => process.exit(0));
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out starting ${phase} stalled runtime`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/^(\d+)\n/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${phase} stalled runtime exited early with ${code}`));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      child.kill('SIGTERM');
      try { await waitForProcessExit(child.pid, `${phase} stalled runtime exit`, 3000); } catch {}
    }
  };
}

function bufferGcCanonicalizationRaceWorkflow() {
  for (const phase of ['before', 'after']) {
    const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-realpath-${phase}-${testId}-`));
    const directory = path.join(raceRoot, 'bufs');
    const movedDirectory = path.join(raceRoot, 'moved-bufs');
    const outsideDirectory = path.join(raceRoot, 'outside');
    fs.mkdirSync(directory);
    fs.mkdirSync(outsideDirectory);
    const cutoffMs = Date.now() - 60_000;
    let outsideFile = path.join(outsideDirectory, 'outside.out');
    fs.writeFileSync(outsideFile, 'outside');
    fs.utimesSync(outsideFile, new Date(cutoffMs - 60_000), new Date(cutoffMs - 60_000));
    const originalRealpathSync = fs.realpathSync;
    let replaced = false;
    try {
      fs.realpathSync = function interceptedRealpath(value, ...args) {
        const matches = !replaced && path.resolve(String(value)) === path.resolve(directory);
        if (matches && phase === 'before') {
          replaced = true;
          fs.renameSync(directory, movedDirectory);
          fs.symlinkSync(outsideDirectory, directory);
        }
        const resolved = originalRealpathSync.call(this, value, ...args);
        if (matches && phase === 'after') {
          replaced = true;
          fs.renameSync(directory, movedDirectory);
          fs.mkdirSync(directory);
          outsideFile = path.join(directory, 'outside.out');
          fs.writeFileSync(outsideFile, 'replacement');
          fs.utimesSync(outsideFile, new Date(cutoffMs - 60_000), new Date(cutoffMs - 60_000));
        }
        return resolved;
      };
      const plan = planBufferFiles({ directories: [directory], cutoffMs });
      const result = applyBufferPlan(plan);
      if (plan.deletePaths.length !== 0 || result.deleted !== 0 || !fs.existsSync(outsideFile)) {
        fail(`buffer GC scanned a ${phase}-realpath replacement: ${JSON.stringify({ plan, result })}`);
      }
    } finally {
      fs.realpathSync = originalRealpathSync;
      fs.rmSync(raceRoot, { recursive: true, force: true });
    }
  }
}

async function bufferGcArbitrationWorkflow() {
  log('buffer GC: runtime arbitration, exact active paths, and safe fallback');
  bufferGcCanonicalizationRaceWorkflow();
  const runtime = currentRuntime();
  const unauthorized = await fetch(new URL('/api/runtime/gc-buffers', runtime.base_url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HCC-API-Version': '2' },
    body: JSON.stringify({ cutoffMs: Date.now(), dryRun: true })
  });
  if (unauthorized.status !== 401) fail(`buffer GC endpoint allowed missing auth: ${unauthorized.status}`);

  const legacyResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cutoffMs: Date.now(), observedAt: 1, retentionSec: 0, dryRun: true })
  }, { root: secondProjectRoot });
  if (legacyResponse.status !== 400) {
    fail(`buffer GC endpoint accepted legacy client timing: ${legacyResponse.status}`);
  }
  const forgedResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: true, observedAt: 1 })
  }, { root: secondProjectRoot });
  if (forgedResponse.status !== 400) {
    fail(`buffer GC endpoint accepted a forged timing tuple: ${forgedResponse.status}`);
  }
  const previewResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: true })
  }, { root: secondProjectRoot });
  const preview = await previewResponse.json();
  if (!previewResponse.ok || Object.hasOwn(preview, 'token') ||
      !Number.isSafeInteger(preview.observedAt) ||
      preview.cutoffMs !== preview.observedAt * 1000 ||
      !Array.isArray(preview.gcCutoffs)) {
    fail(`buffer GC dry-run prepare returned an invalid preview: ${JSON.stringify(preview)}`);
  }
  const boundPrepareResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: false })
  }, { root: secondProjectRoot });
  const boundPrepare = await boundPrepareResponse.json();
  if (!boundPrepareResponse.ok || !/^[A-Za-z0-9_-]{43}$/.test(boundPrepare.token || '')) {
    fail(`buffer GC apply prepare omitted its one-shot token: ${JSON.stringify(boundPrepare)}`);
  }
  const mismatchResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'apply', token: boundPrepare.token })
  }, { root });
  if (mismatchResponse.ok) fail('buffer GC token was not bound to its prepared project');
  const mismatchReplay = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'apply', token: boundPrepare.token })
  }, { root: secondProjectRoot });
  if (mismatchReplay.ok) fail('buffer GC binding mismatch did not consume the token');
  const replayPrepareResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: false })
  }, { root: secondProjectRoot });
  const replayPrepare = await replayPrepareResponse.json();
  const firstApply = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'apply', token: replayPrepare.token })
  }, { root: secondProjectRoot });
  const replayApply = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'apply', token: replayPrepare.token })
  }, { root: secondProjectRoot });
  if (!firstApply.ok || replayApply.ok) fail('buffer GC token was not exactly once');

  const cutoffMs = Date.now() - 60_000;
  const oldTime = new Date(cutoffMs - 60_000);
  const rootBufs = path.join(root, '.hello-cc', 'bufs');
  const siblingBufs = path.join(secondProjectRoot, '.hello-cc', 'bufs');
  fs.mkdirSync(rootBufs, { recursive: true });
  fs.mkdirSync(siblingBufs, { recursive: true });
  const rootOrphan = path.join(rootBufs, `gc-orphan-${testId}.out`);
  const siblingOrphan = path.join(siblingBufs, `gc-sibling-orphan-${testId}.out`);
  fs.writeFileSync(rootOrphan, 'orphan');
  fs.writeFileSync(siblingOrphan, 'sibling orphan');
  fs.utimesSync(rootOrphan, oldTime, oldTime);
  fs.utimesSync(siblingOrphan, oldTime, oldTime);

  const liveId = `gc-live-external-${testId}`;
  const liveFiles = ['out', 'in', 'resize', 'meta'].map((suffix) => path.join(rootBufs, `${liveId}.${suffix}`));
  for (const file of liveFiles.slice(0, 3)) fs.writeFileSync(file, file.endsWith('.out') ? 'live\n' : '');
  const identity = inspectProcessIdentity(process.pid).identity;
  fs.writeFileSync(liveFiles[3], JSON.stringify({
    id: liveId,
    kind: 'shell',
    role: 'peer',
    command: 'regression live external',
    cwd: root,
    pid: process.pid,
    wrapper_pid: process.pid,
    child_identity: identity,
    wrapper_identity: identity,
    cols: 120,
    rows: 40
  }));
  await waitFor(async () => {
    const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
    return (data.sessions || []).some((session) => session.id === liveId);
  }, 'buffer GC live external adoption');
  for (const file of liveFiles) fs.utimesSync(file, oldTime, oldTime);

  const legacyId = `gc-legacy-${testId}`;
  const legacyFiles = ['out', 'in', 'resize', 'meta'].map((suffix) => path.join(rootBufs, `${legacyId}.${suffix}`));
  for (const file of legacyFiles.slice(0, 3)) fs.writeFileSync(file, '');
  fs.writeFileSync(legacyFiles[3], JSON.stringify({ id: legacyId, pid: process.pid, wrapper_pid: process.pid }));
  for (const file of legacyFiles) fs.utimesSync(file, oldTime, oldTime);
  await waitFor(async () => {
    const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
    return (data.sessions || []).some((session) => session.id === legacyId);
  }, 'buffer GC legacy external adoption');

  const siblingLiveId = `gc-sibling-external-${testId}`;
  const siblingLiveFiles = ['out', 'in', 'resize', 'meta']
    .map((suffix) => path.join(siblingBufs, `${siblingLiveId}.${suffix}`));
  for (const file of siblingLiveFiles.slice(0, 3)) fs.writeFileSync(file, '');
  fs.writeFileSync(siblingLiveFiles[3], JSON.stringify({
    id: siblingLiveId,
    kind: 'shell',
    role: 'peer',
    command: 'regression sibling external',
    cwd: secondProjectRoot,
    pid: process.pid,
    wrapper_pid: process.pid,
    child_identity: identity,
    wrapper_identity: identity,
    cols: 120,
    rows: 40
  }));
  await waitFor(async () => {
    const data = await (await runtimeFetch('/api/sessions', {}, { root: secondProjectRoot })).json();
    return (data.sessions || []).some((session) => session.id === siblingLiveId);
  }, 'buffer GC sibling external adoption');
  for (const file of siblingLiveFiles) fs.utimesSync(file, oldTime, oldTime);

  const isolatedProjectPreviewResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: true })
  }, { root: secondProjectRoot });
  const isolatedProjectPreview = await isolatedProjectPreviewResponse.json();
  if (!isolatedProjectPreviewResponse.ok || isolatedProjectPreview.deleted !== 1) {
    fail(`buffer GC scanned another project's unrelated actual directory: ${JSON.stringify(isolatedProjectPreview)}`);
  }

  let siblingPeer = null;
  let siblingPipe = null;
  if (tmuxAvailable()) {
    siblingPeer = `gc-sibling-live-${testId}`;
    const started = hccFrom(['peer', 'start', siblingPeer, '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], secondProjectRoot);
    const pane = parsePane(started);
    const safePane = pane.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeId = siblingPeer.replace(/[^a-zA-Z0-9_-]/g, '');
    siblingPipe = path.join(siblingBufs, `tmux-${safePane}-${safeId}.pipe`);
    await waitFor(() => fs.existsSync(siblingPipe), 'sibling-project tmux FIFO');
    fs.utimesSync(siblingPipe, oldTime, oldTime);
  }

  const siblingDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    siblingDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    siblingDb.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
  } finally {
    siblingDb.close();
  }
  const graceRacePrepareResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'prepare', retentionSec: 0, dryRun: false })
  }, { root: secondProjectRoot });
  const graceRacePrepare = await graceRacePrepareResponse.json();
  const graceRaceDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    graceRaceDb.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000) + 120));
  } finally {
    graceRaceDb.close();
  }
  const graceRaceApplyResponse = await runtimeFetch('/api/runtime/gc-buffers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'apply', token: graceRacePrepare.token })
  }, { root: secondProjectRoot });
  const graceRaceApply = await graceRaceApplyResponse.json();
  if (!graceRaceApplyResponse.ok || Number(graceRaceApply.deleted || 0) !== 0 ||
      Number(graceRaceApply.deferred || 0) < 1 || graceRaceApply.complete !== false ||
      !fs.existsSync(rootOrphan) || !fs.existsSync(siblingOrphan)) {
    fail(`runtime buffer apply ignored grace extended after prepare: ${JSON.stringify(graceRaceApply)}`);
  }
  const clearGraceRaceDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    clearGraceRaceDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    clearGraceRaceDb.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
  } finally {
    clearGraceRaceDb.close();
  }
  const aliasContainer = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-alias-${testId}-`));
  const parentAlias = path.join(aliasContainer, 'parent');
  fs.symlinkSync(path.dirname(secondProjectRoot), parentAlias);
  const siblingAliasRoot = path.join(parentAlias, path.basename(secondProjectRoot));
  const gcOutput = hccFrom(['--json', 'gc', '--older-than', '0', '--yes'], siblingAliasRoot);
  fs.rmSync(aliasContainer, { recursive: true, force: true });
  const gcPayload = JSON.parse(gcOutput);
  const result = gcPayload.data || {};
  const expectedSiblingProtected = siblingLiveFiles.length + (siblingPipe ? 1 : 0);
  if (result.buf_files !== 1 || result.protected_buf_files < expectedSiblingProtected ||
      result.deferred_buf_files !== 0) {
    fail(`sibling buffer GC endpoint returned incomplete counts: ${JSON.stringify(result)}`);
  }
  if (fs.existsSync(siblingOrphan) || !fs.existsSync(rootOrphan)) {
    fail('sibling buffer GC crossed project directory ownership');
  }

  const rootGcClockDb = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    rootGcClockDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    rootGcClockDb.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
  } finally {
    rootGcClockDb.close();
  }
  const rootGcPayload = JSON.parse(hcc(['--json', 'gc', '--older-than', '0', '--yes']));
  const rootGcResult = rootGcPayload.data || {};
  if (rootGcResult.buf_files !== 1 || rootGcResult.protected_buf_files < liveFiles.length ||
      rootGcResult.deferred_buf_files < legacyFiles.length || fs.existsSync(rootOrphan)) {
    fail(`primary buffer GC endpoint returned incomplete evidence counts: ${JSON.stringify(rootGcResult)}`);
  }
  for (const file of [
    ...liveFiles,
    ...legacyFiles,
    ...siblingLiveFiles,
    ...(siblingPipe ? [siblingPipe] : [])
  ]) {
    if (!fs.existsSync(file)) fail(`buffer GC removed active/unknown file: ${file}`);
  }
  if (siblingPeer) hccFromMaybe(['peer', 'stop', siblingPeer], secondProjectRoot);

  const setSiblingClockGap = (boundary) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const clockDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
    try {
      clockDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
      clockDb.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(nowSec));
      clockDb.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_pending_gap', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify({
        from: Math.max(0, boundary - 1),
        to: nowSec,
        backward: false,
        first: false
      }));
    } finally {
      clockDb.close();
    }
  };
  const clearSiblingClockSafety = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const clockDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
    try {
      clockDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
      clockDb.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(nowSec));
    } finally {
      clockDb.close();
    }
  };

  const gapOrphan = path.join(siblingBufs, `gc-actual-dir-gap-${testId}.out`);
  fs.writeFileSync(gapOrphan, 'actual directory pending gap');
  fs.utimesSync(gapOrphan, oldTime, oldTime);
  const unifiedIds = {};
  const unifiedDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    const oldSec = Math.floor(oldTime.getTime() / 1000);
    unifiedDb.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, status, capabilities, created_at, last_seen_at)
      VALUES ('gc-unified-dead', 'shell', 'peer', ?, '', 'exited', '', ?, ?)
    `).run(secondProjectRoot, oldSec, oldSec);
    unifiedDb.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
      VALUES ('gc-unified-lock', 'gc-unified-lock', '*', 'gc-unified-dead', 'expired', ?, ?, 90)
    `).run(oldSec, oldSec);
    unifiedIds.event = Number(unifiedDb.prepare(`
      INSERT INTO events(type, actor, payload, created_at)
      VALUES ('gc.unified.clock', 'seed', '{}', ?) RETURNING id
    `).get(oldSec).id);
  } finally {
    unifiedDb.close();
  }
  setSiblingClockGap(Math.floor(fs.statSync(gapOrphan).mtimeMs / 1000));
  const beforeGapPreviewDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  let beforeGapMeta;
  try {
    beforeGapMeta = beforeGapPreviewDb.prepare('SELECT key, value FROM meta ORDER BY key').all();
  } finally {
    beforeGapPreviewDb.close();
  }
  const gapPreview = JSON.parse(hccFrom(['--json', 'gc', '--older-than', '0', '--history'], secondProjectRoot)).data;
  const afterGapPreviewDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    const afterGapMeta = afterGapPreviewDb.prepare('SELECT key, value FROM meta ORDER BY key').all();
    if (JSON.stringify(afterGapMeta) !== JSON.stringify(beforeGapMeta) ||
        !afterGapPreviewDb.prepare('SELECT 1 FROM events WHERE id = ?').get(unifiedIds.event) ||
        !afterGapPreviewDb.prepare("SELECT 1 FROM locks WHERE resource = 'gc-unified-lock'").get() ||
        !afterGapPreviewDb.prepare("SELECT 1 FROM peers WHERE id = 'gc-unified-dead'").get()) {
      fail(`manual GC dry-run changed unified clock state: ${JSON.stringify({ beforeGapMeta, afterGapMeta })}`);
    }
  } finally {
    afterGapPreviewDb.close();
  }
  if (Number(gapPreview.deferred_buf_files || 0) < 1 ||
      Number(gapPreview.deferred_old_events || 0) < 1 ||
      Number(gapPreview.deferred_expired_locks || 0) < 1 ||
      Number(gapPreview.deferred_stale_peers || 0) < 1) {
    fail(`manual GC dry-run did not predict unified grace deferral: ${JSON.stringify(gapPreview)}`);
  }

  const gapGc = JSON.parse(hccFrom(['--json', 'gc', '--older-than', '0', '--history', '--yes'], secondProjectRoot)).data;
  if (!fs.existsSync(gapOrphan) || Number(gapGc.buf_files || 0) !== 0 ||
      Number(gapGc.deferred_buf_files || 0) < 1 ||
      Number(gapGc.protected_buf_files || 0) < siblingLiveFiles.length ||
      Number(gapGc.deferred_old_events || 0) < 1 ||
      Number(gapGc.deferred_expired_locks || 0) < 1 ||
      Number(gapGc.deferred_stale_peers || 0) < 1) {
    fail(`actual runtime buffer directory ignored clock pending gap: ${JSON.stringify(gapGc)}`);
  }
  const afterGapApplyDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    if (!afterGapApplyDb.prepare('SELECT 1 FROM events WHERE id = ?').get(unifiedIds.event) ||
        !afterGapApplyDb.prepare("SELECT 1 FROM locks WHERE resource = 'gc-unified-lock'").get() ||
        !afterGapApplyDb.prepare("SELECT 1 FROM peers WHERE id = 'gc-unified-dead'").get()) {
      fail('manual GC applied a database plan after runtime grace deferral');
    }
  } finally {
    afterGapApplyDb.close();
  }

  clearSiblingClockSafety();
  const normalOrphan = path.join(siblingBufs, `gc-actual-dir-normal-${testId}.out`);
  fs.writeFileSync(normalOrphan, 'actual directory normal baseline');
  fs.utimesSync(normalOrphan, oldTime, oldTime);
  const normalGc = JSON.parse(hccFrom(['--json', 'gc', '--older-than', '0', '--yes'], secondProjectRoot)).data;
  if (fs.existsSync(gapOrphan) || fs.existsSync(normalOrphan) || Number(normalGc.buf_files || 0) < 2) {
    fail(`actual runtime buffer directory did not delete against a live baseline: ${JSON.stringify(normalGc)}`);
  }

  const failureRetentionDays = 100;
  const failureRetentionSec = failureRetentionDays * 86400;
  const failureOrphan = path.join(siblingBufs, `gc-actual-dir-clock-failure-${testId}.out`);
  const failureMtime = new Date((Math.floor(Date.now() / 1000) - 101 * 86400) * 1000);
  fs.writeFileSync(failureOrphan, 'actual directory clock persistence failure');
  fs.utimesSync(failureOrphan, failureMtime, failureMtime);
  setSiblingClockGap(Math.floor(fs.statSync(failureOrphan).mtimeMs / 1000) + failureRetentionSec);
  const failureDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    failureDb.exec(`
      CREATE TRIGGER fail_runtime_buffer_gc_clock_grace
      BEFORE INSERT ON meta
      WHEN NEW.key = 'clock_grace_until'
      BEGIN
        SELECT RAISE(ABORT, 'runtime buffer clock persistence failure');
      END
    `);
  } finally {
    failureDb.close();
  }
  const failedGc = hccFromMaybe(
    ['--json', 'gc', '--older-than', String(failureRetentionDays), '--yes'],
    secondProjectRoot
  );
  const failedGcOutput = `${failedGc.stdout || ''}\n${failedGc.stderr || ''}`;
  if (failedGc.status === 0 || !/"code"\s*:\s*"CLOCK_SAFETY_UNAVAILABLE"/.test(failedGcOutput) ||
      !fs.existsSync(failureOrphan)) {
    fail(`runtime buffer clock persistence failure did not fail closed:\n${failedGcOutput}`);
  }
  const cleanupFailureDb = new DatabaseSync(path.join(secondProjectRoot, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    cleanupFailureDb.exec('DROP TRIGGER fail_runtime_buffer_gc_clock_grace');
    cleanupFailureDb.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
  } finally {
    cleanupFailureDb.close();
  }
  fs.rmSync(failureOrphan, { force: true });
  for (const file of [...liveFiles, ...legacyFiles, ...siblingLiveFiles]) {
    fs.rmSync(file, { force: true });
  }

  for (const status of ['unreachable', 404, 426]) {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-${status}-${testId}-`));
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-home-${status}-${testId}-`));
    let server = null;
    try {
      const isolatedEnv = { ...env, HOME: isolatedHome };
      run(process.execPath, [hccBin, '--root', isolatedRoot, 'init', '--no-guidance'], { env: isolatedEnv });
      const directory = path.join(isolatedRoot, '.hello-cc', 'bufs');
      fs.mkdirSync(directory, { recursive: true });
      const orphan = path.join(directory, 'old-orphan.out');
      fs.writeFileSync(orphan, 'orphan');
      fs.utimesSync(orphan, oldTime, oldTime);
      if (status !== 'unreachable') server = await statusServer(status);
      const pointer = {
        pid: process.pid,
        base_url: server?.baseUrl || 'http://127.0.0.1:1',
        token: 'regression-token'
      };
      fs.writeFileSync(path.join(isolatedRoot, '.hello-cc', 'runtime.json'), JSON.stringify(pointer));
      const gc = run(process.execPath, [hccBin, '--root', isolatedRoot, '--json', 'gc', '--older-than', '0', '--yes'], { env: isolatedEnv });
      const payload = JSON.parse(gc);
      if (!fs.existsSync(orphan) || Number(payload.data?.deferred_buf_files || 0) < 1) {
        fail(`runtime ${status} did not defer eligible buffer cleanup: ${gc}`);
      }
    } finally {
      await server?.close();
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  for (const phase of ['headers', 'body']) {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-stall-${phase}-${testId}-`));
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-stall-home-${phase}-${testId}-`));
    let server = null;
    try {
      const isolatedEnv = { ...env, HOME: isolatedHome };
      run(process.execPath, [hccBin, '--root', isolatedRoot, 'init', '--no-guidance'], { env: isolatedEnv });
      const directory = path.join(isolatedRoot, '.hello-cc', 'bufs');
      fs.mkdirSync(directory, { recursive: true });
      const orphan = path.join(directory, 'old-orphan.out');
      fs.writeFileSync(orphan, 'orphan');
      fs.utimesSync(orphan, oldTime, oldTime);
      server = await stalledRuntimeServer(phase);
      fs.writeFileSync(path.join(isolatedRoot, '.hello-cc', 'runtime.json'), JSON.stringify({
        pid: process.pid,
        base_url: server.baseUrl,
        token: 'regression-token'
      }));

      const startedAt = Date.now();
      const gc = run(process.execPath, [hccBin, '--root', isolatedRoot, '--json', 'gc', '--older-than', '0', '--yes'], { env: isolatedEnv });
      const elapsedMs = Date.now() - startedAt;
      const payload = JSON.parse(gc);
      if (elapsedMs >= 9000 ||
          Number(payload.data?.buf_files || 0) !== 0 ||
          Number(payload.data?.deferred_buf_files || 0) < 1 ||
          !fs.existsSync(orphan)) {
        fail(`runtime ${phase} stall did not fail closed within deadline (${elapsedMs}ms): ${gc}`);
      }
    } finally {
      await server?.close();
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-local-${testId}-`));
  const localHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-buffer-gc-local-home-${testId}-`));
  try {
    const localEnv = { ...env, HOME: localHome };
    run(process.execPath, [hccBin, '--root', localRoot, 'init', '--no-guidance'], { env: localEnv });
    const directory = path.join(localRoot, '.hello-cc', 'bufs');
    fs.mkdirSync(directory, { recursive: true });
    const files = ['out', 'in', 'resize', 'meta'].map((suffix) => path.join(directory, `legacy-local.${suffix}`));
    for (const file of files.slice(0, 3)) fs.writeFileSync(file, '');
    fs.writeFileSync(files[3], JSON.stringify({ id: 'legacy-local', pid: process.pid, wrapper_pid: process.pid }));
    for (const file of files) fs.utimesSync(file, oldTime, oldTime);
    const gc = run(process.execPath, [hccBin, '--root', localRoot, '--json', 'gc', '--older-than', '0', '--yes'], { env: localEnv });
    const payload = JSON.parse(gc);
    if (Number(payload.data?.deferred_buf_files || 0) < files.length || files.some((file) => !fs.existsSync(file))) {
      fail(`CLI-only legacy metadata was not deferred: ${gc}`);
    }
  } finally {
    fs.rmSync(localRoot, { recursive: true, force: true });
    fs.rmSync(localHome, { recursive: true, force: true });
  }
}

async function tmuxBackedStartWorkflow() {
  if (!tmuxAvailable()) {
    log('[5/13] tmux-backed start skipped (tmux not installed)');
    return;
  }

  log('[5/13] tmux-backed start + websocket + restore');
  const file = path.join(outDir, 'pty-ok');
  const started = hcc(['peer', 'start', 'shell-a', '--kind', 'shell', '--', 'bash']);
  const pane = parsePane(started);
  assertHccManagedTmuxEnv(pane);
  const list = hcc(['peer', 'list']);
  if (!list.includes('shell-a') || !list.includes('tmux')) fail(`tmux-backed peer missing from list:\n${list}`);
  hcc(['inject', 'shell-a', `echo PTY_OK > ${file}`]);
  await waitForFile(file, 'PTY_OK', 'pty injection');
  await expectWebSocketMarker('shell-a', 'WS_PTY_OK');
  await expectResizeReplaceSnapshot('shell-a', 'WS_RESIZE_OK');
  await expectWebSocketInputVisible('shell-a', 'WS_INPUT_VISIBLE_OK');
  await expectBoundedTmuxStream('tmux-backed FIFO stream');

  const heldWs = await openTerminalWebSocket('shell-a');
  try {
    await stopRuntime();
    await waitFor(() => heldWs.readyState === WebSocket.CLOSED || heldWs.readyState === WebSocket.CLOSING, 'runtime websocket close', 2000);
  } finally {
    try { heldWs.close(); } catch {}
  }
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
  startRuntime();
  await waitRuntime();
  await waitFor(() => hcc(['peer', 'list']).includes('shell-a'), 'tmux-backed peer restore after websocket shutdown');

  const restoredFile = path.join(outDir, 'pty-restored-ok');
  hcc(['inject', 'shell-a', `echo PTY_RESTORED_OK > ${restoredFile}`]);
  await waitForFile(restoredFile, 'PTY_RESTORED_OK', 'tmux restore injection');

  const aliasPeer = 'shell-canonical-alias';
  parsePane(hcc(['peer', 'start', 'shell-runtime-alias', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc']));
  moveRuntimeBindingPeer('shell-runtime-alias', aliasPeer);
  const aliasSessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  const aliasSession = (aliasSessions.sessions || []).find((session) => session.id === 'shell-runtime-alias');
  if (!aliasSession || aliasSession.peer_id !== aliasPeer) {
    fail(`sessions API did not expose canonical peer id for runtime alias:\n${JSON.stringify(aliasSessions, null, 2)}`);
  }
  const aliasDetected = await (await runtimeFetch('/api/detected', {}, { root })).json();
  if ((aliasDetected.detected || []).some((peer) => peer.id === aliasPeer || peer.id === 'shell-runtime-alias')) {
    fail(`detected API showed managed runtime/canonical duplicate:\n${JSON.stringify(aliasDetected, null, 2)}`);
  }
  const aliasFile = path.join(outDir, 'runtime-alias-ok');
  hcc(['inject', aliasPeer, `echo RUNTIME_ALIAS_OK > ${aliasFile}`]);
  await waitForFile(aliasFile, 'RUNTIME_ALIAS_OK', 'canonical peer injection to runtime alias');
  hcc(['peer', 'stop', aliasPeer]);

  const canonicalSession = 'canonical-session';
  insertStaleProviderBinding('claude-stale-canonical', 'claude', canonicalSession);
  const canonicalStarted = hcc(['peer', 'start', 'claude-live-canonical', '--kind', 'claude', '--resume', canonicalSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  const canonicalPane = parsePane(canonicalStarted);
  assertHccManagedTmuxEnv(canonicalPane);
  const canonicalRows = providerBindingRows('claude', canonicalSession);
  if (canonicalRows.length !== 1 ||
      canonicalRows[0].peer !== 'claude-live-canonical' ||
      canonicalRows[0].transport !== 'tmux' ||
      canonicalRows[0].runtime_target !== canonicalPane) {
    fail(`stale provider binding was not migrated to live tmux peer:\n${JSON.stringify(canonicalRows, null, 2)}`);
  }
  hcc(['peer', 'stop', 'claude-live-canonical']);

  const forceSession = 'force-canonical-session';
  const forceFirst = hcc(['peer', 'start', 'claude-force-a', '--kind', 'claude', '--resume', forceSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  const forceFirstPane = parsePane(forceFirst);
  const forceFirstSession = run('tmux', ['display-message', '-p', '-t', forceFirstPane, '#{session_name}']).trim();
  const forceConflict = hccMaybe(['peer', 'start', 'claude-force-b', '--kind', 'claude', '--resume', forceSession], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  if (forceConflict.status === 0 || !String(forceConflict.stderr || forceConflict.stdout).includes('already bound to claude-force-a')) {
    fail(`provider session duplicate start was not rejected:\n${forceConflict.stdout}\n${forceConflict.stderr}`);
  }
  if (runMaybe('tmux', ['has-session', '-t', tmuxManagedSession(root, 'claude-force-b')]).status === 0) {
    fail('failed duplicate provider start left a new claude-force-b tmux session behind');
  }
  let forceFirstAttachEvent = withMeshDb((db) => {
    const row = db.prepare(`
      SELECT id, payload FROM events
      WHERE type = 'tmux.session.attached'
        AND json_extract(payload, '$.target_peer') = 'claude-force-a'
      ORDER BY id DESC LIMIT 1
    `).get();
    return row ? { id: row.id, payload: JSON.parse(row.payload) } : null;
  });
  if (!forceFirstAttachEvent?.payload?.tmux_session_created) {
    fail(`tmux attach event omitted immutable identity: ${JSON.stringify(forceFirstAttachEvent)}`);
  }
  const oldAuthorityAt = Math.floor(Date.now() / 1000) - 20 * 86400;
  withMeshDb((db) => db.prepare('UPDATE events SET created_at = ? WHERE id = ?')
    .run(oldAuthorityAt, forceFirstAttachEvent.id));
  await stopRuntime();
  const authorityBindingAfterStop = withMeshDb((db) => db.prepare(`
    SELECT peer, transport, runtime_target, runtime_session_id
    FROM peer_bindings WHERE peer = 'claude-force-a'
  `).get());
  if (!withMeshDb((db) => db.prepare('SELECT id FROM events WHERE id = ?').get(forceFirstAttachEvent.id))) {
    fail(`runtime shutdown deleted the latest immutable tmux authority event: ${JSON.stringify(authorityBindingAfterStop)}`);
  }
  startRuntime();
  await waitRuntime();
  const restoredAuthority = withMeshDb((db) => {
    const row = db.prepare(`
      SELECT id, payload FROM events
      WHERE type = 'tmux.session.attached'
        AND json_extract(payload, '$.target_peer') = 'claude-force-a'
      ORDER BY id DESC LIMIT 1
    `).get();
    return row ? { id: row.id, payload: JSON.parse(row.payload) } : null;
  });
  if (!restoredAuthority?.payload?.tmux_session_created || !restoredAuthority?.payload?.tmux_session_id) {
    fail(`startup auto GC left no complete immutable tmux authority: ${JSON.stringify({ authorityBindingAfterStop, restoredAuthority })}`);
  }
  withMeshDb((db) => db.prepare('UPDATE events SET created_at = ? WHERE id = ?')
    .run(oldAuthorityAt, restoredAuthority.id));
  hcc(['gc', '--older-than', '14', '--yes']);
  const authorityRowsAfterFullGc = withMeshDb((db) => db.prepare(`
    SELECT id FROM events
    WHERE type = 'tmux.session.attached'
      AND json_extract(payload, '$.target_peer') = 'claude-force-a'
    ORDER BY id
  `).all().map((row) => row.id));
  if ((restoredAuthority.id !== forceFirstAttachEvent.id && authorityRowsAfterFullGc.includes(forceFirstAttachEvent.id)) ||
      !authorityRowsAfterFullGc.includes(restoredAuthority.id)) {
    fail(`full GC did not delete only superseded tmux authority events: ${JSON.stringify(authorityRowsAfterFullGc)}`);
  }
  forceFirstAttachEvent = restoredAuthority;
  run('tmux', ['set-environment', '-u', '-t', forceFirstSession, 'HCC_ROOT']);
  const missingRootStopResponse = await runtimeFetch('/api/sessions/claude-force-a/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kill_tmux: true })
  }, { root });
  const missingRootStop = await missingRootStopResponse.json();
  if (missingRootStopResponse.ok ||
      runMaybe('tmux', ['has-session', '-t', forceFirstSession]).status !== 0 ||
      !String(missingRootStop.error?.message || '').includes('tmux_root_unknown')) {
    fail(`tmux stop did not fail closed on missing HCC_ROOT:\n${JSON.stringify(missingRootStop, null, 2)}`);
  }
  run('tmux', ['set-environment', '-t', forceFirstSession, 'HCC_ROOT', root]);

  withMeshDb((db) => {
    const changed = {
      ...forceFirstAttachEvent.payload,
      tmux_session_created: `${forceFirstAttachEvent.payload.tmux_session_created}-reused`
    };
    db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(changed), forceFirstAttachEvent.id);
  });
  const reusedRebind = hccMaybe(['peer', 'start', 'claude-force-b', '--kind', 'claude', '--resume', forceSession, '--force'], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  if (reusedRebind.status === 0 ||
      !`${reusedRebind.stdout}\n${reusedRebind.stderr}`.includes('tmux_session_reused') ||
      runMaybe('tmux', ['has-session', '-t', forceFirstSession]).status !== 0 ||
      runMaybe('tmux', ['has-session', '-t', tmuxManagedSession(root, 'claude-force-b')]).status === 0) {
    fail(`tmux rebind did not reject a reused immutable session identity:\n${reusedRebind.stdout}\n${reusedRebind.stderr}`);
  }
  withMeshDb((db) => db.prepare('UPDATE events SET payload = ? WHERE id = ?')
    .run(JSON.stringify(forceFirstAttachEvent.payload), forceFirstAttachEvent.id));
  const forceSecond = hcc(['peer', 'start', 'claude-force-b', '--kind', 'claude', '--resume', forceSession, '--force'], {
    env: { ...env, HCC_FAKE_STAY_ALIVE: '1' }
  });
  const forcePane = parsePane(forceSecond);
  assertHccManagedTmuxEnv(forcePane);
  const forceRows = providerBindingRows('claude', forceSession);
  if (forceRows.length !== 1 ||
      forceRows[0].peer !== 'claude-force-b' ||
      forceRows[0].transport !== 'tmux' ||
      forceRows[0].runtime_target !== forcePane) {
    fail(`--force did not move provider binding to replacement tmux peer:\n${JSON.stringify(forceRows, null, 2)}`);
  }
  if (runMaybe('tmux', ['has-session', '-t', forceFirstSession]).status === 0) {
    fail('--force provider rebind did not remove old hcc-managed tmux session');
  }
  const rebindEvidence = withMeshDb((db) => {
    const row = db.prepare(`
      SELECT payload
      FROM events
      WHERE type = 'tmux.session.rebind_cleanup_pending'
        AND json_extract(payload, '$.old_peer') = 'claude-force-a'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    return row ? JSON.parse(row.payload) : null;
  });
  if (rebindEvidence?.old_pane !== forceFirstPane ||
      rebindEvidence?.old_process_identity?.pid <= 0 ||
      !rebindEvidence?.old_process_identity?.startToken ||
      !rebindEvidence?.old_process_identity?.commandHash ||
      !samePath(rebindEvidence?.old_hcc_root, root) ||
      !rebindEvidence?.old_tmux_session_created ||
      !rebindEvidence?.old_tmux_session_id) {
    fail(`forced rebind did not persist complete old tmux evidence:\n${JSON.stringify(rebindEvidence, null, 2)}`);
  }
  hccMaybe(['peer', 'stop', 'claude-force-a']);
  hcc(['peer', 'stop', 'claude-force-b']);

  await stopRuntime();
  startRuntime({ env: envWithoutProvider({ HCC_REG_VALUE: 'runtime-old', ANTHROPIC_BASE_URL: 'runtime-old-url' }) });
  await waitRuntime();
  const envFile = path.join(outDir, 'caller-env-ok');
  const envPane = parsePane(hcc(['peer', 'start', 'env-a', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], {
    env: envWithoutProvider({ HCC_REG_VALUE: 'caller-new' })
  }));
  assertHccManagedTmuxEnv(envPane);
  hcc(['inject', 'env-a', `printf '%s|%s\\n' "$HCC_REG_VALUE" "\${ANTHROPIC_BASE_URL:-}" > ${envFile}`]);
  await waitForFile(envFile, 'caller-new|', 'caller env propagation');
  hcc(['peer', 'stop', 'env-a']);
  await assertTmuxGcPolicy();
}

async function shimTmuxWorkflow() {
  if (!tmuxAvailable()) {
    log('[6/13] shim tmux-backed launch skipped (tmux not installed)');
    return;
  }

  log('[6/13] shim tmux-backed launch');
  if (!fs.existsSync(path.join(root, '.hello-cc', 'runtime.json'))) {
    startRuntime();
  }
  await waitRuntime();
  const shim = path.join(home, '.hcc-shims', 'claude');
  const codexShim = path.join(home, '.hcc-shims', 'codex');
  const claudeVersion = run(shim, ['--version'], { cwd: root, env });
  if (!claudeVersion.includes('fake-claude --version') || claudeVersion.includes('started ')) {
    fail(`claude shim did not pass through --version:\n${claudeVersion}`);
  }
  const claudePrint = run(shim, ['--print', 'hello'], { cwd: root, env });
  if (!claudePrint.includes('fake-claude --print hello') || claudePrint.includes('started ')) {
    fail(`claude shim did not pass through --print:\n${claudePrint}`);
  }
  const codexVersion = run(codexShim, ['--version'], { cwd: root, env });
  if (!codexVersion.includes('fake-codex --version') || codexVersion.includes('started ')) {
    fail(`codex shim did not pass through --version:\n${codexVersion}`);
  }
  const codexExec = run(codexShim, ['exec', 'hello'], { cwd: root, env });
  if (!codexExec.includes('fake-codex exec hello') || codexExec.includes('started ')) {
    fail(`codex shim did not pass through exec:\n${codexExec}`);
  }

  const shimEnv = {
    ...env,
    HCC_SHIM_NO_ATTACH: '1',
    HCC_FAKE_STAY_ALIVE: '1',
    HCC_NO_AUTO_INSTALL_TMUX: '1',
    HCC_REG_VALUE: 'shim-first'
  };
  const output = run(shim, ['--resume', 'shim-regression-session'], { cwd: root, env: shimEnv });
  const peerMatch = output.match(/started\s+(\S+)\s+\(/);
  if (!peerMatch) fail(`shim did not start a peer:\n${output}`);
  const peer = peerMatch[1];
  const pane = parsePane(output);
  const list = hcc(['peer', 'list']);
  if (!list.includes(peer) || !list.includes('tmux') || !list.includes(pane)) {
    fail(`shim peer missing from list:\n${list}`);
  }
  const hookPreservePayload = JSON.stringify({
    session_id: 'hook-preserve-session',
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'keep tmux binding'
  });
  hcc(['hook', 'userpromptsubmit'], {
    env: { ...env, HCC_PEER: peer, CLAUDE_CODE_SESSION_ID: 'hook-preserve-session' },
    input: hookPreservePayload
  });
  const afterHookRows = hccJson(['peer', 'list']);
  const afterHookPeer = afterHookRows.find((row) => row.id === peer);
  if (!afterHookPeer?.binding || afterHookPeer.binding.transport !== 'tmux' || afterHookPeer.binding.runtime_target !== pane) {
    fail(`Claude hook overwrote tmux binding:\n${JSON.stringify(afterHookPeer, null, 2)}`);
  }
  hcc(['hook', 'userpromptsubmit'], {
    env: envWithoutPeer({ CLAUDE_CODE_SESSION_ID: 'hook-preserve-session' }),
    input: hookPreservePayload
  });
  const hookBindingRows = providerBindingRows('claude', 'hook-preserve-session');
  if (hookBindingRows.length !== 1 ||
      hookBindingRows[0].peer !== peer ||
      hookBindingRows[0].transport !== 'tmux' ||
      hookBindingRows[0].runtime_target !== pane) {
    fail(`Claude hook did not canonicalize provider session to tmux peer:\n${JSON.stringify(hookBindingRows, null, 2)}`);
  }
  const file = path.join(outDir, 'shim-ok');
  hcc(['inject', peer, `echo SHIM_OK > ${file}`]);
  await waitForFile(file, 'SHIM_OK', 'shim tmux injection');
  await expectWebSocketMarker(peer, 'WS_SHIM_OK');
  await expectBoundedTmuxStream('shim tmux FIFO stream');

  const firstEnvFile = path.join(outDir, 'shim-env-first');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${firstEnvFile}`]);
  await waitForFile(firstEnvFile, 'shim-first', 'shim first env');
  const shimInternalEnvFile = path.join(outDir, 'shim-internal-env');
  hcc(['inject', peer, `printf '%s|%s|%s\\n' "\${HCC_SHIM_ENSURED-unset}" "\${HCC_SKIP_SHIM_INSTALL-unset}" "\${HCC_RUNTIME_LOCAL_ONLY-unset}" > ${shimInternalEnvFile}`]);
  await waitForFile(shimInternalEnvFile, 'unset|unset|unset', 'shim internal env cleanup');

  const restarted = run(shim, ['--resume', 'shim-regression-session'], {
    cwd: root,
    env: { ...shimEnv, HCC_REG_VALUE: 'shim-second' }
  });
  parsePane(restarted);
  const secondEnvFile = path.join(outDir, 'shim-env-second');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${secondEnvFile}`]);
  await waitForFile(secondEnvFile, 'shim-second', 'shim env restart');
  const reentryFile = path.join(outDir, 'shim-reentry');
  hcc(['inject', peer, `HCC_FAKE_STAY_ALIVE=0 HCC_REG_VALUE=shim-third ${sh(shim)} --resume shim-regression-session > ${sh(reentryFile)} 2>&1`]);
  await waitForFileContent(reentryFile, 'fake-claude --resume shim-regression-session', 'shim tmux pane re-entry');
  hcc(['peer', 'stop', peer]);

  const exitedResume = 'shim-exited-session';
  const exitedLog = path.join(outDir, 'shim-exited-log');
  const exitedEnv = {
    ...shimEnv,
    HCC_FAKE_STAY_ALIVE: '0',
    HCC_FAKE_LOG: exitedLog
  };
  const exitedFirstResult = runMaybe(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  if (exitedFirstResult.status !== 0) {
    const allShimLines = fs.readFileSync(shim, 'utf8').split('\n');
    const shimLines = allShimLines
      .slice(0, 35)
      .concat(['...'])
      .concat(allShimLines.slice(139))
      .map((line, index) => {
        if (index < 35) return `${index + 1}: ${line}`;
        if (index === 35) return line;
        return `${index + 104}: ${line}`;
      })
      .join('\n');
    fail(`${sh([shim, '--resume', exitedResume].join(' '))} failed\n${exitedFirstResult.stdout || ''}${exitedFirstResult.stderr || ''}\nshim excerpt:\n${shimLines}`);
  }
  const exitedFirst = exitedFirstResult.stdout || '';
  const exitedPeerMatch = exitedFirst.match(/started\s+(\S+)\s+\(/);
  if (!exitedPeerMatch) fail(`exited shim did not start a peer:\n${exitedFirst}`);
  const exitedPeer = exitedPeerMatch[1];
  const exitedPane = parsePane(exitedFirst);
  try {
    await waitForFileLineCount(exitedLog, 1, 'shim exited first provider launch');
  } catch (err) {
    const paneCapture = runMaybe('tmux', ['capture-pane', '-p', '-S', '-80', '-t', exitedPane]);
    const peerList = hccMaybe(['peer', 'list']);
    const shimHead = fs.readFileSync(shim, 'utf8').split('\n').slice(0, 18).join('\n');
    fail(`${err.message}\nshim output:\n${exitedFirst}\nshim stderr:\n${exitedFirstResult.stderr || ''}\npeer list:\n${peerList.stdout || ''}${peerList.stderr || ''}\npane ${exitedPane}:\n${paneCapture.stdout || ''}${paneCapture.stderr || ''}\nshim head:\n${shimHead}`);
  }
  const fallbackFile = path.join(outDir, 'shim-exited-fallback');
  hcc(['inject', exitedPeer, `printf '%s\\n' fallback > ${sh(fallbackFile)}`]);
  await waitForFile(fallbackFile, 'fallback', 'shim exited fallback shell');
  const exitedProviderPid = spawnSync('true', [], { stdio: 'ignore' }).pid;
  withMeshDb((db) => db.prepare(`
    UPDATE peers
    SET pid = ?, pid_start_token = 'dead:shim-provider', pid_command_hash = ?
    WHERE id = ?
  `).run(exitedProviderPid, 'd'.repeat(64), exitedPeer));
  const exitedSecondResult = runMaybe(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  if (exitedSecondResult.status !== 0) {
    const restartEvents = withMeshDb((db) => db.prepare(`
      SELECT type, payload
      FROM events
      WHERE actor = ? OR json_extract(payload, '$.target_peer') = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(exitedPeer, exitedPeer));
    const tmuxState = runMaybe('tmux', ['list-sessions', '-F',
      '#{session_name}|#{session_created}|#{session_id}|#{session_attached}']);
    const webLog = path.join(root, '.hello-cc', 'web.log');
    const webLogTail = fs.existsSync(webLog)
      ? fs.readFileSync(webLog, 'utf8').split('\n').slice(-80).join('\n')
      : '(web log missing)';
    fail(`${sh([shim, '--resume', exitedResume].join(' '))} failed on provider relaunch\n${exitedSecondResult.stdout || ''}${exitedSecondResult.stderr || ''}\nevents:\n${JSON.stringify(restartEvents, null, 2)}\ntmux:\n${tmuxState.stdout || ''}${tmuxState.stderr || ''}\nweb log:\n${webLogTail}`);
  }
  const exitedSecond = exitedSecondResult.stdout || '';
  parsePane(exitedSecond);
  await waitForFileLineCount(exitedLog, 2, 'shim exited resume relaunch');
  hcc(['peer', 'stop', exitedPeer]);
}

async function tmuxWorkflow() {
  const tmuxVersion = runMaybe('tmux', ['-V']);
  if (tmuxVersion.status !== 0) {
    log('[7/13] tmux skipped (tmux not installed)');
    return;
  }

  log('[7/13] tmux attach + websocket + force');
  run('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', os.tmpdir(), 'bash --noprofile --norc']);
  tmuxStarted = true;
  const pane = run('tmux', ['display-message', '-p', '-t', `${tmuxSession}:0.0`, '#{pane_id}']).trim();
  const file = path.join(outDir, 'tmux-ok');
  hcc(['peer', 'attach', 'tmux-a', '--kind', 'shell', '--pane', pane]);
  hcc(['inject', 'tmux-a', `echo TMUX_OK > ${file}`]);
  await waitForFile(file, 'TMUX_OK', 'tmux injection');
  await expectWebSocketMarker('tmux-a', 'WS_TMUX_OK');
  await expectBoundedTmuxStream('attached tmux FIFO stream');
  const conflict = hccMaybe(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane]);
  if (conflict.status === 0 || !String(conflict.stderr || conflict.stdout).includes('already attached to tmux-a')) {
    fail('tmux duplicate attach did not fail as expected');
  }
  hcc(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane, '--force']);
  if (!hcc(['peer', 'list']).includes('tmux-b')) fail('tmux force attach missing');
  hcc(['peer', 'stop', 'tmux-b']);
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
}

async function askBroadcastWorkflow() {
  if (!tmuxAvailable()) {
    log('[8/13] ask/broadcast injection skipped (tmux not installed)');
    return;
  }

  log('[8/13] ask/broadcast injection');
  const askFile = path.join(outDir, 'ask-ok');
  parsePane(hcc(['peer', 'start', 'shell-b', '--kind', 'shell', '--', 'bash']));
  hcc(['ask', 'shell-b', `echo ASK_OK > ${askFile}`, '--from', 'human', '--inject']);
  await waitForFile(askFile, 'ASK_OK', 'ask injection');
  if (!hcc(['msg', 'inbox', '--peer', 'shell-b', '--all']).includes('ASK_OK')) fail('ask durable message missing');
  const shellDefaultDispatch = hccJson(['task', 'dispatch', '--from', 'human', '--to', 'shell-b', '--title', 'shell default dispatch']);
  if (shellDefaultDispatch.injected !== false || shellDefaultDispatch.injection_reason !== 'unsupported_session_kind') {
    fail(`task dispatch injected default natural-language prompt into shell session:\n${JSON.stringify(shellDefaultDispatch, null, 2)}`);
  }
  const dispatchFile = path.join(outDir, 'dispatch-ok');
  const shellCommandDispatch = hccJson(['task', 'dispatch', '--from', 'human', '--to', 'shell-b', '--title', 'shell command dispatch', '--message', `echo DISPATCH_OK > ${dispatchFile}`, '--force']);
  if (!shellCommandDispatch.injected || shellCommandDispatch.delivery !== 'message+inject') {
    fail(`task dispatch did not inject explicit shell-safe message:\n${JSON.stringify(shellCommandDispatch, null, 2)}`);
  }
  await waitForFile(dispatchFile, 'DISPATCH_OK', 'task dispatch injection');
  const broadcastFile = path.join(outDir, 'broadcast-ok');
  hcc(['broadcast', `echo BROADCAST_OK > ${broadcastFile}`, '--from', 'human', '--inject']);
  await waitForFile(broadcastFile, 'BROADCAST_OK', 'broadcast injection');
}

async function downGcPackWorkflow() {
  log('[9/13] down/gc/pack');
  hccMaybe(['peer', 'stop', 'shell-a']);
  hccMaybe(['peer', 'stop', 'shell-b']);
  await stopRuntime();
  await waitFor(() => !fs.existsSync(path.join(root, '.hello-cc', 'runtime.json')), 'runtime cleanup', 5000);
  hcc(['gc', '--older-than', '0', '--yes']);
  const pack = JSON.parse(run('npm', ['pack', '--dry-run', '--json']));
  const files = new Set(pack[0]?.files?.map((entry) => entry.path) || []);
  for (const file of [
    'assets/logo.svg',
    'CHANGELOG.md',
    'docs/commands.md',
    'docs/commands.zh-CN.md',
    ...libModuleFiles(),
    'scripts/github-release.mjs'
  ]) {
    if (!files.has(file)) fail(`npm package missing ${file}`);
  }
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const releaseCheck = run('npm', ['run', 'release:check']);
  if (!releaseCheck.includes(`release notes ok: ${packageVersion}`)) fail(`release check output wrong:\n${releaseCheck}`);
  const releaseNotes = run('npm', ['run', 'release:notes']);
  if (!releaseNotes.includes(`## ${packageVersion}`) || !releaseNotes.includes('### Summary')) {
    fail(`release notes output wrong:\n${releaseNotes}`);
  }
  const releaseNotesWithV = run(process.execPath, [path.join(repoRoot, 'scripts', 'release-notes.mjs'), '--version', `v${packageVersion}`]);
  if (!releaseNotesWithV.includes(`## ${packageVersion}`) || releaseNotesWithV.includes(`## v${packageVersion}`)) {
    fail(`release notes v-prefixed version output wrong:\n${releaseNotesWithV}`);
  }
  const githubRelease = JSON.parse(run(process.execPath, [path.join(repoRoot, 'scripts', 'github-release.mjs'), '--dry-run', '--version', packageVersion]));
  if (!githubRelease.ok || !githubRelease.dry_run || githubRelease.repo !== 'Dullne/hello-cc' || githubRelease.tag !== `v${packageVersion}` || githubRelease.body_length < 100) {
    fail(`github release dry run output wrong:\n${JSON.stringify(githubRelease, null, 2)}`);
  }
  const docsIndex = fs.readFileSync(path.join(repoRoot, 'docs', 'README.md'), 'utf8');
  const docsIndexZh = fs.readFileSync(path.join(repoRoot, 'docs', 'README.zh-CN.md'), 'utf8');
  if (!docsIndex.includes('github-release.yml') || !docsIndex.includes('workflow_dispatch') || !docsIndexZh.includes('github-release.yml') || !docsIndexZh.includes('workflow_dispatch')) {
    fail('docs index missing GitHub Release publishing command');
  }
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'github-release.yml'), 'utf8');
  for (const expected of [
    'Publish GitHub Release',
    "tags:\n      - 'v*'",
    'workflow_dispatch:',
    'contents: write',
    'actions/checkout@v5',
    'actions/setup-node@v5',
    'node-version: 24',
    'npm run release:check',
    'npm run release:github:dry-run',
    'npm run release:github',
    'GITHUB_TOKEN: ${{ github.token }}'
  ]) {
    if (!workflow.includes(expected)) fail(`github release workflow missing ${expected}`);
  }
}

function oldNameScan() {
  log('[10/13] old-name scan');
  const oldNamePattern = [
    'agent' + 'mesh',
    'Agent' + 'mesh',
    'AGENT' + 'MESH',
    '\\.' + 'agent' + 'mesh',
    'bin/' + 'agent' + 'mesh',
    'HCC_' + 'AGENT',
    'ACTIVE_' + 'AGENT_' + 'TTL',
    '--' + 'agent\\b'
  ].join('|');
  const oldNameRegex = new RegExp(oldNamePattern);
  const files = run('git', ['ls-files'])
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('/node_modules/') && !file.endsWith('.tgz'));
  const matches = [];
  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    let content = '';
    try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (oldNameRegex.test(lines[i])) matches.push(`${file}:${i + 1}: ${lines[i]}`);
    }
  }
  if (matches.length) fail(`old names found:\n${matches.join('\n')}`);
}

function identityEnforcementWorkflow() {
  log('[11/13] identity enforcement');
  const identityRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-reg-identity-root-${testId}-`));
  const identityHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-reg-identity-home-${testId}-`));
  const identityEnv = {
    ...env,
    HOME: identityHome,
    HCC_PEER: 'real-peer'
  };
  delete identityEnv.HCC_ROOT;
  delete identityEnv.HCC_DB;
  try {
    hccFrom(['register', '--peer', 'fake-peer', '--kind', 'codex', '--role', 'peer'], identityRoot, { env: identityEnv });
    const envOut = hccFrom(['env', '--peer', 'fake-peer'], identityRoot, { env: identityEnv });
    if (!envOut.includes('HCC_PEER=fake-peer')) {
      fail(`env did not export explicit target peer:\n${envOut}`);
    }
    const created = hccFrom(['task', 'create', '--from', 'fake-peer', '--title', 'identity guard'], identityRoot, { env: identityEnv });
    const match = created.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse identity task id:\n${created}`);
    const taskId = match[1];
    hccFrom(['task', 'claim', '--peer', 'fake-peer', '--id', taskId], identityRoot, { env: identityEnv });

    const dbPath = path.join(identityRoot, '.hello-cc', 'mesh.db');
    const db = new DatabaseSync(dbPath);
    try {
      const task = db.prepare('SELECT owner, created_by FROM tasks WHERE id = ?').get(Number(taskId));
      const fakePeer = db.prepare('SELECT id FROM peers WHERE id = ?').get('fake-peer');
      if (task?.owner !== 'real-peer' || task?.created_by !== 'real-peer' || fakePeer) {
        fail(`system peer identity was not enforced:\n${JSON.stringify({ task, fakePeer }, null, 2)}`);
      }
      db.prepare(`
        INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
        VALUES ('inspect-peer', 'codex', 'peer', ?, '', NULL, 'working', '', 1, 1)
      `).run(identityRoot);
      db.prepare(`
        INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
        VALUES ('owner-peer', 'codex', 'peer', ?, '', NULL, 'working', '', 1, 1)
      `).run(identityRoot);
      db.prepare(`
        INSERT INTO tasks(title, body, status, assignee, owner, priority, created_by, created_at, updated_at)
        VALUES ('owned identity guard', '', 'claimed', NULL, 'owner-peer', 100, 'owner-peer', 1, 1)
      `).run();
    } finally {
      db.close();
    }

    const statusOut = hccFrom(['status', '--peer', 'inspect-peer'], identityRoot, { env: identityEnv });
    if (!statusOut.includes('inbox(inspect-peer)')) {
      fail(`status did not inspect explicit target peer:\n${statusOut}`);
    }
    const stateOut = hccFrom(['state', '--peer', 'inspect-peer'], identityRoot, { env: identityEnv });
    if (!stateOut.includes('peer: inspect-peer')) {
      fail(`state did not inspect explicit target peer:\n${stateOut}`);
    }

    const owned = hccFromMaybe(['task', 'done', '--peer', 'owner-peer', '--id', '2', '--summary', 'should not pass'], identityRoot, { env: identityEnv });
    if (owned.status === 0 || !`${owned.stdout}\n${owned.stderr}`.includes('Task #2 is owned by owner-peer')) {
      fail(`owned task mutation was not rejected:\nstdout=${owned.stdout}\nstderr=${owned.stderr}`);
    }
    const forcedOwned = hccFromMaybe(['task', 'done', '--force', '--peer', 'owner-peer', '--id', '2', '--summary', 'should not pass'], identityRoot, { env: identityEnv });
    if (forcedOwned.status === 0 || !`${forcedOwned.stdout}\n${forcedOwned.stderr}`.includes('Task #2 is owned by owner-peer')) {
      fail(`forced owned task mutation was not rejected:\nstdout=${forcedOwned.stdout}\nstderr=${forcedOwned.stderr}`);
    }
    const db2 = new DatabaseSync(dbPath);
    try {
      const task = db2.prepare('SELECT owner, status FROM tasks WHERE id = 2').get();
      const notice = db2.prepare(`
        SELECT sender, recipient, kind
        FROM messages
        WHERE task_id = 2 AND kind = 'task.owner-conflict'
      `).get();
      if (task?.owner !== 'owner-peer' || task?.status !== 'claimed' ||
          !notice || notice.sender !== 'real-peer' || notice.recipient !== 'owner-peer') {
        fail(`owned task mutation did not preserve owner and notify:\n${JSON.stringify({ task, notice }, null, 2)}`);
      }
    } finally {
      db2.close();
    }

    hccFrom(['run', '--peer', 'fake-runner', '--', process.execPath, '-e', 'process.exit(0)'], identityRoot, { env: identityEnv });
    const db3 = new DatabaseSync(dbPath);
    try {
      const realRunner = db3.prepare('SELECT id, status FROM peers WHERE id = ?').get('real-peer');
      const fakeRunner = db3.prepare('SELECT id FROM peers WHERE id = ?').get('fake-runner');
      if (!realRunner || realRunner.status !== 'exited' || fakeRunner) {
        fail(`run did not enforce system peer identity:\n${JSON.stringify({ realRunner, fakeRunner }, null, 2)}`);
      }
    } finally {
      db3.close();
    }

    hccFrom(['peer', 'stop', 'fake-target'], identityRoot, { env: identityEnv });
    const stopRequested = eventPayloads('peer.stop.requested', 5, dbPath)
      .find((event) => event.payload?.target_peer === 'fake-target');
    if (!stopRequested ||
        stopRequested.actor !== 'real-peer' ||
        stopRequested.payload.actor_peer !== 'real-peer' ||
        stopRequested.payload.source !== 'cli' ||
        stopRequested.payload.admin !== true) {
      fail(`peer stop request did not record real actor and target:\n${JSON.stringify(stopRequested, null, 2)}`);
    }
    const stoppedFallback = eventPayloads('peer.stopped', 5, dbPath)
      .find((event) => event.payload?.target_peer === 'fake-target');
    if (!stoppedFallback ||
        stoppedFallback.actor !== 'real-peer' ||
        stoppedFallback.payload.actor_peer !== 'real-peer' ||
        stoppedFallback.payload.source !== 'cli' ||
        stoppedFallback.payload.admin !== true) {
      fail(`peer stop fallback did not record real actor and target:\n${JSON.stringify(stoppedFallback, null, 2)}`);
    }
  } finally {
    try { fs.rmSync(identityRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(identityHome, { recursive: true, force: true }); } catch {}
  }
}

async function syntaxAndHelp() {
  log('[12/13] syntax/help');
  run(process.execPath, ['--check', path.join(repoRoot, 'bin', 'hcc.mjs')]);
  for (const file of libModuleFiles()) {
    run(process.execPath, ['--check', path.join(repoRoot, file)]);
  }
  const hccSource = fs.readFileSync(hccBin, 'utf8');
  const coordinationStateSource = fs.readFileSync(path.join(repoRoot, 'lib', 'coordination-state.mjs'), 'utf8');
  const errorsCompatSource = fs.readFileSync(path.join(repoRoot, 'lib', 'errors.mjs'), 'utf8');
  const sharedErrorsSource = fs.readFileSync(path.join(repoRoot, 'lib', 'shared', 'errors.mjs'), 'utf8');
  const setupSource = fs.readFileSync(path.join(repoRoot, 'lib', 'setup.mjs'), 'utf8');
  const shimScriptCompatSource = fs.readFileSync(path.join(repoRoot, 'lib', 'shim-script.mjs'), 'utf8');
  const integrationHooksSource = fs.readFileSync(path.join(repoRoot, 'lib', 'integrations', 'hooks.mjs'), 'utf8');
  const integrationShimsSource = fs.readFileSync(path.join(repoRoot, 'lib', 'integrations', 'shims.mjs'), 'utf8');
  const integrationShimScriptSource = fs.readFileSync(path.join(repoRoot, 'lib', 'integrations', 'shims', 'script.mjs'), 'utf8');
  const shellPathSource = fs.readFileSync(path.join(repoRoot, 'lib', 'shell-path.mjs'), 'utf8');
  const webPeerActionsSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'peer-actions.mjs'), 'utf8');
  const webUiTemplateSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'ui-template.mjs'), 'utf8');
  const tmuxSafetySource = fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'peers', 'tmux-safety.mjs'), 'utf8');
  const cmdWebSource = hccSource.slice(
    hccSource.indexOf('async function cmdWeb('),
    hccSource.indexOf('async function cmdRun(', hccSource.indexOf('async function cmdWeb('))
  );
  for (const expected of [
    'statusSnapshot: webStatusSnapshot',
    'statusSummary: webStatusSummary',
    'webPeerAction: webPeerActionForProject',
    'connect: connectWebProject',
    'statusSnapshot: webStatusSnapshot',
    'statusSummary: webStatusSummary',
    'webStatusSnapshot(reqCtx',
    'webPeerActionForProject(reqCtx'
  ]) {
    if (!cmdWebSource.includes(expected)) {
      fail(`cmdWeb project-safe coordination factory wiring missing: ${expected}`);
    }
  }
  const migrationConnectionSource = fs.readFileSync(path.join(repoRoot, 'lib', 'db', 'connection.mjs'), 'utf8');
  for (const expected of [
    'resolved = resolveProjectDatabase({',
    'root: project.root',
    'createStateDir: false',
    'const dbPath = resolved.db',
    'db = new DatabaseSync(dbPath'
  ]) {
    if (!migrationConnectionSource.includes(expected)) {
      fail(`registered migration project-path recheck missing: ${expected}`);
    }
  }
  if (migrationConnectionSource.indexOf('resolved = resolveProjectDatabase({') >
      migrationConnectionSource.indexOf('db = new DatabaseSync(dbPath')) {
    fail('registered migration opens a sibling database before its project-path recheck');
  }
  // skip the old hccSource-based migration fanout check (code moved to lib/db/connection.mjs)
  const migrationFanoutSource = '';
  const tmuxStreamSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'tmux-stream.mjs'), 'utf8');
  for (const expected of [
    "runTmux(['pipe-pane', '-t', session.pane]);",
    "broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });"
  ]) {
    if (!tmuxStreamSource.includes(expected)) fail(`web terminal input refresh support missing: ${expected}`);
  }
  for (const expected of [
    'function scheduleTmuxInputRefresh(session)',
    'if (session.inputRefreshTimer) return;',
    'session.inputRefreshTimer = setTimeout',
    'scheduleTmuxInputRefresh(session)'
  ]) {
    if (!hccSource.includes(expected)) fail(`web terminal input refresh support missing: ${expected}`);
  }
  for (const expected of [
    'function listTmuxPanesOnce()',
    'let autoAttachScanInFlight = false;',
    'if (autoAttachScanInFlight) return;',
    'const paneByPid = new Map();',
    'const attached = attachedTmuxState(ctx, db);',
    'function killOldTmuxForRebind(',
    'function providerSessionBindingMatches(',
    'function hccWebProcessMatches(',
    'function splitProcessArgs(line)',
    'const { global, rest } = splitGlobalArgs(hccArgs);',
    "if (rest[0] !== 'web') return false;",
    'sameResolvedPath(global.root, ctx.root)',
    'sameResolvedPath(global.db, ctx.dbPath)',
    'sameResolvedPath(',
    'async function stopOrphanWebRuntimes(',
    'await stopOrphanWebRuntimes(ctx, existing.pid || null);',
    'await stopOrphanWebRuntimes(ctx);',
    'const restoredTmuxDbs = new Set();',
    'if (restoredTmuxDbs.has(dbKey)) continue;',
    'input.rebindOldTmux',
    'rebindOldTmux: true',
    'skipProviderRebindCleanup:',
    'function safeOldTmuxRebindPlan(',
    'function assertOldTmuxCanRebind(',
    'TMUX_REBIND_NOT_HCC_MANAGED',
    'assertTmuxDestructiveEvidence(stored, observed',
    'tmuxAttachmentEvidence(db, oldPeer, oldTarget)',
    "addEvent(db, 'tmux.session.rebind_cleanup_pending'",
    'TMUX_REBIND_OLD_SESSION_IN_USE',
    "addEvent(db, 'tmux.session.rebind_cleanup_failed'",
    'function restoreParkedOldTmuxSessions()',
    'restoreParkedOldTmuxSessions();',
    'parkedOldTmuxSessions.push',
    "addEvent(db, 'tmux.session.rebound'",
    "addEvent(eventDb, 'provider.session.rebound'"
  ]) {
    if (!hccSource.includes(expected)) fail(`tmux auto-attach/rebind guard missing: ${expected}`);
  }
  if (hccSource.includes("return line.includes(`--root ${root}`) || line.includes(`--db ${db}`);")) {
    fail('orphan web runtime cleanup still uses substring matching for --root/--db');
  }
  for (const expected of [
    'function safeTmuxKillPlan(projectCtx, db, peerId, expectedTarget)',
    "binding.transport !== 'tmux'",
    'const expectedSession = tmuxManagedSessionName(projectCtx, peerId);',
    "throw new CliError('TMUX_KILL_NOT_HCC_MANAGED'",
    'const stored = tmuxAttachmentEvidence(db, peerId, binding.runtime_target);',
    'executeTmuxKillPlan(projectCtx, plan);',
    'validateTmuxDestructiveEvidence(stored, observed, options)',
    'conditionalTmuxKill(runTmux, plan.stored);',
    'killDbProvenTmuxSession(reqCtx, db, peerId)',
    'safeTmuxKillPlan(reqCtx, stopDb, peerId, session.pane || null)'
  ]) {
    if (!hccSource.includes(expected)) fail(`tmux kill safety guard missing: ${expected}`);
  }
  if (hccSource.includes("if (sessName) tmuxKillSession(sessName);")) {
    fail('web stop kill_tmux still kills tmux by session name without DB-proven guard');
  }
  for (const expected of [
    'async function cmdTmux(',
    'async function planTmuxGc(',
    "validateOpts('tmux gc'",
    'const dryRun = !opts.yes;',
    'const targetPeer = opts.peer || null;',
    'if (targetPeer && row.peer !== targetPeer) continue;',
    'if (targetPeer && rowPeer !== targetPeer) continue;',
    "b.transport = 'tmux'",
    'b.runtime_target IS NOT NULL',
    'actualSession !== expectedSession',
    "const hccRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');",
    "skip('hcc_root_mismatch'",
    "skip('runtime_managed')",
    'validateTmuxGcBindingEvidence(validationSubject, observed)',
    'expected_root: canonicalRoot(subject.expected_root)',
    'root: canonicalRoot(subject.authority.root)',
    'gc_validation_subject: bindingSubject',
    'sameTmuxGcBindingSubject(candidate.gc_validation_subject, currentSubject)',
    "'tmux_binding_validation_mode_changed'",
    'TMUX_GC_CONDITIONAL_TIMEOUT_MS = 5000',
    'finalizeTmuxGcBindingMutation({',
    'readSubject: () => tmuxGcBindingSubjectFromDb(db, ctx, candidate.peer)',
    'conditionalKill: () => conditionalTmuxKill(runBoundedTmuxGcCommand',
    'casBinding: (subject) => casDetachTmuxGcBinding(db, subject, t)',
    'updatePeer: (subject) => casDetachTmuxGcPeer(db, subject, t)',
    "reason: 'stale_hcc_managed_session'",
    "type IN ('tmux.session.rebind_cleanup_failed', 'tmux.session.rebind_cleanup_pending')",
    "'stale_rebind_cleanup_failed_session'",
    "'rebind_cleanup_failed'",
    "'rebind_cleanup_pending'",
    "'stale_rebind_cleanup_pending_session'",
    "SET transport = 'detached'",
    "addEvent(db, 'tmux.session.gc'"
  ]) {
    if (!hccSource.includes(expected)) fail(`tmux gc guard missing: ${expected}`);
  }
  const bindingFinalizerSource = tmuxSafetySource.slice(
    tmuxSafetySource.indexOf('export function finalizeTmuxGcBindingMutation('),
    tmuxSafetySource.indexOf('const KILL_OK')
  );
  for (const expected of [
    'return tx(db, () => {',
    'const currentSubject = readSubject();',
    'conditionalKill();',
    'const bindingResult = casBinding(currentSubject);',
    'Number(bindingResult?.changes) !== 1',
    'updatePeer(currentSubject);'
  ]) {
    if (!bindingFinalizerSource.includes(expected)) fail(`tmux GC finalizer guard missing: ${expected}`);
  }
  for (const forbidden of [
    'inspectProcessIdentity',
    'observeTmuxConditionalTarget',
    'tmuxSessionEnvironmentValue',
    'validateTmuxGcBindingEvidence'
  ]) {
    if (bindingFinalizerSource.includes(forbidden)) {
      fail(`tmux GC finalizer performs an evidence probe inside its write transaction: ${forbidden}`);
    }
  }
  if (bindingFinalizerSource.indexOf('casBinding(currentSubject)') >
      bindingFinalizerSource.indexOf('updatePeer(currentSubject)')) {
    fail('tmux GC finalizer updates peer state before binding CAS');
  }
  const autoAttachSource = hccSource.slice(
    hccSource.indexOf('function scanAndAttachDetectedPeers()'),
    hccSource.indexOf('scanAndAttachDetectedPeers();')
  );
  if ((autoAttachSource.match(/runTmux\(\['list-panes'/g) || []).length > 0) {
    fail('auto-attach scan calls tmux list-panes inside scanAndAttachDetectedPeers instead of using listTmuxPanesOnce');
  }
  if (!autoAttachSource.includes('panes = listTmuxPanesOnce();')) {
    fail('auto-attach scan no longer uses one tmux pane listing per tick');
  }
  const managedStartSource = hccSource.slice(
    hccSource.indexOf('function startTmuxManagedSession(input)'),
    hccSource.indexOf('function restoreTmuxManagedSessions')
  );
  if (!managedStartSource.includes('rebindOldTmux: true')) {
    fail('managed tmux start no longer marks explicit rebind cleanup');
  }
  if (!managedStartSource.includes('skipProviderRebindCleanup: oldTmuxTargetsForRebind.length > 0')) {
    fail('managed tmux start no longer avoids duplicate provider rebind cleanup planning');
  }
  for (const expected of [
    'HCC_ROOT: pctx.root',
    'HCC_DB: pctx.dbPath',
    '[LAUNCH_FINGERPRINT_ENV]: env[LAUNCH_FINGERPRINT_ENV]'
  ]) {
    if (!managedStartSource.includes(expected)) fail(`managed tmux start no longer marks session env: ${expected}`);
  }
  const restoreSource = hccSource.slice(
    hccSource.indexOf('function restoreTmuxManagedSessions'),
    hccSource.indexOf('function startPtySession')
  );
  if (restoreSource.includes('rebindOldTmux')) {
    fail('restore path must not kill old tmux sessions as a rebind');
  }
  for (const expected of [
    'function detectedPeerCanStop(peer)',
    "if (['exited', 'detached'].includes(status)) return false;",
    'const canStop = detectedPeerCanStop(p);',
    '${canStop ?',
    'function providerSessionKnown(session)',
    "tr('providerSession') + '=' + sessionProvider(session) + ':' + (value || tr('unknown'))",
    'sessionCardDetailText(s)',
    'const activeDetectedPeers = visibleDetected.filter((p) => peerIsActive(p));',
    'const staleDetectedPeers = visibleDetected.filter((p) => !peerIsActive(p));',
    "localStorage.setItem('hcc.showStaleDetected'",
    'id="toggleStaleDetected"',
    "if (e.target.closest('[data-action]')) return;",
    'id="stopKillLabel" data-i18n="dialog.killTmux"',
    'id="stopCancelBtn" type="button" data-i18n="dialog.cancel"',
    'id="stopConfirmBtn" type="button" data-i18n="stop"'
  ]) {
    if (!webUiTemplateSource.includes(expected)) fail(`web display regression guard missing: ${expected}`);
  }
  if (webUiTemplateSource.includes("p.status === 'running' ?")) {
    fail('detected peer action rendering still depends on status === running instead of liveness');
  }
  if (webUiTemplateSource.indexOf("const stopDialog = document.getElementById('stopDialog');") >
      webUiTemplateSource.indexOf("document.getElementById('stopBtn').addEventListener('click'")) {
    fail('stop dialog DOM references are declared after the stop button handler uses them');
  }
  if (webUiTemplateSource.includes("sessionRuntimeNote(s) + (s.command || '')")) {
    fail('managed session display still uses command text as the primary runtime identity');
  }
  const sessionSerializeSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'session-serialize.mjs'), 'utf8');
  for (const expected of [
    'function sessionBindingForSerialize(db, session, peerId)',
    'function serializeBindingSummary(binding, session)',
    'provider_session_known: Boolean(providerSessionLabel)',
    'provider_session_label: providerSessionLabel'
  ]) {
    if (!sessionSerializeSource.includes(expected)) fail(`sessions API binding summary missing: ${expected}`);
  }
  for (const expected of [
    'import { createWebPeerActions } from \'../lib/web/peer-actions.mjs\'',
    '} = createWebPeerActions({',
    'const peerActionMatch = url.pathname.match(/^\\/api\\/peers\\/([^/]+)\\/actions\\/([^/]+)$/)',
    "const readOnly = ['status', 'state', 'inbox'].includes(action)",
    'resolveWebActionSession(reqCtx, peer, input, req)',
    'action_token: connectionActionToken',
    'session.actionTokens.add(connectionActionToken)',
    'session.actionTokens.delete(connectionActionToken)',
    "const sender = 'web';",
    "auditActorPeer: 'web'",
    "auditSource: 'web'",
    "addEvent(db, 'peer.start.requested'",
    "addEvent(db, 'peer.attach.requested'",
    "addEvent(db, 'peer.stop.requested'",
    "addEvent(eventDb, 'web.session.stop_requested'",
    "addEvent(db, 'tmux.session.gc'"
  ]) {
    if (!hccSource.includes(expected)) fail(`web peer action API support missing: ${expected}`);
  }
  const actionResolverSource = hccSource.slice(
    hccSource.indexOf('function resolveWebActionSession('),
    hccSource.indexOf('function knownPeerIds(')
  );
  if (!actionResolverSource.includes('tokenMatches(provided, candidate)') ||
      !actionResolverSource.includes('session.actionTokens') ||
      actionResolverSource.includes('provided !== expected')) {
    fail('resolveWebActionSession must use the shared constant-time token comparator');
  }
  const websocketInputSource = hccSource.slice(
    hccSource.indexOf("ws.on('message', (raw) => {"),
    hccSource.indexOf("ws.on('close', () => {", hccSource.indexOf("ws.on('message', (raw) => {"))
  );
  if (!websocketInputSource.includes('tokenMatches(msg.action_token, connectionActionToken)') ||
      websocketInputSource.includes('session.actionToken')) {
    fail('terminal WebSocket input must use the shared constant-time token comparator');
  }
  const webSessionLifecycleSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'cookie-auth.mjs'), 'utf8');
  for (const expected of [
    'ws.close(4001, reason)',
    "session.expiresAt <= t) closeWebSession(sid, 'session expired')",
    'webSessions.size >= maxSessions',
    "closeWebSession(oldest, 'session limit reached')"
  ]) {
    if (!webSessionLifecycleSource.includes(expected)) {
      fail(`browser session lifecycle no longer closes sockets: ${expected}`);
    }
  }
  for (const helper of [
    'function webPeerRegister(',
    'function webPeerHeartbeat(',
    'function webPeerTaskNext(',
    'function webPeerTaskTakeover(',
    'function webPeerLockAcquire(',
    'function webPeerLockRelease(',
    'function webPeerInbox(',
    'function webPeerAction('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds web peer action helper: ${helper}`);
  }
  for (const expected of [
    'function webMutationPeer(peer, input = {})',
    'function webPeerAction(projectCtx, peer, action, input = {})',
    'function webAuditPayload(peer, input = {}, extra = {})',
    "source: 'web'",
    'actor_peer: actorPeer',
    'target_peer: peer',
    "throw new CliError('PEER_IDENTITY_MISMATCH'",
    "throw new CliError('PEER_IDENTITY_REQUIRED'",
    'claimNextTasksForPeer(db, peer, { force: Boolean(input.force), count })',
    'ownerEvidenceFor: (owner, _row, ownerRow, binding) => observePeerEvidence',
    'runOptimisticEvidenceMutation(db, {',
    'captureLockAcquireSubject(subjectDb, {',
    'beforeMutate: (subject, evidenceByOwner) =>',
    'prepareClockObservation(db, subject, evidenceByOwner)',
    "assertTaskOwnerForMutation(db, peer, task, 'lock-acquire')",
    'const status = statusSummary(projectCtx, peer)',
    "normalized === 'task-next'",
    "normalized === 'lock-acquire'",
    "normalized === 'lock-release'"
  ]) {
    if (!webPeerActionsSource.includes(expected)) fail(`web peer action helper missing: ${expected}`);
  }
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const cliVersion = run(process.execPath, [hccBin, '--version']).trim();
  if (cliVersion !== packageVersion) {
    fail(`CLI version ${cliVersion} does not match package.json ${packageVersion}`);
  }
  const releasePackageMeta = await import(path.join(repoRoot, 'lib', 'release', 'package-meta.mjs'));
  const releaseNotesModule = await import(path.join(repoRoot, 'lib', 'release', 'release-notes.mjs'));
  const compatPackageMeta = await import(path.join(repoRoot, 'lib', 'package-meta.mjs'));
  const compatReleaseNotes = await import(path.join(repoRoot, 'lib', 'release-notes.mjs'));
  for (const [moduleName, mod, names] of [
    ['release/package-meta', releasePackageMeta, ['packageRoot', 'readJson', 'readPackageJson', 'readPackageMeta']],
    ['release/release-notes', releaseNotesModule, ['normalizeVersion', 'releaseSection', 'validateReleaseSection', 'repoFromPackage']],
    ['package-meta compat', compatPackageMeta, ['packageRoot', 'readJson', 'readPackageJson', 'readPackageMeta']],
    ['release-notes compat', compatReleaseNotes, ['normalizeVersion', 'releaseSection', 'validateReleaseSection', 'repoFromPackage']]
  ]) {
    for (const name of names) {
      if (typeof mod[name] !== 'function') fail(`${moduleName} missing export: ${name}`);
    }
  }
  const releaseScriptRoot = releasePackageMeta.packageRoot(
    pathToFileURL(path.join(repoRoot, 'scripts', 'release-notes.mjs')).href
  );
  if (releaseScriptRoot !== repoRoot) {
    fail(`release packageRoot resolved ${releaseScriptRoot}, expected ${repoRoot}`);
  }
  const releaseNotesScriptSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'release-notes.mjs'), 'utf8');
  const githubReleaseScriptSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'github-release.mjs'), 'utf8');
  if (!releaseNotesScriptSource.includes("../lib/release/package-meta.mjs") ||
      !releaseNotesScriptSource.includes("../lib/release/release-notes.mjs") ||
      !githubReleaseScriptSource.includes("../lib/release/package-meta.mjs") ||
      !githubReleaseScriptSource.includes("../lib/release/release-notes.mjs")) {
    fail('release scripts do not import release helpers from lib/release');
  }
  const dbSchema = await import(path.join(repoRoot, 'lib', 'db', 'schema.mjs'));
  const compatDbSchema = await import(path.join(repoRoot, 'lib', 'db-schema.mjs'));
  for (const [moduleName, mod] of [
    ['db/schema', dbSchema],
    ['db-schema compat', compatDbSchema]
  ]) {
    if (typeof mod.DB_SCHEMA_VERSION !== 'number') fail(`${moduleName} missing DB_SCHEMA_VERSION export`);
    for (const name of ['execWithBusyRetry', 'initSchema', 'readSchemaVersion', 'tx']) {
      if (typeof mod[name] !== 'function') fail(`${moduleName} missing export: ${name}`);
    }
  }
  if (!hccSource.includes("import { readPackageMeta } from '../lib/package-meta.mjs'") ||
      !hccSource.includes("} from '../lib/cli-args.mjs'") ||
      !hccSource.includes("import { CliError } from '../lib/shared/errors.mjs'") ||
      !hccSource.includes("} from '../lib/db/schema.mjs'") ||
      !hccSource.includes("} from '../lib/cli-runtime.mjs'") ||
      !hccSource.includes("import { createCoordinationState } from '../lib/coordination-state.mjs'") ||
      !hccSource.includes("import { createWebPeerActions } from '../lib/web/peer-actions.mjs'") ||
      !hccSource.includes("} from '../lib/format.mjs'") ||
      !hccSource.includes("} from '../lib/runtime/paths.mjs'") ||
      !hccSource.includes("} from '../lib/runtime/state.mjs'") ||
      !hccSource.includes("} from '../lib/project-context.mjs'") ||
      !hccSource.includes("} from '../lib/handoff.mjs'") ||
      !hccSource.includes("} from '../lib/core/peers/liveness.mjs'") ||
      !hccSource.includes("} from '../lib/ui/state-render.mjs'") ||
      !hccSource.includes("import { createHelpFunctions } from '../lib/ui/help.mjs'") ||
      !hccSource.includes("} from '../lib/runtime/client.mjs'") ||
      !hccSource.includes("} from '../lib/runtime/buffer-gc.mjs'") ||
      !hccSource.includes("import { createMessageStore } from '../lib/core/coordination/messages.mjs'") ||
      !hccSource.includes("import { createTaskStore } from '../lib/core/coordination/tasks.mjs'") ||
      !hccSource.includes("} from '../lib/task-cli.mjs'") ||
      !hccSource.includes("} from '../lib/core/sessions/launch.mjs'") ||
      !hccSource.includes("} from '../lib/integrations/providers.mjs'") ||
      !hccSource.includes("} from '../lib/core/peers/session.mjs'") ||
      !hccSource.includes("} from '../lib/core/peers/bindings.mjs'") ||
      !hccSource.includes("import { createPeerBindingStore } from '../lib/db/stores/peers.mjs'") ||
      !hccSource.includes("} from '../lib/tmux.mjs'") ||
      !hccSource.includes("} from '../lib/core/coordination/locks.mjs'") ||
      !hccSource.includes("} from '../lib/core/coordination/teams.mjs'") ||
      !hccSource.includes("} from '../lib/integrations/peers/identity.mjs'") ||
      !hccSource.includes("} from '../lib/runtime/projects.mjs'") ||
      !hccSource.includes("} from '../lib/web/runtime.mjs'") ||
      !hccSource.includes("} from '../lib/web/http.mjs'") ||
      !hccSource.includes("import * as webUiTemplate from '../lib/web/ui-template.mjs'") ||
      !hccSource.includes('const VERSION = PACKAGE_META.version') ||
      !hccSource.includes('writeGuidanceForRoot(ctx.root)')) {
    fail('CLI still has duplicated package metadata, cli args, DB schema helpers, CLI runtime helpers, coordination state helpers, format helpers, runtime paths/state helpers, runtime client helpers, project context helpers, handoff helpers, timeline helpers, task liveness helpers, automation helpers, state render helpers, help text helpers, message store helpers, task store helpers, task CLI helpers, session launch helpers, provider command helpers, peer binding helpers, tmux helpers, lock helpers, team planning helpers, peer identity helpers, project registry helpers, web runtime/HTTP/UI helpers, or guidance wiring');
  }
  for (const expected of [
    "renderAutomationContext",
    "from './core/coordination/automation.mjs'",
    "formatOpenTaskLine",
    "from './core/peers/liveness.mjs'",
    "timelineFromRows",
    "from './core/coordination/timeline.mjs'",
    "from './core/coordination/locks.mjs'"
  ]) {
    if (!coordinationStateSource.includes(expected)) fail(`coordination state dependency missing: ${expected}`);
  }
  if (hccSource.includes('function createBaseSchema') ||
      hccSource.includes('function runSchemaMigrations') ||
      hccSource.includes('function readSchemaVersion')) {
    fail('CLI still embeds DB schema or migration helpers');
  }
  for (const helper of [
    'function createContext(',
    'function tailFile(',
    'function commandPath(',
    'function packageRoot('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds CLI runtime helper: ${helper}`);
  }
  if (errorsCompatSource.includes('class CliError')) {
    fail('errors compatibility module still embeds CliError');
  }
  if (!errorsCompatSource.includes("from './shared/errors.mjs'") ||
      !sharedErrorsSource.includes('class CliError')) {
    fail('CliError is not wired through lib/shared/errors.mjs');
  }
  const oldErrorImportPattern = /from ['"](?:\.\.\/lib\/errors|\.\/errors|\.\.\/errors|\.\.\/\.\.\/errors)\.mjs['"]/;
  for (const file of ['bin/hcc.mjs', ...libModuleFiles()]) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    if (file !== 'lib/errors.mjs' && oldErrorImportPattern.test(source)) {
      fail(`${file} still imports CliError through the old errors module`);
    }
  }
  const sharedErrors = await import(path.join(repoRoot, 'lib', 'shared', 'errors.mjs'));
  const compatErrors = await import(path.join(repoRoot, 'lib', 'errors.mjs'));
  if (typeof sharedErrors.CliError !== 'function') fail('shared errors module missing CliError');
  if (compatErrors.CliError !== sharedErrors.CliError) fail('errors compatibility export mismatch');
  if (!hccSource.includes('function shellCommand(args)') ||
      hccSource.includes('return args.map(shellQuoteArg).join')) {
    fail('CLI shellCommand wrapper no longer delegates to cli-runtime shellCommand helper');
  }
  for (const helper of [
    'const CLAUDE_SETTINGS_PATH',
    'const CODEX_HOOKS_PATH',
    'function installClaudeHooks',
    'function uninstallClaudeHooks',
    'function verifyClaudeHooks',
    'function installCodexHooks',
    'function uninstallCodexHooks',
    'function verifyCodexHooks',
    'function mergeCodexHookEntry',
    'function mergeHookEntry',
    'function isHccHookCmd'
  ]) {
    if (setupSource.includes(helper)) fail(`setup module still embeds hook helper: ${helper}`);
  }
  if (!setupSource.includes("from './integrations/hooks.mjs'")) {
    fail('setup module does not re-export hook helpers from integrations/hooks.mjs');
  }
  for (const helper of [
    'const SHIM_DIR',
    'function installShims',
    'function uninstallShims',
    'function verifyShims',
    'function shimStatus',
    'function findRealBinary',
    'function fsExists'
  ]) {
    if (setupSource.includes(helper)) fail(`setup module still embeds shim helper: ${helper}`);
  }
  if (!setupSource.includes("from './integrations/shims.mjs'")) {
    fail('setup module does not re-export shim helpers from integrations/shims.mjs');
  }
  if (!setupSource.includes("from './shell-path.mjs'")) {
    fail('setup module does not re-export shell path helpers from shell-path.mjs');
  }
  if (!integrationHooksSource.includes("from '../shared/json-file.mjs'") ||
      !integrationHooksSource.includes("const CLAUDE_SETTINGS_PATH") ||
      !integrationHooksSource.includes("const CODEX_HOOKS_PATH")) {
    fail('integrations hook module is missing expected hook storage wiring');
  }
  if (!integrationShimsSource.includes("from './shims/script.mjs'") ||
      !integrationShimsSource.includes("const SHIM_DIR") ||
      !integrationShimsSource.includes('function findRealBinary') ||
      !integrationShimsSource.includes("spawnSync('which'")) {
    fail('integrations shim module is missing expected shim wiring');
  }
  if (!shimScriptCompatSource.includes("from './integrations/shims/script.mjs'")) {
    fail('shim script compatibility module does not re-export from integrations/shims/script.mjs');
  }
  if (!integrationShimScriptSource.includes('function generateShim') ||
      !integrationShimScriptSource.includes('hello-cc shim for ${tool.name}') ||
      !integrationShimScriptSource.includes('HCC_SHIM_ENSURED') ||
      !integrationShimScriptSource.includes('HCC_RUNTIME_LOCAL_ONLY') ||
      !integrationShimScriptSource.includes('hcc_runtime_unavailable_start_failure')) {
    fail('integrations shim script module is missing expected generateShim wiring');
  }
  if (integrationShimScriptSource.includes('HCC_SKIP_SHIM_INSTALL=1 "$HCC_BIN" web')) {
    fail('integration shim script still auto-starts hcc web instead of falling back to the real provider');
  }
  if (!shellPathSource.includes('function installPathEntry') ||
      !shellPathSource.includes('function uninstallPathEntry') ||
      !shellPathSource.includes('.hcc-shims')) {
    fail('shell path module is missing expected setup path helpers');
  }
  const setupModule = await import(path.join(repoRoot, 'lib', 'setup.mjs'));
  const integrationHooks = await import(path.join(repoRoot, 'lib', 'integrations', 'hooks.mjs'));
  const integrationShims = await import(path.join(repoRoot, 'lib', 'integrations', 'shims.mjs'));
  const integrationShimScript = await import(path.join(repoRoot, 'lib', 'integrations', 'shims', 'script.mjs'));
  const peerSession = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'session.mjs'));
  const shimScriptCompat = await import(path.join(repoRoot, 'lib', 'shim-script.mjs'));
  const shellPath = await import(path.join(repoRoot, 'lib', 'shell-path.mjs'));
  for (const name of [
    'installClaudeHooks',
    'uninstallClaudeHooks',
    'verifyClaudeHooks',
    'installCodexHooks',
    'uninstallCodexHooks',
    'verifyCodexHooks'
  ]) {
    if (typeof integrationHooks[name] !== 'function') fail(`integrations hook module missing export: ${name}`);
    if (setupModule[name] !== integrationHooks[name]) fail(`setup hook export mismatch: ${name}`);
  }
  for (const name of ['installShims', 'uninstallShims', 'verifyShims', 'shimStatus', 'findRealBinary']) {
    if (typeof integrationShims[name] !== 'function') fail(`integrations shim module missing export: ${name}`);
    if (setupModule[name] !== integrationShims[name]) fail(`setup shim export mismatch: ${name}`);
  }
  if (typeof integrationShims.SHIM_DIR !== 'string' || !integrationShims.SHIM_DIR.endsWith('.hcc-shims')) {
    fail(`integrations shim module has unexpected SHIM_DIR: ${integrationShims.SHIM_DIR}`);
  }
  if (setupModule.SHIM_DIR !== integrationShims.SHIM_DIR) fail('setup shim dir export mismatch');
  if (typeof integrationShimScript.generateShim !== 'function') fail('integrations shim script module missing generateShim export');
  if (shimScriptCompat.generateShim !== integrationShimScript.generateShim) fail('shim script compatibility export mismatch');
  assertShimRuntimeUnavailableFallback(integrationShimScript.generateShim);
  assertGeneratedShimPeerHash(integrationShimScript.generateShim, peerSession.providerSessionPeerId);
  await assertShimIgnoresGlobalRuntime(integrationShimScript.generateShim);
  for (const name of ['installPathEntry', 'uninstallPathEntry']) {
    if (typeof shellPath[name] !== 'function') fail(`shell path module missing export: ${name}`);
    if (setupModule[name] !== shellPath[name]) fail(`setup shell path export mismatch: ${name}`);
  }
  const bashRc = '# regression rc\n[ -z "$PS1" ] && return\nexport PATH="/late:$PATH"\n';
  const bashPath = shellPath.insertPathEntry(bashRc, 'bash');
  if ((bashPath.match(/# hello-cc shims/g) || []).length !== 2 ||
      bashPath.indexOf('# hello-cc shims (early)') > bashPath.indexOf('[ -z "$PS1" ] && return') ||
      bashPath.lastIndexOf('# hello-cc shims (final)') < bashPath.indexOf('export PATH="/late:$PATH"')) {
    fail(`bash shell PATH insertion lost early/final placement:\n${bashPath}`);
  }
  const zshPath = shellPath.insertPathEntry('export PATH="$HOME/bin:$PATH"\n', 'zsh');
  if ((zshPath.match(/# hello-cc shims/g) || []).length !== 1 ||
      zshPath.includes('# hello-cc shims (early)') ||
      !zshPath.includes('# hello-cc shims (final)')) {
    fail(`zsh shell PATH insertion should install one final entry:\n${zshPath}`);
  }
  const fishPath = shellPath.insertPathEntry('set -gx PATH $HOME/bin $PATH\n', 'fish');
  if ((fishPath.match(/# hello-cc shims/g) || []).length !== 1 ||
      fishPath.includes('# hello-cc shims (early)') ||
      !fishPath.includes('# hello-cc shims (final)')) {
    fail(`fish shell PATH insertion should install one final entry:\n${fishPath}`);
  }
  const customRc = [
    'export PATH="$HOME/.hcc-shims:$PATH" # user custom shim dir',
    shellPath.pathEntryLine('bash', 'final')
  ].join('\n');
  const cleanedRc = shellPath.removePathEntryLines(customRc);
  if (!cleanedRc.includes('user custom shim dir') || cleanedRc.includes('# hello-cc shims')) {
    fail(`shell PATH cleanup removed a non-hello-cc custom line or kept hello-cc line:\n${cleanedRc}`);
  }
  const noProviderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-no-provider-home-'));
  try {
    const noProviderEnv = {
      ...env,
      HOME: noProviderHome,
      PATH: '/usr/bin:/bin',
      SHELL: '/bin/bash'
    };
    const noProviderInstall = run(process.execPath, [hccBin, '--root', root, 'shim', 'install'], { env: noProviderEnv });
    if (!noProviderInstall.includes('no shims installed')) {
      fail(`shim install without providers did not report no shims:\n${noProviderInstall}`);
    }
    const noProviderBashrc = path.join(noProviderHome, '.bashrc');
    if (fs.existsSync(noProviderBashrc) && fs.readFileSync(noProviderBashrc, 'utf8').includes('.hcc-shims')) {
      fail(`shim install without providers modified shell PATH:\n${fs.readFileSync(noProviderBashrc, 'utf8')}`);
    }
  } finally {
    try { fs.rmSync(noProviderHome, { recursive: true, force: true }); } catch {}
  }
  const fishHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fish-home-'));
  try {
    const fishEnv = {
      ...env,
      HOME: fishHome,
      SHELL: '/usr/bin/fish'
    };
    const fishInstall = run(process.execPath, [hccBin, '--root', root, 'shim', 'install'], { env: fishEnv });
    const fishRc = path.join(fishHome, '.config', 'fish', 'config.fish');
    if (!fishInstall.includes('PATH updated') ||
        !fs.existsSync(fishRc) ||
        !fs.readFileSync(fishRc, 'utf8').includes('# hello-cc shims (final)')) {
      fail(`fish shim install did not create config.fish PATH entry:\n${fishInstall}\n${fs.existsSync(fishRc) ? fs.readFileSync(fishRc, 'utf8') : '(missing)'}`);
    }
  } finally {
    try { fs.rmSync(fishHome, { recursive: true, force: true }); } catch {}
  }
  const missingRcHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-missing-rc-home-'));
  try {
    const missingRcEnv = {
      ...env,
      HOME: missingRcHome,
      SHELL: '/bin/bash'
    };
    const uninstallOutput = run(process.execPath, [hccBin, '--root', root, 'shim', 'uninstall'], { env: missingRcEnv });
    if (uninstallOutput.includes('PATH entry not removed') || !uninstallOutput.includes('PATH entry not present')) {
      fail(`shim uninstall reported missing shell rc as a failure:\n${uninstallOutput}`);
    }
  } finally {
    try { fs.rmSync(missingRcHome, { recursive: true, force: true }); } catch {}
  }
  const partialStatusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-partial-status-home-'));
  try {
    const partialStatusDir = path.join(partialStatusHome, '.hcc-shims');
    fs.mkdirSync(partialStatusDir, { recursive: true });
    fs.writeFileSync(path.join(partialStatusDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const partialStatusEnv = {
      ...env,
      HOME: partialStatusHome,
      SHELL: '/bin/bash'
    };
    const statusOutput = run(process.execPath, [hccBin, '--root', root, 'shim', 'status'], { env: partialStatusEnv });
    if (!statusOutput.includes('claude: installed') ||
        !statusOutput.includes('codex: missing') ||
        !statusOutput.includes('status: partial')) {
      fail(`shim status did not report partial install per tool:\n${statusOutput}`);
    }
  } finally {
    try { fs.rmSync(partialStatusHome, { recursive: true, force: true }); } catch {}
  }
  const partialShimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-partial-shim-home-'));
  const partialShimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-partial-shim-root-'));
  try {
    const partialShimDir = path.join(partialShimHome, '.hcc-shims');
    fs.mkdirSync(partialShimDir, { recursive: true });
    fs.writeFileSync(path.join(partialShimDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const partialShimEnv = {
      ...env,
      HOME: partialShimHome,
      SHELL: '/bin/bash'
    };
    run(process.execPath, [hccBin, '--root', partialShimRoot, 'setup', '--quiet'], { env: partialShimEnv });
    for (const name of ['claude', 'codex']) {
      if (!fs.existsSync(path.join(partialShimDir, name))) {
        fail(`setup did not repair partial shim install; missing ${name}`);
      }
    }
  } finally {
    try { fs.rmSync(partialShimHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(partialShimRoot, { recursive: true, force: true }); } catch {}
  }
  const scanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-scan-home-'));
  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-scan-root-'));
  try {
    const scanRealRoot = fs.realpathSync(scanRoot);
    const claudeSessionsDir = path.join(scanHome, '.claude', 'sessions');
    fs.mkdirSync(claudeSessionsDir, { recursive: true });
    fs.writeFileSync(path.join(claudeSessionsDir, 'scan-realpath.json'), JSON.stringify({
      pid: process.pid,
      sessionId: 'scan-realpath-session',
      cwd: scanRoot,
      status: 'running'
    }));
    const scanEnv = {
      ...env,
      HOME: scanHome
    };
    const scanOutput = run(process.execPath, [hccBin, '--root', scanRealRoot, 'scan'], { env: scanEnv });
    if (!scanOutput.includes('claude') || !scanOutput.includes('scan-realpath')) {
      fail(`scan did not match discovered hccRoot through realpath comparison:\n${scanOutput}`);
    }
  } finally {
    try { fs.rmSync(scanHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(scanRoot, { recursive: true, force: true }); } catch {}
  }
  const cliRuntime = await import(path.join(repoRoot, 'lib', 'cli-runtime.mjs'));
  for (const name of ['commandPath', 'createContext', 'packageRoot', 'shellCommand', 'tailFile']) {
    if (typeof cliRuntime[name] !== 'function') fail(`CLI runtime module missing function: ${name}`);
  }
  const runtimeCtx = cliRuntime.createContext(
    { root: '/tmp/project', db: '.hello-cc/test.db', json: true },
    { cwd: '/tmp/project/subdir', detectRoot: (_cwd, rootHint) => rootHint || '/tmp/project' }
  );
  if (runtimeCtx.cwd !== '/tmp/project/subdir' ||
      runtimeCtx.root !== '/tmp/project' ||
      !runtimeCtx.dbPath.endsWith('/.hello-cc/test.db') ||
      runtimeCtx.json !== true ||
      runtimeCtx.explicitRoot !== true) {
    fail(`CLI runtime createContext changed: ${JSON.stringify(runtimeCtx)}`);
  }
  const quotedCommand = cliRuntime.shellCommand(['alpha', 'two words'], (value) => `[${value}]`);
  if (quotedCommand !== '[alpha] [two words]') fail(`CLI runtime shellCommand changed: ${quotedCommand}`);
  const tailPath = path.join(outDir, 'tail-smoke.txt');
  fs.writeFileSync(tailPath, '0123456789\n');
  if (cliRuntime.tailFile(tailPath, 4) !== '789' || cliRuntime.tailFile(path.join(outDir, 'missing-tail')) !== '') {
    fail('CLI runtime tailFile behavior changed');
  }
  for (const helper of [
    'function collectStateSnapshot(',
    'function buildHookCoordinationContext(',
    'function ackMessages(',
    'function statusSummary(',
    'function statusSnapshot('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds coordination state helper: ${helper}`);
  }
  const coordinationState = await import(path.join(repoRoot, 'lib', 'coordination-state.mjs'));
  if (typeof coordinationState.createCoordinationState !== 'function') {
    fail('coordination state module missing createCoordinationState');
  }
  const stateHelpers = coordinationState.createCoordinationState({
    connect: () => ({ close() {} }),
    observePeerEvidence: () => ({ state: 'unknown', reason: 'test' }),
    queryInbox: () => [],
    queryOpenTasks: () => [],
    queryTimelineMessages: () => []
  });
  for (const name of ['ackMessages', 'buildHookCoordinationContext', 'collectStateSnapshot', 'statusSnapshot', 'statusSummary']) {
    if (typeof stateHelpers[name] !== 'function') fail(`coordination state factory missing function: ${name}`);
  }
  for (const helper of [
    'function readGlobalRuntimeFile',
    'function writeGlobalRuntime',
    'function writeRuntime',
    'function readRuntime',
    'function readRuntimeFile',
    'function probeRuntime',
    'function readHealthyRuntime',
    'function readHealthyGlobalRuntime',
    'function clearRuntime'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds runtime state helper: ${helper}`);
  }
  const runtimePaths = await import(path.join(repoRoot, 'lib', 'runtime', 'paths.mjs'));
  const compatRuntimePaths = await import(path.join(repoRoot, 'lib', 'runtime-paths.mjs'));
  for (const [moduleName, mod] of [
    ['runtime/paths', runtimePaths],
    ['runtime-paths compat', compatRuntimePaths]
  ]) {
    for (const name of [
      'contextForProject',
      'globalRuntimePath',
      'globalStateDir',
      'globalWebTokenPath',
      'projectDbPath',
      'projectRegistryPath',
      'projectStateDir',
      'runtimePath',
      'webLogPath'
    ]) {
      if (typeof mod[name] !== 'function') fail(`${moduleName} missing export: ${name}`);
    }
  }
  const runtimeState = await import(path.join(repoRoot, 'lib', 'runtime', 'state.mjs'));
  const compatRuntimeState = await import(path.join(repoRoot, 'lib', 'runtime-state.mjs'));
  for (const name of [
    'readGlobalRuntimeFile',
    'writeGlobalRuntime',
    'writeRuntime',
    'readRuntime',
    'readRuntimeFile',
    'probeRuntime',
    'readHealthyRuntime',
    'readHealthyGlobalRuntime',
    'clearRuntime'
  ]) {
    if (typeof runtimeState[name] !== 'function') fail(`runtime state module missing export: ${name}`);
    if (typeof compatRuntimeState[name] !== 'function') fail(`runtime state compat module missing export: ${name}`);
  }
  const savedRuntimeEnv = {
    HOME: process.env.HOME,
    HCC_RUNTIME_URL: process.env.HCC_RUNTIME_URL,
    HCC_RUNTIME_TOKEN: process.env.HCC_RUNTIME_TOKEN
  };
  try {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-state-home-'));
    delete process.env.HCC_RUNTIME_URL;
    delete process.env.HCC_RUNTIME_TOKEN;
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-state-root-'));
    const runtimeCtx = { root: runtimeRoot };

    const projectRuntimeFile = runtimeState.writeRuntime(runtimeCtx, {
      base_url: 'http://127.0.0.1:11',
      token: 'project-token',
      pid: process.pid
    });
    if (!fs.existsSync(projectRuntimeFile) || (fs.statSync(projectRuntimeFile).mode & 0o777) !== 0o600) {
      fail('runtime state writeRuntime did not create a 0600 runtime file');
    }
    const projectRuntime = runtimeState.readRuntime(runtimeCtx);
    if (projectRuntime.base_url !== 'http://127.0.0.1:11' ||
        projectRuntime.token !== 'project-token' ||
        projectRuntime.source !== projectRuntimeFile) {
      fail(`runtime state project read changed: ${JSON.stringify(projectRuntime)}`);
    }
    if (runtimeState.readRuntimeFile(runtimeCtx)?.token !== 'project-token') {
      fail('runtime state readRuntimeFile changed');
    }
    runtimeState.clearRuntime(runtimeCtx, 202);
    if (!fs.existsSync(projectRuntimeFile)) fail('runtime state clearRuntime removed a different pid');
    runtimeState.clearRuntime(runtimeCtx, process.pid);
    if (fs.existsSync(projectRuntimeFile)) fail('runtime state clearRuntime did not remove matching project pid');

    const globalRuntimeFile = runtimeState.writeGlobalRuntime({
      base_url: 'http://127.0.0.1:12',
      token: 'global-token',
      pid: process.pid
    });
    const globalRuntime = runtimeState.readRuntime(runtimeCtx);
    if (globalRuntime.base_url !== 'http://127.0.0.1:12' ||
        globalRuntime.token !== 'global-token' ||
        globalRuntime.source !== globalRuntimeFile ||
        globalRuntime.global !== true) {
      fail(`runtime state global fallback changed: ${JSON.stringify(globalRuntime)}`);
    }
    runtimeState.clearRuntime(runtimeCtx, 404);
    if (!fs.existsSync(globalRuntimeFile)) fail('runtime state clearRuntime removed a different global pid');
    runtimeState.clearRuntime(runtimeCtx, process.pid);
    if (fs.existsSync(globalRuntimeFile)) fail('runtime state clearRuntime did not remove matching global pid');

    // bg-01: a runtime pointer whose pid is dead must be skipped (not returned
    // as reachable), so commands don't fail against a stale pointer.
    runtimeState.writeGlobalRuntime({ base_url: 'http://127.0.0.1:13', token: 'dead-token', pid: 999999 });
    try {
      runtimeState.readRuntime(runtimeCtx);
      fail('runtime state readRuntime returned a dead-pid runtime pointer');
    } catch (err) {
      if (err?.code !== 'RUNTIME_NOT_RUNNING') throw err;
    }
    runtimeState.clearRuntime(runtimeCtx, 999999);
    if (fs.existsSync(globalRuntimeFile)) fail('runtime state clearRuntime did not remove the dead-pid global pointer');

    const deterministicRuntimeIdentity = {
      pid: process.pid,
      startToken: 'regression:current-process',
      commandHash: 'c'.repeat(64)
    };
    const deterministicRuntimeInspect = () => ({
      state: 'live',
      identity: deterministicRuntimeIdentity
    });
    const deterministicGlobalRuntime = {
      base_url: 'http://127.0.0.1:14',
      token: 'reused-pid-token',
      pid: process.pid,
      process_identity: deterministicRuntimeIdentity
    };
    runtimeState.writeGlobalRuntime(deterministicGlobalRuntime);
    const verifiedGlobalRuntime = runtimeState.readRuntime(runtimeCtx, {
      inspectProcessIdentity: deterministicRuntimeInspect
    });
    if (verifiedGlobalRuntime.base_url !== 'http://127.0.0.1:14') {
      fail('runtime state readRuntime rejected a matching global process identity');
    }
    runtimeState.writeGlobalRuntime({
      ...deterministicGlobalRuntime,
      process_identity: {
        ...deterministicRuntimeIdentity,
        startToken: 'regression:reused-process'
      }
    });
    try {
      runtimeState.readRuntime(runtimeCtx, {
        inspectProcessIdentity: deterministicRuntimeInspect
      });
      fail('runtime state readRuntime returned a reused-pid global pointer');
    } catch (err) {
      if (err?.code !== 'RUNTIME_NOT_RUNNING') throw err;
    }
    runtimeState.clearRuntime(runtimeCtx, process.pid);
    if (fs.existsSync(globalRuntimeFile)) {
      fail('runtime state clearRuntime did not remove the reused-pid global pointer');
    }

    fs.writeFileSync(globalRuntimeFile, '{bad');
    if (runtimeState.readGlobalRuntimeFile() !== null) {
      fail('runtime state readGlobalRuntimeFile did not reject invalid JSON');
    }
    // A torn/partial write must NOT be deleted on read (rob-02): deleting it can
    // orphan a healthy runtime. It is preserved for health probing / restart.
    if (!fs.existsSync(globalRuntimeFile)) {
      fail('runtime state readGlobalRuntimeFile must not delete a torn/partial file');
    }
    fs.rmSync(globalRuntimeFile, { force: true });

    process.env.HCC_RUNTIME_URL = 'http://env-runtime.test';
    process.env.HCC_RUNTIME_TOKEN = 'env-token';
    const envRuntime = runtimeState.readRuntime(runtimeCtx);
    if (envRuntime.base_url !== 'http://env-runtime.test' ||
        envRuntime.token !== 'env-token' ||
        envRuntime.source !== 'env') {
      fail(`runtime state env runtime precedence changed: ${JSON.stringify(envRuntime)}`);
    }
    delete process.env.HCC_RUNTIME_URL;
    delete process.env.HCC_RUNTIME_TOKEN;

    try {
      runtimeState.readRuntime(runtimeCtx, { productName: 'product-x', cliName: 'cli-x' });
      fail('runtime state readRuntime succeeded without runtime');
    } catch (err) {
      if (err?.code !== 'RUNTIME_NOT_RUNNING' ||
          !String(err.message || '').includes('product-x') ||
          !String(err.message || '').includes('cli-x web')) {
        throw err;
      }
    }
    if (await runtimeState.probeRuntime(null) !== false ||
        await runtimeState.readHealthyRuntime(runtimeCtx) !== null ||
        await runtimeState.readHealthyGlobalRuntime() !== null) {
      fail('runtime state unhealthy runtime behavior changed');
    }
  } finally {
    for (const [key, value] of Object.entries(savedRuntimeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (hccSource.includes('async function runtimeRequest')) fail('CLI still embeds runtime request client helper');
  const runtimeClient = await import(path.join(repoRoot, 'lib', 'runtime', 'client.mjs'));
  const compatRuntimeClient = await import(path.join(repoRoot, 'lib', 'runtime-client.mjs'));
  if (typeof runtimeClient.runtimeRequest !== 'function') fail('runtime client module missing runtimeRequest export');
  if (typeof compatRuntimeClient.runtimeRequest !== 'function') fail('runtime client compat module missing runtimeRequest export');
  const savedFetch = globalThis.fetch;
  const runtimeFetchCalls = [];
  try {
    globalThis.fetch = async (url, opts = {}) => {
      runtimeFetchCalls.push({ url, opts });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const runtimeClientData = await runtimeClient.runtimeRequest(
      { root: '/repo-root', dbPath: '/repo-root/.hello-cc/mesh.db' },
      'POST',
      '/api/test',
      { value: 1 },
      { base_url: 'http://127.0.0.1:8787/', token: 'runtime-token', source: 'runtime-file' },
      { cliName: 'hccx' }
    );
    if (runtimeClientData.ok !== true || runtimeFetchCalls.length !== 1) {
      fail(`runtime client request data changed: ${JSON.stringify({ runtimeClientData, runtimeFetchCalls })}`);
    }
    const call = runtimeFetchCalls[0];
    if (String(call.url) !== 'http://127.0.0.1:8787/api/test' ||
        call.opts.method !== 'POST' ||
        call.opts.headers.Authorization !== 'Bearer runtime-token' ||
        call.opts.headers['X-HCC-Root'] !== '/repo-root' ||
        call.opts.headers['X-HCC-DB'] !== '/repo-root/.hello-cc/mesh.db' ||
        call.opts.body !== JSON.stringify({ value: 1 })) {
      fail(`runtime client request shape changed: ${JSON.stringify(runtimeFetchCalls, null, 2)}`);
    }
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    try {
      await runtimeClient.runtimeRequest(
        { root: '/repo-root', dbPath: '/repo-root/.hello-cc/mesh.db' },
        'GET',
        '/api/bad',
        null,
        { base_url: 'http://127.0.0.1:8787/' }
      );
      fail('runtime client accepted non-JSON runtime response');
    } catch (err) {
      if (err?.code !== 'RUNTIME_BAD_RESPONSE') throw err;
    }
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      await runtimeClient.runtimeRequest(
        { root: '/repo-root', dbPath: '/repo-root/.hello-cc/mesh.db' },
        'GET',
        '/api/offline',
        null,
        { base_url: 'http://127.0.0.1:8787/', source: 'runtime-file' },
        { cliName: 'hccx' }
      );
      fail('runtime client accepted unreachable runtime');
    } catch (err) {
      if (err?.code !== 'RUNTIME_UNREACHABLE' ||
          !String(err.message || '').includes('Start hccx web again') ||
          err.extra?.runtime !== 'runtime-file') {
        throw err;
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
  for (const helper of [
    'function runGit',
    'function hasHccRootSync',
    'function detectRoot',
    'function detectBranch'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds project context helper: ${helper}`);
  }
  const projectContext = await import(path.join(repoRoot, 'lib', 'project-context.mjs'));
  for (const name of [
    'runGit',
    'hasHccRootSync',
    'detectRoot',
    'detectBranch'
  ]) {
    if (typeof projectContext[name] !== 'function') fail(`project context module missing export: ${name}`);
  }
  const gitTop = projectContext.runGit(['rev-parse', '--show-toplevel'], repoRoot);
  if (path.resolve(gitTop || '') !== repoRoot) fail(`project context runGit changed: ${gitTop}`);
  const gitBranch = projectContext.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '';
  const detectedBranch = projectContext.detectBranch(repoRoot);
  if (detectedBranch !== gitBranch) {
    fail(`project context detectBranch changed: ${detectedBranch} != ${gitBranch}`);
  }
  const savedHccRoot = process.env.HCC_ROOT;
  try {
    delete process.env.HCC_ROOT;
    if (projectContext.detectRoot('/tmp/hcc-a', '') !== path.resolve('/tmp/hcc-a')) {
      fail('project context detectRoot cwd fallback changed');
    }
    process.env.HCC_ROOT = '/tmp/hcc-env-root';
    if (projectContext.detectRoot('/tmp/hcc-a', '') !== path.resolve('/tmp/hcc-env-root') ||
        projectContext.detectRoot('/tmp/hcc-a', '/tmp/hcc-explicit-root') !== path.resolve('/tmp/hcc-explicit-root')) {
      fail('project context detectRoot precedence changed');
    }
  } finally {
    if (savedHccRoot === undefined) delete process.env.HCC_ROOT;
    else process.env.HCC_ROOT = savedHccRoot;
  }
  const contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-project-context-'));
  fs.mkdirSync(path.join(contextRoot, '.hello-cc'), { recursive: true });
  if (projectContext.hasHccRootSync(contextRoot)) fail('project context detected root before marker file');
  fs.writeFileSync(path.join(contextRoot, '.hello-cc', 'config.json'), '{}');
  if (!projectContext.hasHccRootSync(contextRoot)) fail('project context did not detect config marker');
  for (const helper of [
    'function normalizeListText',
    'function changedFiles'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds handoff helper: ${helper}`);
  }
  const handoffModule = await import(path.join(repoRoot, 'lib', 'handoff.mjs'));
  for (const name of [
    'normalizeListText',
    'changedFiles'
  ]) {
    if (typeof handoffModule[name] !== 'function') fail(`handoff module missing export: ${name}`);
  }
  if (handoffModule.normalizeListText(undefined, ['fallback']) !== JSON.stringify(['fallback'])) {
    fail('handoff normalizeListText fallback changed');
  }
  if (handoffModule.normalizeListText('["kept"]') !== '["kept"]') {
    fail('handoff normalizeListText JSON passthrough changed');
  }
  if (handoffModule.normalizeListText('one, two,, three') !== JSON.stringify(['one', 'two', 'three'])) {
    fail('handoff normalizeListText CSV parsing changed');
  }
  const handoffGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-handoff-git-'));
  run('git', ['init'], { cwd: handoffGitRoot });
  run('git', ['config', 'user.email', 'hcc-regression@example.invalid'], { cwd: handoffGitRoot });
  run('git', ['config', 'user.name', 'hcc regression'], { cwd: handoffGitRoot });
  fs.writeFileSync(path.join(handoffGitRoot, 'tracked.txt'), 'base\n');
  run('git', ['add', 'tracked.txt'], { cwd: handoffGitRoot });
  run('git', ['commit', '-m', 'init'], { cwd: handoffGitRoot });
  fs.writeFileSync(path.join(handoffGitRoot, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(handoffGitRoot, 'staged.txt'), 'new\n');
  run('git', ['add', 'staged.txt'], { cwd: handoffGitRoot });
  const handoffChanged = handoffModule.changedFiles(handoffGitRoot);
  if (JSON.stringify(handoffChanged) !== JSON.stringify(['staged.txt', 'tracked.txt'])) {
    fail(`handoff changedFiles changed: ${JSON.stringify(handoffChanged)}`);
  }
  for (const helper of [
    'function parseEventPayload',
    'function uniqueList',
    'function messageParticipants',
    'function taskParticipants',
    'function payloadParticipants',
    'function peerMatchesTimelineItem',
    'function shouldHideTimelineMessage',
    'function shouldHideTimelineEvent',
    'function timelineDirection',
    'function timelineFromRows'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds timeline helper: ${helper}`);
  }
  if (hccSource.includes('const TIMELINE_EVENT_ALLOW')) fail('CLI still embeds timeline event allow list');
  const timelineModule = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'timeline.mjs'));
  const compatTimelineModule = await import(path.join(repoRoot, 'lib', 'timeline.mjs'));
  for (const name of [
    'parseEventPayload',
    'uniqueList',
    'messageParticipants',
    'taskParticipants',
    'payloadParticipants',
    'peerMatchesTimelineItem',
    'shouldHideTimelineMessage',
    'shouldHideTimelineEvent',
    'timelineDirection',
    'timelineFromRows'
  ]) {
    if (typeof timelineModule[name] !== 'function') fail(`timeline module missing export: ${name}`);
    if (typeof compatTimelineModule[name] !== 'function') fail(`timeline compat module missing export: ${name}`);
  }
  if (JSON.stringify(timelineModule.uniqueList(['a', '', null, 'a', 7])) !== JSON.stringify(['a', '7'])) {
    fail('timeline uniqueList behavior changed');
  }
  if (JSON.stringify(timelineModule.parseEventPayload({ payload: '{bad' })) !== JSON.stringify({})) {
    fail('timeline parseEventPayload invalid JSON behavior changed');
  }
  if (!timelineModule.shouldHideTimelineMessage({ kind: 'task', body: 'Task #12 assigned: do work' }) ||
      !timelineModule.shouldHideTimelineEvent({ type: 'message.sent' }) ||
      timelineModule.shouldHideTimelineEvent({ type: 'task.done' })) {
    fail('timeline hide filters changed');
  }
  const timelineItems = timelineModule.timelineFromRows({
    messages: [
      { id: 1, sender: 'system', recipient: 'peer-b', task_id: 1, kind: 'task', body: 'Task #1 assigned: hidden', created_at: 1, read_at: null },
      { id: 2, sender: 'peer-a', recipient: 'peer-b', task_id: 2, kind: 'note', body: 'hello timeline', created_at: 2, read_at: null },
      { id: 3, sender: 'peer-b', recipient: 'all', task_id: null, kind: 'note', body: 'broadcast timeline', created_at: 3, read_at: 3 }
    ],
    handoffs: [
      { id: 4, from_peer: 'peer-a', to_peer: 'peer-b', task_id: 2, summary: 'handoff summary', created_at: 4, tests: 'tests', risks: 'risks' }
    ],
    tasks: [
      { id: 5, status: 'running', created_by: 'human', owner: 'peer-b', assignee: '', title: 'task title', created_at: 5, updated_at: 5, parent_id: null }
    ],
    locks: [
      { resource: 'bin/hcc.mjs', base_resource: 'bin/hcc.mjs', scope: 'timeline', owner: 'peer-a', task_id: 2, reason: 'hidden from peer-b', created_at: 6 }
    ],
    events: [
      { id: 7, type: 'message.sent', actor: 'peer-a', task_id: 2, payload: '{}', created_at: 7 },
      { id: 8, type: 'task.done', actor: 'peer-a', task_id: 2, payload: JSON.stringify({ owner: 'peer-b', summary: 'done summary' }), created_at: 8 },
      { id: 9, type: 'web.session.stop_requested', actor: 'web', task_id: null, payload: JSON.stringify({ actor_peer: 'web', target_peer: 'peer-b', peer: 'peer-b' }), created_at: 9 },
      { id: 10, type: 'task.dispatched', actor: 'peer-a', task_id: 2, payload: JSON.stringify({ actor_peer: 'peer-a', target_peer: 'peer-b', peer: 'peer-b', title: 'dispatch timeline' }), created_at: 10 }
    ]
  }, 'peer-b');
  const timelineIds = timelineItems.map((item) => item.id);
  if (JSON.stringify(timelineIds) !== JSON.stringify(['message:2', 'message:3', 'handoff:4', 'task:5', 'event:8', 'event:9', 'event:10'])) {
    fail(`timelineFromRows filtering/order changed: ${JSON.stringify(timelineItems)}`);
  }
  const inbound = timelineItems.find((item) => item.id === 'message:2');
  const broadcast = timelineItems.find((item) => item.id === 'message:3');
  if (inbound?.direction !== 'in' || inbound?.unread !== true ||
      broadcast?.direction !== 'out' || broadcast?.broadcast !== true) {
    fail(`timelineFromRows message metadata changed: ${JSON.stringify(timelineItems)}`);
  }
  for (const helper of [
    'function taskRelatedLocks',
    'function taskOwnerLiveness',
    'function annotateTasksWithLiveness',
    'function taskOwnerStateText',
    'function summarizeTask',
    'function formatOpenTaskLine'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds task liveness helper: ${helper}`);
  }
  const taskLivenessModule = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'liveness.mjs'));
  const compatTaskLivenessModule = await import(path.join(repoRoot, 'lib', 'task-liveness.mjs'));
  for (const name of [
    'taskRelatedLocks',
    'taskOwnerLiveness',
    'annotateTasksWithLiveness',
    'taskOwnerStateText',
    'summarizeTask',
    'formatOpenTaskLine'
  ]) {
    if (typeof taskLivenessModule[name] !== 'function') fail(`task liveness module missing export: ${name}`);
    if (typeof compatTaskLivenessModule[name] !== 'function') fail(`task liveness compat module missing export: ${name}`);
  }
  const livenessTasks = taskLivenessModule.annotateTasksWithLiveness([
    { id: 1, status: 'running', owner: 'active-owner', assignee: '', title: 'Active task', priority: 1 },
    { id: 2, status: 'running', owner: 'stale-owner', assignee: '', title: 'Stale task', priority: 2 },
    { id: 3, status: 'running', owner: 'locked-owner', assignee: '', title: 'Locked task', priority: 3 },
    { id: 4, status: 'pending', owner: 'stale-pending-owner', assignee: '', title: 'Pending stale task', priority: 4 },
    { id: 5, status: 'pending', owner: '', assignee: 'worker', title: 'Unowned task', priority: 5 }
  ], [
    { id: 'active-owner', age_sec: 10 },
    { id: 'stale-owner', last_seen_at: 100 },
    { id: 'locked-owner', age_sec: 900 },
    { id: 'stale-pending-owner', age_sec: 900 }
  ], [
    { owner: 'locked-owner', task_id: 3 }
  ], 1000, 600);
  const activeTask = livenessTasks.find((task) => task.id === 1);
  const staleTask = livenessTasks.find((task) => task.id === 2);
  const lockedTask = livenessTasks.find((task) => task.id === 3);
  const pendingTask = livenessTasks.find((task) => task.id === 4);
  const unownedTask = livenessTasks.find((task) => task.id === 5);
  if (!activeTask.owner_active || activeTask.owner_stale || taskLivenessModule.taskOwnerStateText(activeTask) !== 'active') {
    fail(`task liveness active owner changed: ${JSON.stringify(activeTask)}`);
  }
  if (!staleTask.owner_stale || !staleTask.takeover_ready || staleTask.owner_age_sec !== 900 ||
      taskLivenessModule.taskOwnerStateText(staleTask) !== 'stale/no-lock') {
    fail(`task liveness stale takeover changed: ${JSON.stringify(staleTask)}`);
  }
  if (!lockedTask.owner_stale || lockedTask.takeover_ready || lockedTask.related_lock_count !== 1 ||
      taskLivenessModule.taskOwnerStateText(lockedTask) !== 'stale/locks=1') {
    fail(`task liveness stale locked owner changed: ${JSON.stringify(lockedTask)}`);
  }
  if (!pendingTask.owner_stale || pendingTask.takeover_ready) {
    fail(`task liveness pending takeover changed: ${JSON.stringify(pendingTask)}`);
  }
  if (unownedTask.owner_known || unownedTask.owner_active !== null || unownedTask.owner_stale || unownedTask.takeover_ready) {
    fail(`task liveness unowned task changed: ${JSON.stringify(unownedTask)}`);
  }
  const summary = taskLivenessModule.summarizeTask(staleTask);
  if (!summary.takeover_ready || summary.owner_age_sec !== 900 || summary.related_lock_count !== 0) {
    fail(`task liveness summarizeTask changed: ${JSON.stringify(summary)}`);
  }
  if (taskLivenessModule.formatOpenTaskLine(staleTask) !== '#2 running owner=stale-owner owner_state=stale/no-lock: Stale task') {
    fail(`task liveness formatOpenTaskLine changed: ${taskLivenessModule.formatOpenTaskLine(staleTask)}`);
  }
  for (const helper of [
    'function actionCommand',
    'function makeAction',
    'function looksLikeMultiTask',
    'function selectCurrentTask',
    'function deriveAutomation',
    'function renderAutomationContext'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds automation helper: ${helper}`);
  }
  const automationModule = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'automation.mjs'));
  const compatAutomationModule = await import(path.join(repoRoot, 'lib', 'automation.mjs'));
  for (const name of [
    'actionCommand',
    'makeAction',
    'looksLikeMultiTask',
    'selectCurrentTask',
    'deriveAutomation',
    'renderAutomationContext'
  ]) {
    if (typeof automationModule[name] !== 'function') fail(`automation module missing export: ${name}`);
    if (typeof compatAutomationModule[name] !== 'function') fail(`automation compat module missing export: ${name}`);
  }
  if (!automationModule.looksLikeMultiTask({ title: 'split', body: '- one\n- two' })) {
    fail('automation looksLikeMultiTask bullet detection changed');
  }
  const selectedTask = automationModule.selectCurrentTask([
    { id: 2, status: 'claimed', owner: 'peer-a', priority: 1 },
    { id: 1, status: 'running', owner: 'peer-a', priority: 9 }
  ], 'peer-a');
  if (selectedTask?.id !== 1) fail(`automation selectCurrentTask ranking changed: ${JSON.stringify(selectedTask)}`);
  const automationConfig = { cliName: 'hccx', activePeerTtl: 600, defaultLockTtl: 321 };
  const automationSnapshot = {
    now: 1000,
    active_peer_ttl: 600,
    peers: [
      { id: 'peer-a', age_sec: 10 },
      { id: 'other-peer', age_sec: 20 }
    ],
    tasks: [
      { id: 10, status: 'running', owner: 'peer-a', assignee: '', title: 'Main task', priority: 1, parent_id: null }
    ],
    locks: [],
    messages: []
  };
  const acquireAutomation = automationModule.deriveAutomation(
    automationSnapshot,
    'peer-a',
    { resource: 'bin/hcc.mjs', scope: 'automation' },
    automationConfig
  );
  if (acquireAutomation.phase !== 'acquire_lock' ||
      acquireAutomation.next_action.kind !== 'lock.acquire' ||
      !acquireAutomation.next_action.argv.includes('321') ||
      !String(acquireAutomation.next_action.command || '').startsWith('hccx lock acquire')) {
    fail(`automation lock acquire action changed: ${JSON.stringify(acquireAutomation, null, 2)}`);
  }
  const finishAutomation = automationModule.deriveAutomation(
    automationSnapshot,
    'peer-a',
    { intent: 'finish' },
    automationConfig
  );
  if (finishAutomation.phase !== 'handoff' || finishAutomation.next_action.kind !== 'handoff.create') {
    fail(`automation finish action changed: ${JSON.stringify(finishAutomation, null, 2)}`);
  }
  const claimAutomation = automationModule.deriveAutomation({
    ...automationSnapshot,
    tasks: [
      { id: 11, status: 'pending', owner: '', assignee: 'peer-a', title: 'Assigned task', priority: 1 }
    ]
  }, 'peer-a', {}, automationConfig);
  if (claimAutomation.phase !== 'claim_task' ||
      claimAutomation.next_action.kind !== 'task.claim' ||
      claimAutomation.next_action.task_id !== 11) {
    fail(`automation assigned claim action changed: ${JSON.stringify(claimAutomation, null, 2)}`);
  }
  const conflictAutomation = automationModule.deriveAutomation({
    ...automationSnapshot,
    locks: [
      { resource: 'scoped:runtime', base_resource: 'bin/hcc.mjs', scope: 'automation', owner: 'other-peer', task_id: 99, expires_at: 1200 }
    ]
  }, 'peer-a', { resource: 'bin/hcc.mjs', scope: 'automation' }, automationConfig);
  if (conflictAutomation.phase !== 'coordinate_lock' ||
      conflictAutomation.next_action.kind !== 'msg.send' ||
      conflictAutomation.next_action.lock_owner !== 'other-peer') {
    fail(`automation lock conflict action changed: ${JSON.stringify(conflictAutomation, null, 2)}`);
  }
  const expiredConflictLock = {
    resource: 'scoped:grace-runtime',
    base_resource: 'bin/hcc.mjs',
    scope: 'automation',
    owner: 'other-peer',
    task_id: 99,
    expires_at: 900
  };
  const graceConflictAutomation = automationModule.deriveAutomation({
    ...automationSnapshot,
    clock_grace_active: true,
    locks: [expiredConflictLock]
  }, 'peer-a', { resource: 'bin/hcc.mjs', scope: 'automation' }, automationConfig);
  const afterGraceAutomation = automationModule.deriveAutomation({
    ...automationSnapshot,
    clock_grace_active: false,
    locks: [expiredConflictLock]
  }, 'peer-a', { resource: 'bin/hcc.mjs', scope: 'automation' }, automationConfig);
  if (graceConflictAutomation.phase !== 'coordinate_lock' ||
      graceConflictAutomation.next_action.kind !== 'msg.send' ||
      graceConflictAutomation.next_action.lock_owner !== 'other-peer' ||
      graceConflictAutomation.next_action.argv.includes('--force') ||
      afterGraceAutomation.phase !== 'coordinate_lock' ||
      afterGraceAutomation.next_action.kind !== 'msg.send' ||
      afterGraceAutomation.next_action.lock_owner !== 'other-peer') {
    fail(`automation clock-grace lock conflict semantics changed:\n${JSON.stringify({ graceConflictAutomation, afterGraceAutomation }, null, 2)}`);
  }
  const automationContext = automationModule.renderAutomationContext(acquireAutomation);
  if (!automationContext.includes('phase: acquire_lock') ||
      !automationContext.includes('why: task #10 needs bin/hcc.mjs [automation] lock')) {
    fail(`automation render context changed: ${automationContext}`);
  }
  for (const helper of [
    'function renderStatusSummary',
    'function normalizeStateResources',
    'function renderStateSummary'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds state render helper: ${helper}`);
  }
  const stateRender = await import(path.join(repoRoot, 'lib', 'ui', 'state-render.mjs'));
  const compatStateRender = await import(path.join(repoRoot, 'lib', 'state-render.mjs'));
  for (const name of [
    'renderStatusSummary',
    'normalizeStateResources',
    'renderStateSummary'
  ]) {
    if (typeof stateRender[name] !== 'function') fail(`state render module missing export: ${name}`);
    if (typeof compatStateRender[name] !== 'function') fail(`state render compat module missing export: ${name}`);
  }
  const normalizedResources = stateRender.normalizeStateResources(['bin/hcc.mjs,scripts/regression.mjs', 'bin/hcc.mjs', '', null]);
  if (JSON.stringify(normalizedResources) !== JSON.stringify(['bin/hcc.mjs', 'scripts/regression.mjs'])) {
    fail(`state resource normalization changed: ${JSON.stringify(normalizedResources)}`);
  }
  const renderedStatus = stateRender.renderStatusSummary({
    root: '/repo',
    db: '/repo/.hello-cc/mesh.db',
    active_peers: 2,
    stale_peers: 3,
    tasks: [
      { status: 'done', n: 4 },
      { status: 'running', n: 1 }
    ],
    active_locks: 5,
    unread: 6,
    recent_events: [
      { id: 7, type: 'task.done', actor: 'peer-a', task_id: 8, created_at: 9 }
    ]
  }, 'peer-a');
  if (!renderedStatus.includes('peers: active=2, stale=3') ||
      !renderedStatus.includes('tasks: done:4, running:1') ||
      !renderedStatus.includes('inbox(peer-a): unread=6') ||
      !renderedStatus.includes('1970-01-01T00:00:09.000Z')) {
    fail(`state render status output changed:\n${renderedStatus}`);
  }
  const renderedState = stateRender.renderStateSummary({
    root: '/repo',
    automation: {
      current_task: { id: 10, status: 'running', title: 'State task' },
      phase: 'work',
      next_action: { kind: 'none', command: '', reason: 'continue task #10' },
      finish_actions: [{ command: 'hcc handoff create' }],
      warnings: ['review locks before commit']
    },
    timeline: [
      { ts: 11, source: 'message', source_id: 12, title: 'note', text: 'body' }
    ]
  }, 'peer-a');
  if (!renderedState.includes('current task: #10 running State task') ||
      !renderedState.includes('next: none') ||
      !renderedState.includes('- hcc handoff create') ||
      !renderedState.includes('review locks before commit') ||
      !renderedState.includes('message:12 note')) {
    fail(`state render state output changed:\n${renderedState}`);
  }
  for (const helper of [
    'function helpMain',
    'function helpTask',
    'function helpTeam',
    'function helpState',
    'function helpJoin',
    'function helpEnv',
    'function helpMsg',
    'function helpAsk',
    'function helpBroadcast',
    'function helpInject',
    'function helpPeer',
    'function helpLock',
    'function helpHandoff',
    'function helpEvent',
    'function helpRun',
    'function helpUp',
    'function helpDown',
    'function helpUpdate',
    'function helpUninstall',
    'function helpWeb'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds help text helper: ${helper}`);
  }
  const helpModule = await import(path.join(repoRoot, 'lib', 'ui', 'help.mjs'));
  const compatHelpModule = await import(path.join(repoRoot, 'lib', 'help.mjs'));
  if (typeof helpModule.createHelpFunctions !== 'function') fail('help module missing createHelpFunctions export');
  if (typeof compatHelpModule.createHelpFunctions !== 'function') fail('help compat module missing createHelpFunctions export');
  const capturedHelp = [];
  const savedConsoleLog = console.log;
  try {
    console.log = (value = '') => capturedHelp.push(String(value));
    const helpFns = helpModule.createHelpFunctions({
      productName: 'product-x',
      version: '1.2.3',
      cliName: 'hccx',
      npmPackageName: '@scope/pkg-x'
    });
    for (const name of [
      'helpMain',
      'helpTask',
      'helpTeam',
      'helpState',
      'helpJoin',
      'helpEnv',
      'helpMsg',
      'helpAsk',
      'helpBroadcast',
      'helpInject',
      'helpPeer',
      'helpLock',
      'helpHandoff',
      'helpEvent',
      'helpRun',
      'helpUp',
      'helpDown',
      'helpUpdate',
      'helpUninstall',
      'helpWeb'
    ]) {
      if (typeof helpFns[name] !== 'function') fail(`help factory missing function: ${name}`);
    }
    helpFns.helpMain();
    helpFns.helpUpdate();
    helpFns.helpUninstall();
    helpFns.helpWeb();
  } finally {
    console.log = savedConsoleLog;
  }
  const [factoryMainHelp, factoryUpdateHelp, factoryUninstallHelp, factoryWebHelp] = capturedHelp;
  if (!factoryMainHelp?.startsWith('product-x 1.2.3') ||
      !factoryMainHelp.includes('hccx [--root DIR]') ||
      !factoryUpdateHelp?.includes('npm install -g @scope/pkg-x@TAG') ||
      !factoryUninstallHelp?.includes('hccx uninstall [--purge --yes]') ||
      !factoryWebHelp?.includes("HCC_WEB_TOKEN='long-token' hccx web --port 8787")) {
    fail(`help factory output changed:\n${capturedHelp.join('\n---\n')}`);
  }
  for (const helper of [
    'function sendMessage(',
    'function queryInbox(',
    'function queryTimelineMessages(',
    'function getMessage(',
    'function queryMessageThread(',
    'function ackMessage('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds message store helper: ${helper}`);
  }
  const messagesModule = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'messages.mjs'));
  const compatMessagesModule = await import(path.join(repoRoot, 'lib', 'messages.mjs'));
  if (typeof messagesModule.createMessageStore !== 'function') fail('messages module missing createMessageStore export');
  if (typeof compatMessagesModule.createMessageStore !== 'function') fail('messages compat module missing createMessageStore export');
  const messageEvents = [];
  const messageStore = messagesModule.createMessageStore({
    now: () => 1234,
    addEvent: (_db, type, actor, taskId, payload) => messageEvents.push({ type, actor, taskId, payload })
  });
  for (const name of [
    'ackMessage',
    'getMessage',
    'queryInbox',
    'queryMessageThread',
    'queryTimelineMessages',
    'sendMessage'
  ]) {
    if (typeof messageStore[name] !== 'function') fail(`message store missing function: ${name}`);
  }
  const messageDb = new DatabaseSync(':memory:');
  try {
    messageDb.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT,
        task_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'note',
        body TEXT NOT NULL,
        reply_to INTEGER,
        thread_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE message_reads (
        message_id INTEGER NOT NULL,
        peer TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, peer)
      );
    `);
    const firstId = messageStore.sendMessage(messageDb, 'alice', 'bob', 42, 'note', 'hello');
    const replyId = messageStore.sendMessage(messageDb, 'bob', 'alice', 42, 'reply', 'ack', {
      reply_to: firstId,
      thread_id: firstId
    });
    const inbox = messageStore.queryInbox(messageDb, 'bob', false, 10);
    const thread = messageStore.queryMessageThread(messageDb, replyId, 10);
    messageStore.ackMessage(messageDb, 'bob', inbox[0]);
    const unread = messageStore.queryInbox(messageDb, 'bob', false, 10);
    const timeline = messageStore.queryTimelineMessages(messageDb, 'bob', 10);
    if (firstId !== 1 ||
        replyId !== 2 ||
        inbox.length !== 1 ||
        inbox[0].thread_id !== firstId ||
        thread.thread_id !== firstId ||
        thread.messages.length !== 2 ||
        unread.length !== 0 ||
        timeline.length !== 2 ||
        messageEvents.map((event) => event.type).join(',') !== 'message.sent,message.sent,message.ack') {
      fail('message store smoke test changed expected send/inbox/thread/ack behavior');
    }
  } finally {
    messageDb.close();
  }
  for (const helper of [
    'function claimTaskRowsForPeer(',
    'function takeoverPolicyDetails(',
    'function takeOverTaskForPeer(',
    'function queryOpenTasks(',
    'function taskById(',
    'function teamChildren(',
    'function teamSummary(',
    'function claimNextTasksForPeer('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds task store helper: ${helper}`);
  }
  const taskStoreModule = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'tasks.mjs'));
  const compatTaskStoreModule = await import(path.join(repoRoot, 'lib', 'task-store.mjs'));
  if (typeof taskStoreModule.createTaskStore !== 'function') fail('task store module missing createTaskStore export');
  if (typeof compatTaskStoreModule.createTaskStore !== 'function') fail('task store compat module missing createTaskStore export');
  const taskEvents = [];
  const taskMessages = [];
  const taskStore = taskStoreModule.createTaskStore({
    now: () => 2000,
    activePeerTtl: 60,
    addEvent: (_db, type, actor, taskId, payload) => taskEvents.push({ type, actor, taskId, payload }),
    sendMessage: (_db, sender, recipient, taskId, kind, body) => {
      taskMessages.push({ sender, recipient, taskId, kind, body });
      return taskMessages.length;
    }
  });
  for (const name of [
    'claimNextTasksForPeer',
    'claimTaskRowsForPeer',
    'queryOpenTasks',
    'takeOverTaskForPeer',
    'taskById',
    'teamChildren',
    'teamSummary',
    'takeoverPolicyDetails'
  ]) {
    if (typeof taskStore[name] !== 'function') fail(`task store missing function: ${name}`);
  }
  const taskDb = new DatabaseSync(':memory:');
  try {
    taskDb.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        assignee TEXT,
        owner TEXT,
        parent_id INTEGER,
        team_role TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_by TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        status TEXT,
        pid INTEGER,
        pid_start_token TEXT,
        pid_command_hash TEXT,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        transport TEXT,
        runtime_target TEXT,
        updated_at INTEGER
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        summary TEXT
      );
    `);
    taskDb.prepare(`
      INSERT INTO tasks(title, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
      VALUES
        ('assigned pending', 'pending', 'bob', NULL, NULL, NULL, 10, 'alice', 1000, 1000),
        ('stale owned', 'running', NULL, 'old-owner', NULL, NULL, 20, 'alice', 1000, 1000),
        ('parent', 'pending', NULL, NULL, NULL, NULL, 30, 'alice', 1000, 1000),
        ('child done', 'done', NULL, NULL, 3, 'worker', 31, 'alice', 1000, 1000),
        ('next pending', 'pending', NULL, NULL, NULL, NULL, 40, 'alice', 1000, 1000),
        ('callback protected', 'running', NULL, 'callback-owner', NULL, NULL, 50, 'alice', 1000, 1000)
    `).run();
    taskDb.prepare('INSERT INTO peers(id, last_seen_at) VALUES (?, ?)').run('old-owner', 1000);
    taskDb.prepare('INSERT INTO peers(id, last_seen_at) VALUES (?, ?)').run('callback-owner', 1000);
    taskDb.prepare('INSERT INTO handoffs(task_id, summary) VALUES (?, ?)').run(4, 'child handoff');
    const claimed = taskStore.claimTaskRowsForPeer(taskDb, 'bob', [1]);
    const blockedReject = (() => {
      try {
        taskStore.takeOverTaskForPeer(taskDb, 'taker', 2, { reason: 'blocked policy', policy: 'blocked' });
        return false;
      } catch (err) {
        return err?.code === 'TAKEOVER_POLICY';
      }
    })();
    const taken = taskStore.takeOverTaskForPeer(taskDb, 'taker', 2, { reason: 'stale policy', policy: 'stale', staleAfter: 60 });
    let callbackOwner = null;
    const callbackProtected = (() => {
      try {
        taskStore.takeOverTaskForPeer(taskDb, 'taker', 6, {
          reason: 'must use current transactional owner',
          policy: 'stale',
          staleAfter: 60,
          ownerEvidenceFor: (owner, row) => {
            callbackOwner = owner;
            if (row.owner !== owner) fail('owner evidence callback received a mismatched task row');
            return { state: 'live', reason: 'verified_callback_owner' };
          }
        });
        return false;
      } catch (err) {
        return err?.code === 'TAKEOVER_POLICY';
      }
    })();
    const next = taskStore.claimNextTasksForPeer(taskDb, 'next-peer', { count: 1 });
    const openForBob = taskStore.queryOpenTasks(taskDb, 10, 'bob');
    const summary = taskStore.teamSummary(taskDb, 3);
    if (claimed.length !== 1 ||
        claimed[0].owner !== 'bob' ||
        !blockedReject ||
        taken.owner !== 'taker' ||
        !callbackProtected ||
        callbackOwner !== 'callback-owner' ||
        taskStore.taskById(taskDb, 6)?.owner !== 'callback-owner' ||
        taskMessages.length !== 1 ||
        !taskMessages[0].body.includes('Task #2 taken over by taker') ||
        next.tasks.length !== 1 ||
        next.tasks[0].owner !== 'next-peer' ||
        openForBob.length !== 1 ||
        summary.children.length !== 1 ||
        summary.counts.done !== 1 ||
        taskEvents.map((event) => event.type).join(',') !== 'task.claimed,task.takeover,task.claimed') {
      fail('task store smoke test changed expected claim/takeover/next/team behavior');
    }
  } finally {
    taskDb.close();
  }
  // hb-05: clock-grace helpers behave as expected (jump classification + window).
  {
    const clockGrace = await import(path.join(repoRoot, 'lib', 'shared', 'clock-grace.mjs'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (clockGrace.clockGraceSuppressed(nowSec, nowSec + 60) !== true ||
        clockGrace.clockGraceSuppressed(nowSec, nowSec - 1) !== false ||
        clockGrace.clockGraceSuppressed(nowSec, 0) !== false) {
      fail('clock grace window suppression semantics changed');
    }
    const fwd = clockGrace.classifyClockJump(120000);
    const bwd = clockGrace.classifyClockJump(-12000);
    const norm = clockGrace.classifyClockJump(30000);
    const stalled = clockGrace.classifyClockDrift({ wallDeltaMs: 120000, monotonicDeltaMs: 120000 });
    const driftFwd = clockGrace.classifyClockDrift({ wallDeltaMs: 120000, monotonicDeltaMs: 30000 });
    const driftBwd = clockGrace.classifyClockDrift({ wallDeltaMs: 18000, monotonicDeltaMs: 30000 });
    if (fwd?.kind !== 'forward' || bwd?.kind !== 'backward' || norm !== null || stalled !== null ||
        driftFwd?.kind !== 'forward' || driftBwd?.kind !== 'backward') {
      fail(`clock jump classification changed: ${JSON.stringify({ fwd, bwd, norm, stalled, driftFwd, driftBwd })}`);
    }
  }
  for (const helper of [
    'function parseTaskIds(',
    'function positiveIntOpt(',
    'function taskRowsText('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds task CLI helper: ${helper}`);
  }
  const taskCliModule = await import(path.join(repoRoot, 'lib', 'task-cli.mjs'));
  for (const name of ['parseTaskIds', 'positiveIntOpt', 'taskRowsText']) {
    if (typeof taskCliModule[name] !== 'function') fail(`task CLI module missing function: ${name}`);
  }
  const parsedTaskIds = taskCliModule.parseTaskIds({
    id: ['1,2', '2'],
    ids: '3',
    _: ['4']
  });
  if (parsedTaskIds.join(',') !== '1,2,3,4') {
    fail(`task CLI parseTaskIds changed expected id normalization: ${parsedTaskIds.join(',')}`);
  }
  const parseRejects = (() => {
    try {
      taskCliModule.parseTaskIds({ id: 'bad' });
      return false;
    } catch (err) {
      return err?.code === 'BAD_ARGS';
    }
  })();
  const emptyRejects = (() => {
    try {
      taskCliModule.parseTaskIds({});
      return false;
    } catch (err) {
      return err?.code === 'BAD_ARGS';
    }
  })();
  const lowRejects = (() => {
    try {
      taskCliModule.positiveIntOpt({ count: '0' }, 'count', 1, { max: 5 });
      return false;
    } catch (err) {
      return err?.code === 'BAD_ARGS';
    }
  })();
  const highRejects = (() => {
    try {
      taskCliModule.positiveIntOpt({ count: '6' }, 'count', 1, { max: 5 });
      return false;
    } catch (err) {
      return err?.code === 'BAD_ARGS';
    }
  })();
  if (!parseRejects ||
      !emptyRejects ||
      !lowRejects ||
      !highRejects ||
      taskCliModule.positiveIntOpt({ count: '2' }, 'count', 1, { max: 5 }) !== 2 ||
      taskCliModule.taskRowsText([], 'claimed') !== 'no pending task' ||
      taskCliModule.taskRowsText([{ id: 7, title: 'demo' }], 'claimed') !== 'claimed task #7: demo') {
    fail('task CLI smoke test changed expected parse/count/render behavior');
  }
  for (const helper of [
    'const WEB_CHILD_ENV',
    'const LAUNCH_FINGERPRINT_ENV',
    'const PROVIDER_STATE_ENV',
    'const LAUNCH_ENV_IGNORED_KEYS',
    'function childSessionEnv',
    'function launchEnvironmentFingerprint',
    'function launchFingerprint',
    'function isLikelyShellCommand',
    'function isProviderFallbackWrapper',
    'function isRelaunchableProviderSession',
    'function tmuxProviderState',
    'function tmuxManagedSessionName',
    'function tmuxEnvironmentArgs',
    'function isolatedEnvCommandArgs'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds session launch helper: ${helper}`);
  }
  const sessionLaunchSource = fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'sessions', 'launch.mjs'), 'utf8');
  const compatSessionLaunchSource = fs.readFileSync(path.join(repoRoot, 'lib', 'session-launch.mjs'), 'utf8');
  if (sessionLaunchSource.includes("from '../../terminal/") ||
      sessionLaunchSource.includes("from '../terminal/") ||
      sessionLaunchSource.includes('tmuxSessionEnvironmentValue')) {
    fail('core session launch module depends on terminal/tmux helpers');
  }
  if (!compatSessionLaunchSource.includes("from './core/sessions/launch.mjs'") ||
      !compatSessionLaunchSource.includes("from './terminal/tmux.mjs'")) {
    fail('session launch compatibility module does not re-export from the new boundaries');
  }
  const sessionLaunch = await import(path.join(repoRoot, 'lib', 'core', 'sessions', 'launch.mjs'));
  const compatSessionLaunch = await import(path.join(repoRoot, 'lib', 'session-launch.mjs'));
  const tmuxModuleForSessionLaunch = await import(path.join(repoRoot, 'lib', 'tmux.mjs'));
  for (const name of [
    'childSessionEnv',
    'launchEnvironmentFingerprint',
    'launchFingerprint',
    'isLikelyShellCommand',
    'isProviderFallbackWrapper',
    'isRelaunchableProviderSession',
    'isolatedEnvCommandArgs'
  ]) {
    if (typeof sessionLaunch[name] !== 'function') fail(`session launch module missing export: ${name}`);
    if (compatSessionLaunch[name] !== sessionLaunch[name]) fail(`session launch compat export mismatch: ${name}`);
  }
  for (const name of [
    'tmuxProviderState',
    'tmuxManagedSessionName',
    'tmuxEnvironmentArgs'
  ]) {
    if (typeof tmuxModuleForSessionLaunch[name] !== 'function') fail(`tmux module missing session launch adapter: ${name}`);
    if (compatSessionLaunch[name] !== tmuxModuleForSessionLaunch[name]) {
      fail(`session launch compat terminal export mismatch: ${name}`);
    }
  }
  if (sessionLaunch.WEB_CHILD_ENV !== 'HCC_WEB_CHILD' ||
      sessionLaunch.LAUNCH_FINGERPRINT_ENV !== 'HCC_LAUNCH_FINGERPRINT' ||
      sessionLaunch.PROVIDER_STATE_ENV !== 'HCC_PROVIDER_STATE') {
    fail('session launch env constant changed');
  }
  const childEnv = sessionLaunch.childSessionEnv({ EXTRA: '1' }, { HCC_WEB_CHILD: '1', BASE: '2' });
  if (childEnv.HCC_WEB_CHILD !== undefined || childEnv.BASE !== '2' || childEnv.EXTRA !== '1') {
    fail(`session launch childSessionEnv changed: ${JSON.stringify(childEnv)}`);
  }
  const launchEnvA = sessionLaunch.launchEnvironmentFingerprint({
    B: '2',
    A: '1',
    PWD: '/ignored',
    TMUX: 'ignored',
    HCC_PEER: 'ignored'
  });
  const launchEnvB = sessionLaunch.launchEnvironmentFingerprint({ A: '1', B: '2' });
  const launchEnvC = sessionLaunch.launchEnvironmentFingerprint({ A: '1', B: '3' });
  if (launchEnvA !== launchEnvB || launchEnvA === launchEnvC) {
    fail('session launch environment fingerprint filtering/sorting changed');
  }
  const launchFingerprintA = sessionLaunch.launchFingerprint({ command: 'cmd', cwd: '/tmp/a', env: { A: '1' } });
  const launchFingerprintB = sessionLaunch.launchFingerprint({ command: 'cmd', cwd: '/tmp/b', env: { A: '1' } });
  if (launchFingerprintA === launchFingerprintB) {
    fail('session launch fingerprint no longer includes cwd');
  }
  if (!sessionLaunch.isLikelyShellCommand('/bin/bash') ||
      !sessionLaunch.isLikelyShellCommand('-zsh') ||
      sessionLaunch.isLikelyShellCommand('node')) {
    fail('session launch shell command detection changed');
  }
  if (!sessionLaunch.isProviderFallbackWrapper(`${sessionLaunch.PROVIDER_STATE_ENV}=starting exec bash`) ||
      !sessionLaunch.isProviderFallbackWrapper('exec zsh') ||
      sessionLaunch.isProviderFallbackWrapper('node script.js')) {
    fail('session launch provider fallback detection changed');
  }
  if (!sessionLaunch.isRelaunchableProviderSession('shell', 'exec bash', { provider: 'codex' }) ||
      sessionLaunch.isRelaunchableProviderSession('shell', 'exec bash', {}) ||
      sessionLaunch.isRelaunchableProviderSession('codex', 'node script.js', {})) {
    fail('session launch relaunchable provider detection changed');
  }
  const managedSessionName = tmuxModuleForSessionLaunch.tmuxManagedSessionName({ root: '/tmp/hcc root' }, 'Bad Peer!');
  if (!managedSessionName.startsWith('hcc-') ||
      !managedSessionName.endsWith('-bad-peer') ||
      managedSessionName.length > 80) {
    fail(`session launch tmux session name changed: ${managedSessionName}`);
  }
  const tmuxEnvArgs = tmuxModuleForSessionLaunch.tmuxEnvironmentArgs({
    A: '1',
    TMUX: 'ignored',
    'BAD-NAME': 'ignored',
    B: 2,
    C: null
  });
  if (JSON.stringify(tmuxEnvArgs) !== JSON.stringify(['-e', 'A=1', '-e', 'B=2'])) {
    fail(`session launch tmux env args changed: ${JSON.stringify(tmuxEnvArgs)}`);
  }
  const isolatedEnvArgs = sessionLaunch.isolatedEnvCommandArgs({
    A: '1',
    TMUX_PANE: 'ignored',
    'BAD-NAME': 'ignored',
    B: 2,
    C: null
  });
  if (!['/usr/bin/env', 'env'].includes(isolatedEnvArgs[0]) ||
      isolatedEnvArgs[1] !== '-i' ||
      !isolatedEnvArgs.includes('A=1') ||
      !isolatedEnvArgs.includes('B=2') ||
      isolatedEnvArgs.some((arg) => arg.includes('TMUX_PANE') || arg.includes('BAD-NAME'))) {
    fail(`session launch isolated env args changed: ${JSON.stringify(isolatedEnvArgs)}`);
  }
  for (const helper of [
    'function runTmux',
    'function tmuxInstallHint',
    'function commandExists',
    'function runInstallCommand',
    'function tryInstallTmux',
    'function ensureTmuxAvailable',
    'function tmuxHasSession',
    'function tmuxSessionHasClients',
    'function tmuxKillSession',
    'function tmuxSessionEnvironmentValue',
    'function tmuxPaneInfo',
    'function tmuxCapturePane',
    'function tmuxCursorInfo',
    'function tmuxCursorPayload',
    'function tmuxSendKeys',
    'function tmuxSendRawLiteral',
    'function tmuxInCopyMode',
    'function tmuxExitCopyMode',
    'function tmuxPasteBuffer',
    'function readTmuxEscapeSequence',
    'function isTmuxRawControlChar',
    'function tmuxSendLiteral'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds tmux helper: ${helper}`);
  }
  const tmuxModule = await import(path.join(repoRoot, 'lib', 'tmux.mjs'));
  for (const name of [
    'runTmux',
    'tryInstallTmux',
    'ensureTmuxAvailable',
    'tmuxHasSession',
    'tmuxSessionHasClients',
    'tmuxKillSession',
    'tmuxSessionEnvironmentValue',
    'tmuxLaunchFingerprint',
    'tmuxPaneInfo',
    'tmuxCapturePane',
    'tmuxCursorInfo',
    'tmuxCursorPayload',
    'tmuxSendLiteral'
  ]) {
    if (typeof tmuxModule[name] !== 'function') fail(`tmux module missing export: ${name}`);
  }
  const cursorPayload = tmuxModule.tmuxCursorPayload('a\nb\nc\nd', {
    x: 3,
    y: 1,
    visible: true,
    history: 2,
    height: 4
  });
  if (JSON.stringify(cursorPayload) !== JSON.stringify({ row: 3, col: 3, visible: true })) {
    fail(`tmux cursor payload mapping changed: ${JSON.stringify(cursorPayload)}`);
  }
  const clampedCursorPayload = tmuxModule.tmuxCursorPayload('a\nb\nc\nd\ne', {
    x: 4,
    y: 1,
    visible: false,
    history: 5,
    height: 3
  });
  if (JSON.stringify(clampedCursorPayload) !== JSON.stringify({ row: 2, col: 4, visible: false }) ||
      tmuxModule.tmuxCursorPayload('', null) !== null) {
    fail(`tmux cursor payload clamp/null behavior changed: ${JSON.stringify(clampedCursorPayload)}`);
  }
  for (const helper of [
    'function providerSessionPeerId',
    'function providerSessionParts',
    'function inferPeerKind',
    'function hasResumeOpts',
    'function defaultSessionCommand',
    'function buildPeerCommand',
    'function buildCodexCommand',
    'function buildClaudeCommand',
    'function bindingFromRun',
    'function parseClaudeCommandArgs',
    'function parseCodexCommandArgs'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds provider command helper: ${helper}`);
  }
  const providerCommandsSource = fs.readFileSync(path.join(repoRoot, 'lib', 'integrations', 'providers.mjs'), 'utf8');
  const compatProviderCommandsSource = fs.readFileSync(path.join(repoRoot, 'lib', 'provider-commands.mjs'), 'utf8');
  if (!providerCommandsSource.includes("from '../core/peers/session.mjs'") ||
      providerCommandsSource.includes('function providerSessionPeerId') ||
      providerCommandsSource.includes('function providerSessionParts')) {
    fail('integrations provider module no longer delegates peer session helpers to core/peers/session.mjs');
  }
  if (!compatProviderCommandsSource.includes("from './integrations/providers.mjs'")) {
    fail('provider command compat module no longer re-exports integrations/providers.mjs');
  }
  const providerCommands = await import(path.join(repoRoot, 'lib', 'integrations', 'providers.mjs'));
  const compatProviderCommands = await import(path.join(repoRoot, 'lib', 'provider-commands.mjs'));
  for (const name of [
    'providerSessionPeerId',
    'providerSessionParts',
    'inferPeerKind',
    'hasResumeOpts',
    'defaultSessionCommand',
    'buildPeerCommand',
    'buildCodexCommand',
    'buildClaudeCommand',
    'bindingFromRun',
    'parseClaudeCommandArgs',
    'parseCodexCommandArgs'
  ]) {
    if (typeof providerCommands[name] !== 'function') fail(`provider command module missing export: ${name}`);
    if (typeof compatProviderCommands[name] !== 'function') fail(`provider command compat module missing export: ${name}`);
  }
  for (const name of ['providerSessionPeerId', 'providerSessionParts']) {
    if (typeof peerSession[name] !== 'function') fail(`peer session module missing export: ${name}`);
    if (providerCommands[name] !== peerSession[name]) fail(`provider command module no longer re-exports peer session helper: ${name}`);
    if (compatProviderCommands[name] !== providerCommands[name]) fail(`provider command compat module no longer re-exports helper: ${name}`);
  }
  const providerIdentityFixtures = [
    ['claude', '123e4567-e89b-12d3-a456-426614174000', 'claude-7f7df0f5'],
    ['codex', 'feature-login', 'codex-2a4f907b'],
    ['codex', 'feature-logout', 'codex-b6c66f1f']
  ];
  const legacyProviderSessionPeerId = (kind, providerId) =>
    `${kind}-${sanitizePeerPart(String(providerId || '').slice(0, 8), shortHash(providerId))}`;
  for (const [kind, providerId, expected] of providerIdentityFixtures) {
    const actual = peerSession.providerSessionPeerId(kind, providerId);
    if (actual !== expected) {
      fail(`v1 provider identity contract changed for ${kind}/${providerId}: expected=${expected} actual=${actual}`);
    }
    const legacy = legacyProviderSessionPeerId(kind, providerId);
    if (actual === legacy) {
      fail(`v1 provider identity still matches remote v0.1.9 prefix algorithm for ${kind}/${providerId}: ${actual}`);
    }
  }
  if (peerSession.providerSessionPeerId('codex', 'feature-login') ===
      peerSession.providerSessionPeerId('codex', 'feature-logout')) {
    fail('v1 provider identity still collides for same-prefix session names');
  }
  const providerNameSession = peerSession.providerSessionParts('named-session');
  if (providerNameSession.provider_session_name !== 'named-session' || providerNameSession.provider_session_id !== null) {
    fail(`provider command module misclassified named session: ${JSON.stringify(providerNameSession)}`);
  }
  const providerUuidSession = peerSession.providerSessionParts('00000000-0000-0000-0000-000000000000');
  if (providerUuidSession.provider_session_id !== '00000000-0000-0000-0000-000000000000' || providerUuidSession.provider_session_name !== null) {
    fail(`provider command module misclassified UUID session: ${JSON.stringify(providerUuidSession)}`);
  }
  const builtClaude = providerCommands.buildPeerCommand('claude-peer', 'claude', { resume: 'named-session' }, []);
  if (builtClaude.command !== 'claude --resume named-session' ||
      builtClaude.binding.resume_mode !== 'resume' ||
      builtClaude.binding.provider_session_name !== 'named-session') {
    fail(`provider command module built wrong Claude resume command: ${JSON.stringify(builtClaude)}`);
  }
  const builtCodex = providerCommands.buildPeerCommand('codex-peer', 'codex', { resume: 'codex-session' }, []);
  if (builtCodex.command !== 'codex resume codex-session' ||
      builtCodex.binding.resume_mode !== 'resume' ||
      builtCodex.binding.provider_session_name !== 'codex-session') {
    fail(`provider command module built wrong Codex resume command: ${JSON.stringify(builtCodex)}`);
  }
  const parsedCodex = providerCommands.parseCodexCommandArgs(['codex', 'resume', '--model', 'gpt-test', 'codex-session']);
  if (parsedCodex.resume_mode !== 'resume' ||
      parsedCodex.resume_arg !== 'codex-session' ||
      parsedCodex.session.provider_session_name !== 'codex-session') {
    fail(`provider command module parsed Codex resume args wrong: ${JSON.stringify(parsedCodex)}`);
  }
  const parsedClaude = providerCommands.parseClaudeCommandArgs(['claude', '--resume', 'claude-session', '--fork-session']);
  if (parsedClaude.resume_mode !== 'fork-resume' ||
      parsedClaude.resume_arg !== 'claude-session' ||
      parsedClaude.session.provider_session_name !== null) {
    fail(`provider command module parsed Claude fork resume args wrong: ${JSON.stringify(parsedClaude)}`);
  }
  for (const helper of [
    'function bindingFromDetected(',
    'function peerBindingRuntimeRank(',
    'function comparePeerBindings(',
    'function dedupePeerBindingRows(',
    'function dedupeProviderSessionColumn(',
    'function dedupeRuntimeTargets(',
    'function dedupePeerBindings(',
    'function bindingHasProviderSession(',
    'function bindingProviderSessionValue(',
    'function bindingHasRuntime(',
    'function mergePeerBinding(',
    'function mergeRuntimeBinding(',
    'function findProviderSessionBinding(',
    'function canonicalizePeerBinding(',
    'function upsertPeerBinding(',
    'function upsertCanonicalPeerBinding('
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds peer binding helper: ${helper}`);
  }
  const peerBindings = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'bindings.mjs'));
  const peerReconcile = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'reconcile.mjs'));
  const peerBindingStoreModule = await import(path.join(repoRoot, 'lib', 'db', 'stores', 'peers.mjs'));
  const compatPeerBindings = await import(path.join(repoRoot, 'lib', 'peer-bindings.mjs'));
  for (const name of [
    'bindingFromDetected',
    'peerBindingRuntimeRank',
    'comparePeerBindings',
    'bindingHasProviderSession',
    'bindingProviderSessionValue',
    'bindingHasRuntime',
    'mergePeerBinding',
    'mergeRuntimeBinding'
  ]) {
    if (typeof peerBindings[name] !== 'function') fail(`peer binding module missing export: ${name}`);
    if (typeof compatPeerBindings[name] !== 'function') fail(`peer binding compat module missing export: ${name}`);
  }
  if (typeof peerBindingStoreModule.createPeerBindingStore !== 'function') {
    fail('peer binding store module missing createPeerBindingStore');
  }
  if (typeof peerReconcile.reconcileRunningPeerBindings !== 'function') {
    fail('peer reconcile module missing reconcileRunningPeerBindings');
  }
  if (typeof compatPeerBindings.createPeerBindingStore !== 'function') {
    fail('peer binding compat module missing createPeerBindingStore');
  }
  const detectedBinding = peerBindings.bindingFromDetected({
    id: 'detected-peer',
    kind: 'claude',
    sessionId: 'detected-session',
    command: 'claude'
  });
  if (detectedBinding.peer !== 'detected-peer' ||
      detectedBinding.provider !== 'claude' ||
      detectedBinding.provider_session_name !== 'detected-session' ||
      detectedBinding.resume_mode !== 'detected' ||
      detectedBinding.runtime_session_id !== 'detected-peer') {
    fail(`peer binding module built wrong detected binding: ${JSON.stringify(detectedBinding)}`);
  }
  if (peerBindings.peerBindingRuntimeRank({ transport: 'tmux', runtime_target: '%1' }) <= peerBindings.peerBindingRuntimeRank({ transport: 'detected' })) {
    fail('peer binding runtime rank no longer prefers tmux runtime bindings over detected bindings');
  }
  const mergedRuntime = peerBindings.mergeRuntimeBinding(
    { peer: 'runtime-peer', command: 'codex resume old', transport: 'tmux', runtime_session_id: 'runtime-peer', runtime_target: '%9' },
    { peer: 'runtime-peer', provider: 'codex', provider_session_name: 'session-a', transport: 'hook', runtime_session_id: 'runtime-peer' }
  );
  if (mergedRuntime.transport !== 'tmux' || mergedRuntime.runtime_target !== '%9' || mergedRuntime.command !== 'codex resume old') {
    fail(`peer binding module did not preserve existing runtime binding: ${JSON.stringify(mergedRuntime)}`);
  }
  const mergedProviderSession = peerBindings.mergePeerBinding(
    { peer: 'session-peer', provider: 'claude', provider_session_id: '00000000-0000-0000-0000-000000000000', provider_session_name: null, resume_mode: 'detected', resume_arg: null, transport: 'hook', runtime_session_id: 'session-peer' },
    { peer: 'session-peer', provider: 'claude', provider_session_id: null, provider_session_name: null, resume_mode: 'attached', resume_arg: '%pane', command: 'tmux %pane (claude)', transport: 'tmux', runtime_session_id: 'session-peer', runtime_target: '%pane' }
  );
  if (mergedProviderSession.provider_session_id !== '00000000-0000-0000-0000-000000000000' ||
      mergedProviderSession.transport !== 'tmux' ||
      mergedProviderSession.runtime_target !== '%pane' ||
      mergedProviderSession.resume_mode !== 'detected') {
    fail(`peer binding module did not preserve known provider session during runtime attach: ${JSON.stringify(mergedProviderSession)}`);
  }
  const peerBindingEvents = [];
  const peerBindingStore = peerBindingStoreModule.createPeerBindingStore({
    now: () => 2000,
    addEvent: (_db, type, actor, taskId, payload) => peerBindingEvents.push({ type, actor, taskId, payload })
  });
  for (const name of [
    'canonicalizePeerBinding',
    'dedupePeerBindings',
    'dedupePeerBindingRows',
    'dedupeProviderSessionColumn',
    'dedupeRuntimeTargets',
    'findProviderSessionBinding',
    'upsertCanonicalPeerBinding',
    'upsertPeerBinding'
  ]) {
    if (typeof peerBindingStore[name] !== 'function') fail(`peer binding store missing function: ${name}`);
  }
  const peerBindingDb = new DatabaseSync(':memory:');
  try {
    peerBindingDb.exec(`
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        runtime_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insertBinding = peerBindingDb.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertBinding.run('detected-old', 'codex', 'same-session', 'detected', null, null, 'detected', 'detected-old', null, 1000, 1000);
    insertBinding.run('runtime-new', 'codex', 'same-session', 'resume', 'same-session', 'codex resume same-session', 'tmux', 'runtime-new', '%pane', 1000, 1100);
    const deleted = peerBindingStore.dedupePeerBindings(peerBindingDb);
    const dedupedRows = peerBindingDb.prepare('SELECT peer FROM peer_bindings ORDER BY peer').all();
    if (deleted !== undefined || dedupedRows.length !== 1 || dedupedRows[0].peer !== 'runtime-new') {
      fail(`peer binding dedupe did not keep runtime binding: ${JSON.stringify(dedupedRows)}`);
    }
    const canonical = peerBindingStore.upsertCanonicalPeerBinding(peerBindingDb, {
      peer: 'hook-peer',
      provider: 'codex',
      provider_session_id: null,
      provider_session_name: 'same-session',
      resume_mode: 'detected',
      resume_arg: null,
      command: null,
      transport: 'hook',
      runtime_session_id: 'hook-peer'
    }, true);
    if (canonical.peer !== 'runtime-new' || canonical.merged_from !== 'hook-peer') {
      fail(`peer binding canonicalization did not merge hook peer into runtime peer: ${JSON.stringify(canonical)}`);
    }
    const canonicalRow = peerBindingDb.prepare('SELECT peer, transport, runtime_target, provider_session_name FROM peer_bindings WHERE peer = ?').get('runtime-new');
    if (canonicalRow.transport !== 'tmux' || canonicalRow.runtime_target !== '%pane' || canonicalRow.provider_session_name !== 'same-session') {
      fail(`peer binding canonical upsert lost runtime fields: ${JSON.stringify(canonicalRow)}`);
    }
    if (!peerBindingEvents.some((event) => event.type === 'provider.session.deduped')) {
      fail(`peer binding dedupe did not emit provider.session.deduped: ${JSON.stringify(peerBindingEvents)}`);
    }
  } finally {
    peerBindingDb.close();
  }
  const reconcileDb = new DatabaseSync(':memory:');
  try {
    reconcileDb.exec(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        role TEXT,
        worktree TEXT,
        branch TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'idle',
        capabilities TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        resume_mode TEXT NOT NULL DEFAULT 'new',
        resume_arg TEXT,
        command TEXT,
        transport TEXT NOT NULL,
        runtime_session_id TEXT,
        runtime_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor TEXT,
        task_id INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_reconcile_provider_session_id
        ON peer_bindings(provider, provider_session_id)
        WHERE provider_session_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_reconcile_provider_session_name
        ON peer_bindings(provider, provider_session_name)
        WHERE provider_session_name IS NOT NULL;
    `);
    const t = 3000;
    const insertPeer = reconcileDb.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES (?, ?, 'peer', ?, 'master', ?, ?, '', ?, ?)
    `);
    const insertBinding = reconcileDb.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tmux', ?, ?, ?, ?)
    `);
    insertPeer.run('hook-known-peer', 'claude', root, 111, 'running', t, t);
    insertBinding.run('hook-known-peer', 'claude', null, null, 'attached', '%1', 'tmux %1 (claude)', 'hook-known-peer', '%1', t, t);
    insertPeer.run('argv-peer', 'codex', root, 222, 'running', t, t);
    insertBinding.run('argv-peer', 'codex', null, null, 'unknown', '%2', 'codex resume', 'argv-peer', '%2', t, t);
    insertPeer.run('weak-peer', 'codex', root, 333, 'running', t, t);
    insertBinding.run('weak-peer', 'codex', null, null, 'unknown', '%3', 'codex resume', 'weak-peer', '%3', t, t);
    insertPeer.run('known-peer', 'claude', root, 444, 'running', t, t);
    insertBinding.run('known-peer', 'claude', '11111111-1111-1111-1111-111111111111', null, 'detected', null, null, 'known-peer', '%4', t, t);
    insertPeer.run('conflict-peer', 'claude', root, 555, 'running', t, t);
    insertBinding.run('conflict-peer', 'claude', '33333333-3333-3333-3333-333333333333', null, 'detected', null, null, 'conflict-peer', '%5', t, t);
    insertPeer.run('conflict-new-peer', 'claude', root, 556, 'running', t, t);
    insertBinding.run('conflict-new-peer', 'claude', null, null, 'attached', '%6', 'tmux %6 (claude)', 'conflict-new-peer', '%6', t, t);
    insertPeer.run('provider-mismatch-conflict', 'codex', root, 666, 'running', t, t);
    insertBinding.run('provider-mismatch-conflict', 'codex', null, 'mismatch-session', 'detected', null, null, 'provider-mismatch-conflict', '%7', t, t);
    insertPeer.run('provider-mismatch-new', 'shell', root, 667, 'running', t, t);
    insertBinding.run('provider-mismatch-new', 'shell', null, null, 'attached', '%8', 'tmux %8 (bash)', 'provider-mismatch-new', '%8', t, t);

    const reconcileEvents = [];
    const reconciled = peerReconcile.reconcileRunningPeerBindings(reconcileDb, { root }, {
      now: () => 4000,
      panes: [
        { pane: '%1', pid: 111, cwd: root },
        { pane: '%2', pid: 222, cwd: root },
        { pane: '%3', pid: 333, cwd: root },
        { pane: '%4', pid: 444, cwd: root },
        { pane: '%5', pid: 555, cwd: root },
        { pane: '%6', pid: 556, cwd: root },
        { pane: '%7', pid: 666, cwd: root },
        { pane: '%8', pid: 667, cwd: root }
      ],
      latestProviderSessionForPeer: (peer) => {
        if (peer === 'hook-known-peer') return '22222222-2222-2222-2222-222222222222';
        if (peer === 'conflict-new-peer') return '33333333-3333-3333-3333-333333333333';
        return null;
      },
      inspectProcess: (pid) => {
        if (pid === 222) return { kind: 'codex', provider_session: 'argv-session', source: 'process.argv.codex' };
        if (pid === 667) return { kind: 'codex', provider_session: 'mismatch-session', source: 'process.argv.codex' };
        return null;
      },
      addEvent: (_db, type, actor, taskId, payload) => reconcileEvents.push({ type, actor, taskId, payload })
    });
    if (reconciled.backfilled !== 2) {
      fail(`peer binding reconcile did not backfill exactly two strong-evidence rows: ${JSON.stringify(reconciled, null, 2)}`);
    }
    const hookKnown = reconcileDb.prepare('SELECT provider_session_id, provider_session_name, resume_mode, resume_arg FROM peer_bindings WHERE peer = ?').get('hook-known-peer');
    if (hookKnown.provider_session_id !== '22222222-2222-2222-2222-222222222222' || hookKnown.provider_session_name !== null) {
      fail(`peer binding reconcile did not backfill hook event session id: ${JSON.stringify(hookKnown)}`);
    }
    const argvKnown = reconcileDb.prepare('SELECT provider_session_id, provider_session_name, resume_mode, resume_arg FROM peer_bindings WHERE peer = ?').get('argv-peer');
    if (argvKnown.provider_session_id !== null || argvKnown.provider_session_name !== 'argv-session') {
      fail(`peer binding reconcile did not backfill process argv session name: ${JSON.stringify(argvKnown)}`);
    }
    const weakKnown = reconcileDb.prepare('SELECT provider_session_id, provider_session_name FROM peer_bindings WHERE peer = ?').get('weak-peer');
    if (weakKnown.provider_session_id !== null || weakKnown.provider_session_name !== null) {
      fail(`peer binding reconcile wrote weak-evidence provider session: ${JSON.stringify(weakKnown)}`);
    }
    const conflictNew = reconcileDb.prepare('SELECT provider_session_id, provider_session_name FROM peer_bindings WHERE peer = ?').get('conflict-new-peer');
    if (conflictNew.provider_session_id !== null || conflictNew.provider_session_name !== null ||
        !reconciled.results.some((result) => result.peer === 'conflict-new-peer' && result.reason === 'provider_session_conflict')) {
      fail(`peer binding reconcile did not skip conflicting provider session safely: ${JSON.stringify({ conflictNew, reconciled }, null, 2)}`);
    }
    const mismatchNew = reconcileDb.prepare('SELECT provider, provider_session_id, provider_session_name FROM peer_bindings WHERE peer = ?').get('provider-mismatch-new');
    if (mismatchNew.provider !== 'shell' || mismatchNew.provider_session_id !== null || mismatchNew.provider_session_name !== null ||
        !reconciled.results.some((result) => result.peer === 'provider-mismatch-new' && result.provider === 'codex' && result.reason === 'provider_session_conflict')) {
      fail(`peer binding reconcile did not use candidate provider for conflict detection: ${JSON.stringify({ mismatchNew, reconciled }, null, 2)}`);
    }
    if (!reconcileEvents.some((event) => event.type === 'provider.session.backfilled' && event.actor === 'hook-known-peer') ||
        !reconcileEvents.some((event) => event.type === 'provider.session.backfilled' && event.actor === 'argv-peer')) {
      fail(`peer binding reconcile did not emit backfill events: ${JSON.stringify(reconcileEvents)}`);
    }
  } finally {
    reconcileDb.close();
  }
  for (const helper of [
    'const WHOLE_LOCK_SCOPE',
    'function normalizeLockScope',
    'function scopedLockResource',
    'function lockBaseResource',
    'function lockScope',
    'function lockLabel',
    'function lockArgv',
    'function locksConflict'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds lock helper: ${helper}`);
  }
  const locksModule = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'locks.mjs'));
  const compatLocksModule = await import(path.join(repoRoot, 'lib', 'locks.mjs'));
  for (const name of [
    'normalizeLockScope',
    'scopedLockResource',
    'lockBaseResource',
    'lockScope',
    'lockLabel',
    'lockArgv',
    'locksConflict'
  ]) {
    if (typeof locksModule[name] !== 'function') fail(`locks module missing export: ${name}`);
    if (typeof compatLocksModule[name] !== 'function') fail(`locks compat module missing export: ${name}`);
  }
  const wholeLock = locksModule.scopedLockResource('bin/hcc.mjs', '');
  const scopedLock = locksModule.scopedLockResource('bin/hcc.mjs', 'provider-commands');
  if (wholeLock.resource !== 'bin/hcc.mjs' ||
      wholeLock.base_resource !== 'bin/hcc.mjs' ||
      wholeLock.scope !== '*') {
    fail(`locks module built wrong whole-resource lock: ${JSON.stringify(wholeLock)}`);
  }
  if (!scopedLock.resource.startsWith('scoped:') ||
      scopedLock.base_resource !== 'bin/hcc.mjs' ||
      scopedLock.scope !== 'provider-commands' ||
      locksModule.lockLabel(scopedLock) !== 'bin/hcc.mjs [provider-commands]') {
    fail(`locks module built wrong scoped lock: ${JSON.stringify(scopedLock)}`);
  }
  if (!locksModule.locksConflict(wholeLock, scopedLock) ||
      locksModule.locksConflict(scopedLock, locksModule.scopedLockResource('bin/hcc.mjs', 'tmux-helpers')) ||
      locksModule.locksConflict(scopedLock, locksModule.scopedLockResource('scripts/regression.mjs', 'provider-commands'))) {
    fail('locks module conflict behavior changed');
  }
  for (const helper of [
    'function splitCsvList',
    'function parseTeamItems',
    'function inferTeamItems',
    'function expandTeamWorkers',
    'function assignTeamWorkers'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds team planning helper: ${helper}`);
  }
  const teamPlanning = await import(path.join(repoRoot, 'lib', 'core', 'coordination', 'teams.mjs'));
  const compatTeamPlanning = await import(path.join(repoRoot, 'lib', 'team-planning.mjs'));
  for (const name of [
    'splitCsvList',
    'parseTeamItems',
    'inferTeamItems',
    'expandTeamWorkers',
    'assignTeamWorkers'
  ]) {
    if (typeof teamPlanning[name] !== 'function') fail(`team planning module missing export: ${name}`);
    if (typeof compatTeamPlanning[name] !== 'function') fail(`team planning compat module missing export: ${name}`);
  }
  const splitTeam = teamPlanning.splitCsvList(['codex:2, claude-a', ' docs-a ']);
  if (JSON.stringify(splitTeam) !== JSON.stringify(['codex:2', 'claude-a', 'docs-a'])) {
    fail(`team planning splitCsvList changed: ${JSON.stringify(splitTeam)}`);
  }
  const parsedTeam = teamPlanning.parseTeamItems({
    item: ['docs:Update docs', 'codex-a:tests:Add: regression']
  });
  if (parsedTeam.length !== 2 ||
      parsedTeam[0].role !== 'docs' ||
      parsedTeam[0].title !== 'Update docs' ||
      parsedTeam[1].assignee !== 'codex-a' ||
      parsedTeam[1].role !== 'tests' ||
      parsedTeam[1].title !== 'Add:regression') {
    fail(`team planning parseTeamItems changed: ${JSON.stringify(parsedTeam)}`);
  }
  const inferredTeam = teamPlanning.inferTeamItems({ title: 'Parent task' }, { count: '0' });
  if (inferredTeam.length !== 1 || inferredTeam[0].title !== 'Parent task / subtask 1') {
    fail(`team planning count normalization changed: ${JSON.stringify(inferredTeam)}`);
  }
  try {
    teamPlanning.inferTeamItems({ title: 'Parent task' }, { count: 'not-a-number' });
    fail('team planning accepted non-integer count');
  } catch (err) {
    if (err?.code !== 'BAD_ARGS') throw err;
  }
  const expandedWorkers = teamPlanning.expandTeamWorkers(['Codex:2', 'claude-a'], 42);
  if (JSON.stringify(expandedWorkers) !== JSON.stringify(['codex-team-42-1', 'codex-team-42-2', 'claude-a'])) {
    fail(`team planning worker expansion changed: ${JSON.stringify(expandedWorkers)}`);
  }
  const assignedTeam = teamPlanning.assignTeamWorkers(parsedTeam, ['codex:2'], 42);
  if (assignedTeam[0].assignee !== 'codex-team-42-1' || assignedTeam[1].assignee !== 'codex-a') {
    fail(`team planning worker assignment changed: ${JSON.stringify(assignedTeam)}`);
  }
  const peerFormat = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'format.mjs'));
  const compatPeerFormat = await import(path.join(repoRoot, 'lib', 'peer-format.mjs'));
  if (typeof peerFormat.sanitizePeerPart !== 'function' ||
      typeof peerFormat.shortHash !== 'function' ||
      typeof compatPeerFormat.sanitizePeerPart !== 'function' ||
      typeof compatPeerFormat.shortHash !== 'function' ||
      peerFormat.sanitizePeerPart('Bad Peer!', 'fallback') !== 'bad-peer' ||
      peerFormat.sanitizePeerPart('!!!', 'fallback') !== 'fallback' ||
      peerFormat.shortHash('hello') !== 'aaf4c61d') {
    fail('peer format module behavior changed');
  }
  for (const [label, source, expectedImport] of [
    ['peer session', fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'peers', 'session.mjs'), 'utf8'), "from './format.mjs'"],
    ['team planning', fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'coordination', 'teams.mjs'), 'utf8'), "from '../peers/format.mjs'"],
    ['peer identity', fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'peers', 'identity.mjs'), 'utf8'), "from './format.mjs'"]
  ]) {
    if (!source.includes(expectedImport)) fail(`${label} module does not import peer format helpers`);
    if (source.includes('function sanitizePeerPart') || source.includes('function shortHash')) {
      fail(`${label} module still embeds peer format helpers`);
    }
  }
  const corePeerIdentitySource = fs.readFileSync(path.join(repoRoot, 'lib', 'core', 'peers', 'identity.mjs'), 'utf8');
  if (corePeerIdentitySource.includes('process.env') ||
      corePeerIdentitySource.includes('spawnSync(') ||
      corePeerIdentitySource.includes('/proc/')) {
    fail('core peer identity still contains process or procfs observation logic');
  }
  for (const helper of [
    'function sanitizePeerPart',
    'function shortHash',
    'function currentTtyName',
    'function readProcCmdline',
    'function readProcEnv',
    'function readProcParentPid',
    'function argsLookLikeCli',
    'function detectCliKindFromProcess',
    'function readAncestorCliInfo',
    'function resumeIdFromArgs',
    'function autoPeerProviderSession',
    'function autoPeerSessionId',
    'function autoPeerResumeId',
    'function autoPeerKind',
    'function autoPeerBasis',
    'function autoPeerId',
    'function resolveCurrentPeer',
    'function currentPeer'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds peer identity helper: ${helper}`);
  }
  const peerIdentity = await import(path.join(repoRoot, 'lib', 'core', 'peers', 'identity.mjs'));
  const integrationPeerIdentity = await import(path.join(repoRoot, 'lib', 'integrations', 'peers', 'identity.mjs'));
  const compatPeerIdentity = await import(path.join(repoRoot, 'lib', 'peer-identity.mjs'));
  for (const name of [
    'sanitizePeerPart',
    'shortHash',
    'autoPeerProviderSession',
    'autoPeerSessionId',
    'autoPeerResumeId',
    'autoPeerKind',
    'autoPeerBasis',
    'autoPeerId',
    'resolveCurrentPeer',
    'currentPeer'
  ]) {
    if (typeof peerIdentity[name] !== 'function') fail(`peer identity core module missing export: ${name}`);
  }
  for (const name of [
    'sanitizePeerPart',
    'shortHash',
    'currentTtyName',
    'readAncestorCliInfo',
    'resumeIdFromArgs',
    'autoPeerProviderSession',
    'autoPeerSessionId',
    'autoPeerResumeId',
    'autoPeerKind',
    'autoPeerBasis',
    'autoPeerId',
    'resolveCurrentPeer',
    'currentPeer'
  ]) {
    if (typeof integrationPeerIdentity[name] !== 'function') fail(`peer identity integration module missing export: ${name}`);
    if (typeof compatPeerIdentity[name] !== 'function') fail(`peer identity compat module missing export: ${name}`);
  }
  if (peerIdentity.sanitizePeerPart('Bad Peer!', 'fallback') !== 'bad-peer' ||
      peerIdentity.sanitizePeerPart('!!!', 'fallback') !== 'fallback' ||
      peerIdentity.shortHash('hello') !== 'aaf4c61d') {
    fail('peer identity sanitize/hash behavior changed');
  }
  if (integrationPeerIdentity.resumeIdFromArgs('claude', ['claude', '--resume', 'named-session']) !== 'named-session' ||
      integrationPeerIdentity.resumeIdFromArgs('claude', ['claude', '--resume=inline-session']) !== 'inline-session' ||
      integrationPeerIdentity.resumeIdFromArgs('claude', ['claude', '--resume', 'named-session', '--fork-session']) !== null ||
      integrationPeerIdentity.resumeIdFromArgs('codex', ['codex', 'resume', 'codex-session']) !== 'codex-session' ||
      integrationPeerIdentity.resumeIdFromArgs('codex', ['codex', 'resume', '--last']) !== null) {
    fail('peer identity resume id parsing changed');
  }
  const savedPeerEnv = {
    HCC_PEER: process.env.HCC_PEER,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CODEX_MANAGED_BY_NPM: process.env.CODEX_MANAGED_BY_NPM,
    CODEX_MANAGED_BY_BUN: process.env.CODEX_MANAGED_BY_BUN
  };
  try {
    process.env.HCC_PEER = 'env-peer';
    if (integrationPeerIdentity.resolveCurrentPeer({ root: repoRoot }, {}, 'peer', 'shell').id !== 'env-peer') {
      fail('peer identity resolveCurrentPeer ignored HCC_PEER');
    }
    const correctedPeer = integrationPeerIdentity.resolveCurrentPeer({ root: repoRoot }, { peer: 'manual-peer' }, 'peer', 'shell');
    if (correctedPeer.id !== 'env-peer' || correctedPeer.corrected_from !== 'manual-peer') {
      fail(`peer identity did not correct explicit peer to HCC_PEER: ${JSON.stringify(correctedPeer)}`);
    }
    delete process.env.HCC_PEER;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDECODE;
    process.env.CODEX_SESSION_ID = '0123456789abcdef';
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_MANAGED_BY_NPM;
    delete process.env.CODEX_MANAGED_BY_BUN;
    const autoPeer = integrationPeerIdentity.resolveCurrentPeer({ root: repoRoot }, {}, 'peer', 'shell');
    // sess-04: peer id is a hash of the full provider session id, not the first 8 chars.
    if (!autoPeer.auto || autoPeer.id !== `codex-${shortHash('0123456789abcdef')}`) {
      fail(`peer identity auto peer id changed: ${JSON.stringify(autoPeer)}`);
    }
    const explicitPeer = integrationPeerIdentity.resolveCurrentPeer({ root: repoRoot }, { peer: 'manual-peer' }, 'peer', 'shell');
    if (explicitPeer.auto || explicitPeer.id !== 'manual-peer') {
      fail(`peer identity explicit peer resolution changed: ${JSON.stringify(explicitPeer)}`);
    }
  } finally {
    for (const [key, value] of Object.entries(savedPeerEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  for (const helper of [
    'function projectRecord',
    'function readProjectRegistry',
    'function writeProjectRegistry',
    'function registerProject',
    'function registerProjectActivity'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds project registry helper: ${helper}`);
  }
  const projectRegistry = await import(path.join(repoRoot, 'lib', 'runtime', 'projects.mjs'));
  const compatProjectRegistry = await import(path.join(repoRoot, 'lib', 'project-registry.mjs'));
  for (const name of [
    'projectRecord',
    'readProjectRegistry',
    'writeProjectRegistry',
    'registerProject',
    'registerProjectActivity'
  ]) {
    if (typeof projectRegistry[name] !== 'function') fail(`project registry module missing export: ${name}`);
    if (typeof compatProjectRegistry[name] !== 'function') fail(`project registry compat module missing export: ${name}`);
  }
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const registryRootA = path.join(root, 'registry-a');
    const registryRootB = path.join(root, 'registry-b');
    const missingRegistryRoot = path.join(root, 'registry-missing');
    fs.mkdirSync(registryRootA, { recursive: true });
    fs.mkdirSync(registryRootB, { recursive: true });
    const canonicalRegistryRootA = fs.realpathSync.native(registryRootA);
    const canonicalRegistryRootB = fs.realpathSync.native(registryRootB);
    const written = projectRegistry.writeProjectRegistry([
      { root: registryRootA, db: '', name: '', last_seen_at: '5' },
      { root: missingRegistryRoot, db: path.join(missingRegistryRoot, 'stale.db'), name: 'Gone', last_seen_at: '20' },
      { root: registryRootB, db: path.join(registryRootB, 'custom.db'), name: 'Bee', last_seen_at: '10' },
      { root: registryRootA, db: path.join(registryRootA, 'new.db'), name: 'Aye', last_seen_at: '15' }
    ]);
    if (written.length !== 3 ||
        written[0].root !== path.resolve(missingRegistryRoot) ||
        written[1].root !== canonicalRegistryRootA ||
        written[1].db !== path.join(canonicalRegistryRootA, 'new.db') ||
        written[1].name !== 'Aye' ||
        written[1].last_seen_at !== 15 ||
        written[2].root !== canonicalRegistryRootB) {
      fail(`project registry write/dedupe/sort changed: ${JSON.stringify(written)}`);
    }
    const readBack = projectRegistry.readProjectRegistry();
    if (readBack.length !== 2 ||
        readBack[0].root !== canonicalRegistryRootA ||
        readBack[1].root !== canonicalRegistryRootB ||
        readBack.some((p) => p.root === path.resolve(missingRegistryRoot))) {
      fail(`project registry kept missing root: ${JSON.stringify(readBack)}`);
    }
    const recorded = projectRegistry.projectRecord({
      root: path.resolve(registryRootB),
      dbPath: path.join(registryRootB, 'mesh.db')
    }, () => 123);
    if (recorded.root !== canonicalRegistryRootB ||
        recorded.db !== path.join(canonicalRegistryRootB, 'mesh.db') ||
        recorded.name !== 'registry-b' ||
        recorded.last_seen_at !== 123) {
      fail(`project registry record changed: ${JSON.stringify(recorded)}`);
    }
    const registered = projectRegistry.registerProject({
      root: path.resolve(registryRootB),
      dbPath: path.join(registryRootB, 'mesh.db')
    });
    if (registered[0].root !== canonicalRegistryRootB ||
        registered.filter((p) => p.root === canonicalRegistryRootB).length !== 1) {
      fail(`project registry register changed: ${JSON.stringify(registered)}`);
    }
    const reboundDb = path.join(registryRootB, 'rebound.db');
    const rebound = projectRegistry.registerProject({
      root: path.join(registryRootB, '.'),
      dbPath: path.join(registryRootB, 'nested', '..', 'rebound.db')
    });
    if (rebound[0].root !== canonicalRegistryRootB ||
        rebound[0].db !== path.join(canonicalRegistryRootB, path.basename(reboundDb)) ||
        fs.existsSync(`${path.join(home, '.hello-cc', 'projects.json')}.lock`)) {
      fail(`project registry DB rebind was throttled or leaked its lock: ${JSON.stringify(rebound)}`);
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
  for (const helper of [
    'function runtimeBaseUrl',
    'function runtimeApiUrl',
    'function requestUrl',
    'function isLoopbackHost',
    'function nextSessionId',
    'function listenServer',
    'function runtimeUrlQuery',
    'function makeWebToken',
    'function validateWebTokenOpts',
    'function expectedWebHost',
    'function webRuntimeMatchesRequest',
    'function publicRuntimeUrl',
    'function localRuntimeUrl'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds web runtime helper: ${helper}`);
  }
  for (const helper of [
    'function readRequestBody',
    'function readJsonRequest',
    'function sendHttp',
    'function sendJson',
    'function sendFile',
    'function authOk'
  ]) {
    if (hccSource.includes(helper)) fail(`CLI still embeds web HTTP helper: ${helper}`);
  }
  if (hccSource.includes('new URL(req.url')) fail('CLI still embeds raw server request URL parsing');
  if (hccSource.includes('function webIndexHtml()')) fail('CLI still embeds the web UI template');
  const webRuntime = await import(path.join(repoRoot, 'lib', 'web', 'runtime.mjs'));
  const webHttp = await import(path.join(repoRoot, 'lib', 'web', 'http.mjs'));
  const webUiTemplate = await import(path.join(repoRoot, 'lib', 'web', 'ui-template.mjs'));
  const compatWebRuntime = await import(path.join(repoRoot, 'lib', 'web-runtime.mjs'));
  const compatWebHttp = await import(path.join(repoRoot, 'lib', 'web-http.mjs'));
  const compatWebPeerActions = await import(path.join(repoRoot, 'lib', 'web-peer-actions.mjs'));
  const compatWebUiTemplate = await import(path.join(repoRoot, 'lib', 'web-ui-template.mjs'));
  for (const [moduleName, mod, names] of [
    ['web/runtime', webRuntime, ['runtimeConnectHost', 'runtimeBaseUrl', 'runtimeApiUrl', 'runtimeHttpRequest', 'requestUrl', 'isLoopbackHost', 'nextSessionId', 'listenServer', 'publicRuntimeUrl', 'localRuntimeUrl', 'makeWebToken', 'expectedWebHost', 'webRuntimeMatchesRequest', 'rememberRuntimeToken']],
    ['web-runtime compat', compatWebRuntime, ['runtimeConnectHost', 'runtimeBaseUrl', 'runtimeApiUrl', 'requestUrl', 'isLoopbackHost', 'nextSessionId', 'listenServer', 'publicRuntimeUrl', 'localRuntimeUrl', 'makeWebToken', 'expectedWebHost', 'webRuntimeMatchesRequest', 'rememberRuntimeToken']],
    ['web/http', webHttp, ['readJsonRequest', 'sendHttp', 'sendJson', 'sendFile', 'authOk', 'tokenMatches', 'requestIsSecure', 'requestOriginMatches']],
    ['web-http compat', compatWebHttp, ['readJsonRequest', 'sendHttp', 'sendJson', 'sendFile', 'authOk']],
    ['web-peer-actions compat', compatWebPeerActions, ['createWebPeerActions']],
    ['web/ui-template', webUiTemplate, ['webIndexHtml']],
    ['web-ui-template compat', compatWebUiTemplate, ['webIndexHtml']]
  ]) {
    for (const name of names) {
      if (typeof mod[name] !== 'function') fail(`${moduleName} missing export: ${name}`);
    }
  }
  const expectEqual = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  };
  const html = webUiTemplate.webIndexHtml({ nonce: 'regression-template-nonce' });
  if (!html.includes('<!doctype html>') ||
      !html.includes('<div class="app">') ||
      !html.includes('<script src="/assets/xterm.js"></script>')) {
    fail('web UI template module did not render the expected shell HTML');
  }
  const jsonReq = Readable.from(['{"ok":true}']);
  jsonReq.headers = {};
  const parsedJson = await webHttp.readJsonRequest(jsonReq);
  if (parsedJson.ok !== true) fail(`web HTTP helper failed to parse JSON request: ${JSON.stringify(parsedJson)}`);
  const emptyReq = Readable.from(['']);
  emptyReq.headers = {};
  const parsedEmpty = await webHttp.readJsonRequest(emptyReq);
  if (Object.keys(parsedEmpty).length !== 0) fail(`web HTTP helper failed empty request fallback: ${JSON.stringify(parsedEmpty)}`);
  const mockRes = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  webHttp.sendJson(mockRes, 202, { ok: true });
  if (mockRes.status !== 202 ||
      mockRes.headers?.['Content-Type'] !== 'application/json; charset=utf-8' ||
      mockRes.headers?.['Cache-Control'] !== 'no-store' ||
      !mockRes.body.includes('"ok": true')) {
    fail(`web HTTP helper failed sendJson response: ${JSON.stringify(mockRes)}`);
  }
  if (!webHttp.authOk(new URL('http://example.test/?token=tok'), { headers: {} }, 'tok') ||
      !webHttp.authOk(new URL('http://example.test/'), { headers: { authorization: 'Bearer tok' } }, 'tok') ||
      webHttp.authOk(new URL('http://example.test/?token=bad'), { headers: {} }, 'tok')) {
    fail('web HTTP helper authOk token checks failed');
  }
  const sameOriginHttpRequest = {
    headers: { origin: 'http://example.test:8787', host: 'example.test:8787' },
    socket: { encrypted: false }
  };
  if (!webHttp.requestOriginMatches(sameOriginHttpRequest) ||
      webHttp.requestOriginMatches({ ...sameOriginHttpRequest, headers: { ...sameOriginHttpRequest.headers, origin: 'http://example.test:8788' } }) ||
      webHttp.requestOriginMatches({ ...sameOriginHttpRequest, socket: { encrypted: true } }) ||
      webHttp.requestOriginMatches({ ...sameOriginHttpRequest, headers: { host: 'example.test:8787' } })) {
    fail('web HTTP helper same-origin checks failed');
  }
  const trustedProxyOriginRequest = {
    headers: {
      origin: 'https://public.example.test:9443',
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'public.example.test:9443, internal-proxy:8787',
      'x-forwarded-proto': 'https, http'
    },
    socket: { encrypted: false, remoteAddress: '::ffff:127.0.0.1' }
  };
  const trustedProxyOptions = { trustProxy: true, proxyOrigin: 'https://public.example.test:9443' };
  if (!webHttp.requestOriginMatches(trustedProxyOriginRequest, trustedProxyOptions) ||
      webHttp.requestOriginMatches(trustedProxyOriginRequest, { trustProxy: true }) ||
      webHttp.requestOriginMatches(trustedProxyOriginRequest) ||
      webHttp.requestOriginMatches({ ...trustedProxyOriginRequest, socket: { encrypted: false, remoteAddress: '203.0.113.9' } }, trustedProxyOptions) ||
      webHttp.requestOriginMatches({ ...trustedProxyOriginRequest, headers: { ...trustedProxyOriginRequest.headers, 'x-forwarded-host': 'other.example.test:9443' } }, trustedProxyOptions) ||
      webHttp.requestOriginMatches({ ...trustedProxyOriginRequest, headers: { ...trustedProxyOriginRequest.headers, 'x-forwarded-proto': 'http' } }, trustedProxyOptions) ||
      webHttp.requestOriginMatches({ ...trustedProxyOriginRequest, headers: { ...trustedProxyOriginRequest.headers, 'x-forwarded-proto': 'file' } }, trustedProxyOptions)) {
    fail('web HTTP helper trusted-proxy forwarded origin checks failed');
  }
  if (!webHttp.requestIsSecure(trustedProxyOriginRequest, trustedProxyOptions) ||
      webHttp.requestIsSecure(trustedProxyOriginRequest, { trustProxy: true }) ||
      webHttp.requestIsSecure(trustedProxyOriginRequest) ||
      webHttp.requestIsSecure({ ...trustedProxyOriginRequest, socket: { encrypted: false, remoteAddress: '203.0.113.9' } }, trustedProxyOptions) ||
      !webHttp.requestIsSecure({ headers: {}, socket: { encrypted: true, remoteAddress: '203.0.113.9' } })) {
    fail('web HTTP helper trusted-proxy secure-request checks failed');
  }
  const wildcardRuntime = { host: '0.0.0.0', port: 8787, token: 'tok' };
  const ipv6WildcardRuntime = { host: '::', port: 8788, token: 'tok' };
  const localRuntime = { host: '127.0.0.1', port: 8789, token: 'tok', tls: false, base_url: 'http://127.0.0.1:8789' };
  expectEqual(webRuntime.runtimeBaseUrl('0.0.0.0', 8787), 'http://127.0.0.1:8787', 'runtimeBaseUrl 0.0.0.0');
  expectEqual(webRuntime.runtimeBaseUrl('::', 8788), 'http://127.0.0.1:8788', 'runtimeBaseUrl ::');
  expectEqual(String(webRuntime.runtimeApiUrl({ base_url: 'http://127.0.0.1:8787/base' }, '/api/state?peer=a b')), 'http://127.0.0.1:8787/api/state?peer=a%20b', 'runtimeApiUrl route');
  expectEqual(String(webRuntime.requestUrl({ url: '/api/state?peer=a b', headers: { host: 'example.test:8787' } })), 'http://example.test:8787/api/state?peer=a%20b', 'requestUrl host and query');
  expectEqual(String(webRuntime.requestUrl({ url: '', headers: {} })), 'http://localhost/', 'requestUrl fallback');
  if (!webRuntime.isLoopbackHost('127.0.0.1') ||
      !webRuntime.isLoopbackHost('localhost') ||
      !webRuntime.isLoopbackHost('::1') ||
      webRuntime.isLoopbackHost('0.0.0.0')) {
    fail('web runtime isLoopbackHost checks failed');
  }
  expectEqual(webRuntime.nextSessionId(['shell-1', 'shell-2'], 'shell'), 'shell-3', 'nextSessionId array');
  expectEqual(webRuntime.nextSessionId(new Map([
    ['a', { id: 'codex-1' }],
    ['b', 'codex-2']
  ]), 'codex'), 'codex-3', 'nextSessionId map');
  const localMatchOpts = { local: true, port: 8789, token: 'tok' };
  const tlsRuntime = { ...localRuntime, tls: true, base_url: 'https://127.0.0.1:8789' };
  const legacyTlsRuntime = { host: '127.0.0.1', port: 8789, token: 'tok', base_url: 'https://127.0.0.1:8789' };
  if (!webRuntime.webRuntimeMatchesRequest(localRuntime, localMatchOpts) ||
      webRuntime.webRuntimeMatchesRequest(localRuntime, { ...localMatchOpts, tls: true }) ||
      !webRuntime.webRuntimeMatchesRequest(tlsRuntime, { ...localMatchOpts, tls: true }) ||
      webRuntime.webRuntimeMatchesRequest(tlsRuntime, localMatchOpts) ||
      !webRuntime.webRuntimeMatchesRequest(legacyTlsRuntime, { ...localMatchOpts, tls: true })) {
    fail('web runtime TLS mode matching checks failed');
  }
  const listenProbe = http.createServer((req, res) => res.end('ok'));
  try {
    const listenPort = await webRuntime.listenServer(listenProbe, '127.0.0.1', 0, false);
    if (!Number.isInteger(listenPort) || listenPort <= 0) {
      fail(`listenServer did not return a usable port: ${listenPort}`);
    }
  } finally {
    await new Promise((resolve) => listenProbe.close(resolve));
  }
  const tlsHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-tls-${testId}-`));
  const savedTlsHome = process.env.HOME;
  let tlsCredentials;
  try {
    process.env.HOME = tlsHome;
    const webTls = await import(path.join(repoRoot, 'lib', 'web', 'tls.mjs'));
    tlsCredentials = webTls.ensureSelfSignedCert();
    const tlsDir = path.join(tlsHome, '.hello-cc', 'tls');
    const currentPointerPath = path.join(tlsDir, 'current.json');
    const currentGeneration = JSON.parse(fs.readFileSync(currentPointerPath, 'utf8')).generation;
    const generationNames = {
      initialCurrent: currentGeneration,
      previous: `generation-previous-${testId}`,
      recent: `generation-recent-candidate-${testId}`,
      switchedCurrent: `generation-switched-current-${testId}`,
      activeCreating: `generation-active-creating-${testId}`,
      deadCreating: `generation-dead-creating-${testId}`
    };
    const initialGenerationDir = path.join(tlsDir, currentGeneration);
    const cleanupNow = Date.now();
    const generationFixtures = [
      { kind: 'previous', ageMs: 5 * 60 * 1000, complete: true, marker: '.published', pid: process.pid },
      { kind: 'recent', ageMs: 30 * 60 * 1000 },
      { kind: 'switchedCurrent', ageMs: 90 * 60 * 1000, complete: true, marker: '.published', pid: process.pid },
      { kind: 'activeCreating', ageMs: 2 * 60 * 60 * 1000, marker: '.creating', pid: process.pid },
      { kind: 'deadCreating', ageMs: 3 * 60 * 60 * 1000, marker: '.creating', pid: 99999999 }
    ];
    for (const fixture of generationFixtures) {
      const generation = generationNames[fixture.kind];
      const generationDir = path.join(tlsDir, generation);
      fs.mkdirSync(generationDir, { mode: 0o700 });
      if (fixture.complete) {
        fs.copyFileSync(path.join(initialGenerationDir, 'self-signed.key'), path.join(generationDir, 'self-signed.key'));
        fs.copyFileSync(path.join(initialGenerationDir, 'self-signed.crt'), path.join(generationDir, 'self-signed.crt'));
      }
      if (fixture.marker) {
        fs.writeFileSync(path.join(generationDir, fixture.marker), `${fixture.pid}\n`, { mode: 0o600 });
      }
      const modifiedAt = new Date(cleanupNow - fixture.ageMs);
      fs.utimesSync(generationDir, modifiedAt, modifiedAt);
    }
    const originalTlsCert = tlsCredentials.cert;
    const originalTlsCertPath = tlsCredentials.certPath;
    const originalReadFileSync = fs.readFileSync;
    let pointerReads = 0;
    let pointerSwitchedBeforeDelete = false;
    fs.readFileSync = (file, ...args) => {
      if (path.resolve(String(file)) === path.resolve(currentPointerPath)) {
        pointerReads += 1;
        // Read 1 validates the old current; read 2 starts cleanup; read 3 is
        // the deletion-time TOCTOU guard for the stale switched-current row.
        if (pointerReads === 3) {
          const nextPointerPath = path.join(tlsDir, `.current-regression-${testId}.tmp`);
          fs.writeFileSync(nextPointerPath, `${JSON.stringify({ generation: generationNames.switchedCurrent })}\n`, { mode: 0o600 });
          fs.renameSync(nextPointerPath, currentPointerPath);
          pointerSwitchedBeforeDelete = true;
        }
      }
      return originalReadFileSync(file, ...args);
    };
    try {
      tlsCredentials = webTls.ensureSelfSignedCert();
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    const publishedGeneration = JSON.parse(fs.readFileSync(currentPointerPath, 'utf8')).generation;
    const remainingGenerations = fs.readdirSync(tlsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('generation-'))
      .map((entry) => entry.name)
      .sort();
    const expectedRemainingGenerations = [
      generationNames.initialCurrent,
      generationNames.previous,
      generationNames.recent,
      generationNames.switchedCurrent,
      generationNames.activeCreating
    ].sort();
    if (tlsCredentials.cert !== originalTlsCert ||
        tlsCredentials.certPath !== originalTlsCertPath ||
        !pointerSwitchedBeforeDelete || pointerReads < 4 ||
        publishedGeneration !== generationNames.switchedCurrent ||
        !fs.existsSync(path.join(tlsDir, generationNames.initialCurrent, '.published')) ||
        !fs.existsSync(path.join(tlsDir, generationNames.switchedCurrent, '.published')) ||
        !fs.existsSync(path.join(tlsDir, generationNames.activeCreating, '.creating')) ||
        fs.existsSync(path.join(tlsDir, generationNames.deadCreating)) ||
        JSON.stringify(remainingGenerations) !== JSON.stringify(expectedRemainingGenerations)) {
      fail(`TLS generation cleanup violated current/previous/candidate lifecycle protection:\n${JSON.stringify({ generationNames, pointerReads, pointerSwitchedBeforeDelete, publishedGeneration, remainingGenerations }, null, 2)}`);
    }
  } finally {
    if (savedTlsHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedTlsHome;
  }
  const tlsProbe = https.createServer({ key: tlsCredentials.key, cert: tlsCredentials.cert }, (req, res) => res.end('tls-ok'));
  try {
    const tlsPort = await new Promise((resolve, reject) => {
      tlsProbe.once('error', reject);
      // Bind the unspecified address so localhost works whether Node resolves
      // it to IPv4 or IPv6 first (the order differs across target platforms).
      tlsProbe.listen(0, () => {
        tlsProbe.off('error', reject);
        resolve(tlsProbe.address().port);
      });
    });
    const tlsBaseUrl = `https://localhost:${tlsPort}`;
    // TLS-1: an HTTPS environment override without a CA must use normal PKI
    // verification and reject this private self-signed endpoint.
    let untrustedRejected = false;
    try {
      await webRuntime.runtimeHttpRequest({ base_url: tlsBaseUrl }, '/probe', { timeoutMs: 3000 });
    } catch {
      untrustedRejected = true;
    }
    if (!untrustedRejected) {
      fail('runtime HTTPS request accepted a private endpoint without an explicit CA');
    }
    const trustedTlsResponse = await webRuntime.runtimeHttpRequest({
      base_url: tlsBaseUrl,
      tls_ca: tlsCredentials.cert
    }, '/probe', { timeoutMs: 3000 });
    if (!trustedTlsResponse.ok || trustedTlsResponse.text !== 'tls-ok') {
      fail(`runtime HTTPS request rejected its configured CA: ${JSON.stringify(trustedTlsResponse)}`);
    }
    // A mismatched CA must still fail verification.
    let mismatchedCaRejected = false;
    try {
      await webRuntime.runtimeHttpRequest({
        base_url: tlsBaseUrl,
        tls_cert: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----'
      }, '/probe', { timeoutMs: 3000 });
    } catch {
      mismatchedCaRejected = true;
    }
    if (!mismatchedCaRejected) {
      fail('runtime HTTPS request accepted a mismatched CA');
    }
  } finally {
    if (tlsProbe.listening) await new Promise((resolve) => tlsProbe.close(resolve));
    fs.rmSync(tlsHome, { recursive: true, force: true });
  }
  expectEqual(webRuntime.publicRuntimeUrl(wildcardRuntime, '/tmp/hcc project'), 'http://<machine-ip>:8787/?token=tok&project=%2Ftmp%2Fhcc%20project', 'publicRuntimeUrl wildcard');
  expectEqual(webRuntime.localRuntimeUrl(wildcardRuntime, '/tmp/hcc project'), 'http://127.0.0.1:8787/?token=tok&project=%2Ftmp%2Fhcc%20project', 'localRuntimeUrl wildcard');
  expectEqual(webRuntime.publicRuntimeUrl(ipv6WildcardRuntime, '/tmp/hcc project'), 'http://<machine-ip>:8788/?token=tok&project=%2Ftmp%2Fhcc%20project', 'publicRuntimeUrl ipv6 wildcard');
  expectEqual(webRuntime.localRuntimeUrl(localRuntime, null), 'http://127.0.0.1:8789/?token=tok', 'localRuntimeUrl no project');
  const mainHelp = run(process.execPath, [hccBin, '--help']);
  if (mainHelp.includes('setup') || mainHelp.includes('--web-managed')) {
    fail(`public help exposes maintenance or removed commands:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  update                       Update the global npm install of hello-cc')) {
    fail(`main help missing update command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  state [--peer ID]            Show timeline and next coordination action')) {
    fail(`main help missing state command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  team <subcommand>            Plan, start, and inspect explicit task teams')) {
    fail(`main help missing team command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  uninstall                    Remove hooks, shims, and optional project data')) {
    fail(`main help missing uninstall command:\n${mainHelp}`);
  }
  if (!mainHelp.includes('  tmux gc [--yes]              Clean stale DB-proven hcc-managed tmux sessions')) {
    fail(`main help missing tmux gc command:\n${mainHelp}`);
  }
  const msgHelp = run(process.execPath, [hccBin, 'msg', '--help']);
  if (!msgHelp.includes('msg reply') || !msgHelp.includes('msg thread')) {
    fail(`msg help missing reply/thread commands:\n${msgHelp}`);
  }
  const taskHelp = run(process.execPath, [hccBin, 'task', '--help']);
  if (!taskHelp.includes('task next [--peer ID] [--force]') ||
      !taskHelp.includes('[--count N]') ||
      !taskHelp.includes('existing claimed/running/review/blocked task') ||
      !taskHelp.includes('task dispatch --to ID --title TEXT') ||
      !taskHelp.includes('task dispatch --to ID --id N') ||
      !taskHelp.includes('message-only') ||
      !taskHelp.includes('running managed Claude/Codex terminal') ||
      !taskHelp.includes('task takeover [--peer ID] --id N --reason TEXT') ||
      !taskHelp.includes('[--policy any|blocked|stale|blocked-or-stale]') ||
      !taskHelp.includes('task claim [--peer ID] --id N[,N]') ||
      !taskHelp.includes('task create --title TEXT --parent N') ||
      !taskHelp.includes('task running|review|blocked|abandoned [--peer ID] --id N') ||
      !taskHelp.includes('shortcuts for') ||
      !taskHelp.includes('task update --status STATUS')) {
    fail(`task help missing current-task task next semantics:\n${taskHelp}`);
  }
  const taskModuleSource = fs.readFileSync(path.join(repoRoot, 'lib', 'cli', 'commands', 'task.mjs'), 'utf8');
  for (const expected of [
    "if (sub === 'dispatch') return taskDispatch",
    'async function taskDispatch(ctx, args)',
    "addEvent(eventDb, 'task.dispatched'",
    'function sessionLooksProviderInteractive(session)',
    '!customMessage && !sessionLooksProviderInteractive(session)'
  ]) {
    if (!taskModuleSource.includes(expected)) fail(`task dispatch source guard missing: ${expected}`);
  }
  const teamHelp = run(process.execPath, [hccBin, 'team', '--help']);
  if (!teamHelp.includes('hcc team') || !teamHelp.includes('team plan') || !teamHelp.includes('team start') || !teamHelp.includes('team status')) {
    fail(`team help missing expected content:\n${teamHelp}`);
  }
  const stateHelp = run(process.execPath, [hccBin, 'state', '--help']);
  if (!stateHelp.includes('hcc state') ||
      !stateHelp.includes('--scope SCOPE') ||
      !stateHelp.includes('--intent read|review|work|write|stop|finish') ||
      !stateHelp.includes('automation.next_action.argv') ||
      !stateHelp.includes('automation.current_task') ||
      !stateHelp.includes('hcc team plan')) {
    fail(`state help missing expected content:\n${stateHelp}`);
  }
  const lockHelp = run(process.execPath, [hccBin, 'lock', '--help']);
  if (!lockHelp.includes('--scope SCOPE') || !lockHelp.toLowerCase().includes('different scopes on the same resource')) {
    fail(`lock help missing scoped lock content:\n${lockHelp}`);
  }
  const updateHelp = run(process.execPath, [hccBin, 'update', '--help']);
  if (!updateHelp.includes('hcc update') || !updateHelp.includes('npm install -g @logicseek/hello-cc@TAG')) {
    fail(`update help missing expected content:\n${updateHelp}`);
  }
  const tmuxHelp = run(process.execPath, [hccBin, 'tmux', '--help']);
  if (!tmuxHelp.includes('hcc tmux') ||
      !tmuxHelp.includes('tmux gc [--peer ID] [--older-than DAYS]') ||
      !tmuxHelp.includes('peer_bindings.transport must be tmux') ||
      !tmuxHelp.includes('deletion requires --yes')) {
    fail(`tmux help missing DB-backed gc semantics:\n${tmuxHelp}`);
  }
  const shimHelp = run(process.execPath, [hccBin, 'shim', '--help']);
  if (!shimHelp.includes('hcc shim') ||
      !shimHelp.includes('shim install') ||
      !shimHelp.includes('shim status') ||
      !shimHelp.includes('shell PATH entry')) {
    fail(`shim help missing maintenance command content:\n${shimHelp}`);
  }
  const installHooksHelp = run(process.execPath, [hccBin, 'install-hooks', '--help']);
  if (!installHooksHelp.includes('hcc install-hooks') ||
      !installHooksHelp.includes('install-hooks --status') ||
      !installHooksHelp.includes('install-hooks --uninstall')) {
    fail(`install-hooks help missing maintenance command content:\n${installHooksHelp}`);
  }
  const gcHelp = run(process.execPath, [hccBin, 'gc', '--help']);
  if (!gcHelp.includes('hcc gc') ||
      !gcHelp.includes('gc [--older-than DAYS] [--history] [--yes]') ||
      !gcHelp.includes('history deletion requires both --history and --yes') ||
      !gcHelp.includes('Handoffs linked to open tasks are always preserved') ||
      !gcHelp.includes('--older-than must be zero or greater') ||
      !gcHelp.includes('every age-based category is deferred')) {
    fail(`gc help missing cleanup semantics:\n${gcHelp}`);
  }
  const uninstallHelp = run(process.execPath, [hccBin, 'uninstall', '--help']);
  if (!uninstallHelp.includes('hcc uninstall') || !uninstallHelp.includes('hcc uninstall [--purge --yes]')) {
    fail(`uninstall help missing expected content:\n${uninstallHelp}`);
  }
  const updateDryRun = run(process.execPath, [hccBin, 'update', '--dry-run']);
  if (!updateDryRun.includes('would run: npm install -g @logicseek/hello-cc@latest')) {
    fail(`update dry-run output wrong:\n${updateDryRun}`);
  }
  const updateJson = JSON.parse(run(process.execPath, [hccBin, '--json', 'update', '--dry-run', '--tag', '0.1.2']));
  if (!updateJson.ok || updateJson.data.command !== 'npm install -g @logicseek/hello-cc@0.1.2') {
    fail(`update json dry-run output wrong:\n${JSON.stringify(updateJson)}`);
  }
  const updateBuildJson = JSON.parse(run(process.execPath, [hccBin, '--json', 'update', '--dry-run', '--tag', '1.2.3+build.1']));
  if (!updateBuildJson.ok || updateBuildJson.data.command !== 'npm install -g @logicseek/hello-cc@1.2.3+build.1') {
    fail(`update build-metadata dry-run output wrong:\n${JSON.stringify(updateBuildJson)}`);
  }
  const runHelp = run(process.execPath, [hccBin, 'run', '--help']);
  if (runHelp.includes('--web-managed')) fail(`run help exposes removed --web-managed:\n${runHelp}`);
  const subcommandHelpCases = [
    ['task', 'done', 'hcc task done'],
    ['task', 'running', 'hcc task running'],
    ['msg', 'reply', 'hcc msg reply'],
    ['peer', 'attach', 'peer attach'],
    ['tmux', 'gc', 'hcc tmux'],
    ['lock', 'release', 'hcc lock release'],
    ['handoff', 'create', 'hcc handoff create'],
    ['event', 'tail', 'hcc event tail']
  ];
  for (const [group, subcommand, expected] of subcommandHelpCases) {
    const help = run(process.execPath, [hccBin, group, subcommand, '--help']);
    if (!help.includes(expected)) {
      fail(`${group} ${subcommand} help missing expected content:\n${help}`);
    }
  }
  const removed = runMaybe(process.execPath, [hccBin, '--root', root, 'run', '--peer', 'bad', '--kind', 'shell', '--web-managed', '--', 'bash']);
  if (removed.status === 0 || !String(removed.stderr || removed.stdout).includes('unknown option --web-managed')) {
    fail(`run --web-managed was not rejected:\n${removed.stdout}\n${removed.stderr}`);
  }
  run('npm', ['run', 'smoke']);
}

function uninstallWorkflow() {
  log('[13/13] maintenance cleanup');
  const uninstallRoot = path.join(os.tmpdir(), `hcc-reg-uninstall-root-${testId}`);
  const uninstallHome = path.join(os.tmpdir(), `hcc-reg-uninstall-home-${testId}`);
  fs.mkdirSync(uninstallRoot, { recursive: true });
  fs.mkdirSync(uninstallHome, { recursive: true });
  const uninstallEnv = {
    ...env,
    HOME: uninstallHome,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
  };

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  ensureFile(path.join(uninstallRoot, '.hello-cc', 'mesh.db'));
  ensureFile(path.join(uninstallRoot, '.hello-cc', 'HCC.md'));
  ensureFile(path.join(uninstallRoot, 'CLAUDE.md'));
  ensureFile(path.join(uninstallRoot, 'AGENTS.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, '.hello-cc', 'HCC.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, 'CLAUDE.md'));
  assertGuidanceLockPolicy(path.join(uninstallRoot, 'AGENTS.md'));
  ensureFile(path.join(uninstallHome, '.claude', 'settings.json'));
  ensureFile(path.join(uninstallHome, '.codex', 'hooks.json'));
  ensureFile(path.join(uninstallHome, '.hcc-shims', 'claude'));
  const uninstallBashrc = path.join(uninstallHome, '.bashrc');
  if (!fs.readFileSync(uninstallBashrc, 'utf8').includes('.hcc-shims')) {
    fail('setup did not install shim PATH entry before uninstall workflow');
  }

  const kept = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall'], { env: uninstallEnv });
  if (!kept.includes('project data kept')) fail(`uninstall did not keep project data by default:\n${kept}`);
  if (!fs.existsSync(path.join(uninstallRoot, '.hello-cc', 'mesh.db'))) fail('default uninstall removed project db');
  if (fs.existsSync(path.join(uninstallHome, '.hcc-shims', 'claude'))) fail('default uninstall did not remove shim');
  if (fs.readFileSync(uninstallBashrc, 'utf8').includes('.hcc-shims')) fail('default uninstall did not remove shim PATH entry');
  if (!run(process.execPath, [hccBin, '--root', uninstallRoot, 'install-hooks', '--status'], { env: uninstallEnv }).includes('claude=no codex=no')) {
    fail('default uninstall did not remove hooks');
  }

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  const refused = runMaybe(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge'], { env: uninstallEnv });
  if (refused.status === 0 || !String(refused.stderr || refused.stdout).includes('without --yes')) {
    fail(`purge without --yes was not refused:\n${refused.stdout}\n${refused.stderr}`);
  }
  const purged = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge', '--yes'], { env: uninstallEnv });
  if (!purged.includes('project data removed')) fail(`purge output wrong:\n${purged}`);
  if (fs.existsSync(path.join(uninstallRoot, '.hello-cc'))) fail('purge did not remove .hello-cc');
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(uninstallRoot, file);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (text.includes('hello-cc:start')) fail(`${file} still has hello-cc block after purge`);
  }

  try { fs.rmSync(uninstallRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(uninstallHome, { recursive: true, force: true }); } catch {}
}

async function processEvidenceWorkflow() {
  log('process evidence: live, reused, legacy, dead, root mismatch');

  const createOwnedTask = (peer, title) => {
    const output = hcc(['task', 'create', '--from', 'human', '--to', peer, '--title', title]);
    const match = output.match(/created task #(\d+):/);
    if (!match) fail(`cannot parse evidence task id: ${output}`);
    hcc(['task', 'claim', '--peer', peer, '--id', match[1]]);
    return match[1];
  };
  const agePeer = (peer, mutate = '') => withMeshDb((db) => db.prepare(`
    UPDATE peers SET last_seen_at = ? ${mutate} WHERE id = ?
  `).run(Math.floor(Date.now() / 1000) - 7200, peer));
  const taskRow = (taskId) => hccJson(['task', 'list', '--all'])
    .find((row) => String(row.id) === String(taskId));
  const cleanupTask = (taskId) => {
    hcc(['task', 'takeover', '--peer', 'human', '--id', taskId, '--reason', 'evidence fixture cleanup', '--force']);
    hcc(['task', 'update', '--peer', 'human', '--id', taskId, '--status', 'abandoned', '--summary', 'evidence fixture cleanup']);
  };

  const livePeer = 'evidence-live-process';
  hcc(['register', '--peer', livePeer, '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
  const persisted = withMeshDb((db) => db.prepare(`
    SELECT pid_start_token, pid_command_hash FROM peers WHERE id = ?
  `).get(livePeer));
  if (!persisted?.pid_start_token || !/^[a-f0-9]{64}$/.test(persisted.pid_command_hash || '')) {
    fail(`register did not persist complete live process identity: ${JSON.stringify(persisted)}`);
  }
  const liveTask = createOwnedTask(livePeer, 'live evidence blocks takeover');
  agePeer(livePeer);
  const liveTakeover = hccMaybe(['task', 'takeover', '--peer', 'evidence-taker', '--id', liveTask, '--reason', 'must reject live', '--policy', 'stale', '--stale-after', '60']);
  if (liveTakeover.status === 0 || taskRow(liveTask)?.owner_evidence_state !== 'live') {
    fail(`verified live non-tmux peer did not block takeover:\n${liveTakeover.stdout}\n${liveTakeover.stderr}`);
  }
  cleanupTask(liveTask);

  const reusedPeer = 'evidence-reused-pid';
  hcc(['register', '--peer', reusedPeer, '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
  const reusedTask = createOwnedTask(reusedPeer, 'reused PID permits takeover');
  agePeer(reusedPeer, `, pid_start_token = 'reused:start', pid_command_hash = '${'f'.repeat(64)}'`);
  if (taskRow(reusedTask)?.owner_evidence_state !== 'dead') fail('reused PID fingerprint was not reported dead');
  const reusedTakeover = hccMaybe(['task', 'takeover', '--peer', 'evidence-taker', '--id', reusedTask, '--reason', 'reused PID', '--policy', 'stale', '--stale-after', '60']);
  if (reusedTakeover.status !== 0) fail(`reused PID did not permit takeover:\n${reusedTakeover.stdout}\n${reusedTakeover.stderr}`);
  hcc(['task', 'update', '--peer', 'evidence-taker', '--id', reusedTask, '--status', 'abandoned', '--summary', 'evidence fixture cleanup']);

  const legacyPeer = 'evidence-legacy';
  hcc(['register', '--peer', legacyPeer, '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
  const legacyTask = createOwnedTask(legacyPeer, 'legacy evidence remains unknown');
  agePeer(legacyPeer, ', pid_start_token = NULL, pid_command_hash = NULL');
  const legacyRow = taskRow(legacyTask);
  if (legacyRow?.owner_evidence_state !== 'unknown' || legacyRow?.owner_evidence_reason !== 'process_identity_incomplete' ||
      !legacyRow?.owner_stale || !legacyRow?.takeover_ready) {
    fail(`legacy process evidence was not preserved as unknown: ${JSON.stringify(legacyRow)}`);
  }
  cleanupTask(legacyTask);

  const deadPeer = 'evidence-dead-process';
  const deadPid = spawnSync('true', [], { stdio: 'ignore' }).pid;
  const deadTask = createOwnedTask(deadPeer, 'dead process permits takeover');
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000);
    db.prepare(`
      UPDATE peers SET pid = ?, pid_start_token = 'dead:start', pid_command_hash = ?,
                       status = 'working', last_seen_at = ?
      WHERE id = ?
    `).run(deadPid, 'e'.repeat(64), t, deadPeer);
  });
  const deadRow = taskRow(deadTask);
  if (deadRow?.owner_evidence_state !== 'dead' || !deadRow?.owner_stale || !deadRow?.takeover_ready) {
    fail(`recent confirmed-dead process was not reported stale: ${JSON.stringify(deadRow)}`);
  }
  const deadTakeover = hccMaybe(['task', 'takeover', '--peer', 'evidence-taker', '--id', deadTask, '--reason', 'confirmed dead', '--policy', 'stale', '--stale-after', '60']);
  if (deadTakeover.status !== 0) fail(`confirmed dead process did not permit takeover:\n${deadTakeover.stdout}\n${deadTakeover.stderr}`);
  hcc(['task', 'update', '--peer', 'evidence-taker', '--id', deadTask, '--status', 'abandoned', '--summary', 'evidence fixture cleanup']);

  if (tmuxAvailable()) {
    const rootPeer = 'evidence-root-mismatch';
    const session = tmuxManagedSession(root, rootPeer);
    managedTmuxSessions.add(session);
    runMaybe('tmux', ['kill-session', '-t', session]);
    run('tmux', ['new-session', '-d', '-s', session, '-e', `HCC_ROOT=${root}-other`, '-c', root, 'bash', '--noprofile', '--norc']);
    const pane = run('tmux', ['display-message', '-p', '-t', `${session}:0.0`, '#{pane_id}']).trim();
    const panePid = Number(run('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}']).trim());
    const paneIdentity = inspectProcessIdentity(panePid).identity;
    const rootTask = createOwnedTask(rootPeer, 'root mismatch does not override live owner');
    withMeshDb((db) => {
      const t = Math.floor(Date.now() / 1000) - 7200;
      db.prepare(`
        UPDATE peers SET pid = ?, pid_start_token = ?, pid_command_hash = ?, status = 'working', last_seen_at = ?
        WHERE id = ?
      `).run(panePid, paneIdentity?.startToken || null, paneIdentity?.commandHash || null, t, rootPeer);
      db.prepare(`
        INSERT INTO peer_bindings(peer, provider, resume_mode, transport, runtime_session_id, runtime_target, created_at, updated_at)
        VALUES (?, 'shell', 'attached', 'tmux', ?, ?, ?, ?)
        ON CONFLICT(peer) DO UPDATE SET transport = 'tmux', runtime_target = excluded.runtime_target, updated_at = excluded.updated_at
      `).run(rootPeer, rootPeer, pane, t, t);
    });
    const rootRow = taskRow(rootTask);
    if (rootRow?.owner_evidence_state !== 'live' || rootRow?.owner_evidence_reason !== 'process_identity_match' ||
        rootRow?.owner_stale || rootRow?.takeover_ready) {
      fail(`tmux root mismatch overrode matching owner-process evidence: ${JSON.stringify(rootRow)}`);
    }
    cleanupTask(rootTask);
    runMaybe('tmux', ['kill-session', '-t', session]);
    cleanupBindingPeers(rootPeer);
  }

  const externalDir = path.join(root, '.hello-cc', 'bufs');
  const shortExternalId = `evidence-external-short-${testId}`;
  const shortProducer = spawn(process.execPath, [
    hccBin,
    '--root', root,
    'run', '--peer', shortExternalId, '--kind', 'shell', '--',
    '/bin/true'
  ], {
    cwd: root,
    env: { ...env, HCC_INTERNAL_WEB_MANAGED_RUN: '1' },
    stdio: 'ignore'
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      shortProducer.once('error', reject);
      shortProducer.once('close', resolve);
    }),
    sleep(5000).then(() => { throw new Error('short external producer did not exit'); })
  ]);
  const shortFiles = ['out', 'in', 'resize', 'meta']
    .map((suffix) => path.join(externalDir, `${shortExternalId}.${suffix}`));
  const shortState = withMeshDb((db) => ({
    peer: db.prepare('SELECT status FROM peers WHERE id = ?').get(shortExternalId),
    event: db.prepare(`
      SELECT id FROM events WHERE type = 'run.session.exited' AND actor = ? ORDER BY id DESC LIMIT 1
    `).get(shortExternalId)
  }));
  if (shortFiles.some((file) => fs.existsSync(file)) ||
      shortState.peer?.status !== 'exited' || !shortState.event?.id) {
    fail(`short external PTY did not complete and clean up: ${JSON.stringify(shortState)}`);
  }

  const signaledExternalId = `evidence-external-signaled-${testId}`;
  const signaledChildPidFile = path.join(root, '.hello-cc', `${signaledExternalId}.pid`);
  const signaledProducer = spawn(process.execPath, [
    hccBin,
    '--root', root,
    'run', '--peer', signaledExternalId, '--kind', 'shell', '--',
    '/bin/bash', '--noprofile', '--norc', '-c',
    'trap "" HUP; printf "%s" "$$" > "$HCC_SIGNAL_TEST_PID_FILE"; sleep 30'
  ], {
    cwd: root,
    env: {
      ...env,
      HCC_INTERNAL_WEB_MANAGED_RUN: '1',
      HCC_SIGNAL_TEST_PID_FILE: signaledChildPidFile
    },
    stdio: 'ignore'
  });
  await waitFor(() => fs.existsSync(signaledChildPidFile), 'signaled external child PID', 5000);
  const signaledChildPid = Number(fs.readFileSync(signaledChildPidFile, 'utf8'));
  const signaledClose = new Promise((resolve, reject) => {
    signaledProducer.once('error', reject);
    signaledProducer.once('close', (code, signal) => resolve({ code, signal }));
  });
  signaledProducer.kill('SIGTERM');
  const signaledExit = await Promise.race([
    signaledClose,
    sleep(5000).then(() => { throw new Error('signaled external producer did not exit'); })
  ]);
  if (signaledExit.signal !== 'SIGTERM') {
    fail(`signaled external producer did not preserve SIGTERM: ${JSON.stringify(signaledExit)}`);
  }
  await waitFor(
    () => inspectProcessIdentity(signaledChildPid).state === 'dead',
    'signaled external child exit',
    5000
  );
  const signaledFiles = ['out', 'in', 'resize', 'meta']
    .map((suffix) => path.join(externalDir, `${signaledExternalId}.${suffix}`));
  const signaledState = withMeshDb((db) => ({
    peer: db.prepare('SELECT status FROM peers WHERE id = ?').get(signaledExternalId),
    event: db.prepare(`
      SELECT id FROM events WHERE type = 'run.session.exited' AND actor = ? ORDER BY id DESC LIMIT 1
    `).get(signaledExternalId)
  }));
  fs.rmSync(signaledChildPidFile, { force: true });
  if (signaledFiles.some((file) => fs.existsSync(file)) ||
      signaledState.peer?.status !== 'exited' || !signaledState.event?.id) {
    fail(`signaled external PTY did not terminate and clean up: ${JSON.stringify(signaledState)}`);
  }

  const externalId = `evidence-external-${testId}`;
  const externalMetaFile = path.join(externalDir, `${externalId}.meta`);
  const producer = spawn(process.execPath, [
    hccBin,
    '--root', root,
    'run', '--peer', externalId, '--kind', 'shell', '--',
    '/bin/bash', '--noprofile', '--norc', '-c', 'trap "" HUP; sleep 0.1; exec sleep 30'
  ], {
    cwd: root,
    env: { ...env, HCC_INTERNAL_WEB_MANAGED_RUN: '1' },
    stdio: 'ignore'
  });
  await waitFor(() => {
    try {
      const meta = JSON.parse(fs.readFileSync(externalMetaFile, 'utf8'));
      return meta.publishing !== true && meta.wrapper_identity?.pid === meta.wrapper_pid &&
        meta.child_identity?.pid === meta.pid;
    } catch {
      return false;
    }
  }, 'complete external producer metadata', 10000);
  const externalMeta = JSON.parse(fs.readFileSync(externalMetaFile, 'utf8'));
  if (externalMeta.wrapper_pid !== producer.pid ||
      !externalMeta.pid || externalMeta.pid === externalMeta.wrapper_pid ||
      externalMeta.wrapper_identity?.pid !== externalMeta.wrapper_pid ||
      !externalMeta.wrapper_identity?.startToken ||
      !externalMeta.wrapper_identity?.commandHash ||
      externalMeta.child_identity?.pid !== externalMeta.pid ||
      !externalMeta.child_identity?.startToken ||
      !externalMeta.child_identity?.commandHash) {
    fail(`external producer did not persist distinct complete identities: ${JSON.stringify(externalMeta)}`);
  }
  await waitFor(async () => {
    const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
    return (data.sessions || []).some((session) => session.id === externalId);
  }, 'external session adoption', 10000);
  const duplicateProducer = runMaybe(process.execPath, [
    hccBin,
    '--root', root,
    'run', '--peer', externalId, '--kind', 'shell', '--',
    '/bin/bash', '--noprofile', '--norc', '-c', 'sleep 30'
  ], {
    cwd: root,
    env: { ...env, HCC_INTERNAL_WEB_MANAGED_RUN: '1' }
  });
  const duplicateMeta = JSON.parse(fs.readFileSync(externalMetaFile, 'utf8'));
  const duplicateDbPeer = withMeshDb((db) => db.prepare(
    'SELECT pid, pid_start_token, pid_command_hash, status FROM peers WHERE id = ?'
  ).get(externalId));
  if (duplicateProducer.status === 0 ||
      !String(duplicateProducer.stderr || '').includes('already has a live or unknown owner') ||
      duplicateMeta.generation !== externalMeta.generation ||
      duplicateDbPeer?.pid !== producer.pid || duplicateDbPeer?.status !== 'running' ||
      inspectProcessIdentity(externalMeta.pid).state !== 'live') {
    fail(`same-id external producer replaced a live generation: ${JSON.stringify({
      status: duplicateProducer.status,
      stderr: duplicateProducer.stderr,
      duplicateMeta,
      duplicateDbPeer
    })}`);
  }
  const replacementIdentity = inspectProcessIdentity(process.pid);
  if (replacementIdentity.state !== 'live') fail('replacement DB fingerprint unavailable');
  withMeshDb((db) => {
    db.prepare(`
      UPDATE peers
      SET pid = ?, pid_start_token = ?, pid_command_hash = ?, status = 'running'
      WHERE id = ?
    `).run(
      process.pid,
      replacementIdentity.identity.startToken,
      replacementIdentity.identity.commandHash,
      externalId
    );
    const bindingMutation = db.prepare(`
      UPDATE peer_bindings
      SET runtime_target = 'replacement-owner', updated_at = ?
      WHERE peer = ?
    `).run(Math.floor(Date.now() / 1000), externalId);
    if (Number(bindingMutation.changes || 0) !== 1) {
      fail('external replacement binding fixture was not created');
    }
  });
  producer.kill('SIGKILL');
  await waitForProcessExit(producer.pid, 'external wrapper SIGKILL');
  await sleep(2500);
  const externalChildAfterExec = inspectProcessIdentity(externalMeta.pid);
  if (externalChildAfterExec.state !== 'live' ||
      externalChildAfterExec.identity?.startToken !== externalMeta.child_identity.startToken ||
      !fs.existsSync(externalMetaFile)) {
    fail('live external child did not preserve session after wrapper death');
  }
  process.kill(externalMeta.pid, 'SIGKILL');
  await waitFor(() => !fs.existsSync(externalMetaFile), 'external aggregate cleanup', 10000);
  const replacementAfterExit = withMeshDb((db) => ({
    peer: db.prepare('SELECT pid, pid_start_token, pid_command_hash, status FROM peers WHERE id = ?').get(externalId),
    binding: db.prepare('SELECT runtime_target FROM peer_bindings WHERE peer = ?').get(externalId)
  }));
  if (replacementAfterExit.peer?.pid !== process.pid ||
      replacementAfterExit.peer?.status !== 'running' ||
      replacementAfterExit.peer?.pid_start_token !== replacementIdentity.identity.startToken ||
      replacementAfterExit.peer?.pid_command_hash !== replacementIdentity.identity.commandHash ||
      replacementAfterExit.binding?.runtime_target !== 'replacement-owner') {
    fail(`external exit poller overwrote replacement DB ownership: ${JSON.stringify(replacementAfterExit)}`);
  }

  const legacyExternalId = `evidence-external-legacy-${testId}`;
  const legacyProcess = spawn('sleep', ['30'], { stdio: 'ignore' });
  const legacyFiles = ['out', 'in', 'resize', 'meta']
    .map((suffix) => path.join(externalDir, `${legacyExternalId}.${suffix}`));
  fs.writeFileSync(legacyFiles[0], 'legacy external\n');
  fs.writeFileSync(legacyFiles[1], '');
  fs.writeFileSync(legacyFiles[2], '');
  fs.writeFileSync(legacyFiles[3], JSON.stringify({
    id: legacyExternalId,
    kind: 'shell',
    role: 'peer',
    command: 'sleep 30',
    cwd: root,
    pid: legacyProcess.pid,
    wrapper_pid: legacyProcess.pid,
    cols: 120,
    rows: 40
  }));
  await waitFor(async () => {
    const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
    return (data.sessions || []).some((session) => session.id === legacyExternalId);
  }, 'legacy external adoption', 10000);
  legacyProcess.kill('SIGKILL');
  await waitForProcessExit(legacyProcess.pid, 'legacy external process exit');
  await waitFor(async () => {
    if (fs.existsSync(legacyFiles[3])) return false;
    const data = await (await runtimeFetch('/api/sessions', {}, { root })).json();
    return !(data.sessions || []).some((session) => session.id === legacyExternalId);
  }, 'legacy external cleanup', 10000);
  const legacySessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  if (fs.existsSync(legacyFiles[3]) ||
      (legacySessions.sessions || []).some((session) => session.id === legacyExternalId)) {
    fail('legacy external metadata with a confirmed-missing process was not cleaned');
  }
  for (const file of legacyFiles) fs.rmSync(file, { force: true });
}

function cliOnlyClockSafetyWorkflow() {
  log('CLI-only clock safety: live renew, unknown grace, dead cleanup, read-only observers');
  const clockRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-clock-root-${testId}-`));
  const clockHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-clock-home-${testId}-`));
  const clockEnv = { ...env, HOME: clockHome };
  for (const key of Object.keys(clockEnv)) {
    if (key.startsWith('HCC_')) delete clockEnv[key];
  }
  const clockDbPath = path.join(clockRoot, '.hello-cc', 'mesh.db');
  const clockHcc = (args) => run(process.execPath, [hccBin, '--root', clockRoot, ...args], { env: clockEnv });
  const clockHccMaybe = (args) => runMaybe(process.execPath, [hccBin, '--root', clockRoot, ...args], { env: clockEnv });
  const withClockDb = (fn) => {
    const db = new DatabaseSync(clockDbPath, { timeout: 5000 });
    try { return fn(db); } finally { db.close(); }
  };
  const rewind = (resource, ownerMode) => withClockDb((db) => {
    const t = Math.floor(Date.now() / 1000);
    db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(t - 86400));
    db.prepare('UPDATE locks SET created_at = ?, expires_at = ? WHERE resource = ?')
      .run(t - 86400, t - 60, resource);
    db.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(t - 86400, `${ownerMode}-owner`);
    if (ownerMode === 'unknown') {
      db.prepare(`
        UPDATE peers SET pid_start_token = NULL, pid_command_hash = NULL
        WHERE id = 'unknown-owner'
      `).run();
    } else if (ownerMode === 'dead') {
      db.prepare("UPDATE peers SET pid = 2147483647 WHERE id = 'dead-owner'").run();
    }
    return t;
  });

  try {
    fs.mkdirSync(clockRoot, { recursive: true });
    clockHcc(['init', '--no-guidance']);
    if (fs.existsSync(path.join(clockRoot, '.hello-cc', 'runtime.json')) ||
        fs.existsSync(path.join(clockHome, '.hello-cc', 'runtime.json'))) {
      fail('CLI-only clock fixture unexpectedly has a local or global runtime pointer');
    }

    clockHcc(['register', '--peer', 'live-owner', '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
    clockHcc(['lock', 'acquire', '--peer', 'live-owner', '--resource', 'src/clock-live', '--ttl', '90']);
    const liveNow = rewind('src/clock-live', 'live');
    const liveAttempt = clockHccMaybe(['--json', 'lock', 'acquire', '--peer', 'live-taker', '--resource', 'src/clock-live', '--ttl', '90']);
    if (liveAttempt.status === 0 || !String(liveAttempt.stderr || liveAttempt.stdout).includes('LOCK_HELD')) {
      fail(`live owner was not protected after a CLI-only clock gap:\n${liveAttempt.stderr}`);
    }
    const liveState = withClockDb((db) => ({
      lock: db.prepare('SELECT owner, expires_at, ttl_sec FROM locks WHERE resource = ?').get('src/clock-live'),
      grace: db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get() || null
    }));
    if (liveState.lock?.owner !== 'live-owner' || liveState.lock.ttl_sec !== 90 ||
        liveState.lock.expires_at < liveNow + 90 || liveState.grace !== null) {
      fail(`verified-live CLI-only owner was not renewed without blanket grace:\n${JSON.stringify(liveState, null, 2)}`);
    }

    clockHcc(['register', '--peer', 'unknown-owner', '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
    clockHcc(['lock', 'acquire', '--peer', 'unknown-owner', '--resource', 'src/clock-unknown', '--ttl', '90']);
    const unknownNow = rewind('src/clock-unknown', 'unknown');
    const unknownAttempt = clockHccMaybe(['--json', 'lock', 'acquire', '--peer', 'unknown-taker', '--resource', 'src/clock-unknown', '--ttl', '90']);
    if (unknownAttempt.status === 0 || !String(unknownAttempt.stderr || unknownAttempt.stdout).includes('LOCK_HELD')) {
      fail(`unknown owner was not protected by clock grace:\n${unknownAttempt.stdout}\n${unknownAttempt.stderr}`);
    }
    const unknownState = withClockDb((db) => ({
      owner: db.prepare('SELECT owner FROM locks WHERE resource = ?').get('src/clock-unknown')?.owner,
      grace: Number(db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get()?.value || 0)
    }));
    if (unknownState.owner !== 'unknown-owner' || unknownState.grace < unknownNow + 120) {
      fail(`unknown owner grace was not persisted for 120 seconds:\n${JSON.stringify(unknownState, null, 2)}`);
    }

    clockHcc(['register', '--peer', 'dead-owner', '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
    clockHcc(['lock', 'acquire', '--peer', 'dead-owner', '--resource', 'src/clock-dead', '--ttl', '90']);
    rewind('src/clock-dead', 'dead');
    const deadAttempt = clockHccMaybe(['lock', 'acquire', '--peer', 'dead-taker', '--resource', 'src/clock-dead', '--ttl', '90']);
    if (deadAttempt.status !== 0) {
      fail(`verified-dead owner was delayed after a CLI-only clock gap:\n${deadAttempt.stdout}\n${deadAttempt.stderr}`);
    }
    const deadState = withClockDb((db) => ({
      owner: db.prepare('SELECT owner FROM locks WHERE resource = ?').get('src/clock-dead')?.owner,
      grace: db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get() || null,
      watermark: db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get()?.value
    }));
    if (deadState.owner !== 'dead-taker' || deadState.grace !== null) {
      fail(`verified-dead evidence entered grace or retained ownership:\n${JSON.stringify(deadState, null, 2)}`);
    }

    clockHcc(['register', '--peer', 'unavailable-owner', '--kind', 'shell', '--pid', String(process.pid), '--status', 'working']);
    clockHcc(['lock', 'acquire', '--peer', 'unavailable-owner', '--resource', 'src/clock-unavailable', '--ttl', '90']);
    const unavailableNow = Math.floor(Date.now() / 1000);
    withClockDb((db) => {
      db.prepare(`
        UPDATE peers
        SET last_seen_at = ?, pid_start_token = NULL, pid_command_hash = NULL
        WHERE id = 'unavailable-owner'
      `).run(unavailableNow - 86400);
      db.prepare('UPDATE locks SET created_at = ?, expires_at = ? WHERE resource = ?')
        .run(unavailableNow - 86400, unavailableNow - 60, 'src/clock-unavailable');
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(unavailableNow - 86400));
      db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
      db.exec(`
        CREATE TRIGGER force_clock_grace_write_failure
        BEFORE INSERT ON meta
        WHEN NEW.key = 'clock_grace_until'
        BEGIN
          SELECT RAISE(ABORT, 'forced clock grace storage failure');
        END;
      `);
    });
    const unavailableAttempt = clockHccMaybe(['--json', 'lock', 'acquire', '--peer', 'unavailable-taker', '--resource', 'src/clock-unavailable']);
    if (unavailableAttempt.status === 0 || !String(unavailableAttempt.stderr).includes('CLOCK_SAFETY_UNAVAILABLE')) {
      fail(`clock safety persistence failure did not fail closed:\n${unavailableAttempt.stdout}\n${unavailableAttempt.stderr}`);
    }
    const unavailableStderr = String(unavailableAttempt.stderr);
    const publicStart = unavailableStderr.indexOf('{');
    const publicEnd = unavailableStderr.lastIndexOf('}');
    const unavailablePublicText = publicStart >= 0 && publicEnd >= publicStart
      ? unavailableStderr.slice(publicStart, publicEnd + 1)
      : '';
    const unavailablePublicError = JSON.parse(unavailablePublicText);
    if (JSON.stringify(unavailablePublicError) !== JSON.stringify({
      ok: false,
      error: {
        code: 'CLOCK_SAFETY_UNAVAILABLE',
        message: 'Clock safety state could not be persisted; ownership was left unchanged'
      }
    }) || /corrupt|sqlite|schema|invalid persisted/i.test(unavailablePublicText)) {
      fail(`clock safety public error leaked internal persistence details:\n${unavailableAttempt.stderr}`);
    }
    const unavailableState = withClockDb((db) => ({
      owner: db.prepare('SELECT owner FROM locks WHERE resource = ?').get('src/clock-unavailable')?.owner,
      watermark: db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get()?.value,
      grace: db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get()?.value
    }));
    if (unavailableState.owner !== 'unavailable-owner' ||
        unavailableState.watermark !== String(unavailableNow - 86400) ||
        unavailableState.grace !== undefined) {
      fail(`clock safety failure changed ownership state:\n${JSON.stringify(unavailableState, null, 2)}`);
    }

    withClockDb((db) => db.exec('DROP TRIGGER force_clock_grace_write_failure'));
    const readOnlyWatermark = unavailableState.watermark;
    clockHcc(['status']);
    clockHcc(['lock', 'list']);
    clockHcc(['doctor']);
    const afterReadOnly = withClockDb((db) => ({
      watermark: db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get()?.value,
      grace: db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get() || null
    }));
    if (afterReadOnly.watermark !== readOnlyWatermark || afterReadOnly.grace !== null) {
      fail(`status/list/doctor mutated clock safety state:\n${JSON.stringify({ readOnlyWatermark, afterReadOnly }, null, 2)}`);
    }
  } finally {
    fs.rmSync(clockRoot, { recursive: true, force: true });
    fs.rmSync(clockHome, { recursive: true, force: true });
  }
}

function gcClockSubjectDriftWorkflow() {
  log('GC clock safety: concurrently introduced expired lock is not swept');
  const gcRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-clock-root-${testId}-`));
  const gcHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-clock-home-${testId}-`));
  const gcEnv = { ...env, HOME: gcHome };
  for (const key of Object.keys(gcEnv)) {
    if (key.startsWith('HCC_')) delete gcEnv[key];
  }
  const gcDbPath = path.join(gcRoot, '.hello-cc', 'mesh.db');
  const gcHcc = (args) => run(process.execPath, [hccBin, '--root', gcRoot, ...args], { env: gcEnv });

  try {
    gcHcc(['init', '--no-guidance']);
    const t = Math.floor(Date.now() / 1000);
    const db = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(t));
      db.exec(`
        CREATE TRIGGER inject_expired_lock_during_gc_observation
        AFTER UPDATE OF value ON meta
        WHEN NEW.key = 'clock_last_observed_at'
        BEGIN
          INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
          VALUES ('gc-concurrent-expired', 'gc-concurrent-expired', '*', 'gc-concurrent-unknown',
                  'inserted after GC subject validation', ${t - 60}, ${t - 120}, 90);
          INSERT INTO messages(sender, recipient, kind, body, created_at)
          VALUES ('gc-concurrent', 'reader', 'note', 'backdated after GC subject validation', ${t - 10000 * 86400});
        END;
      `);
    } finally {
      db.close();
    }

    gcHcc(['gc', '--older-than', '9999', '--yes']);
    const verify = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      const lock = verify.prepare(`
        SELECT owner, expires_at FROM locks WHERE resource = 'gc-concurrent-expired'
      `).get();
      const message = verify.prepare(`
        SELECT body FROM messages WHERE body = 'backdated after GC subject validation'
      `).get();
      if (lock?.owner !== 'gc-concurrent-unknown' || Number(lock.expires_at) !== t - 60) {
        fail(`GC swept an expired unknown lock introduced after subject validation:\n${JSON.stringify(lock, null, 2)}`);
      }
      if (message?.body !== 'backdated after GC subject validation') {
        fail(`GC swept a backdated history row introduced after subject validation:\n${JSON.stringify(message, null, 2)}`);
      }
    } finally {
      verify.close();
    }
  } finally {
    fs.rmSync(gcRoot, { recursive: true, force: true });
    fs.rmSync(gcHome, { recursive: true, force: true });
  }
}

function gcOutputConsistencyWorkflow() {
  log('GC output: text and JSON report the same snapshot counts');
  const gcRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-output-root-${testId}-`));
  const gcHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-output-home-${testId}-`));
  const gcEnv = { ...env, HOME: gcHome };
  for (const key of Object.keys(gcEnv)) {
    if (key.startsWith('HCC_')) delete gcEnv[key];
  }
  const gcDbPath = path.join(gcRoot, '.hello-cc', 'mesh.db');
  const gcHcc = (args) => run(process.execPath, [hccBin, '--root', gcRoot, ...args], { env: gcEnv });

  try {
    gcHcc(['init', '--no-guidance']);
    const t = Math.floor(Date.now() / 1000);
    const old = t - 10 * 86400;
    const db = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(t));
      const event = db.prepare("INSERT INTO events(type, actor, payload, created_at) VALUES ('note', 'seed', '{}', ?)");
      const task = db.prepare("INSERT INTO tasks(title, status, created_at, updated_at) VALUES ('done', 'done', ?, ?)");
      const message = db.prepare("INSERT INTO messages(sender, kind, body, created_at) VALUES ('seed', 'note', 'old', ?)");
      const handoff = db.prepare("INSERT INTO handoffs(from_peer, summary, created_at) VALUES ('seed', 'old', ?)");
      db.exec('BEGIN');
      for (let index = 0; index < 17; index += 1) {
        event.run(old);
        task.run(old, old);
        message.run(old);
        handoff.run(old);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    const text = gcHcc(['gc', '--older-than', '1', '--history']);
    const json = JSON.parse(gcHcc(['--json', 'gc', '--older-than', '1', '--history'])).data;
    for (const [key, label] of [
      ['old_events', 'old events'],
      ['old_tasks', 'old tasks'],
      ['old_messages', 'old messages'],
      ['old_handoffs', 'old handoffs'],
      ['deferred_history', 'history rows deferred']
    ]) {
      const match = text.match(new RegExp(`^\\s*${label}:\\s*(\\d+)`, 'm'));
      const textCount = match ? Number(match[1]) : 0;
      if (textCount !== json[key]) {
        fail(`gc text/json count mismatch for ${key}: text=${textCount}, json=${json[key]}\n${text}`);
      }
    }
    for (const key of ['old_events', 'old_tasks', 'old_messages', 'old_handoffs']) {
      if (json[key] !== 17) fail(`gc output fixture count wrong for ${key}: ${json[key]}`);
    }
    if (json.deferred_history !== 0) fail(`gc output fixture unexpectedly deferred ${json.deferred_history} rows`);
  } finally {
    fs.rmSync(gcRoot, { recursive: true, force: true });
    fs.rmSync(gcHome, { recursive: true, force: true });
  }
}

function manualGcRetentionContractWorkflow() {
  log('manual GC: explicit history retention and clock-safe age cleanup');
  const gcRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-contract-root-${testId}-`));
  const gcHome = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-gc-contract-home-${testId}-`));
  const gcEnv = { ...env, HOME: gcHome };
  for (const key of Object.keys(gcEnv)) {
    if (key.startsWith('HCC_')) delete gcEnv[key];
  }
  const gcDbPath = path.join(gcRoot, '.hello-cc', 'mesh.db');
  const gcHcc = (args) => run(process.execPath, [hccBin, '--root', gcRoot, ...args], { env: gcEnv });
  const gcHccMaybe = (args) => runMaybe(process.execPath, [hccBin, '--root', gcRoot, ...args], { env: gcEnv });
  const readJson = (args) => JSON.parse(gcHcc(['--json', ...args])).data;
  const treeSnapshot = (directory) => {
    const entries = [];
    const visit = (current, relative = '') => {
      for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(current, item.name);
        const name = relative ? path.join(relative, item.name) : item.name;
        if (item.isDirectory()) {
          entries.push([name, 'directory']);
          visit(absolute, name);
        } else if (item.isSymbolicLink()) {
          entries.push([name, 'symlink', fs.readlinkSync(absolute)]);
        } else {
          entries.push([name, 'file', crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
        }
      }
    };
    visit(directory);
    return entries;
  };
  const rowExists = (db, table, id) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

  try {
    gcHcc(['init', '--no-guidance']);
    const t = Math.floor(Date.now() / 1000);
    const old = t - 10 * 86400;
    const bufsDir = path.join(gcRoot, '.hello-cc', 'bufs');
    const ordinaryBuffer = path.join(bufsDir, 'ordinary-orphan.out');
    fs.mkdirSync(bufsDir, { recursive: true });
    fs.writeFileSync(ordinaryBuffer, 'ordinary orphan');
    fs.utimesSync(ordinaryBuffer, new Date((old - 60) * 1000), new Date((old - 60) * 1000));

    const seeded = {};
    const db = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(t));
      db.prepare(`
        INSERT INTO peers(id, kind, role, worktree, branch, status, capabilities, created_at, last_seen_at)
        VALUES ('gc-contract-dead', 'shell', 'peer', ?, '', 'exited', '', ?, ?)
      `).run(gcRoot, old, old);
      db.prepare(`
        INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
        VALUES ('gc-contract-expired', 'gc-contract-expired', '*', 'gc-contract-dead', 'expired', ?, ?, 90)
      `).run(old, old);
      seeded.event = Number(db.prepare(
        "INSERT INTO events(type, actor, payload, created_at) VALUES ('gc.contract', 'seed', '{}', ?) RETURNING id"
      ).get(old).id);
      seeded.doneTask = Number(db.prepare(`
        INSERT INTO tasks(title, status, created_at, updated_at)
        VALUES ('gc contract done', 'done', ?, ?) RETURNING id
      `).get(old, old).id);
      seeded.openTask = Number(db.prepare(`
        INSERT INTO tasks(title, status, created_at, updated_at)
        VALUES ('gc contract open', 'running', ?, ?) RETURNING id
      `).get(old, old).id);
      seeded.message = Number(db.prepare(`
        INSERT INTO messages(sender, recipient, kind, body, created_at)
        VALUES ('seed', 'reader', 'note', 'gc contract old', ?) RETURNING id
      `).get(old).id);
      db.prepare('INSERT INTO message_reads(message_id, peer, read_at) VALUES (?, ?, ?)')
        .run(seeded.message, 'reader', old);
      seeded.handoff = Number(db.prepare(`
        INSERT INTO handoffs(task_id, from_peer, summary, created_at)
        VALUES (NULL, 'seed', 'gc contract eligible', ?) RETURNING id
      `).get(old).id);
      seeded.openHandoff = Number(db.prepare(`
        INSERT INTO handoffs(task_id, from_peer, summary, created_at)
        VALUES (?, 'seed', 'gc contract open task', ?) RETURNING id
      `).get(seeded.openTask, old).id);
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {
      db.close();
    }

    const beforeInvalid = {
      project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
      home: treeSnapshot(gcHome)
    };
    for (const forceArgs of [
      ['gc', '--older-than', '0', '--force'],
      ['gc', '--older-than', '0', '--history', '--force'],
      ['gc', '--older-than', '0', '--yes', '--force']
    ]) {
      const beforeForce = {
        project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
        home: treeSnapshot(gcHome)
      };
      const forced = gcHccMaybe(['--json', ...forceArgs]);
      const forcedOutput = `${forced.stdout || ''}\n${forced.stderr || ''}`;
      if (forced.status === 0 || !/"code"\s*:\s*"BAD_ARGS"/.test(forcedOutput)) {
        fail(`GC force alias did not fail with BAD_ARGS for ${forceArgs.join(' ')}:\n${forced.stdout}\n${forced.stderr}`);
      }
      const afterForce = {
        project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
        home: treeSnapshot(gcHome)
      };
      if (JSON.stringify(afterForce) !== JSON.stringify(beforeForce)) {
        fail(`GC force alias changed project state for ${forceArgs.join(' ')}:\n${JSON.stringify({ beforeForce, afterForce }, null, 2)}`);
      }
    }

    const invalidGcArgs = [
      ['gc', '--older-than', '0', '--yes=false'],
      ['gc', '--older-than', '0', '--yes=true'],
      ['gc', '--older-than', '0', '--yes=0'],
      ['gc', '--older-than', '0', '--yes='],
      ['gc', '--older-than', '0', '--yes=false', '--yes'],
      ['gc', '--older-than', '0', '--history=false'],
      ['gc', '--older-than', '0', '--history=true'],
      ['gc', '--older-than', '0', '--history=0'],
      ['gc', '--older-than', '0', '--history='],
      ['gc', '--older-than', '0', '--history=false', '--history'],
      ...['-1', '-0', '-0.5', '0.9', '1day', 'NaN', 'Infinity', '9007199254740992', '01']
        .map((value) => ['gc', '--older-than', value, '--yes'])
    ];
    for (const invalidArgs of invalidGcArgs) {
      const beforeCase = {
        project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
        home: treeSnapshot(gcHome)
      };
      const invalid = gcHccMaybe(['--json', ...invalidArgs]);
      const invalidOutput = `${invalid.stdout || ''}\n${invalid.stderr || ''}`;
      if (invalid.status === 0 || !/"code"\s*:\s*"BAD_ARGS"/.test(invalidOutput)) {
        fail(`invalid GC arguments did not fail with BAD_ARGS for ${invalidArgs.join(' ')}:\n${invalid.stdout}\n${invalid.stderr}`);
      }
      const afterCase = {
        project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
        home: treeSnapshot(gcHome)
      };
      if (JSON.stringify(afterCase) !== JSON.stringify(beforeCase)) {
        fail(`invalid GC arguments changed state for ${invalidArgs.join(' ')}:\n${JSON.stringify({ beforeCase, afterCase }, null, 2)}`);
      }
    }
    const afterInvalid = {
      project: treeSnapshot(path.join(gcRoot, '.hello-cc')),
      home: treeSnapshot(gcHome)
    };
    if (JSON.stringify(afterInvalid) !== JSON.stringify(beforeInvalid)) {
      fail(`invalid GC arguments changed project state:\n${JSON.stringify({ beforeInvalid, afterInvalid }, null, 2)}`);
    }

    const ordinary = readJson(['gc', '--older-than', '0', '--yes']);
    if (ordinary.old_events !== 0 || ordinary.old_tasks !== 0 ||
        ordinary.old_messages !== 0 || ordinary.old_handoffs !== 0) {
      fail(`ordinary GC applied business history without --history:\n${JSON.stringify(ordinary, null, 2)}`);
    }
    if (!ordinary.wal_checkpoint || ordinary.protected_old_events < 1 ||
        ordinary.protected_old_tasks < 1 || ordinary.protected_old_messages < 1 ||
        ordinary.protected_old_handoffs < 2) {
      fail(`ordinary GC did not report applied technical cleanup and protected history:\n${JSON.stringify(ordinary, null, 2)}`);
    }
    const afterOrdinary = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      for (const [table, id] of [
        ['events', seeded.event],
        ['tasks', seeded.doneTask],
        ['messages', seeded.message],
        ['handoffs', seeded.handoff],
        ['handoffs', seeded.openHandoff]
      ]) {
        if (!rowExists(afterOrdinary, table, id)) fail(`ordinary GC removed ${table} row ${id}`);
      }
      if (afterOrdinary.prepare("SELECT 1 FROM locks WHERE resource = 'gc-contract-expired'").get()) {
        fail('ordinary GC did not remove eligible technical lock state');
      }
    } finally {
      afterOrdinary.close();
    }
    if (fs.existsSync(ordinaryBuffer)) fail('ordinary GC did not remove eligible technical buffer state');

    const historyDryRun = readJson(['gc', '--older-than', '0', '--history']);
    for (const key of ['old_events', 'old_tasks', 'old_messages', 'old_handoffs']) {
      if (Number(historyDryRun[key] || 0) < 1) {
        fail(`history dry-run did not plan ${key}: ${JSON.stringify(historyDryRun, null, 2)}`);
      }
    }
    if (Number(historyDryRun.protected_old_handoffs || 0) < 1) {
      fail(`history dry-run did not report the open-task handoff as protected: ${JSON.stringify(historyDryRun, null, 2)}`);
    }
    const afterDryRun = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      if (!rowExists(afterDryRun, 'messages', seeded.message) ||
          !rowExists(afterDryRun, 'handoffs', seeded.handoff)) {
        fail('history dry-run changed persisted history');
      }
    } finally {
      afterDryRun.close();
    }

    const historyApplied = readJson(['gc', '--older-than', '0', '--history', '--yes']);
    for (const key of ['old_events', 'old_tasks', 'old_messages', 'old_handoffs']) {
      if (Number(historyApplied[key] || 0) < 1) {
        fail(`history apply did not remove ${key}: ${JSON.stringify(historyApplied, null, 2)}`);
      }
    }
    if (!historyApplied.wal_checkpoint) {
      fail(`history apply omitted its post-cleanup WAL checkpoint: ${JSON.stringify(historyApplied, null, 2)}`);
    }
    const afterHistory = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      for (const [table, id] of [
        ['events', seeded.event],
        ['tasks', seeded.doneTask],
        ['messages', seeded.message],
        ['handoffs', seeded.handoff]
      ]) {
        if (rowExists(afterHistory, table, id)) fail(`history GC retained eligible ${table} row ${id}`);
      }
      if (!rowExists(afterHistory, 'tasks', seeded.openTask) ||
          !rowExists(afterHistory, 'handoffs', seeded.openHandoff)) {
        fail('history GC removed an open task or its handoff');
      }
      if (afterHistory.prepare('SELECT 1 FROM message_reads WHERE message_id = ?').get(seeded.message)) {
        fail('history GC left message_reads for a deleted message');
      }
    } finally {
      afterHistory.close();
    }

    const protectedOnlyText = gcHcc(['gc', '--older-than', '0', '--history']);
    if (!/^\s*protected old handoffs:\s*[1-9]/m.test(protectedOnlyText) ||
        /^\s*nothing to clean\s*$/m.test(protectedOnlyText)) {
      fail(`history GC text did not report the open-task handoff as protected:\n${protectedOnlyText}`);
    }

    const completedDb = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      completedDb.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(old, seeded.openTask);
    } finally {
      completedDb.close();
    }
    const completedHistory = readJson(['gc', '--older-than', '0', '--history', '--yes']);
    if (Number(completedHistory.old_handoffs || 0) < 1 ||
        Number(completedHistory.protected_old_handoffs || 0) !== 0) {
      fail(`completed-task handoff did not transition from protected to deleted: ${JSON.stringify(completedHistory, null, 2)}`);
    }
    const afterCompletedHistory = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      if (rowExists(afterCompletedHistory, 'tasks', seeded.openTask) ||
          rowExists(afterCompletedHistory, 'handoffs', seeded.openHandoff)) {
        fail('history GC retained a handoff after its task became complete');
      }
    } finally {
      afterCompletedHistory.close();
    }

    const noOpApply = readJson(['gc', '--older-than', '0', '--yes']);
    if (Object.hasOwn(noOpApply, 'wal_checkpoint')) {
      fail(`GC checkpointed without applied database cleanup: ${JSON.stringify(noOpApply, null, 2)}`);
    }

    const graceBuffer = path.join(bufsDir, 'grace-orphan.out');
    fs.writeFileSync(graceBuffer, 'grace orphan');
    fs.utimesSync(graceBuffer, new Date((old - 60) * 1000), new Date((old - 60) * 1000));
    const graceIds = {};
    const graceDb = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      graceDb.prepare(`
        INSERT INTO peers(id, kind, role, worktree, branch, status, capabilities, created_at, last_seen_at)
        VALUES ('gc-contract-grace-dead', 'shell', 'peer', ?, '', 'exited', '', ?, ?)
      `).run(gcRoot, old, old);
      graceDb.prepare(`
        INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
        VALUES ('gc-contract-grace-lock', 'gc-contract-grace-lock', '*', 'gc-contract-grace-dead', 'expired', ?, ?, 90)
      `).run(old, old);
      graceIds.event = Number(graceDb.prepare(
        "INSERT INTO events(type, actor, payload, created_at) VALUES ('gc.contract.grace', 'seed', '{}', ?) RETURNING id"
      ).get(old).id);
      graceIds.task = Number(graceDb.prepare(`
        INSERT INTO tasks(title, status, created_at, updated_at)
        VALUES ('gc contract grace', 'done', ?, ?) RETURNING id
      `).get(old, old).id);
      graceIds.message = Number(graceDb.prepare(`
        INSERT INTO messages(sender, kind, body, created_at)
        VALUES ('seed', 'note', 'gc contract grace', ?) RETURNING id
      `).get(old).id);
      graceIds.handoff = Number(graceDb.prepare(`
        INSERT INTO handoffs(task_id, from_peer, summary, created_at)
        VALUES (NULL, 'seed', 'gc contract grace', ?) RETURNING id
      `).get(old).id);
      graceDb.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(t + 120));
      graceDb.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(t));
    } finally {
      graceDb.close();
    }

    const graceText = gcHcc(['gc', '--older-than', '0', '--history', '--yes']);
    for (const label of [
      'buffer files deferred',
      'stale peers deferred',
      'old events deferred',
      'old tasks deferred',
      'old messages deferred',
      'old handoffs deferred',
      'expired locks deferred by clock grace'
    ]) {
      if (!new RegExp(`^\\s*${label}:\\s*[1-9]`, 'm').test(graceText)) {
        fail(`clock-grace text output omitted ${label}:\n${graceText}`);
      }
    }

    for (const args of [
      ['gc', '--older-than', '0'],
      ['gc', '--older-than', '0', '--yes'],
      ['gc', '--older-than', '0', '--history'],
      ['gc', '--older-than', '0', '--history', '--yes']
    ]) {
      const result = readJson(args);
      if (!result.deferred_age_based || result.buf_files !== 0 || result.stale_peers !== 0 ||
          result.expired_locks !== 0 || Number(result.deferred_buf_files || 0) < 1 ||
          Number(result.deferred_stale_peers || 0) < 1 ||
          Number(result.deferred_expired_locks || 0) < 1 ||
          Number(result.deferred_old_events || 0) < 1 ||
          Number(result.deferred_old_tasks || 0) < 1 ||
          Number(result.deferred_old_messages || 0) < 1 ||
          Number(result.deferred_old_handoffs || 0) < 1 ||
          Object.hasOwn(result, 'wal_checkpoint')) {
        fail(`clock-grace GC did not defer every age category for ${args.join(' ')}:\n${JSON.stringify(result, null, 2)}`);
      }
    }
    const afterGrace = new DatabaseSync(gcDbPath, { timeout: 5000 });
    try {
      for (const [table, id] of [
        ['events', graceIds.event],
        ['tasks', graceIds.task],
        ['messages', graceIds.message],
        ['handoffs', graceIds.handoff]
      ]) {
        if (!rowExists(afterGrace, table, id)) fail(`clock-grace GC removed ${table} row ${id}`);
      }
      if (!afterGrace.prepare("SELECT 1 FROM locks WHERE resource = 'gc-contract-grace-lock'").get() ||
          !afterGrace.prepare("SELECT 1 FROM peers WHERE id = 'gc-contract-grace-dead'").get()) {
        fail('clock-grace GC removed age-based technical database state');
      }
    } finally {
      afterGrace.close();
    }
    if (!fs.existsSync(graceBuffer)) fail('clock-grace GC removed an age-based buffer file');
  } finally {
    fs.rmSync(gcRoot, { recursive: true, force: true });
    fs.rmSync(gcHome, { recursive: true, force: true });
  }
}

// Name-authoritative re-adoption + dead-peer reaper (session leak hardening).
async function sessionRecoveryWorkflow() {
  if (!tmuxAvailable()) {
    log('session recovery skipped (tmux not installed)');
    return;
  }
  log('session recovery: re-adopt orphan tmux + reap dead peer');
  if (!fs.existsSync(path.join(root, '.hello-cc', 'runtime.json'))) startRuntime();
  await waitRuntime();

  // ── Default Stop (no kill) must not strand a live managed session ──
  const readoptPeer = 'readopt-shell';
  const pane = parsePane(hcc(['peer', 'start', readoptPeer, '--kind', 'shell', '--', 'bash', '--noprofile', '--norc']));
  const sessionName = tmuxManagedSession(root, readoptPeer);
  let binding = peerBindingRow(readoptPeer);
  if (!binding || binding.runtime_target !== pane) {
    fail(`readopt peer binding not live after start:\n${JSON.stringify(binding, null, 2)}`);
  }
  const detachedTaskOutput = hcc(['task', 'create', '--from', 'human', '--to', readoptPeer, '--title', 'detached tmux evidence']);
  const detachedTaskMatch = detachedTaskOutput.match(/created task #(\d+):/);
  if (!detachedTaskMatch) fail(`cannot parse detached tmux task id: ${detachedTaskOutput}`);
  const detachedTaskId = detachedTaskMatch[1];
  hcc(['task', 'claim', '--peer', readoptPeer, '--id', detachedTaskId]);
  hcc(['peer', 'stop', readoptPeer]); // default = detach, leaves tmux alive
  // Immediately after a default stop: tmux session still alive, binding detached.
  if (runMaybe('tmux', ['has-session', '-t', sessionName]).status !== 0) {
    fail('default peer stop killed the tmux session instead of detaching');
  }
  binding = peerBindingRow(readoptPeer);
  if (!binding || binding.runtime_target !== null) {
    fail(`default stop did not detach binding:\n${JSON.stringify(binding, null, 2)}`);
  }
  withMeshDb((db) => db.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 7200, readoptPeer));
  const detachedRow = hccJson(['task', 'list', '--all'])
    .find((row) => String(row.id) === String(detachedTaskId));
  const detachedTakeover = hccMaybe(['task', 'takeover', '--peer', 'detached-taker', '--id', detachedTaskId, '--reason', 'must reject live tmux', '--policy', 'stale', '--stale-after', '60']);
  if (detachedRow?.owner_evidence_state !== 'live' ||
      detachedRow?.owner_evidence_reason !== 'process_identity_match' ||
      detachedTakeover.status === 0) {
    fail(`live detached tmux pane did not block takeover: ${JSON.stringify(detachedRow)}\n${detachedTakeover.stdout}\n${detachedTakeover.stderr}`);
  }
  // Within a few poll cycles the name-sweep must re-adopt the still-live session.
  await waitFor(() => {
    const row = peerBindingRow(readoptPeer);
    return Boolean(row && row.runtime_target === pane);
  }, 'orphan managed tmux session re-adoption', 20000);
  const restoredStatus = withMeshDb((db) => db.prepare('SELECT status FROM peers WHERE id = ?').get(readoptPeer)?.status);
  if (restoredStatus !== 'running') fail(`re-adopted peer not marked running (status=${restoredStatus})`);
  // Re-enterability: the runtime now exposes the session again.
  const sessions = await (await runtimeFetch('/api/sessions', {}, { root })).json();
  if (!(sessions.sessions || []).some((s) => s.id === readoptPeer && s.status === 'running')) {
    fail(`re-adopted session not exposed by /api/sessions:\n${JSON.stringify(sessions, null, 2)}`);
  }
  hcc(['task', 'takeover', '--peer', 'human', '--id', detachedTaskId, '--reason', 'detached evidence cleanup', '--force']);
  hcc(['task', 'update', '--peer', 'human', '--id', detachedTaskId, '--status', 'abandoned', '--summary', 'detached evidence cleanup']);
  // Destroying the live session is the real teardown path (CLI peer stop has
  // no kill flag; the web API's kill_tmux is the equivalent). Kill it directly
  // so it does not leak into the final tmux-session leak assertion.
  runMaybe('tmux', ['kill-session', '-t', sessionName]);
  if (runMaybe('tmux', ['has-session', '-t', sessionName]).status === 0) {
    fail('failed to tear down re-adopted managed tmux session');
  }
  withMeshDb((db) => {
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(readoptPeer);
    db.prepare('DELETE FROM peers WHERE id = ?').run(readoptPeer);
  });

  // ── A peer whose process is gone must be reaped, not stuck at 'running' ──
  const reaped = spawnSync('sleep', ['10'], { stdio: 'ignore' });
  // spawnSync of sleep returns after exit; its pid is guaranteed dead now.
  const deadPid = reaped.pid;
  withMeshDb((db) => {
    const t = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO peers(
        id, kind, role, worktree, branch, pid, pid_start_token,
        pid_command_hash, status, capabilities, created_at, last_seen_at
      )
      VALUES (?, 'shell', 'peer', ?, '', ?, 'dead:identity', ?, 'running', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        pid_start_token = excluded.pid_start_token,
        pid_command_hash = excluded.pid_command_hash,
        status = 'running',
        last_seen_at = excluded.last_seen_at
    `).run('reap-dead', root, deadPid, 'd'.repeat(64), t, t);
    db.prepare(`
      INSERT INTO peer_bindings(peer, provider, resume_mode, transport, runtime_session_id, runtime_target, created_at, updated_at)
      VALUES (?, 'shell', 'attached', 'tmux', ?, 'DEADPANE', ?, ?)
      ON CONFLICT(peer) DO UPDATE SET runtime_target = 'DEADPANE', updated_at = excluded.updated_at
    `).run('reap-dead', 'reap-dead', t, t);
  });
  await waitFor(() => {
    const row = withMeshDb((db) => db.prepare('SELECT status FROM peers WHERE id = ?').get('reap-dead') || {});
    return row.status === 'exited';
  }, 'dead peer reaped to exited', 20000);
  const reapedBinding = peerBindingRow('reap-dead');
  if (!reapedBinding || reapedBinding.runtime_target !== null) {
    fail(`reaper did not clear dead peer runtime_target:\n${JSON.stringify(reapedBinding, null, 2)}`);
  }
  if (!eventPayloads('peer.reaped').some((e) => e.payload?.peer === 'reap-dead')) {
    fail('reaper did not emit peer.reaped event');
  }
  // Cleanup the synthetic peer row so later assertions are unaffected.
  withMeshDb((db) => {
    db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run('reap-dead');
    db.prepare('DELETE FROM peers WHERE id = ?').run('reap-dead');
  });
}

function doctorReadOnlyWorkflow() {
  log('doctor read-only behavior');
  const doctorRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-doctor-${testId}-`));
  const futureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-doctor-future-${testId}-`));
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-doctor-missing-${testId}-`));
  try {
    const stateDir = path.join(doctorRoot, '.hello-cc');
    const dbPath = path.join(stateDir, 'mesh.db');
    fs.mkdirSync(stateDir, { recursive: true });
    const legacyDb = new DatabaseSync(dbPath);
    try {
      legacyDb.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES ('schema_version', '1');
        PRAGMA user_version = 1;
      `);
    } finally {
      legacyDb.close();
    }

    const doctor = runMaybe(process.execPath, [hccBin, '--root', doctorRoot, '--json', 'doctor'], { env });
    if (doctor.status !== 0) {
      fail(`doctor rejected a readable legacy database:\n${doctor.stdout}\n${doctor.stderr}`);
    }
    const payload = JSON.parse(doctor.stdout);
    if (!payload.ok || payload.data?.schema_version !== 1 || payload.data?.user_version !== 1) {
      fail(`doctor changed or misreported the legacy schema version:\n${doctor.stdout}`);
    }

    const inspectedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = inspectedDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => row.name);
      const userVersion = inspectedDb.prepare('PRAGMA user_version').get().user_version;
      if (tables.length !== 1 || tables[0] !== 'meta' || userVersion !== 1) {
        fail(`doctor migrated or initialized the database: ${JSON.stringify({ tables, userVersion })}`);
      }
    } finally {
      inspectedDb.close();
    }

    const futureStateDir = path.join(futureRoot, '.hello-cc');
    const futureDbPath = path.join(futureStateDir, 'mesh.db');
    fs.mkdirSync(futureStateDir, { recursive: true });
    const futureDb = new DatabaseSync(futureDbPath);
    try {
      futureDb.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES ('schema_version', '999');
        PRAGMA user_version = 999;
      `);
    } finally {
      futureDb.close();
    }
    const futureDoctor = runMaybe(process.execPath, [hccBin, '--root', futureRoot, '--json', 'doctor'], { env });
    if (futureDoctor.status === 0) {
      fail(`doctor accepted a schema newer than this hcc:\n${futureDoctor.stdout}\n${futureDoctor.stderr}`);
    }
    let futurePayload;
    try {
      futurePayload = JSON.parse(futureDoctor.stdout);
    } catch {
      fail(`doctor did not return JSON diagnostics for a newer schema:\n${futureDoctor.stdout}\n${futureDoctor.stderr}`);
    }
    if (!futurePayload.ok ||
        futurePayload.data?.schema_version !== 999 ||
        futurePayload.data?.supported_schema_version !== 7 ||
        futurePayload.data?.schema_compatible !== false ||
        futurePayload.data?.migration_required !== false) {
      fail(`doctor misreported newer-schema compatibility:\n${futureDoctor.stdout}`);
    }
    const futureInspected = new DatabaseSync(futureDbPath, { readOnly: true });
    try {
      const schemaVersion = futureInspected.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
      const userVersion = futureInspected.prepare('PRAGMA user_version').get().user_version;
      if (schemaVersion !== '999' || userVersion !== 999) {
        fail(`doctor mutated the newer database: ${JSON.stringify({ schemaVersion, userVersion })}`);
      }
    } finally {
      futureInspected.close();
    }

    const missing = runMaybe(process.execPath, [hccBin, '--root', missingRoot, '--json', 'doctor'], { env });
    if (missing.status === 0) {
      fail(`doctor created a missing database instead of failing:\n${missing.stdout}`);
    }
    if (fs.existsSync(path.join(missingRoot, '.hello-cc'))) {
      fail('doctor created project state while checking a missing database');
    }
  } finally {
    fs.rmSync(doctorRoot, { recursive: true, force: true });
    fs.rmSync(futureRoot, { recursive: true, force: true });
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }
}

// `hcc gc` must cover messages/handoffs/expired locks (not just events/tasks).
function gcCoverageWorkflow() {
  log('gc coverage: messages + handoffs + expired locks + dead-only peers');
  const t = Math.floor(Date.now() / 1000);
  const liveLockResource = 'gc-live-lock';
  const unknownPeer = 'gc-legacy-unknown';
  const deadPeer = 'gc-confirmed-dead';
  // Track the exact message row we insert. Assert per-row afterwards: a late
  // async message write from an earlier workflow (e.g. broadcast) can land with
  // a created_at that gc's second-resolution cutoff excludes, so whole-table
  // counts would be flaky; our row's deletion is the deterministic signal.
  let gcMessageId = 0;
  withMeshDb((db) => {
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
      VALUES ('gc-peer', 'shell', 'peer', ?, '', NULL, 'exited', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'exited', last_seen_at = excluded.last_seen_at
    `).run(root, t, t);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, pid_start_token, pid_command_hash, status, capabilities, created_at, last_seen_at)
      VALUES (?, 'shell', 'peer', ?, '', NULL, NULL, NULL, 'working', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = NULL, pid_start_token = NULL, pid_command_hash = NULL,
        status = 'working', last_seen_at = excluded.last_seen_at
    `).run(unknownPeer, root, t - 10, t - 10);
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, pid, pid_start_token, pid_command_hash, status, capabilities, created_at, last_seen_at)
      VALUES (?, 'shell', 'peer', ?, '', NULL, NULL, NULL, 'exited', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'exited', last_seen_at = excluded.last_seen_at
    `).run(deadPeer, root, t - 100000, t - 100000);
    db.prepare(`
      INSERT INTO messages(sender, recipient, kind, body, thread_id, created_at)
      VALUES ('gc-peer', 'gc-peer', 'note', 'stale', NULL, ?)
    `).run(t - 100000);
    gcMessageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare('INSERT INTO message_reads(message_id, peer, read_at) VALUES (?, ?, ?)').run(gcMessageId, 'gc-peer', t);
    db.prepare(`
      INSERT INTO handoffs(task_id, from_peer, to_peer, summary, created_at)
      VALUES (NULL, 'gc-peer', NULL, 'stale handoff', ?)
    `).run(t - 100000);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at)
      VALUES (?, ?, '*', 'gc-peer', 'expired', ?, ?)
    `).run('gc-expired-lock', 'gc-expired-lock', t - 60, t - 100000);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at)
      VALUES (?, ?, '*', 'gc-peer', 'live', ?, ?)
    `).run(liveLockResource, liveLockResource, t + 3600, t);
    // This fixture exercises ordinary retention, not an earlier workflow's
    // unknown-evidence grace window. Establish a current observation baseline.
    db.prepare("DELETE FROM meta WHERE key = 'clock_grace_until'").run();
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(t));
  });

  const out = hcc(['gc', '--older-than', '0', '--history', '--yes']);
  if (!/old messages:\s+[1-9]/.test(out)) fail(`gc did not report deleted messages:\n${out}`);
  if (!/old handoffs:\s+[1-9]/.test(out)) fail(`gc did not report deleted handoffs:\n${out}`);
  if (!/expired locks:\s+[1-9]/.test(out)) fail(`gc did not report expired locks:\n${out}`);
  if (!/unknown peers deferred:\s+[1-9]/.test(out)) fail(`gc did not report deferred unknown peers:\n${out}`);

  withMeshDb((db) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(gcMessageId).n !== 0) fail('gc left our message behind');
    if (db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE message_id = ?').get(gcMessageId).n !== 0) fail('message_reads did not cascade-delete with our message');
    if (db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n !== 0) fail('gc left handoffs behind');
    if (db.prepare('SELECT COUNT(*) AS n FROM locks WHERE expires_at < ?').get(t).n !== 0) fail('gc left expired locks behind');
    const live = db.prepare('SELECT resource FROM locks WHERE resource = ?').get(liveLockResource);
    if (!live) fail('gc deleted a not-yet-expired lock');
    if (!db.prepare('SELECT id FROM peers WHERE id = ?').get(unknownPeer)) fail('gc deleted an unknown peer inside the 120-second evidence grace');
    if (db.prepare('SELECT id FROM peers WHERE id = ?').get(deadPeer)) fail('gc retained a confirmed-dead peer');
    // Cleanup
    db.prepare('DELETE FROM locks WHERE resource = ?').run(liveLockResource);
    db.prepare('DELETE FROM peers WHERE id = ?').run('gc-peer');
    db.prepare('DELETE FROM peers WHERE id = ?').run(unknownPeer);
  });
}

async function main() {
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  await setupRegression();
  await webSecretRedactionWorkflow();
  await cookieSessionExpiryWorkflow();
  log('[2/13] runtime');
  startRuntime();
  await waitRuntime();
  hcc(['peer', 'list']);
  await dbWorkflow();
  cliOnlyClockSafetyWorkflow();
  gcClockSubjectDriftWorkflow();
  manualGcRetentionContractWorkflow();
  gcOutputConsistencyWorkflow();
  await processEvidenceWorkflow();
  await multiProjectWebWorkflow();
  await bufferGcArbitrationWorkflow();
  await tmuxBackedStartWorkflow();
  await shimTmuxWorkflow();
  await tmuxWorkflow();
  await sessionRecoveryWorkflow();
  await askBroadcastWorkflow();
  await downGcPackWorkflow();
  gcCoverageWorkflow();
  oldNameScan();
  identityEnforcementWorkflow();
  doctorReadOnlyWorkflow();
  await syntaxAndHelp();
  uninstallWorkflow();
  assertNoRealProjectRegistryLeak();
  cleanup();
  assertNoRegressionTmuxSessionLeak();
  log('FULL_REGRESSION_OK');
}

main().catch((err) => {
  try { assertNoRealProjectRegistryLeak(); } catch (leakErr) {
    process.stderr.write(`${leakErr.stack || leakErr.message}\n`);
  }
  cleanup();
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
}).finally(() => {
  try {
    assertNoRealProjectRegistryLeak();
  } finally {
    cleanup();
  }
});
