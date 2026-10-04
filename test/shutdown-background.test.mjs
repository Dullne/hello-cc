import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createExternalSessions } from '../lib/web/external-sessions.mjs';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';

test('external discovery cancels an adoption already queued by a file watcher', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-stop-external-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let observedChange, sessionLookups = 0;
  t.mock.method(fs, 'watch', (_directory, _options, callback) => {
    observedChange = callback;
    const watcher = new EventEmitter(); watcher.close = () => {};
    return watcher;
  });
  const ctx = { root }, sessions = new Map();
  const external = createExternalSessions({
    ctx, sessions, sessionKey() { sessionLookups++; return 'late'; },
    broadcast() {}, now: () => 1, tx() {},
    connectWebProject() { assert.fail('no late producer may open the project database'); },
    runtimeProjectContexts: () => [ctx], refreshPeerIoHeartbeat() {},
    redactedLogText: value => value, BUFS_DIR_NAME: 'bufs'
  });
  t.after(() => {
    external.stopExternalDiscovery();
    clearInterval(external.externalScanPoller); clearInterval(external.bufsWatcherSyncPoller);
    for (const watcher of external.bufsWatchers.values()) watcher.close();
  });
  assert.equal(typeof observedChange, 'function');
  observedChange('rename', 'late.out');
  external.stopExternalDiscovery();
  t.mock.timers.tick(300);
  external.adoptExternalSession('late');
  assert.equal(sessionLookups, 0);
  assert.equal(sessions.size, 0);
});

test('a queued tmux snapshot stops before reading the pane or broadcasting after shutdown', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-stop-snapshot-')));
  const probe = path.join(root, 'tmux-called');
  fs.writeFileSync(path.join(root, 'tmux'), '#!/bin/sh\nprintf called > "' + probe + '"\nexit 1\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = root + path.delimiter + (previousPath || '');
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let stopping = false, broadcasts = 0;
  const stream = createTmuxStream({ ctx: { root }, now: () => 1,
    isStopping: () => stopping, broadcast() { broadcasts++; }, refreshPeerIoHeartbeat() {} });
  const session = { id: 'fixture', type: 'tmux', pane: '%fixture', status: 'running', buffer: 'retained' };
  stream.scheduleTmuxReplace(session);
  stopping = true;
  t.mock.timers.tick(80);
  assert.equal(broadcasts, 0);
  assert.equal(fs.existsSync(probe), false);
  assert.equal(stream.tmuxSnapshot(session), 'retained');
  assert.equal(fs.existsSync(probe), false);
});
