import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providerRestartReason
} from '../lib/core/sessions/launch.mjs';
import {
  findLinuxAncestorCliInfo,
  findMacAncestorCliInfo,
  parseMacAncestorLine
} from '../lib/integrations/peers/identity.mjs';

test('provider restart requires confirmed-dead owner identity and treats unknown as live-safe', () => {
  assert.equal(providerRestartReason({
    providerState: 'exited',
    ownerEvidence: { state: 'live' },
    paneCommand: 'bash'
  }), null);
  assert.equal(providerRestartReason({
    providerState: 'exited',
    ownerEvidence: { state: 'unknown' },
    paneCommand: 'bash'
  }), null);
  assert.equal(providerRestartReason({
    providerState: 'exited',
    ownerEvidence: { state: 'dead' },
    paneCommand: 'bash'
  }), 'provider_exited');
  assert.equal(providerRestartReason({
    providerState: null,
    ownerEvidence: { state: 'dead' },
    paneCommand: 'bash'
  }), 'provider_fallback_shell');
  assert.equal(providerRestartReason({
    providerState: null,
    ownerEvidence: { state: 'dead' },
    paneCommand: 'node'
  }), null);
});

test('macOS ancestor parsing is single-line, locale-independent input', () => {
  assert.deepEqual(parseMacAncestorLine('  42 /opt/homebrew/bin/node /usr/local/bin/codex resume abc\n'), {
    ppid: 42,
    command: '/opt/homebrew/bin/node /usr/local/bin/codex resume abc'
  });
  for (const malformed of ['', '42', 'x command', '42 command\n43 other']) {
    assert.equal(parseMacAncestorLine(malformed), null);
  }
});

test('macOS ancestor traversal identifies provider command and fails closed on malformed ps output', () => {
  const rows = new Map([
    [300, '  200 /bin/zsh -c hook\n'],
    [200, '  100 /Applications/Codex.app/Contents/MacOS/codex resume thread-1\n']
  ]);
  assert.deepEqual(findMacAncestorCliInfo(300, {
    inspect: (pid) => rows.get(pid) ?? null
  }), {
    pid: 200,
    kind: 'codex',
    args: [],
    env: {},
    command: '/Applications/Codex.app/Contents/MacOS/codex resume thread-1'
  });
  assert.equal(findMacAncestorCliInfo(300, { inspect: () => 'malformed' }), null);
});

test('Linux ancestor traversal identifies provider from proc argv/env fixtures', () => {
  const rows = new Map([
    [300, { parent: 200, args: ['/bin/sh', '-c', 'hook'], env: {} }],
    [200, { parent: 100, args: ['/usr/local/bin/claude', '--resume', 'session-1'], env: {} }]
  ]);
  assert.deepEqual(findLinuxAncestorCliInfo(300, {
    read: (pid) => rows.get(pid) ?? null
  }), {
    pid: 200,
    kind: 'claude',
    args: ['/usr/local/bin/claude', '--resume', 'session-1'],
    env: {}
  });
  assert.equal(findLinuxAncestorCliInfo(300, { read: () => null }), null);
});
