// Server-side terminal control ownership. Action tokens stay private; clients
// share only controller IDs and monotonically increasing fencing epochs.

export class ControlLeaseError extends Error {
  constructor(code, message, control = null) {
    super(message);
    this.name = 'ControlLeaseError';
    this.code = code;
    this.statusCode = 409;
    this.control = control;
  }
}

export function createControlLease({
  nowMs = Date.now,
  disconnectGraceMs = 15_000,
  broadcast = () => {},
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  if (!Number.isSafeInteger(disconnectGraceMs) || disconnectGraceMs < 0) {
    throw new TypeError('disconnectGraceMs must be a nonnegative safe integer');
  }
  const states = new WeakMap();
  let nextClientId = 0;

  function stateFor(session) {
    if (!session || typeof session !== 'object') throw new TypeError('session must be an object');
    let state = states.get(session);
    if (!state) {
      state = { epoch: 0, clients: new Map(), controller: null, expiresAt: null, timer: null };
      states.set(session, state);
    }
    return state;
  }

  function publicStatus(state) {
    return {
      epoch: state.epoch,
      controller_id: state.controller?.id || null,
      has_controller: Boolean(state.controller),
      controller_connected: Boolean(state.controller?.connected),
      expires_at: state.expiresAt,
      client_count: state.clients.size
    };
  }

  function notify(session, state) {
    // A closed socket must not undo an ownership change or interrupt fencing.
    try { broadcast(session, { type: 'control', control: publicStatus(state) }); } catch {}
  }

  function clearExpiry(state) {
    if (state.timer !== null) cancel(state.timer);
    state.timer = null;
  }

  function advanceEpoch(state) {
    if (state.epoch === Number.MAX_SAFE_INTEGER) {
      throw new ControlLeaseError('CONTROL_EPOCH_EXHAUSTED', 'Terminal control epoch exhausted');
    }
    state.epoch += 1;
  }

  function expire(session, state) {
    if (!state.controller || state.controller.connected || state.expiresAt > nowMs()) return false;
    clearExpiry(state);
    advanceEpoch(state);
    state.controller = null;
    state.expiresAt = null;
    notify(session, state);
    return true;
  }

  function scheduleExpiry(session, state) {
    clearExpiry(state);
    const epoch = state.epoch;
    state.timer = schedule(() => {
      state.timer = null;
      if (states.get(session) !== state || state.epoch !== epoch || state.controller?.connected) return;
      if (!expire(session, state) && state.controller) scheduleExpiry(session, state);
    }, Math.max(0, state.expiresAt - nowMs()));
    state.timer?.unref?.();
  }

  function current(session) {
    const state = stateFor(session);
    expire(session, state);
    return state;
  }

  function checkToken(token) {
    if (typeof token !== 'string' || !token) {
      throw new ControlLeaseError('UNKNOWN_CONTROL_CLIENT', 'A connected terminal action token is required');
    }
  }

  function connectedClient(state, token) {
    checkToken(token);
    const client = state.clients.get(token);
    if (!client?.connected) {
      throw new ControlLeaseError('UNKNOWN_CONTROL_CLIENT', 'Terminal client is disconnected', publicStatus(state));
    }
    return client;
  }

  function checkEpoch(state, epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch !== state.epoch) {
      throw new ControlLeaseError('STALE_CONTROL_EPOCH', 'Terminal control changed; refresh its control state', publicStatus(state));
    }
  }

  function setController(state, client) {
    clearExpiry(state);
    advanceEpoch(state);
    state.controller = client;
    state.expiresAt = null;
  }

  function status(session, actionToken) {
    const state = current(session);
    const result = publicStatus(state);
    if (actionToken !== undefined) {
      const client = state.clients.get(actionToken);
      result.client_id = client?.id || (state.controller?.token === actionToken ? state.controller.id : null);
      result.can_control = Boolean(client?.connected && state.controller === client);
    }
    return result;
  }

  function connect(session, actionToken) {
    checkToken(actionToken);
    const state = current(session);
    if (state.clients.has(actionToken)) {
      throw new ControlLeaseError('CONTROL_CLIENT_CONNECTED', 'Terminal action token is already connected', publicStatus(state));
    }
    const retained = state.controller?.token === actionToken ? state.controller : null;
    const client = retained || { token: actionToken, id: `client-${++nextClientId}`, connected: true };
    client.connected = true;
    state.clients.set(actionToken, client);
    if (!state.controller || retained) setController(state, client);
    notify(session, state);
    return status(session, actionToken);
  }

  function disconnect(session, actionToken) {
    const state = current(session);
    const client = state.clients.get(actionToken);
    if (!client) return status(session, actionToken);
    state.clients.delete(actionToken);
    client.connected = false;
    if (state.controller === client) {
      state.expiresAt = nowMs() + disconnectGraceMs;
      if (disconnectGraceMs === 0) expire(session, state);
      else scheduleExpiry(session, state);
    }
    notify(session, state);
    return status(session, actionToken);
  }

  function claim(session, actionToken, { epoch, takeover = false } = {}) {
    const state = current(session);
    const client = connectedClient(state, actionToken);
    checkEpoch(state, epoch);
    if (state.controller !== client) {
      if (state.controller && takeover !== true) {
        throw new ControlLeaseError('CONTROL_HELD', 'Another client controls this terminal; explicitly take control', publicStatus(state));
      }
      setController(state, client);
      notify(session, state);
    }
    return status(session, actionToken);
  }

  function assertControl(session, actionToken, epoch) {
    const state = current(session);
    const client = connectedClient(state, actionToken);
    checkEpoch(state, epoch);
    if (state.controller !== client) {
      throw new ControlLeaseError('CONTROL_REQUIRED', 'Take terminal control before changing this session', publicStatus(state));
    }
    return status(session, actionToken);
  }

  function release(session, actionToken, epoch) {
    assertControl(session, actionToken, epoch);
    const state = states.get(session);
    clearExpiry(state);
    advanceEpoch(state);
    state.controller = null;
    state.expiresAt = null;
    notify(session, state);
    return status(session, actionToken);
  }

  function forget(session) {
    const state = states.get(session);
    if (!state) return;
    clearExpiry(state);
    states.delete(session);
  }

  return { connect, disconnect, status, claim, release, assertControl, forget };
}
