import { randomUUID } from 'node:crypto';
import { applyStateOperations, SESSION_SYNC_PROTOCOL } from './browser/session-sync.mjs';

export const STATE_HIGH_WATER_BYTES = 1024 * 1024;
export const STATE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const wireClone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));

/** Immutable patch construction; retained text is appended without recopying historical turns. */
export function diffSessionState(previous, next, metadata = {}) {
  const operations = [];
  const set = (path, value) => operations.push({ op: 'set', path, value: wireClone(value) });
  function diff(before, after, path) {
    if (Object.is(before, after)) return;
    if (typeof before === 'string' && typeof after === 'string' && after.startsWith(before)) {
      operations.push({ op: 'append', path, value: after.slice(before.length) }); return;
    }
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) { set(path, after); return; }
    if (Array.isArray(before)) {
      if (before.length !== after.length) { set(path, after); return; }
      for (let index = 0; index < before.length; index++) diff(before[index], after[index], [...path, index]);
      return;
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    if ([...keys].some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) { set(path, after); return; }
    for (const key of keys) {
      if (!Object.hasOwn(after, key) || after[key] === undefined) {
        if (Object.hasOwn(before, key)) operations.push({ op: 'delete', path: [...path, key] });
      }
      else if (!Object.hasOwn(before, key)) set([...path, key], after[key]);
      else diff(before[key], after[key], [...path, key]);
    }
  }
  // Adapter-supplied hints cover every delta in the 50ms batch. Validate layout
  // identities before indexing; newly created/evicted items take the full diff.
  const paths = [];
  const textOnly = metadata.textOnly === true && Array.isArray(metadata.textItems) &&
    previous?.threads?.length === next?.threads?.length && metadata.textItems.every(({ threadId, turnId, itemId }) => {
      const ti = next.threads.findIndex(thread => thread.id === threadId), thread = next.threads[ti], oldThread = previous.threads[ti];
      if (!thread || oldThread?.id !== threadId || oldThread.turns.length !== thread.turns.length) return false;
      const ui = thread.turns.findIndex(turn => turn.id === turnId), turn = thread.turns[ui], oldTurn = oldThread.turns[ui];
      if (!turn || oldTurn?.id !== turnId || turn.items.length !== oldTurn.items.length) return false;
      const ii = turn.items.findIndex(item => item.id === itemId), item = turn.items[ii];
      if (!item || oldTurn.items[ii]?.id !== itemId || item.type !== 'agentMessage') return false;
      paths.push(['threads', ti, 'turns', ui, 'items', ii, 'text']); return true;
    });
  if (textOnly) {
    for (const path of paths) {
      const read = object => path.reduce((value, key) => value?.[key], object);
      diff(read(previous), read(next), path);
    }
    diff(previous.truncated, next.truncated, ['truncated']);
    diff(previous.updateSequence, next.updateSequence, ['updateSequence']);
    const count = next.updateSequence - previous.updateSequence;
    if (Number.isSafeInteger(count) && count > 0 && count <= 100 && Array.isArray(previous.events) && Array.isArray(next.events)) {
      const values = wireClone(next.events.slice(-count));
      operations.push({ op: 'splice', path: ['events'], start: 0, deleteCount: Math.max(0, previous.events.length + values.length - 100), values: [] });
      operations.push({ op: 'splice', path: ['events'], start: Math.min(previous.events.length, 100 - values.length), deleteCount: 0, values });
    } else diff(previous.events, next.events, ['events']);
  } else diff(previous, next, []);
  return operations;
}

/** One server-side revision stream per session, independent of observer count. */
export function createSessionStateStream({ root, sessionId, channel, state, generation = randomUUID() }) {
  let current = wireClone(state), revision = 0;
  const executorId = String(state.executorId || state.owner || '');
  const envelope = () => ({ type: 'state_sync', protocol: SESSION_SYNC_PROTOCOL, root, sessionId, channel, executorId, generation, revision });
  const api = {
    snapshot(requestId) { return { ...envelope(), mode: 'snapshot', state: current, ...(requestId ? { requestId } : {}) }; },
    update(next, metadata) {
      if (String(next.executorId || next.owner || '') !== executorId) return { replaced: true };
      const operations = diffSessionState(current, next, metadata);
      if (!operations.length) return null;
      const baseRevision = revision++;
      current = operations.length > 2048 ? wireClone(next) : applyStateOperations(current, operations);
      // A huge structural replacement is a snapshot; ordinary text stays delta.
      if (operations.length > 2048) return { ...envelope(), mode: 'snapshot', state: current, replacement: true };
      return { ...envelope(), mode: 'patch', baseRevision, operations };
    }
  };
  Object.defineProperties(api, { executorId: { get: () => executorId }, state: { get: () => current } });
  return api;
}

/** Slow structured observers disconnect and recover from a new snapshot. No work is replayed. */
export function sendStructuredFrame(client, text) {
  if (client.hccStateClosing || client.readyState !== client.OPEN) return false;
  const bytes = Buffer.byteLength(text);
  if ((client.bufferedAmount || 0) > STATE_HIGH_WATER_BYTES || bytes > STATE_MAX_FRAME_BYTES) {
    client.hccStateClosing = true;
    try { client.close(bytes > STATE_MAX_FRAME_BYTES ? 1009 : 1013, 'state stream requires snapshot recovery'); } catch { client.terminate?.(); }
    // close() itself may be queued behind a slow reader. Bound that lifetime.
    const timer = setTimeout(() => { if (client.readyState !== client.CLOSED) client.terminate?.(); }, 1000);
    timer.unref?.(); client.once?.('close', () => clearTimeout(timer));
    return false;
  }
  client.send(text); return true;
}
