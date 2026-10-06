// Web project context management, extracted from lib/web/runtime-main.mjs.
// Owns the projectContexts map: normalization, registry-backed discovery,
// fail-closed path re-resolution, per-project DB connections, and
// session/peer lookup helpers used by the HTTP and WS layers.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';
import { CliError } from '../shared/errors.mjs';
import { contextForProject, projectDbPath } from '../runtime/paths.mjs';
import { prevalidateProjectDatabaseLocation, resolveProjectDatabase } from '../runtime/project-path.mjs';
import { provisionPrivateProjectGeneration } from '../runtime/private-state.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdIdentity, sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import {
  projectRecord,
  readProjectRegistry,
  registerProject,
  registerProjectActivity
} from '../runtime/projects.mjs';
import { nextSessionId } from '../web/runtime.mjs';
import { tokenMatches } from '../web/http.mjs';

export function createProjectContexts(deps) {
  const {
    ctx, sessions,
    sessionKey, sessionsForProject, resolveSessionPeerId,
    connect, now, addEvent, tx, touchPeer, upsertPeer, detectBranch,
    ACTIVE_PEER_TTL, CLI_NAME, DEFAULT_LOCK_TTL,
    queryInbox, queryOpenTasks, queryTimelineMessages,
    observePeerEvidence, peerEvidenceFromDb,
    observeClockSafetyInTransaction,
    assertTaskOwnerForMutation, claimNextTasksForPeer, takeOverTaskForPeer,
    positiveIntOpt, sameResolvedPath, assertSessionControl
  } = deps;

  const projectContexts = new Map();
  const retiredProjectContexts = new Set();
  const MAX_IDLE_PROJECT_DESCRIPTORS = 32;

  function changedProject() {
    return new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed; select its current location again');
  }

  // This is a comparison value, not an authority token: it contains only the
  // canonical path and stat identity already used by CLI-carried requests.
  function selectedProjectIdentity(projectCtx) {
    projectCtx.rootIdentity?.assertUnchanged();
    const { canonical, identity } = projectCtx.rootIdentity || {};
    if (!canonical || !identity) throw changedProject();
    return Buffer.from(JSON.stringify({ canonical, identity })).toString('base64url');
  }

  function sessionBelongsToProject(session, projectCtx) {
    if (session?.ctx?.dbPath && projectCtx?.dbPath &&
        path.resolve(session.ctx.dbPath) !== path.resolve(projectCtx.dbPath)) return false;
    const owner = session?.ctx?.rootIdentity || session?.rootIdentity;
    const requested = projectCtx?.rootIdentity;
    // New managed sessions must never be found through another inode merely
    // because their old root pathname now resolves to the requested project.
    if (owner || requested) return Boolean(owner && requested && sameSelectedCwdIdentity(owner, requested));
    return true; // Pre-existing contexts retain their legacy lookup behavior.
  }

  function hasLiveManagedSession(binding) {
    for (const session of sessions.values()) {
      if (['exited', 'closed'].includes(session.status)) continue;
      const owner = session.ctx?.rootIdentity || session.rootIdentity;
      if (sameSelectedCwdIdentity(owner, binding)) return true;
    }
    return false;
  }

  function dropIdleProjectContextDescriptors(except = null, maxIdle = MAX_IDLE_PROJECT_DESCRIPTORS) {
    let retainedIdle = 0;
    // Map insertion order is selection recency. Keep a small hot cache plus
    // descriptors held by live managed sessions; registry-only and older idle
    // projects retain immutable stat identities without consuming an FD.
    for (const project of [...projectContexts.values()].reverse()) {
      const binding = project.rootIdentity;
      if (!binding || binding.mode !== 'descriptor' || binding === except || hasLiveManagedSession(binding)) continue;
      retainedIdle += 1;
      if (retainedIdle > maxIdle) binding.dropDescriptor();
    }
    for (const project of retiredProjectContexts) {
      if (hasLiveManagedSession(project.rootIdentity)) continue;
      project.rootIdentity?.release();
      retiredProjectContexts.delete(project);
    }
  }

  function retainProjectContextDescriptor(projectCtx) {
    const previous = projectCtx.rootIdentity;
    if (!previous) throw changedProject();
    previous.assertUnchanged();
    if (previous.mode === 'descriptor') return previous;
    const refreshed = captureSelectedCwdIdentity(previous.canonical);
    try {
      refreshed.assertUnchanged();
      previous.assertUnchanged();
      if (!sameSelectedCwdIdentity(previous, refreshed)) throw changedProject();
      if (refreshed.mode !== 'descriptor' || hasLiveManagedSession(previous)) {
        refreshed.release();
        return previous;
      }
      projectCtx.rootIdentity = refreshed;
      previous.release();
      return refreshed;
    } catch (error) {
      refreshed.release();
      throw error;
    }
  }

  function newSessionActionToken() {
    return randomBytes(32).toString('base64url');
  }

  function rememberProject(projectCtx, { activity = false, register = false, nonblocking = false } = {}) {
    const incoming = projectCtx.rootIdentity || captureSelectedCwdIdentity(projectCtx.root);
    let retained = incoming;
    try {
      incoming.assertUnchanged();
      const normalized = contextForProject(projectCtx.root, projectCtx.dbPath, { cwd: projectCtx.cwd, json: ctx.json });
      if (normalized.root !== incoming.canonical) throw changedProject();
      const existing = projectContexts.get(normalized.root);
      let reusableContext = false;
      if (existing?.rootIdentity && sameSelectedCwdIdentity(existing.rootIdentity, incoming)) {
        try {
          existing.rootIdentity.assertUnchanged();
          reusableContext = existing.dbPath === normalized.dbPath;
          // A dormant stat-only record is upgraded from this request's fresh
          // descriptor. Live sessions keep their original binding until exit.
          if (existing.rootIdentity.mode === 'descriptor' || incoming.mode === 'stat-only' ||
              hasLiveManagedSession(existing.rootIdentity)) retained = existing.rootIdentity;
        } catch { /* A released or stale binding is never reused. */ }
      }
      normalized.rootIdentity = retained;
      const isNew = !existing;
      // Activity refresh is already nonblocking and throttled before it tries
      // the registry lock. Reusing the existing binding avoids one open FD per
      // browser request while keeping the initial inode attached to sessions.
      if (activity) registerProjectActivity(normalized);
      else if (isNew || register) {
        try {
          registerProject(normalized, { nonblocking });
        } catch (error) {
          if (nonblocking && ['ERR_FILE_LOCK_BUSY', 'ERR_FILE_LOCK_TIMEOUT'].includes(error?.code)) {
            throw new CliError('REGISTRY_BUSY', 'Project registry is busy; retry the request');
          }
          throw error;
        }
      }
      retained.assertUnchanged();
      if (retained !== incoming) incoming.release();
      const previous = existing?.rootIdentity;
      if (reusableContext) {
        // Background scanners retain this object. Refresh its idle binding in
        // place only while both the selected directory and database match.
        existing.rootIdentity = retained;
        projectContexts.delete(normalized.root);
        projectContexts.set(normalized.root, existing);
        if (previous !== retained) previous.release();
        dropIdleProjectContextDescriptors(retained);
        return existing;
      }
      if (previous && previous !== retained) {
        if (hasLiveManagedSession(previous)) retiredProjectContexts.add(existing);
        else previous.release();
      }
      projectContexts.set(normalized.root, normalized);
      dropIdleProjectContextDescriptors(retained);
      return normalized;
    } catch (error) {
      if (retained !== incoming || ![...projectContexts.values()].some(value => value.rootIdentity === incoming)) {
        incoming.release();
      }
      throw error;
    }
  }

  function knownProjects() {
    const rows = readProjectRegistry();
    if (!rows.some((p) => sameResolvedPath(p.root, ctx.root))) rows.unshift(projectRecord(ctx));
    for (const project of rows) {
      if (!projectContexts.has(project.root)) {
        const normalized = contextForProject(project.root, project.db, { json: ctx.json });
        try {
          normalized.rootIdentity = captureSelectedCwdIdentity(normalized.root);
          normalized.rootIdentity.dropDescriptor();
        }
        catch { /* An unavailable registered project remains discoverable, not active. */ }
        projectContexts.set(project.root, normalized);
      }
    }
    return rows;
  }

  function resolveWebProjectContext(root, db, { explicitSelection = false } = {}) {
    const selected = captureSelectedCwdIdentity(root);
    let binding = selected;
    try {
      // Freeze the canonical target, not an alias that may later be retargeted
      // while the originally selected directory remains available at its own
      // pathname. The alias must still be unchanged throughout selection.
      if (selected.requested !== selected.canonical) binding = captureSelectedCwdIdentity(selected.canonical);
      selected.assertUnchanged();
      if (db) {
        prevalidateProjectDatabaseLocation({ root: selected.requested, db });
        selected.assertUnchanged();
        binding.assertUnchanged();
      }
      if (explicitSelection) {
        provisionPrivateProjectGeneration(binding.canonical, { expectedIdentity: binding });
        selected.assertUnchanged();
        binding.assertUnchanged();
      }
      // Preserve explicit legacy DB spellings under a selected alias while
      // resolving state against the captured canonical directory only.
      const selectedLegacy = path.join(selected.requested, '.hello-cc');
      const relativeDb = db ? path.relative(selectedLegacy, path.resolve(String(db))) : null;
      const underSelectedLegacy = relativeDb !== null && relativeDb !== '..' &&
        !relativeDb.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDb);
      const stableDb = underSelectedLegacy
        ? path.join(binding.canonical, '.hello-cc', relativeDb)
        : db || projectDbPath(binding.canonical);
      const first = resolveProjectDatabase({ root: binding.canonical, db: stableDb, createStateDir: true });
      selected.assertUnchanged();
      binding.assertUnchanged();
      if (first.root !== binding.canonical) throw changedProject();
      const final = resolveProjectDatabase({ root: first.root, db: first.db, createStateDir: true });
      selected.assertUnchanged();
      binding.assertUnchanged();
      if (final.root !== binding.canonical) throw changedProject();
      return { ...contextForProject(final.root, final.db, { cwd: final.root, json: ctx.json }),
        rootIdentity: binding };
    } catch (error) {
      binding.release();
      throw error;
    } finally {
      if (selected !== binding) selected.release();
    }
  }

  function connectWebProject(projectCtx, options = {}) {
    const binding = projectCtx.rootIdentity;
    binding?.assertUnchanged();
    const final = resolveProjectDatabase({
      root: projectCtx.root,
      db: projectCtx.dbPath,
      createStateDir: options.create !== false
    });
    binding?.assertUnchanged();
    if (binding && final.root !== binding.canonical) throw changedProject();
    const db = connect(contextForProject(final.root, final.db, {
      cwd: final.root,
      json: projectCtx.json
    }), options);
    try { binding?.assertUnchanged(); }
    catch (error) { try { db.close(); } catch {} throw error; }
    return db;
  }

  function projectFromRequest(req, url, { requireIdentity = false } = {}) {
    const selectedRoot = url.searchParams.get('root') ||
      url.searchParams.get('project') ||
      req.headers['x-hcc-root'];
    const requestedRoot = selectedRoot || ctx.root;
    const requestedDb = url.searchParams.get('db') ||
      req.headers['x-hcc-db'] || null;
    let carried = null;
    let resolved = null;
    try {
      const headerIdentity = req.headers['x-hcc-root-identity'];
      const queryIdentity = url.searchParams.get('root_identity');
      if (headerIdentity !== undefined && queryIdentity !== null && headerIdentity !== queryIdentity) {
        throw changedProject();
      }
      const encoded = headerIdentity === undefined ? queryIdentity : headerIdentity;
      const browserRequest = req.headers['x-hcc-browser'] === '1' || url.searchParams.get('browser') === '1';
      const explicitSelection = (url.pathname === '/api/projects/select' && req.method === 'POST') ||
        (url.pathname === '/api/projects' && req.method === 'POST');
      if ((browserRequest || requireIdentity) && !explicitSelection && !encoded) throw changedProject();
      // A request that names no project falls back to the Web process's
      // startup root. Its automatic bootstrap is not an explicit selection of
      // a new inode at the same pathname after that startup root was moved.
      if (!selectedRoot && ctx.initialRootIdentity) {
        assertSelectedCwdSnapshot(ctx.initialRootIdentity);
      }
      if (encoded !== undefined && encoded !== null) {
        if (typeof encoded !== 'string' || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
          throw changedProject();
        }
        let expected;
        try { expected = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
        catch { throw changedProject(); }
        if (!expected || typeof expected.canonical !== 'string' || !path.isAbsolute(expected.canonical) ||
            !expected.identity || typeof expected.identity.dev !== 'string' ||
            typeof expected.identity.ino !== 'string' ||
            !(typeof expected.identity.birthtimeNs === 'string' || expected.identity.birthtimeNs === null)) {
          throw changedProject();
        }
        carried = captureSelectedCwdIdentity(requestedRoot, expected);
      }
      resolved = resolveWebProjectContext(requestedRoot, requestedDb, { explicitSelection });
      if (carried && !sameSelectedCwdIdentity(carried, resolved.rootIdentity)) throw changedProject();
      const remembered = rememberProject(resolved, { activity: true });
      resolved = null;
      return remembered;
    } finally {
      carried?.release();
      resolved?.rootIdentity?.release();
    }
  }

  function getSession(projectCtx, id, db = null) {
    const direct = sessions.get(sessionKey(projectCtx, id));
    if (direct && sessionBelongsToProject(direct, projectCtx)) return direct;
    for (const session of sessionsForProject(projectCtx)) {
      if (sessionBelongsToProject(session, projectCtx) && session.peerId === id) return session;
    }
    if (db) {
      for (const session of sessionsForProject(projectCtx)) {
        if (sessionBelongsToProject(session, projectCtx) && resolveSessionPeerId(db, session) === id) return session;
      }
    }
    return null;
  }

  function readActionToken(input, req) {
    const headerToken = req.headers["x-hcc-session-token"];
    return String(input.action_token || input.actionToken || headerToken || "").trim();
  }

  function resolveWebActionSession(projectCtx, peer, input, req) {
    const db = connectWebProject(projectCtx);
    let session;
    try {
      session = getSession(projectCtx, peer, db);
    } finally {
      db.close();
    }
    if (!session || session.status !== "running") {
      throw new CliError("PEER_IDENTITY_REQUIRED", "Web peer action requires a running managed session for " + peer, { peer });
    }
    const actorPeer = session.peerId || peer;
    if (actorPeer !== peer && session.id !== peer) {
      throw new CliError("PEER_IDENTITY_MISMATCH", "Web peer action target " + peer + " does not match managed session " + actorPeer, {
        peer, actor_peer: actorPeer, session_id: session.id
      });
    }
    const provided = readActionToken(input, req);
    const authorized = Boolean(provided) && [...(session.actionTokens || [])]
      .some((candidate) => {
        if (!tokenMatches(provided, candidate)) return false;
        const socket = session.actionTokenSockets?.get(candidate);
        return socket?.readyState === WebSocket.OPEN;
      });
    if (!authorized) {
      throw new CliError("PEER_IDENTITY_REQUIRED", "Web peer action for " + peer + " requires the managed session action token", { peer });
    }
    assertSessionControl?.(session, provided, input.epoch);
    projectCtx.rootIdentity?.assertUnchanged();
    session.ctx?.rootIdentity?.assertUnchanged();
    return actorPeer;
  }

  function releaseProjectContexts() {
    for (const project of projectContexts.values()) project.rootIdentity?.release();
    for (const project of retiredProjectContexts) project.rootIdentity?.release();
    projectContexts.clear();
    retiredProjectContexts.clear();
  }

  function knownPeerIds(projectCtx) {
    const db = connectWebProject(projectCtx);
    try {
      return db.prepare("SELECT id FROM peers").all().map((row) => row.id);
    } finally {
      db.close();
    }
  }

  function nextProjectSessionId(projectCtx, kind) {
    return nextSessionId([
      ...sessionsForProject(projectCtx).map((session) => session.id),
      ...knownPeerIds(projectCtx)
    ], kind);
  }

  return {
    projectContexts, releaseProjectContexts, dropIdleProjectContextDescriptors,
    retainProjectContextDescriptor,
    newSessionActionToken, rememberProject, knownProjects, selectedProjectIdentity,
    resolveWebProjectContext, connectWebProject, projectFromRequest,
    getSession, readActionToken, resolveWebActionSession,
    knownPeerIds, nextProjectSessionId
  };
}
