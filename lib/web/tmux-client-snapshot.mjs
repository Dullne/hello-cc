import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const UNKNOWN = Object.freeze({ state: 'unknown', count: null });
const MAX_AGE_MS = 5_000;
const REFRESH_AFTER_MS = 2_000;

function parseSnapshot(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split(/\r?\n/).filter(Boolean)) {
    const match = /^(%\d+)\|(\$\d+)\|(\d+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[3]))) throw new Error('Invalid tmux client snapshot');
    const [, pane, session, countText] = match;
    const count = Number(countText);
    const previous = rows.get(pane);
    // Linked windows may repeat a pane within or across sessions. A display
    // hint must not guess which session's local clients control that pane.
    if (rows.has(pane) && (!previous || previous.session !== session || previous.count !== count)) {
      rows.set(pane, null);
    } else if (!rows.has(pane)) {
      rows.set(pane, { session, count });
    }
  }
  return rows;
}

// Display-only observations. Destructive actions must continue to query live
// clients through strictTmuxClientObservation and verify their ownership.
// One asynchronous read covers every pane; serialization never waits for tmux.
export function createTmuxClientSnapshot({ run = execFile, now = () => performance.now() } = {}) {
  let rows = new Map();
  let observedAt = -Infinity;
  let nextRefreshAt = -Infinity;
  let pending = null;
  let closed = false;

  function refresh(at) {
    if (closed || pending || at < nextRefreshAt) return;
    const operation = { controller: new globalThis.AbortController() };
    pending = operation;
    nextRefreshAt = at + REFRESH_AFTER_MS;
    const complete = (error, stdout) => {
      if (pending !== operation) return;
      pending = null;
      if (closed || operation.controller.signal.aborted) return;
      nextRefreshAt = now() + REFRESH_AFTER_MS;
      try {
        if (error) throw error;
        rows = parseSnapshot(stdout);
        observedAt = at;
      } catch {
        rows = new Map();
        observedAt = -Infinity;
      }
    };
    try {
      run('tmux', ['list-panes', '-a', '-F', '#{pane_id}|#{session_id}|#{session_attached}'], {
        encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024,
        signal: operation.controller.signal
      }, complete);
    } catch (error) {
      complete(error);
    }
  }

  function observe(session) {
    if (closed || session?.type !== 'tmux' || !/^%\d+$/.test(session.pane || '')) return UNKNOWN;
    const at = now();
    refresh(at);
    const row = rows.get(session.pane);
    if (!row || at - observedAt >= MAX_AGE_MS) return UNKNOWN;
    return { state: 'known', count: row.count };
  }

  function close() {
    closed = true;
    rows = new Map();
    observedAt = -Infinity;
    const operation = pending;
    pending = null;
    operation?.controller.abort();
  }

  return { observe, close };
}
