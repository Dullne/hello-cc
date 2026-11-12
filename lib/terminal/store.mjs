import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { createConnectionHelpers } from '../db/connection.mjs';
import { createPeerBindingStore } from '../db/stores/peers.mjs';
import { createPeerHelpers } from '../core/peers/peer-helpers.mjs';
import { tx } from '../db/schema.mjs';
import { inspectProcessIdentity, compareProcessIdentity } from '../process/identity.mjs';
import { assertSelectedCwdSnapshot } from '../process/selected-cwd-identity.mjs';
import { ensurePrivateProjectStateDir, inspectPrivateProjectAuthority } from '../runtime/private-state.mjs';
import { resolveProjectDatabase } from '../runtime/project-path.mjs';
import { captureDirectory } from '../platform/windows-filesystem.mjs';

const now = () => Math.floor(Date.now() / 1000);
const bindings = createPeerBindingStore({ now });
const { connect } = createConnectionHelpers({ now, dedupePeerBindings: bindings.dedupePeerBindings, redactedLogText: () => 'Terminal database operation failed' });
const { upsertPeer } = createPeerHelpers({ now, liveProcessIdentity: pid => {
  const observed = inspectProcessIdentity(pid); return observed.state === 'live' ? observed.identity : null;
}});
function context(project) { return { root: project.root, cwd: project.root, dbPath: project.dbPath, initialRootIdentity: project.rootIdentity }; }
const preparations = new Map();
function ownerRows(db, peerId) {
  return { peer: db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId) || null,
    binding: db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peerId) || null };
}
export function prepareTerminalCreate(input) {
  if (typeof input.peerId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.peerId)) throw new CliError('BAD_REQUEST', 'Invalid terminal peer identity');
  const lease = captureDirectory(input.project.stateDir, { pin: true });
  let db;
  try {
    db = connect(context(input.project), { migrateRegistered: false });
    const previous = ownerRows(db, input.peerId);
    if (['native', 'app-server'].includes(previous.binding?.transport)) throw new CliError('PEER_RUNTIME_CONFLICT', 'Peer belongs to a structured runtime');
    const peer = previous.peer;
    if (peer && (Number.isInteger(peer.pid) && peer.pid > 0 || !['exited', 'detached'].includes(peer.status))) {
      const observed = inspectProcessIdentity(peer.pid);
      const state = observed.state === 'live' ? compareProcessIdentity({ pid: peer.pid,
        startToken: peer.pid_start_token, commandHash: peer.pid_command_hash }, observed.identity) : observed.state;
      if (state !== 'dead') throw new CliError('PEER_RUNTIME_CONFLICT', 'Previous peer is live or its exit is unconfirmed');
    }
    const key = `${input.project.stateDir}\0${input.peerId}`;
    if (preparations.has(key)) throw new CliError('PEER_RUNTIME_CONFLICT', 'Peer launch is already in progress');
    const preparation = { previous, lease, key };
    preparations.set(key, preparation);
    return () => { if (preparations.get(key) === preparation) preparations.delete(key); lease.close(); };
  } catch (error) { lease.close(); throw error; }
  finally { db?.close(); }
}

export function validateTerminalProject(project, cwd, cwdIdentity) {
  if (typeof project?.root !== 'string' || !project.rootIdentity || !project.stateDir || !project.dbPath ||
      !path.isAbsolute(project.root) || !path.isAbsolute(cwd)) throw new CliError('BAD_REQUEST', 'Terminal requires the current project binding');
  assertSelectedCwdSnapshot(project.rootIdentity);
  assertSelectedCwdSnapshot(cwdIdentity);
  if (project.root !== project.rootIdentity.canonical || path.resolve(cwd) !== cwdIdentity.canonical) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Terminal directory does not match its captured identity');
  }
  if (!['fresh', 'migrated'].includes(inspectPrivateProjectAuthority(project.root))) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Project state is not active');
  const stateDir = ensurePrivateProjectStateDir(project.root);
  const selected = resolveProjectDatabase({ root: project.root, db: project.dbPath });
  if (stateDir !== project.stateDir || selected.stateDir !== project.stateDir || selected.db !== project.dbPath) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Terminal belongs to a different project state generation');
  }
}
export function publishTerminalCreated(session) {
  validateTerminalProject(session.project, session.cwd, session.cwdIdentity);
  const db = connect(context(session.project), { migrateRegistered: false });
  try {
    return tx(db, () => {
      const preparation = preparations.get(`${session.project.stateDir}\0${session.peerId}`);
      if (!preparation || JSON.stringify(ownerRows(db, session.peerId)) !== JSON.stringify(preparation.previous)) {
        throw new CliError('PEER_RUNTIME_CONFLICT', 'Peer ownership changed during terminal startup');
      }
      preparation.lease.assertUnchanged();
      // This identity comes from the owned process HANDLE before ResumeThread.
      // A command may finish before a later PID lookup; retain the creation
      // receipt and let the owned Job/PTY close event publish its exact exit.
      const identity = session.processIdentity;
      if (identity?.pid !== session.pid || identity.startToken !== `win32:v1:${session.creationTime}` ||
          !/^[a-f0-9]{64}$/.test(identity.commandHash || '')) {
        throw new CliError('TERMINAL_START_UNCONFIRMED', 'Terminal creation identity was not confirmed');
      }
      upsertPeer(db, { id: session.peerId, kind: session.kind, role: session.role, worktree: session.cwd,
        pid: session.pid, processIdentity: identity, status: 'running', capabilities: 'windows-terminal' });
      const canonical = bindings.upsertCanonicalPeerBinding(db, { ...session.binding, peer: session.peerId,
        provider: session.binding?.provider || session.kind, command: session.binding?.command || session.command.file,
        transport: 'windows-terminal', runtime_session_id: session.id });
      if (canonical.peer !== session.peerId) throw new CliError('PEER_RUNTIME_CONFLICT', 'Provider session belongs to a different canonical peer');
      return identity;
    });
  } finally { db.close(); }
}
export function publishTerminalExited(session) {
  validateTerminalProject(session.project, session.cwd, session.cwdIdentity);
  const db = connect(context(session.project), { migrateRegistered: false });
  try {
    db.prepare(`UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ? AND pid = ? AND pid_start_token = ? AND pid_command_hash = ? AND EXISTS
      (SELECT 1 FROM peer_bindings b WHERE b.peer = peers.id AND b.transport = 'windows-terminal' AND b.runtime_session_id = ?)`)
      .run(session.status === 'exited' ? 'exited' : 'unknown', now(), session.peerId, session.pid,
        session.processIdentity?.startToken || '', session.processIdentity?.commandHash || '', session.id);
  } finally { db.close(); }
}
