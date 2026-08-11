// tmux terminal streaming/snapshot helpers extracted from cmdWeb.
// These manage the raw pipe-pane FIFO → WebSocket data path and the
// capture-pane fallback for tmux-backed sessions.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTmux, tmuxCapturePane, tmuxCursorInfo, tmuxCursorPayload } from '../terminal/tmux.mjs';
import { CliError } from '../shared/errors.mjs';

export function createTmuxStream({
  broadcast,
  now,
  refreshPeerIoHeartbeat,
  bufferDirectory,
  withBufferDirectoryLease,
  shellQuoteArg,
  ctx
}) {
  function cursorEscape(payload) {
    if (!payload) return '';
    return '[' + (payload.row + 1) + ';' + (payload.col + 1) + 'H' +
      (payload.visible ? '[?25h' : '[?25l');
  }

  function tmuxSnapshot(session) {
    const captured = tmuxCapturePane(session.pane);
    return captured + cursorEscape(tmuxCursorPayload(captured, tmuxCursorInfo(session.pane)));
  }

  function refreshTmuxSnapshot(session) {
    if (session.type !== 'tmux' || !session.pane) return session.buffer || '';
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {
      // Keep the previous buffer if the pane disappears during capture.
    }
    return session.buffer || '';
  }

  function scheduleTmuxReplace(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.replaceTimer) clearTimeout(session.replaceTimer);
    session.replaceTimer = setTimeout(() => {
      session.replaceTimer = null;
      session.lastBroadcastTime = Date.now();
      broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
  }

  function startTmuxReplacePoller(session, warning = null) {
    if (session.replacePoller) clearInterval(session.replacePoller);
    if (warning) {
      session.warning = {
        code: 'TMUX_STREAM_FALLBACK',
        message: `Raw tmux streaming unavailable; using capture polling: ${warning}`
      };
    }
    session.lastBroadcastTime = Date.now();
    session.replacePoller = setInterval(() => {
      if (session.status !== 'running') return;
      if (Date.now() - (session.lastBroadcastTime || 0) > 4000) {
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
      }
    }, 1600);
  }

  function startTmuxStream(session) {
    const safePane = String(session.pane).replace(/[^A-Za-z0-9_-]/g, '');
    const safeId = String(session.id).replace(/[^A-Za-z0-9_.-]/g, '_');
    const streamDirectory = bufferDirectory(session.ctx || ctx);
    fs.mkdirSync(streamDirectory, { recursive: true });
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
        try { fs.chmodSync(pipeFile, 0o600); } catch {}
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

  function stopTmuxStream(session) {
    if (session.streamPoller) { clearInterval(session.streamPoller); session.streamPoller = null; }
    if (session.replacePoller) { clearInterval(session.replacePoller); session.replacePoller = null; }
    if (session.replaceTimer) { clearTimeout(session.replaceTimer); session.replaceTimer = null; }
    if (session.inputRefreshTimer) { clearTimeout(session.inputRefreshTimer); session.inputRefreshTimer = null; }
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    if (session.streamFd !== null && session.streamFd !== undefined) {
      try { fs.closeSync(session.streamFd); } catch {}
      session.streamFd = null;
    }
    if (session.pipeFile) {
      try {
        withBufferDirectoryLease(path.dirname(session.pipeFile), () => {
          fs.unlinkSync(session.pipeFile);
        });
      } catch {}
      session.pipeFile = null;
    }
  }

  return { cursorEscape, tmuxSnapshot, refreshTmuxSnapshot, scheduleTmuxReplace, startTmuxReplacePoller, startTmuxStream, stopTmuxStream };
}
