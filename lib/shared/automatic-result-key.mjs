import { createHash } from 'node:crypto';

export function automaticResultKey({ executorId, threadId, turnId, kind, itemId = null }) {
  const identity = [executorId, threadId, turnId, kind, itemId];
  return `automatic:${kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
