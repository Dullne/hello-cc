import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshInbox } from '../lib/integrations/dsh-inbox.mjs';

function fixture(t, { pollMs = 1000 } = {}) {
  const timers = new Map(), registry = new Map(), warnings = [], states = new Map();
  let timerId = 0, messageId = 0, bridge;
  const ctx = { agents: { list: () => [...registry.values()], get: id => registry.get(id) },
    logger: { warn: text => warnings.push(text) } };
  const timersApi = {
    schedule(fn) { const timer = { id: ++timerId, unref() {} }; timers.set(timer, fn); return timer; },
    unschedule(timer) { timers.delete(timer); }
  };
  function start() {
    bridge = createDshInbox({ ctx, pollMs, ...timersApi,
      ensure(agent) {
        const state = states.get(agent);
        if (state.invalid) throw new Error('lost project or peer authority');
        return state;
      },
      contextMessage(text) { return { id: `context-${++messageId}`, source: { kind: 'hello-cc', form: 'snapshot' },
        role: 'user', content: [{ type: 'text', text }] }; }
    });
    return bridge;
  }
  function agent(id = `agent-${registry.size + 1}`) {
    const a = { session: { header: { id, cwd: `/project/${id}` } }, status: 'idle', sends: [],
      inbox: { nextTurn: [], nextStep: [],
        get hasPending() { return this.nextTurn.length + this.nextStep.length > 0; },
        remove(id) {
          for (const list of [this.nextTurn, this.nextStep]) {
            const index = list.findIndex(message => message.id === id);
            if (index < 0) continue;
            const [message] = list.splice(index, 1);
            bridge.discarded(a, message);
            return true;
          }
          return false;
        }
      },
      followup(message) { this.sends.push(['followup', message]); this.inbox.nextTurn.push(message); },
      steer(message) { this.sends.push(['steer', message]); this.inbox.nextStep.push(message); }
    };
    const state = { peer: id, unread: [], acked: [], snapshots: 0, complete: true, invalid: false, ackFails: false,
      snapshot({ externalOnly = false } = {}) {
        this.snapshots++;
        if (this.snapshotFails) throw new Error('database unavailable');
        const unread = this.unread.filter(message => !externalOnly || message.sender !== this.peer);
        return { text: unread.map(message => message.body).join('\n'), complete: this.complete,
          hasUnread: unread.length > 0, messages: this.complete ? unread.slice() : [] };
      },
      ack(messages) {
        if (this.ackFails) throw new Error('database busy');
        this.acked.push(...messages.map(message => message.id));
        this.unread = this.unread.filter(message => !messages.some(item => item.id === message.id));
      }
    };
    states.set(a, state); registry.set(id, a);
    return a;
  }
  function tick() {
    const callbacks = [...timers]; timers.clear();
    for (const [, fn] of callbacks) fn();
  }
  function claim(a) {
    const message = a.inbox.nextTurn.shift() || a.inbox.nextStep.shift();
    a.status = 'running'; bridge.claimed(a, message); return message;
  }
  start();
  t.after(() => bridge.dispose());
  return { agent, states, registry, timers, warnings, tick, claim, start,
    get bridge() { return bridge; },
    add(a, id, body = `message ${id}`, sender = 'other-peer') { states.get(a).unread.push({ id, body, sender }); },
    idle(a) { a.status = 'idle'; bridge.idle(a); },
    commit(a, message) { bridge.commit(a.session, { type: 'user/message', data: message }); }
  };
}

test('idle mail wakes exactly once, uses one admitted context and ACKs only exact committed content', t => {
  const f = fixture(t), a = f.agent();
  f.tick(); assert.equal(a.sends.length, 0);
  f.add(a, 1); f.tick(); f.tick();
  assert.equal(a.sends.length, 1);
  assert.equal(a.sends[0][0], 'followup');
  assert.deepEqual(f.states.get(a).acked, []);
  const message = f.claim(a), decision = { kind: 'enter', messages: [message], startsRequestSeries: true };
  assert.equal(f.bridge.step(a, decision, [message]), decision);
  f.bridge.commit({ header: a.session.header }, { type: 'user/message', data: message });
  f.commit(a, { ...message, content: [{ type: 'text', text: 'altered context' }] });
  assert.deepEqual(f.states.get(a).acked, []);
  f.commit(a, { ...message, source: { form: 'snapshot', kind: 'hello-cc' } }); f.commit(a, message);
  assert.deepEqual(f.states.get(a).acked, [1]);
  f.idle(a); f.tick(); assert.equal(a.sends.length, 1);
});

test('idle context excludes own broadcasts while explicit active-turn context still includes them', t => {
  const f = fixture(t), a = f.agent();
  f.add(a, 18, 'own broadcast', f.states.get(a).peer); f.tick();
  assert.equal(a.sends.length, 0); assert.deepEqual(f.states.get(a).acked, []);
  f.add(a, 19, 'external request'); f.tick();
  assert.equal(a.sends.length, 1);
  const message = f.claim(a);
  assert.doesNotMatch(message.content[0].text, /own broadcast/);
  assert.match(message.content[0].text, /external request/);
  f.commit(a, message); assert.deepEqual(f.states.get(a).acked, [19]);
  f.add(a, 20, 'own active-turn message', f.states.get(a).peer);
  f.bridge.steer(a); assert.equal(a.sends.at(-1)[0], 'steer');
  assert.match(a.sends.at(-1)[1].content[0].text, /own broadcast/);
});

test('busy work receives mail at its next admitted step; idle poll does not create a competing turn', t => {
  const f = fixture(t), a = f.agent();
  a.status = 'running'; f.add(a, 2); f.tick();
  assert.equal(a.sends.length, 0);
  const decision = f.bridge.step(a, { kind: 'enter', messages: [] });
  assert.equal(decision.messages.length, 1);
  f.commit(a, decision.messages[0]); f.idle(a); f.tick();
  assert.deepEqual(f.states.get(a).acked, [2]); assert.equal(a.sends.length, 0);
});

test('activity stopping steers unread mail once and does not duplicate its context', t => {
  const f = fixture(t), a = f.agent(); a.status = 'running'; f.add(a, 3);
  f.bridge.steer(a); f.bridge.steer(a);
  assert.deepEqual(a.sends.map(item => item[0]), ['steer']);
  const message = f.claim(a);
  const decision = f.bridge.step(a, { kind: 'enter', messages: [message] }, [message]);
  assert.equal(decision.messages.length, 1);
  f.commit(a, message); assert.deepEqual(f.states.get(a).acked, [3]);
});

test('rejected or removed wake inputs remain unread and cannot create a repeated automatic prompt loop', t => {
  for (const removed of [false, true]) {
    const f = fixture(t), a = f.agent(); f.add(a, 4); f.tick();
    const message = f.claim(a);
    const decision = removed ? { kind: 'enter', messages: [] } : { kind: 'reject' };
    assert.equal(f.bridge.step(a, decision, [message]), decision);
    f.idle(a); f.tick(); f.tick();
    assert.equal(a.sends.length, 1); assert.deepEqual(f.states.get(a).acked, []);
    f.add(a, 5); f.tick(); assert.equal(a.sends.length, 2);
  }
});

test('cancellation before or after claim preserves unread mail without immediately undoing the cancellation', t => {
  for (const claimed of [false, true]) {
    const f = fixture(t), a = f.agent(); f.add(a, 6); f.tick();
    if (claimed) { f.claim(a); f.idle(a); }
    else a.inbox.remove(a.sends[0][1].id);
    f.tick(); f.tick();
    assert.equal(a.sends.length, 1); assert.deepEqual(f.states.get(a).acked, []);
    // A later human turn can still consume the unread collaboration context.
    const decision = f.bridge.step(a, { kind: 'enter', messages: [] });
    f.commit(a, decision.messages[0]); assert.deepEqual(f.states.get(a).acked, [6]);
  }
});

test('cancelling a mixed ordinary snapshot still suppresses its external-only idle batch', t => {
  const f = fixture(t), a = f.agent();
  f.add(a, 21, 'own pending message', f.states.get(a).peer);
  f.add(a, 22, 'external pending message');
  a.status = 'running';
  const decision = f.bridge.step(a, { kind: 'enter', messages: [] });
  assert.match(decision.messages[0].content[0].text, /own pending message/);
  f.idle(a); f.tick(); f.tick();
  assert.equal(a.sends.length, 0);
  assert.deepEqual(f.states.get(a).acked, []);
  f.add(a, 24, 'new own broadcast', f.states.get(a).peer); f.tick();
  f.states.get(a).unread = f.states.get(a).unread.filter(message => message.id !== 21); f.tick();
  assert.equal(a.sends.length, 0, 'self additions and removals cannot undo external cancellation');
  f.bridge.dispose(); f.start(); f.tick();
  assert.equal(a.sends.length, 0, 'reload preserves the external cancellation fingerprint');
  f.add(a, 23, 'new external request'); f.tick();
  assert.equal(a.sends.length, 1);
});

test('failed snapshots and ACKs recover without duplicate dispatch or cross-Agent receipts', t => {
  const f = fixture(t), a = f.agent(), b = f.agent();
  f.add(a, 7); f.add(b, 8); f.states.get(a).snapshotFails = true;
  f.tick(); f.tick(); assert.equal(a.sends.length, 0); assert.equal(b.sends.length, 1);
  assert.equal(f.warnings.length, 1);
  f.states.get(a).snapshotFails = false; f.tick(); assert.equal(a.sends.length, 1);
  const message = f.claim(a); f.states.get(a).ackFails = true; f.commit(a, message);
  f.idle(a); f.tick(); assert.equal(a.sends.length, 1); assert.deepEqual(f.states.get(a).acked, []);
  f.states.get(a).ackFails = false; f.tick();
  assert.deepEqual(f.states.get(a).acked, [7]); assert.deepEqual(f.states.get(b).acked, []);
});

test('project authority loss, exact registry replacement and truncated snapshots never wake', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 9); f.states.get(a).invalid = true;
  f.tick(); assert.equal(a.sends.length, 0);
  f.states.get(a).invalid = false; f.states.get(a).complete = false;
  f.tick(); assert.equal(a.sends.length, 0);
  f.states.get(a).complete = true;
  f.registry.delete(a.session.header.id); f.tick(); assert.equal(a.sends.length, 0);
});

test('pre-step rechecks authority even for a previously queued wake', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 10); f.tick(); const message = f.claim(a);
  f.states.get(a).invalid = true;
  assert.throws(() => f.bridge.step(a, { kind: 'enter', messages: [message] }, [message]), /authority/);
  assert.deepEqual(f.states.get(a).acked, []);
});

test('disposal removes only owned queued input and reload rediscovers existing idle Agents', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 11); f.tick();
  const human = { id: 'human-input' }; a.inbox.nextTurn.push(human);
  f.bridge.dispose(); assert.equal(f.timers.size, 0);
  assert.deepEqual(a.inbox.nextTurn, [human]);
  f.start(); f.tick(); assert.equal(a.sends.length, 1, 'queued human work wins');
  a.inbox.nextTurn.shift(); f.tick(); assert.equal(a.sends.length, 2);
  f.bridge.forget(a); f.registry.delete(a.session.header.id); f.tick();
  assert.equal(a.inbox.hasPending, false); assert.equal(a.sends.length, 2);
});

test('committed receipts survive a same-Agent plugin reload when database ACK was unavailable', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 12); f.tick(); const message = f.claim(a);
  f.states.get(a).ackFails = true; f.commit(a, message); f.idle(a); f.bridge.dispose();
  f.states.get(a).ackFails = false; f.start(); f.tick();
  assert.deepEqual(f.states.get(a).acked, [12]); assert.equal(a.sends.length, 1);
});

test('reload during claimed input retains its exact commit receipt without starting another turn', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 15); f.tick(); const message = f.claim(a);
  f.bridge.step(a, { kind: 'enter', messages: [message] }, [message]);
  f.bridge.dispose(); f.start(); f.commit(a, message); f.idle(a); f.tick();
  assert.deepEqual(f.states.get(a).acked, [15]); assert.equal(a.sends.length, 1);
});

test('reload preserves cancellation and refuses to guess a commit that happened during its listener gap', t => {
  for (const canceled of [false, true]) {
    const f = fixture(t), a = f.agent(); f.add(a, 16); f.tick(); f.claim(a);
    if (canceled) f.idle(a);
    f.bridge.dispose();
    a.status = 'idle'; f.start(); f.tick(); f.tick();
    assert.deepEqual(f.states.get(a).acked, []); assert.equal(a.sends.length, 1);
  }
});

test('a queued wake retained after unload cleanup failure is adopted before its first claimed event', t => {
  const f = fixture(t), a = f.agent(); f.add(a, 17); f.tick();
  const remove = a.inbox.remove; a.inbox.remove = () => { throw new Error('runtime cleanup unavailable'); };
  f.bridge.dispose(); a.inbox.remove = remove; f.start();
  const message = f.claim(a);
  f.bridge.step(a, { kind: 'enter', messages: [message] }, [message]);
  f.commit(a, message); f.idle(a); f.tick();
  assert.deepEqual(f.states.get(a).acked, [17]); assert.equal(a.sends.length, 1);
});

test('disabled polling creates no timer but leaves explicit active-turn steering available', t => {
  const f = fixture(t, { pollMs: 0 }), a = f.agent(); f.add(a, 13); f.tick();
  assert.equal(f.timers.size, 0); assert.equal(a.sends.length, 0);
  a.status = 'running'; f.bridge.steer(a); assert.equal(a.sends.length, 1);
});

test('failed followup retries before insertion but retains a partially inserted message', t => {
  for (const insert of [false, true]) {
    const f = fixture(t), a = f.agent(); f.add(a, 14);
    const followup = a.followup;
    a.followup = function(message) { if (insert) followup.call(this, message); throw new Error('runtime failed'); };
    f.tick(); a.followup = followup; f.tick(); f.tick();
    assert.equal(a.sends.length, 1);
    assert.equal(a.inbox.nextTurn.length, 1);
  }
});
