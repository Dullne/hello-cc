import assert from 'node:assert/strict';
import test from 'node:test';

import { pollTmuxSessionExit } from '../lib/web/tmux-sessions.mjs';

const original = { pid: 77, startToken: 'boot:one', commandHash: 'a'.repeat(64) };
const reused = { ...original, startToken: 'boot:two' };
const session = () => ({
  pane: '%7', pid: original.pid,
  adoptionIdentity: { process_identity: original }
});
const missingPane = () => {
  const error = new Error("can't find pane: %7");
  error.code = 'TMUX_ERROR';
  throw error;
};

for (const [name, observed, expected] of [
  ['live original process', { state: 'live', identity: original }, 'detached'],
  ['unknown process', { state: 'unknown', identity: null }, 'detached'],
  ['dead original process', { state: 'dead', identity: null }, 'exited'],
  ['reused original PID', { state: 'live', identity: reused }, 'exited']
]) {
  test(`missing tmux pane with ${name} yields ${expected} after three polls`, () => {
    const state = { deadCount: 0 };
    const detached = [];
    const tick = () => pollTmuxSessionExit(session(), state, {
      paneInfo: missingPane,
      inspectProcess: () => observed,
      detach: (_session, status) => detached.push(status)
    });
    tick(); tick();
    assert.deepEqual(detached, []);
    tick();
    assert.deepEqual(detached, [expected]);
  });
}

test('dead pane with live original process detaches Web without asserting exit', () => {
  const state = { deadCount: 0 };
  const detached = [];
  const tick = () => pollTmuxSessionExit(session(), state, {
    paneInfo: () => ({ pane: '%7', pid: 77, dead: true }),
    inspectProcess: () => ({ state: 'live', identity: original }),
    detach: (_session, status) => detached.push(status)
  });
  tick(); tick(); tick();
  assert.deepEqual(detached, ['detached']);
});

test('reused pane PID detaches immediately and never follows the replacement', () => {
  const detached = [];
  pollTmuxSessionExit(session(), { deadCount: 0 }, {
    paneInfo: () => ({ pane: '%7', pid: 88, dead: false }),
    inspectProcess: () => ({ state: 'live', identity: original }),
    detach: (_session, status) => detached.push(status)
  });
  assert.deepEqual(detached, ['detached']);
});

test('reused process identity at the same pane and PID exits the original immediately', () => {
  const detached = [];
  pollTmuxSessionExit(session(), { deadCount: 0 }, {
    paneInfo: () => ({ pane: '%7', pid: 77, dead: false }),
    inspectProcess: () => ({ state: 'live', identity: reused }),
    detach: (_session, status) => detached.push(status)
  });
  assert.deepEqual(detached, ['exited']);
});

test('healthy pane or transient tmux error resets the missing-pane count', () => {
  const state = { deadCount: 0 };
  const detached = [];
  let result = 'missing';
  const paneInfo = () => {
    if (result === 'missing') return missingPane();
    if (result === 'busy') throw Object.assign(new Error('server busy'), { code: 'TMUX_ERROR' });
    return { pane: '%7', pid: 77, dead: false };
  };
  const tick = () => pollTmuxSessionExit(session(), state, {
    paneInfo,
    inspectProcess: () => ({ state: 'live', identity: original }),
    detach: (_session, status) => detached.push(status)
  });
  tick(); tick();
  result = 'busy'; tick();
  result = 'missing'; tick(); tick();
  assert.deepEqual(detached, []);
  result = 'healthy'; tick();
  result = 'missing'; tick(); tick(); tick();
  assert.deepEqual(detached, ['detached']);
});
