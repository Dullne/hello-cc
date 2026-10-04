import { performance } from 'node:perf_hooks';

const PREFIX = 'HCC_SHUTDOWN_PHASE ';
const PHASES = new Set(['request_received', 'stop_accepted', 'response_finished',
  'cleanup_begin', 'pollers_closed', 'state_cleaned', 'sessions_cleaned', 'http_closed', 'cleanup_end']);
const COUNTS = ['sessions', 'running', 'tmux', 'appServer', 'native', 'external', 'pty'];
const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 86400000;

// Opt-in fixture telemetry only: fixed phases and counts, no identifiers,
// paths, command arguments, request fields, messages or environment values.
export function createShutdownDiagnostics({ enabled = false, pid = process.pid,
  now = () => performance.now(), write = line => console.error(line) } = {}) {
  const started = enabled ? now() : 0;
  return (phase, counts = {}) => {
    if (!enabled || !PHASES.has(phase)) return;
    try {
      const elapsedMs = Math.max(0, Math.round(now() - started));
      if (!bounded(elapsedMs)) return;
      write(PREFIX + JSON.stringify({ pid, phase, elapsedMs,
        ...Object.fromEntries(COUNTS.filter(key => bounded(counts[key])).map(key => [key, counts[key]])) }));
    } catch { /* Diagnostics must never change shutdown behavior. */ }
  };
}

export function parseShutdownDiagnostics(text, pid) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || !Number.isSafeInteger(pid) || pid <= 0) return [];
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX) || line.length > 2048) continue;
    try {
      const value = JSON.parse(line.slice(PREFIX.length));
      if (value?.pid !== pid || !PHASES.has(value.phase) || !bounded(value.elapsedMs)) continue;
      result.push({ phase: value.phase, elapsedMs: value.elapsedMs,
        ...Object.fromEntries(COUNTS.filter(key => bounded(value[key])).map(key => [key, value[key]])) });
    } catch {}
  }
  return result.slice(-16);
}
