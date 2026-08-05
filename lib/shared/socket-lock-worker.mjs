import net from 'node:net';
import { parentPort } from 'node:worker_threads';

const STATE_INDEX = 0;
const DETAIL_INDEX = 1;
const PROTOCOL_PREFIX = 'HCC_FILE_LOCK_V1 ';
const PROBE_TIMEOUT_MS = 25;

export function runSocketLockWorker(workerData) {
  const state = new Int32Array(workerData.stateBuffer);
  const states = workerData.states;
  const targets = workerData.targets;
  let servers = [];
  let contentionDeadline = null;
  let releasing = false;
  let finished = false;
  let generation = 0;

  function publish(status, detail = 0) {
    Atomics.store(state, DETAIL_INDEX, detail);
    Atomics.store(state, STATE_INDEX, status);
    Atomics.notify(state, STATE_INDEX);
  }

  function finish(status, detail = 0) {
    if (finished) return;
    finished = true;
    publish(status, detail);
    parentPort.close();
  }

  function closeServers(callback) {
    const closing = servers;
    servers = [];
    if (closing.length === 0) {
      callback(null);
      return;
    }
    let remaining = closing.length;
    let firstError = null;
    const closed = (error = null) => {
      if (error && !firstError) firstError = error;
      remaining -= 1;
      if (remaining === 0) callback(firstError);
    };
    for (const server of closing) {
      try {
        server.close(closed);
      } catch (error) {
        closed(error);
      }
    }
  }

  function closeAndFinish(status, detail = 0) {
    generation += 1;
    closeServers((error) => finish(error ? states.FAILED : status, error ? 1 : detail));
  }

  function retryAfterContention() {
    if (workerData.nonblocking) {
      finish(states.BUSY);
      return;
    }
    if (contentionDeadline === null) {
      contentionDeadline = performance.now() + workerData.timeoutMs;
    }
    const remaining = contentionDeadline - performance.now();
    if (remaining <= 0) {
      finish(states.TIMEOUT);
      return;
    }
    setTimeout(attemptAll, Math.min(workerData.retryMs, remaining));
  }

  function retryCleanly(attemptGeneration) {
    if (finished || attemptGeneration !== generation) return;
    generation += 1;
    closeServers((error) => {
      if (error) finish(states.FAILED, 1);
      else retryAfterContention();
    });
  }

  function lockBanner(identity) {
    return `${PROTOCOL_PREFIX}${identity}\n`;
  }

  function probeOccupant(port, identity, callback) {
    const expected = lockBanner(identity);
    let received = '';
    let settled = false;
    let socket;
    const settle = (matching) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      callback(matching);
    };
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    try {
      socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += chunk;
        if (received.includes('\n') || received.length >= expected.length) {
          settle(received === expected);
        }
      });
      socket.once('end', () => settle(received === expected));
      socket.once('error', () => settle(false));
    } catch {
      settle(false);
    }
  }

  function bindCandidate(targetIndex, candidateIndex, boundForTarget, attemptGeneration) {
    if (finished || attemptGeneration !== generation) return;
    const target = targets[targetIndex];
    if (candidateIndex === target.ports.length) {
      if (boundForTarget === 0) {
        retryCleanly(attemptGeneration);
      } else {
        bindTarget(targetIndex + 1, attemptGeneration);
      }
      return;
    }
    const port = target.ports[candidateIndex];
    let candidate;
    try {
      candidate = net.createServer((socket) => socket.end(lockBanner(target.identity)));
      const bindError = (error) => {
        if (finished || attemptGeneration !== generation) return;
        if (error?.code !== 'EADDRINUSE') {
          generation += 1;
          closeServers(() => finish(states.FAILED, 1));
          return;
        }
        probeOccupant(port, target.identity, (matching) => {
          if (finished || attemptGeneration !== generation) return;
          if (matching) retryCleanly(attemptGeneration);
          else bindCandidate(targetIndex, candidateIndex + 1, boundForTarget, attemptGeneration);
        });
      };
      candidate.once('error', bindError);
      candidate.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        if (finished || attemptGeneration !== generation) {
          try { candidate.close(); } catch {}
          return;
        }
        candidate.off('error', bindError);
        candidate.on('error', () => closeAndFinish(states.FAILED, 1));
        servers.push(candidate);
        bindCandidate(targetIndex, candidateIndex + 1, boundForTarget + 1, attemptGeneration);
      });
    } catch {
      generation += 1;
      closeServers(() => finish(states.FAILED, 1));
    }
  }

  function bindTarget(index, attemptGeneration) {
    if (finished || attemptGeneration !== generation) return;
    if (index === targets.length) {
      publish(states.ACQUIRED);
      return;
    }
    bindCandidate(index, 0, 0, attemptGeneration);
  }

  function attemptAll() {
    if (finished) return;
    if (contentionDeadline !== null && performance.now() >= contentionDeadline) {
      finish(states.TIMEOUT);
      return;
    }
    const attemptGeneration = generation;
    bindTarget(0, attemptGeneration);
  }

  parentPort.on('message', (message) => {
    if (message?.type !== 'release' || releasing ||
        Atomics.load(state, STATE_INDEX) !== states.ACQUIRED) return;
    releasing = true;
    generation += 1;
    closeServers((error) => finish(error ? states.RELEASE_FAILED : states.RELEASED, error ? 1 : 0));
  });

  try {
    if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) =>
      !/^[a-f0-9]{64}$/.test(target?.identity) ||
      !Array.isArray(target?.ports) || target.ports.length === 0 ||
      target.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))) {
      throw new TypeError('file lock worker requires valid targets');
    }
    attemptAll();
  } catch {
    closeAndFinish(states.FAILED, 1);
  }
}
