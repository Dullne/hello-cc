// tmux terminal streaming/snapshot helpers extracted from cmdWeb.
// These manage the raw pipe-pane FIFO → WebSocket data path and the
// capture-pane fallback for tmux-backed sessions.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { runTmux, tmuxCapturePane, tmuxCursorInfo, tmuxCursorPayload, tmuxDisplaySnapshot } from '../terminal/tmux.mjs';
import { CliError } from '../shared/errors.mjs';
import { ensurePrivateProjectBufferDirectory } from '../runtime/project-path.mjs';

export function createTmuxStream({
  broadcast,
  now,
  refreshPeerIoHeartbeat,
  withBufferDirectoryLease,
  shellQuoteArg,
  ctx,
  isStopping = () => false,
  snapshotTimeoutMs = 5000
}) {
  const snapshots = new WeakMap();
  function snapshotState(session) {
    let state = snapshots.get(session);
    if (!state) {
      state = { generation: 0, revision: 0, enabled: true, flight: null, dirty: false };
      snapshots.set(session, state);
    }
    return state;
  }
  function invalidateSnapshot(session, enabled) {
    const state = snapshotState(session);
    state.generation++;
    state.enabled = enabled;
    state.dirty = false;
    state.flight?.controller.abort();
  }
  function invalidateTmuxSnapshot(session) {
    snapshotState(session).revision++;
  }
  function cursorEscape(payload) {
    if (!payload) return '';
    return '\x1b[' + (payload.row + 1) + ';' + (payload.col + 1) + 'H' +
      (payload.visible ? '\x1b[?25h' : '\x1b[?25l');
  }

  function tmuxSnapshot(session) {
    if (isStopping()) return session.buffer || '';
    const captured = tmuxCapturePane(session.pane);
    return captured + cursorEscape(tmuxCursorPayload(captured, tmuxCursorInfo(session.pane)));
  }

  function refreshTmuxSnapshot(session) {
    if (session.type !== 'tmux' || !session.pane) return session.buffer || '';
    snapshotState(session).revision++;
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {
      // Keep the previous buffer if the pane disappears during capture.
    }
    return session.buffer || '';
  }

  // Display refreshes share one flight per session. A later input/resize
  // invalidates that image and coalesces into one follow-up, never a queue.
  function refreshTmuxSnapshotAsync(session, { invalidate = false } = {}) {
    const state = snapshotState(session);
    const active = () => state.enabled && !isStopping() && session.type === 'tmux' &&
      session.status === 'running' && Boolean(session.pane);
    if (!active()) return Promise.resolve(false);
    if (invalidate) state.revision++;
    if (state.flight) {
      if (state.flight.revision !== state.revision || state.flight.pane !== session.pane || state.flight.generation !== state.generation) state.dirty = true;
      return state.flight.promise;
    }
    const flight = { pane: session.pane, generation: state.generation, revision: state.revision,
      controller: new globalThis.AbortController(), promise: null };
    state.flight = flight;
    flight.promise = (async () => {
      let published = false;
      try {
        const { captured, cursor } = await tmuxDisplaySnapshot(flight.pane,
          { timeoutMs: snapshotTimeoutMs, signal: flight.controller.signal });
        if (active() && state.generation === flight.generation && state.revision === flight.revision &&
            session.pane === flight.pane && !flight.controller.signal.aborted) {
          session.buffer = captured + cursorEscape(tmuxCursorPayload(captured, cursor));
          state.revision++;
          session.lastBroadcastTime = Date.now();
          broadcast(session, { type: 'replace', data: session.buffer });
          published = true;
        }
      } catch { /* Keep the last image on timeout, cancellation or tmux errors. */ }
      finally { if (state.flight === flight) state.flight = null; }
      if (state.dirty && active()) {
        state.dirty = false;
        return refreshTmuxSnapshotAsync(session);
      }
      return published;
    })();
    return flight.promise;
  }

  function scheduleTmuxReplace(session) {
    if (isStopping() || session.type !== 'tmux' || !session.pane) return;
    invalidateTmuxSnapshot(session);
    if (session.replaceTimer) clearTimeout(session.replaceTimer);
    session.replaceTimer = setTimeout(() => {
      session.replaceTimer = null;
      if (isStopping()) return;
      void refreshTmuxSnapshotAsync(session);
    }, 80);
  }

  function startTmuxReplacePoller(session, warning = null) {
    if (isStopping()) return;
    const state = snapshotState(session);
    if (!state.enabled) invalidateSnapshot(session, true);
    if (session.replacePoller) clearInterval(session.replacePoller);
    if (warning) {
      session.warning = {
        code: 'TMUX_STREAM_FALLBACK',
        message: `Raw tmux streaming unavailable; using capture polling: ${warning}`
      };
    }
    session.lastBroadcastTime = Date.now();
    session.replacePoller = setInterval(() => {
      if (isStopping() || session.status !== 'running') return;
      if (Date.now() - (session.lastBroadcastTime || 0) > 4000) {
        session.lastBroadcastTime = Date.now();
        void refreshTmuxSnapshotAsync(session);
      }
    }, 1600);
  }

  function startTmuxStream(session) {
    if (isStopping()) throw new CliError('RUNTIME_STOPPING', 'Web runtime is stopping');
    invalidateSnapshot(session, true);
    const safePane = String(session.pane).replace(/[^A-Za-z0-9_-]/g, '');
    const safeId = String(session.id).replace(/[^A-Za-z0-9_.-]/g, '_');
    const streamDirectory = ensurePrivateProjectBufferDirectory((session.ctx || ctx).root);
    const pipeFile = path.join(streamDirectory, `tmux-${safePane}-${safeId}.pipe`);
    session.pipeFile = pipeFile;
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {}

    try {
      withBufferDirectoryLease(path.dirname(pipeFile), () => {
        fs.rmSync(pipeFile, { force: true });
        const mkfifo = spawnSync('mkfifo', [pipeFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
        if (mkfifo.status !== 0) {
          const message = (mkfifo.stderr || mkfifo.stdout || '').trim() || 'mkfifo failed';
          throw new CliError('TMUX_STREAM_ERROR', message);
        }
        fs.chmodSync(pipeFile, 0o600);
        session.streamFd = fs.openSync(pipeFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      });
    } catch (err) {
      const message = err?.message || String(err);
      stopTmuxStream(session);
      startTmuxReplacePoller(session, message);
      return 'poll';
    }

    try {
      runTmux(['pipe-pane', '-t', session.pane, `cat > ${shellQuoteArg(pipeFile)}`]);
    } catch (err) {
      stopTmuxStream(session);
      startTmuxReplacePoller(session, err?.message || String(err));
      return 'poll';
    }
    session.streamPoller = setInterval(() => {
      if (isStopping()) return;
      try {
        if (session.streamFd === null || session.streamFd === undefined) return;
        const chunks = [];
        for (;;) {
          const buf = Buffer.alloc(65536);
          let bytes = 0;
          try {
            bytes = fs.readSync(session.streamFd, buf, 0, buf.length, null);
          } catch (err) {
            if (['EAGAIN', 'EWOULDBLOCK'].includes(err?.code)) break;
            throw err;
          }
          if (bytes <= 0) break;
          chunks.push(buf.subarray(0, bytes));
          if (bytes < buf.length) break;
        }
        if (!chunks.length) return;
        const data = Buffer.concat(chunks).toString();
        snapshotState(session).revision++;
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'data', data });
        refreshPeerIoHeartbeat(session);
      } catch {
        if (session.streamFd !== null && session.streamFd !== undefined) {
          try { fs.closeSync(session.streamFd); } catch {}
          session.streamFd = null;
        }
      }
    }, 40);

    startTmuxReplacePoller(session);
    return 'stream';
  }

  function stopTmuxStream(session, { shutdownDeadline = null } = {}) {
    invalidateSnapshot(session, false);
    const shuttingDown = Number.isFinite(shutdownDeadline);
    const remaining = () => shuttingDown ? shutdownDeadline - performance.now() : Infinity;
    if (session.streamPoller) { clearInterval(session.streamPoller); session.streamPoller = null; }
    if (session.replacePoller) { clearInterval(session.replacePoller); session.replacePoller = null; }
    if (session.replaceTimer) { clearTimeout(session.replaceTimer); session.replaceTimer = null; }
    if (session.inputRefreshTimer) { clearTimeout(session.inputRefreshTimer); session.inputRefreshTimer = null; }
    // Shutdown shares one budget across all sessions. Detach keeps its normal
    // behavior, but advisory stream cleanup must not consume down's 5s wait
    // once per pane. Never pass zero to spawnSync (it disables the timeout).
    if (remaining() >= 1) {
      try { runTmux(['pipe-pane', '-t', session.pane], shuttingDown
        ? { timeout: Math.max(1, Math.min(250, Math.floor(remaining()))) } : {}); } catch {}
    }
    let originalPipe = null;
    if (session.streamFd !== null && session.streamFd !== undefined) {
      if (shuttingDown) {
        try { originalPipe = fs.fstatSync(session.streamFd); } catch {}
      }
      try { fs.closeSync(session.streamFd); } catch {}
      session.streamFd = null;
    }
    if (session.pipeFile) {
      try {
        if (remaining() >= 1 && (!shuttingDown || originalPipe?.isFIFO())) {
          withBufferDirectoryLease(path.dirname(session.pipeFile), () => {
            if (shuttingDown) {
              if (remaining() < 1) return;
              // Pointers may already be cleared. A successor can reuse this
              // pathname, so only unlink the FIFO owned by our open descriptor.
              const current = fs.lstatSync(session.pipeFile);
              if (!current.isFIFO() || current.dev !== originalPipe.dev || current.ino !== originalPipe.ino) return;
            }
            fs.unlinkSync(session.pipeFile);
          }, shuttingDown ? { nonblocking: true, createParent: false } : {});
        }
      } catch {}
      session.pipeFile = null;
    }
  }

  return { cursorEscape, tmuxSnapshot, refreshTmuxSnapshot, refreshTmuxSnapshotAsync, invalidateTmuxSnapshot, scheduleTmuxReplace, startTmuxReplacePoller, startTmuxStream, stopTmuxStream };
}
