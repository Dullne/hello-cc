import net from 'node:net';
import { parentPort } from 'node:worker_threads';

const STATE_INDEX = 0;
const DETAIL_INDEX = 1;

export function runSocketLockWorker(workerData) {
  const state = new Int32Array(workerData.stateBuffer);
  const states = workerData.states;
  const ports = [...new Set(workerData.ports)].sort((left, right) => left - right);
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

  function handleBindFailure(error, attemptGeneration) {
    if (finished || attemptGeneration !== generation) return;
    generation += 1;
    closeServers((closeError) => {
      if (closeError) {
        finish(states.FAILED, 1);
      } else if (error?.code === 'EADDRINUSE') {
        retryAfterContention();
      } else {
        finish(states.FAILED, 1);
      }
    });
  }

  function bindNext(index, attemptGeneration) {
    if (finished || attemptGeneration !== generation) return;
    if (index === ports.length) {
      publish(states.ACQUIRED);
      return;
    }
    let candidate;
    try {
      candidate = net.createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
      const bindError = (error) => handleBindFailure(error, attemptGeneration);
      candidate.once('error', bindError);
      candidate.listen({ host: '127.0.0.1', port: ports[index], exclusive: true }, () => {
        if (finished || attemptGeneration !== generation) {
          try { candidate.close(); } catch {}
          return;
        }
        candidate.off('error', bindError);
        candidate.on('error', () => closeAndFinish(states.FAILED, 1));
        servers.push(candidate);
        bindNext(index + 1, attemptGeneration);
      });
    } catch (error) {
      handleBindFailure(error, attemptGeneration);
    }
  }

  function attemptAll() {
    if (finished) return;
    if (contentionDeadline !== null && performance.now() >= contentionDeadline) {
      finish(states.TIMEOUT);
      return;
    }
    const attemptGeneration = generation;
    bindNext(0, attemptGeneration);
  }

  parentPort.on('message', (message) => {
    if (message?.type !== 'release' || releasing ||
        Atomics.load(state, STATE_INDEX) !== states.ACQUIRED) return;
    releasing = true;
    generation += 1;
    closeServers((error) => finish(error ? states.RELEASE_FAILED : states.RELEASED, error ? 1 : 0));
  });

  try {
    if (ports.length === 0) throw new TypeError('file lock worker requires at least one port');
    attemptAll();
  } catch {
    closeAndFinish(states.FAILED, 1);
  }
}
