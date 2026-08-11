import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('web runtime verifies a complete process identity before opening its listener', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'bin', 'hcc.mjs'), 'utf8');
  const command = source.indexOf('async function cmdWeb(ctx, args, startMeta = {})');
  const identityWait = source.indexOf('await waitForLiveProcessIdentity(process.pid', command);
  const identityFailure = source.indexOf("'RUNTIME_IDENTITY_UNAVAILABLE'", identityWait);
  const server = source.indexOf('const server = useTls', command);

  assert.ok(command >= 0 && identityWait > command && identityFailure > identityWait,
    'web startup must fail closed when its complete process identity is unavailable');
  assert.ok(identityFailure < server,
    'web startup must verify its process identity before opening the listener');
});

test('startup auto-GC runs only after all tmux sessions are restored', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'bin', 'hcc.mjs'), 'utf8');
  const restoreLoop = source.indexOf('const restoredTmuxDbs = new Set();');
  const requestHandler = source.indexOf('const handleWebRequest = async', restoreLoop);
  const startupGc = source.indexOf('runAutoGc();', restoreLoop);

  assert.ok(restoreLoop >= 0 && requestHandler > restoreLoop);
  assert.ok(startupGc > restoreLoop && startupGc < requestHandler,
    'initial runAutoGc() must follow the sibling tmux restore loop');
});

test('external session reconciliation compares the current owner before treating a missing out file as exit', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'bin', 'hcc.mjs'), 'utf8');
  const poller = source.indexOf('session.exitPoller = setInterval', source.indexOf('function adoptExternalSession'));
  const ownerRead = source.indexOf('const currentOwnerKey = externalBufferOwnerKey(currentMeta);', poller);
  const ownerMismatch = source.indexOf('currentOwnerKey !== session.externalOwnerKey', ownerRead);
  const missingOut = source.indexOf('if (!outExists)', ownerMismatch);

  assert.ok(poller >= 0 && ownerRead > poller && ownerMismatch > ownerRead && missingOut > ownerMismatch,
    'external exit must compare generation before applying missing-output cleanup');
});

test('tmux stream FIFOs are created in their owning project buffer directory', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'tmux-stream.mjs'), 'utf8');
  assert.match(source, /const streamDirectory = bufferDirectory\(session\.ctx \|\| ctx\)/);
  assert.match(source, /path\.join\(streamDirectory, `tmux-/);
});
