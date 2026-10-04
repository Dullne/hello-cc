// Terminal data frames are arbitrary stream chunks. Projections can be checked
// independently, but must never supply a prefix to the raw stream matcher.
const failures = new WeakMap();

// Only errors created here carry publishable diagnostics. Never publish a
// socket error's message, terminal contents, token, or caller-supplied fields.
export function terminalMarkerFailureDiagnostic(error) {
  return failures.get(error);
}

export function createTerminalMarkerMatcher(marker) {
  if (typeof marker !== 'string' || !marker) throw new TypeError('A nonempty terminal marker is required');
  const limit = marker.length - 1;
  let suffix = '';
  return {
    get retainedLength() { return suffix.length; },
    observe(type, value) {
      if (!['snapshot', 'replace', 'data'].includes(type)) return false;
      const data = String(value || '');
      if (type !== 'data') return data.includes(marker);
      const matched = data.includes(marker) || (suffix + data.slice(0, limit)).includes(marker);
      suffix = limit === 0 ? '' : data.length >= limit
        ? data.slice(-limit) : (suffix + data).slice(-limit);
      return matched;
    }
  };
}

export function waitForTerminalMarker(ws, marker, { claim, release, timeoutMs = 15_000 }) {
  const matcher = createTerminalMarkerMatcher(marker);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, sawMarker = false, inputStarted = false, inputSent = false;
    let phase = 'snapshot';
    const timer = setTimeout(() => finish('TERMINAL_MARKER_TIMEOUT'), timeoutMs);
    const removeSocketListeners = () => {
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    function finish(code = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      controller.abort();
      // Keep the error listener until close: terminate() while connecting can
      // emit an asynchronous error before its close event.
      if (ws.readyState === 3) removeSocketListeners();
      try {
        if (code) ws.terminate();
        else { try { release(); } catch {} ws.close(); }
      } catch { try { ws.terminate(); } catch {} }
      if (code) {
        const error = Object.assign(new Error(`${code} (${phase})`), { code, phase });
        failures.set(error, Object.freeze({ code, phase }));
        reject(error);
      } else resolve();
    }
    function onError() { finish('TERMINAL_MARKER_SOCKET_ERROR'); }
    function onClose() {
      if (!settled) finish('TERMINAL_MARKER_CLOSED');
      removeSocketListeners();
    }
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(String(raw)); }
      catch { finish('TERMINAL_MARKER_MESSAGE_INVALID'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { finish('TERMINAL_MARKER_MESSAGE_INVALID'); return; }
      if (message.type === 'error') { finish('TERMINAL_MARKER_SERVER_ERROR'); return; }
      // Initial history is not evidence that this connection's input worked.
      // A snapshot received again must never submit the command again.
      if (inputSent) sawMarker ||= matcher.observe(message.type, message.data);
      if (sawMarker) { finish(); return; }
      if (message.type !== 'snapshot' || inputStarted) return;
      inputStarted = true;
      phase = 'control';
      Promise.resolve().then(() => {
        if (settled) return;
        return claim(controller.signal);
      }).then(() => {
        if (settled) return;
        phase = 'input';
        try {
          inputSent = true;
          ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r`,
            action_token: ws.hccActionToken, epoch: ws.hccControl?.epoch }));
          if (!settled) phase = 'marker';
        } catch { finish('TERMINAL_MARKER_INPUT_FAILED'); }
      }).catch(() => finish('TERMINAL_MARKER_CONTROL_FAILED'));
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}
