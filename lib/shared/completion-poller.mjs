export function completionPoller(callback, intervalMs, stopped, { cooldownFactor = 0 } = {}) {
  // Refresh the same Timeout only after work completes. A slow synchronous
  // filesystem scan must not leave another scan overdue on every event-loop
  // turn, and an async scan must never overlap the next periodic invocation.
  let nextAllowed = 0;
  const timer = setTimeout(async () => {
    if (stopped()) return;
    if (performance.now() + 1 < nextAllowed) { timer.refresh(); return; }
    const started = performance.now();
    try { await callback(); }
    finally {
      // Windows private-state scans can cost longer than their interval.
      // Preserve time for HTTP/WebSocket work without caching trusted state.
      nextAllowed = performance.now() + Math.max(intervalMs, (performance.now() - started) * cooldownFactor);
      if (!stopped()) timer.refresh();
    }
  }, intervalMs);
  return timer;
}
