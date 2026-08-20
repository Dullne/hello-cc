import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runtimeClientSource = fs.readFileSync(path.join(repoRoot, 'lib', 'runtime', 'client.mjs'), 'utf8');
const peerSource = fs.readFileSync(path.join(repoRoot, 'lib', 'cli', 'commands', 'peer.mjs'), 'utf8');
const coordinationSource = fs.readFileSync(path.join(repoRoot, 'lib', 'cli', 'commands', 'coordination.mjs'), 'utf8');

test('runtime request forwards the caller deadline to the HTTP transport', () => {
  assert.match(runtimeClientSource, /runtimeHttpRequest\([\s\S]*timeoutMs: opts\.timeoutMs/);
});

test('session mutations use a bounded 30 second runtime deadline', () => {
  assert.match(runtimeClientSource, /export const RUNTIME_SESSION_MUTATION_TIMEOUT_MS = 30_000/);
  assert.equal(
    peerSource.match(/timeoutMs: RUNTIME_SESSION_MUTATION_TIMEOUT_MS/g)?.length,
    3
  );
  assert.match(
    coordinationSource,
    /\/api\/sessions\/\$\{encodeURIComponent\(peer\)\}\/input[\s\S]*timeoutMs: RUNTIME_SESSION_MUTATION_TIMEOUT_MS/
  );
});
