// Stop accepting work before calling this helper. Cleanup starts after the
// reply is flushed or disconnected, with a bound for an unfinished response.
export function scheduleResponseShutdown(response, shutdown, {
  fallbackMs = 250, schedule = setTimeout, cancel = clearTimeout
} = {}) {
  let started = false;
  let timer;
  function finish() {
    if (started) return;
    started = true;
    response.removeListener('finish', finish);
    response.removeListener('close', finish);
    if (timer !== undefined) cancel(timer);
    shutdown();
  }
  response.once('finish', finish);
  response.once('close', finish);
  timer = schedule(finish, fallbackMs);
  timer?.unref?.();
  if (response.writableFinished || response.destroyed) finish();
}
