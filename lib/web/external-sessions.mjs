// External buffer-file session adoption, extracted from lib/web/runtime-main.mjs.
// Adopts hcc-run PTY bridges from .hello-cc/bufs/<id>.* files: owner-evidence
// checks under the producer lease, output polling, exit reconciliation, and
// per-project directory watchers.

import fs from 'node:fs';
import path from 'node:path';
import { withBufferDirectoryLease } from '../runtime/buffer-directory-lease.mjs';
import {
  externalBufferEvidence,
  externalBufferOwnerKey,
  externalBufferSessionIds,
  readExternalBufferMetadata
} from '../runtime/buffer-evidence.mjs';
import { inspectProcessIdentity } from '../process/identity.mjs';

export function createExternalSessions(deps) {
  const {
    ctx, sessions,
    sessionKey, broadcast,
    now, tx, connectWebProject,
    bufferDirectory, runtimeProjectContexts,
    refreshPeerIoHeartbeat, redactedLogText, BUFS_DIR_NAME
  } = deps;

  // ── Optional external buffer-file session adoption ───────────────────────
  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  fs.mkdirSync(bufsDir, { recursive: true });

  function removeExternalBufferFiles(id, directory = bufsDir) {
    for (const suffix of ['out', 'in', 'resize', 'meta']) {
      fs.rmSync(path.join(directory, `${id}.${suffix}`), { force: true });
    }
  }

  function adoptExternalSession(id, pctx = ctx, directory = bufsDir) {
    const key = sessionKey(pctx, id);
    if (sessions.has(key)) return;
    const outFile  = path.join(directory, `${id}.out`);
    const inFile   = path.join(directory, `${id}.in`);
    const resizeFile = path.join(directory, `${id}.resize`);
    const metaFile = path.join(directory, `${id}.meta`);
    let adopted = null;
    try {
      adopted = withBufferDirectoryLease(directory, () => {
        if (!fs.existsSync(outFile) || !fs.existsSync(metaFile)) return null;
        let meta;
        try { meta = readExternalBufferMetadata(metaFile); } catch { return null; }
        // The producer publishes wrapper evidence before the PTY child identity
        // is complete. Do not cache that transitional snapshot as a session;
        // the next scan adopts the final metadata instead.
        if (meta.publishing === true) return null;
        const ownerKey = externalBufferOwnerKey(meta);
        if (!ownerKey) return null;
        const evidence = externalBufferEvidence(meta, inspectProcessIdentity);
        // Re-read and remove in one producer-coordinated lease. A new producer
        // with the same id cannot publish between this decision and deletion.
        if (evidence.state === 'dead') {
          removeExternalBufferFiles(id, directory);
          return null;
        }
        return { meta, ownerKey };
      });
    } catch { return; }
    if (!adopted) return;
    const { meta, ownerKey } = adopted;
    const wrapperOwnerPid = meta.wrapper_pid || meta.wrapperPid || null;
    const wrapperOwnerIdentity = meta.wrapper_identity || meta.wrapperIdentity || null;
    const dbOwnerPid = wrapperOwnerPid || meta.pid || null;
    const dbOwnerIdentity = wrapperOwnerPid
      ? wrapperOwnerIdentity
      : meta.child_identity || meta.childIdentity || null;

    const session = {
      id,
      peerId: id,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind: meta.kind || 'external',
      role: meta.role || 'peer',
      command: meta.command || '(shim)',
      cwd: meta.cwd || pctx.root,
      pid: meta.pid || null,
      wrapperPid: meta.wrapper_pid || null,
      childIdentity: meta.child_identity || null,
      wrapperIdentity: meta.wrapper_identity || null,
      externalOwnerKey: ownerKey,
      externalDbOwner: Number.isInteger(Number(dbOwnerPid)) && dbOwnerIdentity?.startToken &&
        dbOwnerIdentity?.commandHash
        ? {
            pid: Number(dbOwnerPid),
            startToken: dbOwnerIdentity.startToken,
            commandHash: dbOwnerIdentity.commandHash
          }
        : null,
      type: 'external',
      outFile, inFile, resizeFile, metaFile,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set(),
      outputPoller: null,
      outputFd: null,
      exitPoller: null,
    };
    // Load existing output as initial snapshot
    try { session.buffer = fs.readFileSync(outFile, 'utf8'); } catch {}
    sessions.set(key, session);

    // Open a persistent fd for polling output; fstatSync is cheap.
    let outputOffset = 0;
    try {
      session.outputFd = fs.openSync(outFile, 'r');
      outputOffset = fs.fstatSync(session.outputFd).size;
    } catch {}
    session.outputPoller = setInterval(() => {
      try {
        if (session.outputFd === null) return;
        const stat = fs.fstatSync(session.outputFd);
        if (stat.size < outputOffset) outputOffset = 0;
        if (stat.size <= outputOffset) return;
        const buf = Buffer.alloc(stat.size - outputOffset);
        fs.readSync(session.outputFd, buf, 0, buf.length, outputOffset);
        outputOffset = stat.size;
        const data = buf.toString();
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        broadcast(session, { type: 'data', data });
        refreshPeerIoHeartbeat(session);
      } catch {
        // File removed or truncated — close and stop polling
        if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
      }
    }, 100);

    function finalizeExternalSession({ updateDatabase }) {
      session.status = 'exited';
      session.exitedAt = now();
      broadcast(session, { type: 'exit', event: {} });
      if (updateDatabase) {
        try {
          const exitDb = connectWebProject(session.ctx || ctx);
          try {
            const exitPeerId = session.peerId || session.id;
            if (session.externalDbOwner) {
              tx(exitDb, () => {
                const mutation = exitDb.prepare(`
                  UPDATE peers SET status = ?
                  WHERE id = ? AND pid = ? AND pid_start_token = ? AND pid_command_hash = ?
                `).run(
                  'exited',
                  exitPeerId,
                  session.externalDbOwner.pid,
                  session.externalDbOwner.startToken,
                  session.externalDbOwner.commandHash
                );
                if (Number(mutation.changes || 0) > 0) {
                  exitDb.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?')
                    .run(now(), exitPeerId);
                }
              });
            }
          } finally { exitDb.close(); }
        } catch {}
      }
      if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
      if (session.outputPoller) clearInterval(session.outputPoller);
      if (session.exitPoller) clearInterval(session.exitPoller);
      sessions.delete(key);
    }

    // Reconcile and mutate the external group under the same lease used by its
    // producer. Owner changes detach only this stale in-memory view; they never
    // mark the replacement producer exited or remove its files.
    session.exitPoller = setInterval(() => {
      try {
        withBufferDirectoryLease(directory, () => {
          const outExists = fs.existsSync(outFile);
          let currentMeta;
          try {
            currentMeta = readExternalBufferMetadata(metaFile);
          } catch {
            // A producer removes the whole group in one lease. No out and no
            // metadata is therefore a clean exit; an unreadable metadata file
            // is unknown and must not mutate DB ownership.
            if (!outExists && !fs.existsSync(metaFile)) {
              finalizeExternalSession({ updateDatabase: true });
            }
            return;
          }
          const currentOwnerKey = externalBufferOwnerKey(currentMeta);
          if (!currentOwnerKey) return;
          if (currentOwnerKey !== session.externalOwnerKey) {
            finalizeExternalSession({ updateDatabase: false });
            return;
          }
          if (!outExists) {
            finalizeExternalSession({ updateDatabase: true });
            return;
          }
          if (externalBufferEvidence(currentMeta, inspectProcessIdentity).state !== 'dead') return;
          removeExternalBufferFiles(id, directory);
          finalizeExternalSession({ updateDatabase: true });
        });
      } catch {}
    }, 2000);
  }

  // Adopt any already-running external sessions
  function scanExternalSessions() {
    for (const projectCtx of runtimeProjectContexts()) {
      const directory = bufferDirectory(projectCtx);
      for (const id of externalBufferSessionIds(directory)) {
        adoptExternalSession(id, projectCtx, directory);
      }
    }
  }

  scanExternalSessions();

  const externalScanPoller = setInterval(scanExternalSessions, 1000);

  // bg-04: watch for new external sessions appearing in EVERY registered
  // project's bufsDir, not just the primary. New projects discovered by
  // scanExternalSessions get their own watcher on the next scan tick.
  const bufsWatchers = new Map();
  function ensureBufsWatchers() {
    for (const projectCtx of runtimeProjectContexts()) {
      const root = path.resolve(projectCtx.root);
      if (bufsWatchers.has(root)) continue;
      const directory = bufferDirectory(projectCtx);
      try {
        const watcher = fs.watch(directory, { persistent: false }, (event, filename) => {
          if (filename?.endsWith('.out')) {
            setTimeout(() => adoptExternalSession(path.basename(filename, '.out'), projectCtx, directory), 300);
          }
        });
        watcher.on('error', (err) => {
          console.error(redactedLogText(`[${new Date().toISOString()}] bufs watcher error for ${root}: ${err?.message || err}`));
        });
        bufsWatchers.set(root, watcher);
      } catch {}
    }
  }
  ensureBufsWatchers();
  const bufsWatcherSyncPoller = setInterval(ensureBufsWatchers, 5000);

  return {
    bufsWatchers, externalScanPoller, bufsWatcherSyncPoller,
    scanExternalSessions, adoptExternalSession, removeExternalBufferFiles
  };
}
