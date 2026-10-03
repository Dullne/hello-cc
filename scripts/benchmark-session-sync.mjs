// Fixed-input transport benchmark. No processes, providers, model calls or user sessions.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createSessionStateStream } from '../lib/web/session-state-sync.mjs';
import { createSessionSync } from '../lib/web/browser/session-sync.mjs';

export function benchmarkSessionSync({ fragments = 1000, batchSize = 5 } = {}) {
  function fixture() {
    const turns = Array.from({ length: 9 }, (_, turn) => ({ id: 'history-' + turn, status: 'completed', items:
      Array.from({ length: 30 }, (_, item) => ({ id: 'item-' + item, type: 'agentMessage', text: 'Fixed retained history '.repeat(48) })) }));
    turns.push({ id: 'active', status: 'inProgress', items: [{ id: 'message', type: 'agentMessage', text: '' }] });
    return { executorId: 'benchmark-executor', status: 'ready', threads: [{ id: 'thread', turns }], updateSequence: 0, events: [], truncated: false, pendingApprovals: [] };
  }
  function run(incremental) {
    const state = fixture(), samples = [], cpuStart = process.cpuUsage(), start = performance.now();
    const stream = incremental ? createSessionStateStream({ root: '/benchmark', sessionId: 'session', channel: 'codex', state, generation: 'benchmark' }) : null;
    const receiver = createSessionSync({ root: '/benchmark', sessionId: 'session', requestSnapshot() { throw new Error('Unexpected recovery'); } });
    let bytes = 0, frames = 0, received;
    function deliver(frame) {
      const encoded = JSON.stringify(frame); bytes += Buffer.byteLength(encoded); frames++;
      const decoded = JSON.parse(encoded);
      if (incremental) { assert.equal(receiver.receive(decoded).accepted, true); received = receiver.state; }
      else received = decoded.state;
    }
    deliver(incremental ? stream.snapshot() : { type: 'codex_state', state: structuredClone(state) });
    for (let index = 0; index < fragments; index++) {
      const text = 'token-' + String(index).padStart(4, '0') + '|';
      state.threads[0].turns[9].items[0].text += text;
      state.events.push({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'active', itemId: 'message', delta: text }, at: index });
      if (state.events.length > 100) state.events.shift();
      state.updateSequence++;
      if ((index + 1) % batchSize === 0 || index === fragments - 1) {
        const tick = performance.now();
        deliver(incremental ? stream.update(state, { textOnly: true, textItems: [{ threadId: 'thread', turnId: 'active', itemId: 'message' }] })
          : { type: 'codex_state', state: structuredClone(state) });
        samples.push(performance.now() - tick);
      }
    }
    assert.deepEqual(received, state);
    const cpu = process.cpuUsage(cpuStart), elapsedMs = performance.now() - start;
    samples.sort((a, b) => a - b);
    return { frames, bytes, elapsedMs: +elapsedMs.toFixed(3), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(3),
      p95DeliveryMs: +samples[Math.floor(samples.length * .95)].toFixed(3), initialStateBytes: Buffer.byteLength(JSON.stringify(fixture())),
      finalStateBytes: Buffer.byteLength(JSON.stringify(state)), finalOutputCharacters: state.threads[0].turns[9].items[0].text.length };
  }
  const legacy = run(false), incremental = run(true);
  return { workload: { fragments, batchSize, sameInput: true, coldSnapshotIncluded: true, observers: 1 }, legacy, incremental,
    byteReductionPercent: +((1 - incremental.bytes / legacy.bytes) * 100).toFixed(2),
    limits: 'Synchronization layer only: server copy/diff/encode plus receiver parse/apply. Excludes provider parsing, SQLite, socket scheduling and browser DOM. Timing is machine-dependent; not production capacity.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(benchmarkSessionSync(), null, 2));
