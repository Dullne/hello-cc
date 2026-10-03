/** Structured session wire protocol. This module is shared by Node and browsers. */
export const SESSION_SYNC_PROTOCOL = 1;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** @typedef {{op:'set'|'delete'|'append'|'splice', path:(string|number)[], value?:unknown, start?:number, deleteCount?:number, values?:unknown[]}} StateOperation */

/** Copy only changed ancestors. Never mutate a previously delivered UI state. */
export function applyStateOperations(state, operations) {
  if (!Array.isArray(operations) || operations.length > 2048) throw new Error('Invalid operations');
  let result = state;
  for (const operation of operations) {
    const path = operation.path;
    if (!Array.isArray(path) || path.length > 32 || path.some(key =>
      !(typeof key === 'string' || Number.isSafeInteger(key) && key >= 0) || forbidden.has(String(key)))) throw new Error('Invalid path');
    const update = (value, depth) => {
      if (depth === path.length) {
        if (operation.op === 'set') return structuredClone(operation.value);
        if (operation.op === 'append' && typeof value === 'string' && typeof operation.value === 'string') return value + operation.value;
        if (operation.op === 'splice' && Array.isArray(value) && Array.isArray(operation.values) &&
            Number.isSafeInteger(operation.start) && operation.start >= 0 && operation.start <= value.length &&
            Number.isSafeInteger(operation.deleteCount) && operation.deleteCount >= 0 && operation.deleteCount <= value.length - operation.start) {
          const copy = value.slice(); copy.splice(operation.start, operation.deleteCount, ...structuredClone(operation.values)); return copy;
        }
        throw new Error('Invalid operation');
      }
      if (!value || typeof value !== 'object') throw new Error('Missing path');
      const key = path[depth], last = depth === path.length - 1;
      if (Array.isArray(value) && (!Number.isSafeInteger(key) || key >= value.length)) throw new Error('Invalid array path');
      if (!Object.hasOwn(value, key) && !(last && operation.op === 'set' && !Array.isArray(value))) throw new Error('Missing path');
      const copy = Array.isArray(value) ? value.slice() : { ...value };
      if (last && operation.op === 'delete' && !Array.isArray(value)) delete copy[key];
      else copy[key] = update(value[key], depth + 1);
      return copy;
    };
    result = update(result, 0);
  }
  return result;
}

/**
 * One receiver per WebSocket. Reconnection must create a receiver or reset it.
 * onState receives immutable-by-convention state; recovery never sends input.
 * @param {{root:string,sessionId:string,onState?:(state:object,channel:string)=>void,requestSnapshot?:(frame:object)=>void}} options
 */
export function createSessionSync({ root, sessionId, onState = () => {}, requestSnapshot = () => {} }) {
  let state = null, generation = null, executorId = null, revision = -1, channel = null, requestId = null, sequence = 0;
  function recover(reason) {
    if (!requestId) {
      requestId = 'sync-' + ++sequence;
      requestSnapshot({ type: 'state_sync_request', protocol: SESSION_SYNC_PROTOCOL, requestId });
    }
    return { accepted: false, recovery: true, reason };
  }
  function receive(frame) {
    if (frame?.type !== 'state_sync') return { accepted: false, ignored: true };
    if (frame.protocol !== SESSION_SYNC_PROTOCOL || frame.root !== root || frame.sessionId !== sessionId ||
        !['codex', 'native'].includes(frame.channel) || typeof frame.generation !== 'string' || !frame.generation ||
        typeof frame.executorId !== 'string' || !Number.isSafeInteger(frame.revision) || frame.revision < 0) return recover('scope-or-version');
    if (generation && (frame.generation !== generation || frame.executorId !== executorId || frame.channel !== channel)) return recover('executor-or-generation');
    if (frame.mode === 'snapshot') {
      if (!frame.state || typeof frame.state !== 'object' || Array.isArray(frame.state)) return recover('invalid-snapshot');
      if (frame.state.executorId != null && frame.state.executorId !== frame.executorId) return recover('executor-state-mismatch');
      if (generation && (!requestId || frame.requestId !== requestId || frame.revision < revision)) return recover('unsolicited-or-stale-snapshot');
      if (requestId && frame.requestId !== requestId) return { accepted: false, recovery: true, reason: 'waiting-for-recovery' };
      state = structuredClone(frame.state); generation = frame.generation; executorId = frame.executorId; channel = frame.channel;
    } else if (frame.mode === 'patch') {
      if (requestId) return { accepted: false, recovery: true, reason: 'waiting-for-recovery' };
      if (!generation || frame.baseRevision !== revision || frame.revision !== revision + 1) return recover('revision-gap');
      try {
        const next = applyStateOperations(state, frame.operations);
        if (next.executorId != null && next.executorId !== executorId) return recover('executor-state-mismatch');
        state = next;
      } catch { return recover('invalid-patch'); }
    } else return recover('unknown-mode');
    revision = frame.revision; requestId = null;
    onState(state, channel);
    return { accepted: true, revision, generation };
  }
  const api = { receive, reset() { state = null; generation = null; executorId = null; revision = -1; channel = null; requestId = null; } };
  Object.defineProperties(api, { state: { get: () => state }, revision: { get: () => revision }, recovering: { get: () => Boolean(requestId) } });
  return api;
}
