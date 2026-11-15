import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { completionPoller } from '../lib/shared/completion-poller.mjs';

test('slow discovery scans leave a full polling interval after completion and never overlap', async t => {
  const starts = [], ends = [];
  let active = 0, maximum = 0, stopped = false;
  const timer = completionPoller(async () => {
    active++; maximum = Math.max(maximum, active); starts.push(performance.now());
    await delay(70);
    ends.push(performance.now()); active--;
    if (ends.length === 3) stopped = true;
  }, 30, () => stopped);
  t.after(() => clearInterval(timer));
  for (let i = 0; i < 100 && !stopped; i++) await delay(10);
  assert.equal(stopped, true);
  assert.equal(maximum, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - ends[i - 1] >= 20, 'scan restarted before its cooldown');
});

test('stopping during discovery prevents the in-flight callback from rearming its timer', async () => {
  let stopped = false, calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const timer = completionPoller(async () => { calls++; await pending; }, 10, () => stopped);
  await delay(30);
  stopped = true; clearInterval(timer); release();
  await delay(50);
  assert.equal(calls, 1);
});

test('clearInterval alone cancels a completion poller while its callback is pending', async () => {
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const timer = completionPoller(async () => { calls++; await pending; }, 10, () => false);
  await delay(30);
  clearInterval(timer); release();
  await delay(50);
  assert.equal(calls, 1);
});

for (const mode of ['synchronous', 'asynchronous']) {
  test(`expensive ${mode} scans yield a proportional cooldown for foreground requests`, async t => {
    const starts = [], ends = [];
    let stopped = false;
    const timer = completionPoller(async () => {
      starts.push(performance.now());
      if (mode === 'synchronous') {
        const until = performance.now() + 30;
        while (performance.now() < until) { /* Simulate synchronous native validation. */ }
      } else await delay(30);
      ends.push(performance.now());
      if (ends.length === 2) stopped = true;
    }, 10, () => stopped, { cooldownFactor: 3 });
    t.after(() => clearInterval(timer));
    for (let i = 0; i < 100 && !stopped; i++) await delay(10);
    assert.equal(stopped, true);
    assert.ok(starts[1] - ends[0] >= 85, 'expensive scan did not leave its proportional cooldown');
  });
}
