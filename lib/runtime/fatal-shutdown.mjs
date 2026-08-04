import { redactSecrets } from '../shared/redact.mjs';

function fatalReason(error) {
  if (error instanceof Error) return redactSecrets(error.message || error.name);
  if (typeof error === 'string') return redactSecrets(error);
  return 'fatal runtime error';
}

export function createFatalShutdownController({
  cleanup,
  exit,
  forceExit,
  log,
  schedule = setTimeout,
  cancel = clearTimeout,
  timeoutMs = 2_000
}) {
  let state = 'idle';

  function safeLog(entry) {
    try { log(redactSecrets(entry)); } catch {}
  }

  async function fatal(error) {
    if (state !== 'idle') {
      forceExit(1);
      return;
    }

    state = 'stopping';
    const deadline = schedule(() => {
      state = 'forced';
      forceExit(1);
    }, timeoutMs);
    deadline?.unref?.();
    safeLog({ code: 'FATAL_RUNTIME_ERROR', error });
    try {
      await cleanup(fatalReason(error));
    } catch (cleanupError) {
      safeLog({ code: 'FATAL_CLEANUP_ERROR', error: cleanupError });
    }
    if (state === 'forced') return;
    state = 'stopped';
    let exitReturned = false;
    try {
      exit(1);
      exitReturned = true;
    } finally {
      if (exitReturned) cancel(deadline);
    }
  }

  return { fatal };
}
