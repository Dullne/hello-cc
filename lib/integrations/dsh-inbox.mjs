// Official Agent inbox delivery. A queued wake is not a read receipt: only the
// corresponding committed user/message can acknowledge coordination messages.
const registryKey = Symbol.for('@logicseek/hello-cc/dsh-inbox/receipts/v1');
if (!Object.hasOwn(globalThis, registryKey)) {
  Object.defineProperty(globalThis, registryKey, { value: new WeakMap() });
}
const receipts = globalThis[registryKey];
const handoffKey = Symbol.for('@logicseek/hello-cc/dsh-inbox/handoffs/v1');
if (!Object.hasOwn(globalThis, handoffKey)) {
  Object.defineProperty(globalThis, handoffKey, {
    value: Object.freeze({ pending: new WeakMap(), blocked: new WeakMap() })
  });
}
const handoffs = globalThis[handoffKey];
const signature = messages => JSON.stringify(messages.map(message => message.id));
const sameContents = (left, right) => isDeepStrictEqual(
  [left.source, left.content], [right.source, right.content]);

export function createDshInbox({ ctx, ensure, contextMessage, pollMs,
  schedule = setTimeout, unschedule = clearTimeout }) {
  const pending = new Map(), agents = new Map();
  let stopped = false, polling = false, timer;

  function entryFor(agent) {
    let entry = agents.get(agent);
    if (!entry) {
      entry = { wake: null, blocked: handoffs.blocked.get(agent) || null, warned: false };
      agents.set(agent, entry);
    }
    return entry;
  }
  function warn(agent) {
    const entry = entryFor(agent);
    if (entry.warned) return;
    entry.warned = true;
    // Runtime errors can contain user paths or configuration. Log no payload.
    try { ctx.logger?.warn('hello-cc inbox delivery deferred; it will retry after the runtime recovers'); } catch {}
  }
  function acknowledge(agent) {
    const saved = receipts.get(agent);
    if (!saved?.size) return;
    const state = ensure(agent);
    for (const [id, receipt] of saved) {
      if (receipt.session !== agent.session) throw new Error('Cordis receipt Session changed');
      state.ack(receipt.messages);
      saved.delete(id);
    }
    receipts.delete(agent);
  }
  function clearPending(agent, except = null) {
    for (const [id, delivery] of pending) {
      if (delivery.agent === agent && id !== except && !delivery.queued) pending.delete(id);
    }
  }
  function prepare(agent, externalOnly = false) {
    acknowledge(agent);
    const state = ensure(agent);
    const snapshot = state.snapshot({ externalOnly });
    const message = contextMessage(snapshot.text);
    const delivery = { agent, session: agent.session, message, messages: snapshot.messages,
      signature: signature(snapshot.messages),
      externalSignature: signature(snapshot.messages.filter(item => item.sender !== state.peer)),
      queued: false, claimed: false };
    if (snapshot.messages.length) pending.set(message.id, delivery);
    return { state, message, snapshot, delivery };
  }
  function block(agent, delivery) {
    if (!delivery) return;
    const entry = entryFor(agent);
    entry.blocked = { all: delivery.signature, external: delivery.externalSignature };
    handoffs.blocked.set(agent, entry.blocked);
    if (entry.wake === delivery) entry.wake = null;
    pending.delete(delivery.message.id);
  }
  function queued(agent, id) {
    return [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])].some(message => message.id === id);
  }
  function live(agent) {
    return !stopped && ctx.agents?.get(agent.session.header.id) === agent;
  }
  function adopt(agent) {
    const carried = handoffs.pending.get(agent);
    if (!carried) return;
    const entry = entryFor(agent);
    for (const delivery of carried.values()) {
      if (delivery.session !== agent.session) throw new Error('Cordis pending Session changed');
      pending.set(delivery.message.id, delivery);
      if (delivery.queued) entry.wake = delivery;
      // A commit during the reload gap cannot be inferred from idle. Preserve
      // unread data and suppress an automatic replay of that uncertain batch.
      if (agent.status === 'idle' && !queued(agent, delivery.message.id)) block(agent, delivery);
    }
    handoffs.pending.delete(agent);
  }
  function enqueue(agent, method) {
    adopt(agent);
    const entry = entryFor(agent);
    if (entry.wake) return;
    clearPending(agent);
    const prepared = prepare(agent, method === 'followup');
    const { state, snapshot, delivery, message } = prepared;
    const blocked = method === 'followup'
      ? entry.blocked?.external === delivery.externalSignature
      : entry.blocked?.all === delivery.signature;
    if (!snapshot.complete || !snapshot.hasUnread || !snapshot.messages.length ||
        (method === 'followup' && !snapshot.messages.some(item => item.sender !== state.peer)) ||
        blocked) {
      pending.delete(message.id);
      return;
    }
    // Snapshot verifies the exact project/peer owner immediately before send.
    if (!live(agent) || (method === 'followup' &&
        (agent.status !== 'idle' || agent.inbox?.hasPending))) {
      pending.delete(message.id);
      return;
    }
    entry.wake = delivery;
    delivery.queued = true;
    try { agent[method](message); }
    catch (error) {
      // A runtime failure after insertion must not enqueue a second copy.
      if (!queued(agent, message.id) && !delivery.claimed) {
        pending.delete(message.id);
        if (entry.wake === delivery) entry.wake = null;
      }
      throw error;
    }
  }
  function arm() {
    if (!stopped && pollMs > 0) {
      timer = schedule(poll, pollMs);
      timer?.unref?.();
    }
  }
  function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      // Also discovers already-live Agents after profile hot reload. It never
      // resumes cold sessions or creates a provider process.
      for (const agent of ctx.agents?.list() || []) {
        if (!live(agent)) continue;
        try {
          ensure(agent);
          adopt(agent);
          acknowledge(agent);
          if (agent.status === 'idle' && !agent.inbox?.hasPending) enqueue(agent, 'followup');
          entryFor(agent).warned = false;
        } catch { warn(agent); }
      }
    } catch {
      // Registry enumeration can fail during Host disposal; the next poll can
      // recover without an uncaught timer exception or an overlapping scan.
    } finally {
      polling = false;
      arm();
    }
  }
  arm();
  return {
    step(agent, decision, proposed = []) {
      adopt(agent);
      const entry = entryFor(agent), wake = entry.wake;
      ensure(agent);
      if (decision.kind !== 'enter') {
        if (wake && proposed.some(message => message.id === wake.message.id)) block(agent, wake);
        return decision;
      }
      acknowledge(agent);
      // Keep the exact queued context once. The downstream admission chain may
      // remove it; do not put rejected content back or acknowledge altered text.
      if (wake && proposed.some(message => message.id === wake.message.id)) {
        const accepted = decision.messages.find(message => message.id === wake.message.id);
        if (!accepted || !sameContents(accepted, wake.message)) block(agent, wake);
        else ensure(agent).snapshot();
        return decision;
      }
      clearPending(agent);
      const { message } = prepare(agent);
      return { ...decision, messages: [...decision.messages, message] };
    },
    commit(session, event) {
      if (stopped || event.type !== 'user/message') return;
      if (!pending.has(event.data.id)) {
        const agent = ctx.agents?.get(session.header.id);
        if (agent?.session === session) adopt(agent);
      }
      const delivery = pending.get(event.data.id);
      if (!delivery || delivery.session !== session || !sameContents(event.data, delivery.message)) return;
      pending.delete(event.data.id);
      const entry = entryFor(delivery.agent);
      if (entry.wake === delivery) entry.wake = null;
      entry.blocked = null;
      handoffs.blocked.delete(delivery.agent);
      const saved = receipts.get(delivery.agent) || new Map();
      saved.set(event.data.id, delivery);
      receipts.set(delivery.agent, saved);
      try { acknowledge(delivery.agent); } catch { warn(delivery.agent); }
    },
    claimed(agent, message) {
      adopt(agent);
      const delivery = pending.get(message.id);
      if (delivery?.agent === agent) delivery.claimed = true;
    },
    discarded(agent, message) {
      if (stopped) return;
      adopt(agent);
      const delivery = pending.get(message.id);
      if (delivery?.agent === agent) block(agent, delivery);
    },
    idle(agent) {
      adopt(agent);
      // Failed preparation/cancellation after claim leaves unread input. Wait
      // for explicit work or a different unread batch instead of a prompt loop.
      for (const delivery of pending.values()) {
        if (delivery.agent === agent && (delivery.claimed || !delivery.queued)) block(agent, delivery);
      }
    },
    steer(agent) { enqueue(agent, 'steer'); },
    forget(agent) {
      const wake = agents.get(agent)?.wake;
      if (wake && queued(agent, wake.message.id)) {
        try { agent.inbox.remove(wake.message.id); } catch { warn(agent); }
      }
      for (const [id, delivery] of pending) if (delivery.agent === agent) pending.delete(id);
      agents.delete(agent);
      handoffs.pending.delete(agent);
      handoffs.blocked.delete(agent);
    },
    dispose() {
      stopped = true;
      unschedule(timer);
      for (const agent of [...agents.keys()]) {
        const wake = agents.get(agent)?.wake;
        if (wake && queued(agent, wake.message.id)) {
          try {
            if (agent.inbox.remove(wake.message.id)) pending.delete(wake.message.id);
          } catch { warn(agent); }
        }
      }
      for (const delivery of pending.values()) {
        const carried = handoffs.pending.get(delivery.agent) || new Map();
        carried.set(delivery.message.id, delivery);
        handoffs.pending.set(delivery.agent, carried);
      }
      pending.clear();
      agents.clear();
    }
  };
}
import { isDeepStrictEqual } from 'node:util';
