import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';
import { shellQuoteArg } from '../lib/format.mjs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('web runtime verifies a complete process identity before opening its listener', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'runtime-main.mjs'), 'utf8');
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
  // the HTTP handler lives in lib/web/http-routes.mjs; append it so the
  // restore-loop -> runAutoGc() -> request-handler ordering stays checkable
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'runtime-main.mjs'), 'utf8') +
    fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'http-routes.mjs'), 'utf8');
  const restoreLoop = source.indexOf('const restoredTmuxDbs = new Set();');
  const requestHandler = source.indexOf('const handleWebRequest = async', restoreLoop);
  const startupGc = source.indexOf('runAutoGc();', restoreLoop);

  assert.ok(restoreLoop >= 0 && requestHandler > restoreLoop);
  assert.ok(startupGc > restoreLoop && startupGc < requestHandler,
    'initial runAutoGc() must follow the sibling tmux restore loop');
});

test('external session reconciliation compares the current owner before treating a missing out file as exit', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'external-sessions.mjs'), 'utf8');
  const poller = source.indexOf('session.exitPoller = setInterval', source.indexOf('function adoptExternalSession'));
  const ownerRead = source.indexOf('const currentOwnerKey = externalBufferOwnerKey(currentMeta);', poller);
  const ownerMismatch = source.indexOf('currentOwnerKey !== session.externalOwnerKey', ownerRead);
  const missingOut = source.indexOf('if (!outExists)', ownerMismatch);

  assert.ok(poller >= 0 && ownerRead > poller && ownerMismatch > ownerRead && missingOut > ownerMismatch,
    'external exit must compare generation before applying missing-output cleanup');
});

for (const sessionOwnsProject of [true, false]) {
  test('tmux stream FIFOs use the ' + (sessionOwnsProject ? 'session project' : 'runtime project fallback'), { skip: process.platform === 'win32' }, t => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-stream-project-')));
    const primary = path.join(sandbox, 'primary'), sibling = path.join(sandbox, 'sibling'), bin = path.join(sandbox, 'bin');
    for (const folder of [primary, sibling, bin]) fs.mkdirSync(folder);
    // A test-owned unavailable tmux keeps every command away from user panes.
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + (oldPath || '');
    const expected = path.join(sessionOwnsProject ? sibling : primary, '.hello-cc', 'bufs'), observed = [];
    const session = { id: 'test-stream', pane: '%test-stream', type: 'tmux', status: 'running', ...(sessionOwnsProject ? { ctx: { root: sibling } } : {}) };
    const stream = createTmuxStream({ ctx: { root: primary }, now: () => 1, broadcast() {}, refreshPeerIoHeartbeat() {}, shellQuoteArg,
      withBufferDirectoryLease(directory, fn) {
        assert.equal(directory, expected); const result = fn();
        for (const name of fs.readdirSync(directory)) {
          const stat = fs.statSync(path.join(directory, name));
          if (stat.isFIFO()) observed.push({ directory, mode: stat.mode & 0o777 });
        }
        return result;
      } });
    t.after(() => {
      stream.stopTmuxStream(session);
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      fs.rmSync(sandbox, { recursive: true, force: true });
    });
    assert.equal(stream.startTmuxStream(session), 'poll');
    assert.deepEqual(observed, [{ directory: expected, mode: 0o600 }]);
    assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(sessionOwnsProject ? primary : sibling, '.hello-cc')), false);
  });
}
