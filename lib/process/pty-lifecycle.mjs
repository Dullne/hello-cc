import { waitForLiveProcessIdentity } from './identity.mjs';

export function trackPtyExit(child) {
  let exitEvent = null;
  let resolveExit;
  const promise = new Promise((resolve) => { resolveExit = resolve; });

  child.onExit((event) => {
    if (exitEvent !== null) return;
    exitEvent = event;
    resolveExit(event);
  });

  return {
    promise,
    get event() {
      return exitEvent;
    }
  };
}

export function installPtyTerminationHandlers(child, options = {}) {
  const emitter = options.emitter || process;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const forceKillMs = Math.max(0, Number(options.forceKillMs ?? 1200));
  let signal = null;
  let forceKillTimer = null;

  const onTerminate = (requestedSignal) => {
    if (signal !== null) return;
    signal = requestedSignal;
    try { child.kill(requestedSignal === 'SIGTERM' ? 'SIGHUP' : requestedSignal); } catch {}
    forceKillTimer = setTimer(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, forceKillMs);
    forceKillTimer?.unref?.();
  };
  const onSigint = () => onTerminate('SIGINT');
  const onSigterm = () => onTerminate('SIGTERM');
  emitter.once('SIGINT', onSigint);
  emitter.once('SIGTERM', onSigterm);

  return {
    get signal() {
      return signal;
    },
    dispose() {
      emitter.off('SIGINT', onSigint);
      emitter.off('SIGTERM', onSigterm);
      if (forceKillTimer !== null) clearTimer(forceKillTimer);
      forceKillTimer = null;
    }
  };
}

export function ptyTerminationSignal(wrapperSignal, childSignal) {
  return wrapperSignal || childSignal || null;
}

export function ptyStartupFailureDisposition({ termination, childPid, childIdentity = null }) {
  return {
    status: termination.exited ? 'exited' : 'blocked',
    eventType: termination.exited
      ? 'run.session.exited'
      : 'run.session.termination_unconfirmed',
    preserveEvidence: !termination.exited,
    childPid,
    childIdentity
  };
}

async function waitForTrackedExit(exit, timeoutMs, sleep) {
  if (exit.event !== null) return { exited: true, event: exit.event };
  const timedOut = Symbol('timed-out');
  const result = await Promise.race([
    exit.promise,
    sleep(timeoutMs).then(() => timedOut)
  ]);
  return result === timedOut
    ? { exited: false, event: null }
    : { exited: true, event: result };
}

export async function stopPtyAfterStartupFailure(child, exit, options = {}) {
  const graceMs = Math.max(0, Number(options.graceMs ?? 150));
  const killTimeoutMs = Math.max(0, Number(options.killTimeoutMs ?? 1000));
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  if (exit.event !== null) return { exited: true, event: exit.event };
  try { child.kill('SIGHUP'); } catch {}
  const graceful = await waitForTrackedExit(exit, graceMs, sleep);
  if (graceful.exited) return graceful;

  try { child.kill('SIGKILL'); } catch {}
  return waitForTrackedExit(exit, killTimeoutMs, sleep);
}

export async function capturePtyStartupEvidence({
  childPid,
  wrapperPid,
  exit,
  waitForIdentity = waitForLiveProcessIdentity,
  timeoutMs = 2000
}) {
  const identityCapture = Promise.all([
    waitForIdentity(wrapperPid, { timeoutMs }),
    waitForIdentity(childPid, { timeoutMs })
  ]).then(([wrapperEvidence, childEvidence]) => ({
    type: 'identity',
    wrapperEvidence,
    childEvidence
  }));
  const earlyExit = exit.promise.then((exitEvent) => ({ type: 'exit', exitEvent }));
  const first = await Promise.race([identityCapture, earlyExit]);

  if (first.type === 'exit' || exit.event !== null) {
    return {
      state: 'failed',
      reason: 'child_exited_before_identity',
      exitEvent: first.exitEvent || exit.event
    };
  }
  if (first.wrapperEvidence.state !== 'live' || !first.wrapperEvidence.identity) {
    return {
      state: 'failed',
      reason: 'wrapper_identity_unavailable',
      exitEvent: null,
      childIdentity: first.childEvidence.state === 'live'
        ? first.childEvidence.identity
        : null
    };
  }
  if (first.childEvidence.state === 'dead') {
    return {
      state: 'failed',
      reason: 'child_exited_before_identity',
      exitEvent: null
    };
  }

  return {
    state: 'ready',
    wrapperIdentity: first.wrapperEvidence.identity,
    childIdentity: first.childEvidence.state === 'live'
      ? first.childEvidence.identity
      : null
  };
}
