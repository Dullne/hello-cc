import { randomUUID } from 'node:crypto';

// Only the owning runtime can answer. Answers, including secrets, are never
// placed in snapshots, events or persistent delivery receipts.
export function createNativeInteractions({ executorId = randomUUID(), isActive, onChange }) {
  const pending = new Map(), used = new Set();
  function snapshot() {
    return [...pending.values()].map(({ resolve, validate, cancelled, cleanup, ...view }) => structuredClone(view));
  }
  function settle(key, result, reason) {
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key); request.cleanup?.();
    request.resolve(result);
    onChange?.({ type: 'approval.resolved', requestId: request.requestId, turnId: request.turnId, reason });
  }
  function expire(turnId = null, reason = 'expired') {
    for (const [key, request] of pending) if (!turnId || request.turnId === turnId) settle(key, request.cancelled, reason);
  }
  function request({ requestId, sessionId, turnId, kind = 'approval', method, params, validate, cancelled, signal }) {
    const id = requestId ?? randomUUID(), key = JSON.stringify([typeof id, id]);
    if (signal?.aborted || !isActive(sessionId, turnId)) return Promise.resolve(cancelled);
    if (used.has(key) || pending.size >= 64) throw Object.assign(new Error('Duplicate or excessive native interaction requests'), { code: 'NATIVE_PROTOCOL_ERROR' });
    used.add(key); if (used.size > 256) used.delete(used.values().next().value);
    let truncated = false, preview = structuredClone(params);
    if (JSON.stringify(preview).length > 65536) { truncated = true; preview = { preview: JSON.stringify(params).slice(0, 65536) }; }
    const promise = new Promise(resolve => {
      const entry = { executorId, requestId: id, sessionId, turnId, kind, method, params: preview,
        truncated, status: 'pending', createdAt: Date.now(), resolve, validate, cancelled };
      pending.set(key, entry);
      if (signal) {
        const aborted = () => settle(key, cancelled, 'cancelled');
        signal.addEventListener('abort', aborted, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', aborted);
      }
      onChange?.({ type: 'approval', ...snapshot().find(value => value.requestId === id) });
    });
    return promise;
  }
  function respond(input) {
    const key = JSON.stringify([typeof input.requestId, input.requestId]), entry = pending.get(key);
    if (!entry || input.executorId !== executorId || input.sessionId !== entry.sessionId || input.turnId !== entry.turnId || !isActive(entry.sessionId, entry.turnId)) {
      throw Object.assign(new Error('Native interaction expired or belongs to another worker/turn'), { code: 'NATIVE_APPROVAL_MISMATCH' });
    }
    const result = entry.validate(entry, input);
    settle(key, result, 'answered');
    return { executorId, requestId: entry.requestId, sessionId: entry.sessionId, turnId: entry.turnId, status: 'submitted' };
  }
  return { executorId, request, snapshot, respond, expire, resolved(requestId) {
    const key = JSON.stringify([typeof requestId, requestId]);
    if (pending.has(key)) settle(key, pending.get(key).cancelled, 'resolved-by-provider');
  } };
}
