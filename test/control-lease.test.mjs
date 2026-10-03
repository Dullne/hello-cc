import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlLeaseError, createControlLease } from '../lib/web/control-lease.mjs';

function fixture(options = {}) {
  let time = 1_000;
  let timerId = 0;
  const timers = new Map();
  const notifications = [];
  const lease = createControlLease({
    nowMs: () => time,
    disconnectGraceMs: 100,
    broadcast: (session, payload) => notifications.push({ session, payload }),
    schedule: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    ...options
  });
  return {
    lease, timers, notifications,
    advance(ms, runTimers = true) {
      time += ms;
      if (runTimers) {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.fn();
          }
        }
      }
    }
  };
}

function code(expected) {
  return (error) => error instanceof ControlLeaseError && error.code === expected;
}

test('first socket controls the session while another connected socket can only observe', () => {
  const { lease, notifications } = fixture();
  const session = {};
  const controller = lease.connect(session, 'secret-one');
  const observer = lease.connect(session, 'secret-two');
  assert.equal(controller.can_control, true);
  assert.equal(controller.epoch, 1);
  assert.equal(observer.can_control, false);
  assert.equal(observer.controller_id, controller.client_id);
  assert.equal(observer.client_count, 2);
  assert.equal(lease.assertControl(session, 'secret-one', controller.epoch).can_control, true);
  assert.throws(() => lease.assertControl(session, 'secret-two', observer.epoch), code('CONTROL_REQUIRED'));
  assert.throws(() => lease.claim(session, 'secret-two', { epoch: observer.epoch }), code('CONTROL_HELD'));
  const broadcastText = JSON.stringify(notifications);
  assert.doesNotMatch(broadcastText, /secret-one|secret-two/);
  assert.equal(notifications.at(-1).payload.type, 'control');
});

test('explicit takeover fences queued input and stale takeover requests', () => {
  const { lease } = fixture();
  const session = {};
  const first = lease.connect(session, 'one');
  lease.connect(session, 'two');
  const second = lease.claim(session, 'two', { epoch: first.epoch, takeover: true });
  assert.equal(second.can_control, true);
  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(lease.status(session, 'one').can_control, false);
  assert.throws(() => lease.assertControl(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));
  assert.throws(() => lease.claim(session, 'one', { epoch: first.epoch, takeover: true }), code('STALE_CONTROL_EPOCH'));
  assert.throws(() => lease.release(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));

  const reclaimed = lease.claim(session, 'one', { epoch: second.epoch, takeover: true });
  assert.equal(reclaimed.epoch, second.epoch + 1);
  assert.throws(() => lease.assertControl(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));
  assert.equal(lease.assertControl(session, 'one', reclaimed.epoch).can_control, true);
});

test('disconnect retains control during grace but rejects writes and automatic observer promotion', () => {
  const f = fixture();
  const session = {};
  const first = f.lease.connect(session, 'one');
  f.lease.connect(session, 'two');
  const retained = f.lease.disconnect(session, 'one');
  assert.equal(retained.has_controller, true);
  assert.equal(retained.controller_connected, false);
  assert.equal(retained.expires_at, 1_100);
  assert.equal(retained.client_count, 1);
  assert.equal(retained.can_control, false);
  assert.throws(() => f.lease.assertControl(session, 'one', first.epoch), code('UNKNOWN_CONTROL_CLIENT'));
  f.advance(99);
  assert.equal(f.lease.connect(session, 'three').can_control, false);
  assert.throws(() => f.lease.claim(session, 'two', { epoch: first.epoch }), code('CONTROL_HELD'));

  f.advance(1);
  const expired = f.lease.status(session, 'two');
  assert.equal(expired.has_controller, false);
  assert.equal(expired.epoch, first.epoch + 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.notifications.at(-1).payload.control.has_controller, false);
  const claimed = f.lease.claim(session, 'two', { epoch: expired.epoch });
  assert.equal(claimed.can_control, true);
});

test('takeover during disconnect grace cancels expiry without revoking the new controller', () => {
  const f = fixture();
  const session = {};
  const first = f.lease.connect(session, 'one');
  f.lease.connect(session, 'two');
  f.lease.disconnect(session, 'one');
  const takeover = f.lease.claim(session, 'two', { epoch: first.epoch, takeover: true });
  assert.equal(f.timers.size, 0);
  f.advance(200);
  assert.equal(f.lease.assertControl(session, 'two', takeover.epoch).can_control, true);
  assert.equal(f.lease.connect(session, 'one').can_control, false);
});

test('reconnection of the retained token preserves its identity and fences old input', () => {
  const f = fixture();
  const session = {};
  const first = f.lease.connect(session, 'one');
  f.lease.disconnect(session, 'one');
  f.advance(20);
  const resumed = f.lease.connect(session, 'one');
  assert.equal(resumed.client_id, first.client_id);
  assert.equal(resumed.controller_connected, true);
  assert.equal(resumed.can_control, true);
  assert.equal(resumed.expires_at, null);
  assert.equal(resumed.epoch, first.epoch + 1);
  assert.equal(f.timers.size, 0);
  assert.throws(() => f.lease.assertControl(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));
});

test('release fences the former owner until a connected client explicitly claims', () => {
  const { lease } = fixture();
  const session = {};
  const first = lease.connect(session, 'one');
  lease.connect(session, 'two');
  const released = lease.release(session, 'one', first.epoch);
  assert.equal(released.has_controller, false);
  assert.equal(released.can_control, false);
  assert.equal(released.client_count, 2);
  assert.throws(() => lease.assertControl(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));
  assert.throws(() => lease.assertControl(session, 'two', released.epoch), code('CONTROL_REQUIRED'));
  assert.equal(lease.claim(session, 'two', { epoch: released.epoch }).can_control, true);
});

test('session ownership is independent even when sessions share names and token text', () => {
  const { lease } = fixture();
  const firstSession = { id: 'same', root: '/project-one' };
  const secondSession = { id: 'same', root: '/project-two' };
  const first = lease.connect(firstSession, 'one');
  const second = lease.connect(secondSession, 'one');
  lease.connect(firstSession, 'two');
  lease.claim(firstSession, 'two', { epoch: first.epoch, takeover: true });
  assert.equal(lease.assertControl(secondSession, 'one', second.epoch).can_control, true);
  assert.throws(() => lease.assertControl(secondSession, 'two', second.epoch), code('UNKNOWN_CONTROL_CLIENT'));
});

test('epochs and known live tokens are mandatory on every protected mutation', () => {
  const { lease } = fixture();
  const session = {};
  const first = lease.connect(session, 'one');
  for (const epoch of [undefined, null, '1', NaN, -1, first.epoch + 1]) {
    assert.throws(() => lease.assertControl(session, 'one', epoch), code('STALE_CONTROL_EPOCH'));
    assert.throws(() => lease.release(session, 'one', epoch), code('STALE_CONTROL_EPOCH'));
    assert.throws(() => lease.claim(session, 'one', { epoch }), code('STALE_CONTROL_EPOCH'));
  }
  assert.throws(() => lease.connect(session, ''), code('UNKNOWN_CONTROL_CLIENT'));
  assert.throws(() => lease.connect(session, 'one'), code('CONTROL_CLIENT_CONNECTED'));
  assert.throws(() => lease.claim(session, 'forged', { epoch: first.epoch, takeover: true }), code('UNKNOWN_CONTROL_CLIENT'));
  assert.equal(lease.status(session, 'forged').can_control, false);
});

test('status expires leases lazily when their timer has not fired', () => {
  const f = fixture();
  const session = {};
  f.lease.connect(session, 'one');
  f.lease.disconnect(session, 'one');
  f.advance(100, false);
  assert.equal(f.lease.status(session).has_controller, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.lease.connect(session, 'two').can_control, true);
});

test('disconnecting an observer is idempotent and preserves the controller epoch', () => {
  const { lease } = fixture();
  const session = {};
  const first = lease.connect(session, 'one');
  lease.connect(session, 'two');
  lease.disconnect(session, 'two');
  lease.disconnect(session, 'two');
  assert.equal(lease.assertControl(session, 'one', first.epoch).can_control, true);
  assert.equal(lease.status(session).client_count, 1);
});

test('forget cancels retained ownership timers and removes client authority', () => {
  const f = fixture();
  const session = {};
  const first = f.lease.connect(session, 'one');
  f.lease.disconnect(session, 'one');
  f.lease.forget(session);
  f.lease.forget(session);
  assert.equal(f.timers.size, 0);
  f.advance(100);
  assert.throws(() => f.lease.assertControl(session, 'one', first.epoch), code('UNKNOWN_CONTROL_CLIENT'));
});

test('failed broadcasts cannot roll back ownership or fencing', () => {
  const { lease } = fixture({ broadcast: () => { throw new Error('socket closed'); } });
  const session = {};
  const first = lease.connect(session, 'one');
  lease.connect(session, 'two');
  const second = lease.claim(session, 'two', { epoch: first.epoch, takeover: true });
  assert.equal(lease.assertControl(session, 'two', second.epoch).can_control, true);
  assert.throws(() => lease.assertControl(session, 'one', first.epoch), code('STALE_CONTROL_EPOCH'));
});
