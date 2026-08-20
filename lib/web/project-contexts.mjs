// Web project context management, extracted from lib/web/runtime-main.mjs.
// Owns the projectContexts map: normalization, registry-backed discovery,
// fail-closed path re-resolution, per-project DB connections, and
// session/peer lookup helpers used by the HTTP and WS layers.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { CliError } from '../shared/errors.mjs';
import { contextForProject } from '../runtime/paths.mjs';
import { resolveProjectDatabase } from '../runtime/project-path.mjs';
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
    positiveIntOpt, sameResolvedPath
  } = deps;

  const projectContexts = new Map();

  function newSessionActionToken() {
    return randomBytes(32).toString('base64url');
  }

  function rememberProject(projectCtx, { activity = false, register = false, nonblocking = false } = {}) {
    const normalized = contextForProject(projectCtx.root, projectCtx.dbPath, { cwd: projectCtx.cwd, json: ctx.json });
    const isNew = !projectContexts.has(normalized.root);
    // Activity refresh is already nonblocking and throttled before it tries the
    // registry lock. Calling it on each request keeps last_seen_at current
    // without putting the synchronous lock back on the HTTP hot path.
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
    projectContexts.set(normalized.root, normalized);
    return normalized;
  }

  function knownProjects() {
    const rows = readProjectRegistry();
    if (!rows.some((p) => sameResolvedPath(p.root, ctx.root))) rows.unshift(projectRecord(ctx));
    for (const project of rows) {
      if (!projectContexts.has(project.root)) {
        projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
      }
    }
    return rows;
  }

  function resolveWebProjectContext(root, db) {
    const first = resolveProjectDatabase({ root, db, createStateDir: true });
    // Re-read every filesystem identity immediately before the returned
    // context can reach connect(). A path rebound after the first pass fails
    // closed instead of carrying a stale lexical decision into SQLite.
    const final = resolveProjectDatabase({
      root: first.root,
      db: first.db,
      createStateDir: true
    });
    return contextForProject(final.root, final.db, { cwd: final.root, json: ctx.json });
  }

  function connectWebProject(projectCtx, options = {}) {
    const final = resolveProjectDatabase({
      root: projectCtx.root,
      db: projectCtx.dbPath,
      createStateDir: options.create !== false
    });
    return connect(contextForProject(final.root, final.db, {
      cwd: final.root,
      json: projectCtx.json
    }), options);
  }

  function projectFromRequest(req, url) {
    const requestedRoot = url.searchParams.get('root') ||
      url.searchParams.get('project') ||
      req.headers['x-hcc-root'] ||
      ctx.root;
    const requestedDb = url.searchParams.get('db') ||
      req.headers['x-hcc-db'] ||
      path.join(requestedRoot, '.hello-cc', 'mesh.db');
    return rememberProject(
      resolveWebProjectContext(requestedRoot, requestedDb),
      { activity: true }
    );
  }

  function getSession(projectCtx, id, db = null) {
    const direct = sessions.get(sessionKey(projectCtx, id));
    if (direct) return direct;
    for (const session of sessionsForProject(projectCtx)) {
      if (session.peerId === id) return session;
    }
    if (db) {
      for (const session of sessionsForProject(projectCtx)) {
        if (resolveSessionPeerId(db, session) === id) return session;
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
    return actorPeer;
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
    projectContexts,
    newSessionActionToken, rememberProject, knownProjects,
    resolveWebProjectContext, connectWebProject, projectFromRequest,
    getSession, readActionToken, resolveWebActionSession,
    knownPeerIds, nextProjectSessionId
  };
}
