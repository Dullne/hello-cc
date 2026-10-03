import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { parseOpts, intOpt } from '../lib/cli-args.mjs';
import { createLifecycleCommands } from '../lib/cli/commands/lifecycle.mjs';
import { findLinuxAncestorCliInfo, findMacAncestorCliInfo } from '../lib/integrations/peers/identity.mjs';

function fixture(ancestor) {
  const peers = [];
  const bindings = [];
  let ancestorReads = 0;
  const db = { close() {} };
  const commands = createLifecycleCommands({
    connect: () => db,
    addEvent() {},
    printResult() {},
    parseOpts, intOpt,
    registerProjectActivity() {},
    resolveCurrentPeer: () => ({ id: 'provider-peer' }),
    upsertPeer: (_db, peer) => peers.push(peer),
    upsertCanonicalPeerBinding: (_db, binding) => bindings.push(binding),
    detectBranch: () => 'main',
    readAncestorCliInfo: () => { ancestorReads++; return ancestor; },
    shellExports: () => '',
    path,
    process: { ppid: 321 }
  });
  return {
    ...commands,
    ctx: { cwd: '/test/project', root: '/test/project', dbPath: '/test/project/mesh.db' },
    peers, bindings,
    get ancestorReads() { return ancestorReads; }
  };
}

for (const kind of ['claude', 'codex']) {
  test(`register and join retain the ${kind} provider PID`, async () => {
    const f = fixture({ pid: 900, kind });
    await f.cmdRegister(f.ctx, ['--peer', 'provider-peer', '--kind', kind]);
    await f.cmdJoin(f.ctx, ['--peer', 'provider-peer', '--kind', kind]);
    assert.deepEqual(f.peers.map(peer => peer.pid), [900, 900]);
    assert.deepEqual(f.peers.map(peer => peer.kind), [kind, kind]);
    assert.equal(f.bindings[0].peer, 'provider-peer');
    assert.equal(f.ancestorReads, 2);
  });
}

test('explicit PID wins; manual shell and mismatched providers retain the parent-shell fallback', async () => {
  const f = fixture({ pid: 900, kind: 'codex' });
  await f.cmdRegister(f.ctx, ['--peer', 'provider-peer', '--kind', 'codex', '--pid', '777']);
  await f.cmdJoin(f.ctx, ['--peer', 'provider-peer', '--kind', 'codex', '--pid', '778']);
  assert.deepEqual(f.peers.map(peer => peer.pid), [777, 778]);
  assert.equal(f.ancestorReads, 0);

  await f.cmdRegister(f.ctx, ['--peer', 'provider-peer', '--kind', 'shell']);
  await f.cmdJoin(f.ctx, ['--peer', 'provider-peer', '--kind', 'claude']);
  assert.deepEqual(f.peers.slice(2).map(peer => peer.pid), [321, 321]);
});

test('unknown or invalid ancestor PID cannot replace the shell fallback', async () => {
  for (const ancestor of [null, { kind: 'codex', pid: 0 }, { kind: 'codex', pid: '900' }, { kind: 'dsh', pid: 900 }]) {
    const f = fixture(ancestor);
    await f.cmdRegister(f.ctx, ['--peer', 'provider-peer', '--kind', 'codex']);
    assert.equal(f.peers[0].pid, 321);
  }
});

test('Linux provider executable outranks inherited provider environment on the tool shell', async () => {
  const rows = new Map([
    [300, { parent: 200, args: ['/bin/sh', '-c', 'hcc register'], env: { CODEX_THREAD_ID: 'inherited' } }],
    [200, { parent: 1, args: ['/usr/bin/node', '/pkg/node_modules/@openai/codex/bin/codex.js'], env: { CODEX_THREAD_ID: 'inherited' } }]
  ]);
  const ancestor = findLinuxAncestorCliInfo(300, { read: pid => rows.get(pid) });
  assert.equal(ancestor?.pid, 200);
  assert.equal(ancestor?.kind, 'codex');

  const f = fixture(ancestor);
  await f.cmdRegister(f.ctx, ['--peer', 'provider-peer', '--kind', 'codex']);
  await f.cmdJoin(f.ctx, ['--peer', 'provider-peer', '--kind', 'codex']);
  assert.deepEqual(f.peers.map(peer => peer.pid), [200, 200]);
});

test('macOS provider executable outranks a tool shell command mentioning its path', () => {
  const rows = new Map([
    [300, '200 /bin/zsh -c /usr/local/bin/codex exec'],
    [200, '1 /usr/local/bin/codex exec']
  ]);
  assert.equal(findMacAncestorCliInfo(300, { inspect: pid => rows.get(pid) })?.pid, 200);
});

test('environment-only provider ancestry still works when no executable is visible', () => {
  const ancestor = findLinuxAncestorCliInfo(300, { read: pid => ({
    300: { parent: 1, args: ['/bin/sh', '-c', 'hcc register'], env: { CLAUDE_CODE_SESSION_ID: 'session' } }
  })[pid] });
  assert.equal(ancestor?.pid, 300);
  assert.equal(ancestor?.kind, 'claude');
});
