import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { shellQuoteArg } from '../lib/format.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createTmuxSessions } from '../lib/web/tmux-sessions.mjs';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

const fakeTmuxSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const directory = path.dirname(fileURLToPath(import.meta.url));
const file = name => path.join(directory, name);
const command = process.argv[2];
fs.appendFileSync(file('children'), process.pid + '\n');
fs.appendFileSync(file('commands'), command + '\n');
if (command === 'capture-pane') {
  fs.writeFileSync(file('started'), String(process.pid));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file('release'))) {
    if (Date.now() >= deadline) process.exit(2);
    await delay(10);
  }
  fs.writeFileSync(file('capture-finished'), '1');
  process.stdout.write('barrier capture\n');
} else if (command === 'display-message') {
  process.stdout.write('1,1,1,0,24\n');
} else {
  process.exitCode = 3;
}
`;

// This driver has its own event loop. A synchronous capture in the server
// process cannot postpone the HTTP request until after capture has finished.
const driverSource = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [directory, origin] = process.argv.slice(2);
const file = name => path.join(directory, name);
process.send({ stage: 'ready' });
try {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file('started'))) {
    if (Date.now() >= deadline) throw new Error('capture did not start');
    await delay(10);
  }
  const response = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/runtime', {
      agent: false, headers: { 'X-HCC-API-Version': '2' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('HTTP blocked by capture')), 3000);
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
  });
  let captureAlive = false;
  try { process.kill(Number(fs.readFileSync(file('started'), 'utf8')), 0); captureAlive = true; } catch {}
  process.send({ stage: 'result', ...response, captureAlive,
    releaseExisted: fs.existsSync(file('release')),
    captureFinished: fs.existsSync(file('capture-finished')) });
} catch (error) {
  process.exitCode = 1;
  process.send({ stage: 'result', error: error.message });
} finally {
  // Also unblock a synchronous implementation after the independent deadline,
  // so a failing regression can finish and clean up instead of deadlocking.
  fs.writeFileSync(file('release'), '1');
  process.disconnect();
}
`;

for (const mode of ['input', 'periodic']) {
  test(`${mode} tmux display refresh serves production HTTP before slow capture is released`,
    { skip: process.platform === 'win32', timeout: 20000 }, async t => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-display-http-')));
      const file = name => path.join(root, name);
      const previousPath = process.env.PATH;
      let stopping = false, driver, driverClosed, driverExit, driverResult, driverReady = false;
      let driverError = null, driverStderr = '';
      const broadcasts = [];
      const ctx = { root, dbPath: file('unused.db') };
      const session = { id: 'display-fixture', type: 'tmux', pane: '%fixture',
        status: 'running', buffer: 'previous image', ctx };
      const stream = createTmuxStream({ ctx, isStopping: () => stopping, snapshotTimeoutMs: 5000,
        broadcast: (target, message) => broadcasts.push({ target, message }) });
      const { handleWebRequest } = createHttpRoutes({
        ctx, token: 'fixture-only', webAuthMode: () => 'bearer', cookieSessionOk: () => false,
        projectFromRequest: () => ctx, getProcessIdentity: () => null,
        knownProjects: () => [], sessionsForProject: () => [session],
        PRODUCT_NAME: 'http-refresh-fixture', VERSION: 'test', webErrorStatus: () => 500
      });
      const server = http.createServer(handleWebRequest);
      t.after(async () => {
        stopping = true;
        stream.stopTmuxStream(session, { shutdownDeadline: 0 });
        fs.writeFileSync(file('release'), '1');
        try {
          if (driver && !driverExit) driver.kill('SIGKILL');
          if (driverClosed) await driverClosed;
          server.closeAllConnections();
          if (server.listening) await new Promise(resolve => server.close(resolve));
          // Only inspect PIDs written by this fixture's own executable. The
          // production helper owns cancellation and reaping of these children.
          const children = fs.existsSync(file('children'))
            ? fs.readFileSync(file('children'), 'utf8').trim().split('\n').map(Number) : [];
          await waitFor(() => children.every(pid => {
            try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
          }), 'display helper left a fixture child running');
        } finally {
          if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
          fs.rmSync(root, { recursive: true, force: true });
        }
      });

      fs.writeFileSync(file('fake-tmux.mjs'), fakeTmuxSource);
      // exec replaces the shell with one Node process; the fake spawns no
      // grandchildren and never contacts a real tmux socket.
      fs.writeFileSync(file('tmux'), '#!/bin/sh\nexec ' + shellQuoteArg(process.execPath) + ' ' +
        shellQuoteArg(file('fake-tmux.mjs')) + ' "$@"\n', { mode: 0o700 });
      fs.writeFileSync(file('driver.mjs'), driverSource);
      process.env.PATH = root + path.delimiter + (previousPath || '');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      driver = spawn(process.execPath, [file('driver.mjs'), root,
        'http://127.0.0.1:' + server.address().port], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      driverClosed = new Promise(resolve => {
        driver.once('error', error => { driverError = error; });
        driver.once('close', (code, signal) => { driverExit = { code, signal }; resolve(); });
      });
      driver.stderr.on('data', bytes => { driverStderr = (driverStderr + bytes).slice(-4096); });
      driver.on('message', message => {
        if (message.stage === 'ready') driverReady = true;
        if (message.stage === 'result') driverResult = message;
      });
      await waitFor(() => driverReady || driverExit || driverError, 'HTTP driver did not become ready');
      assert.equal(driverError, null);
      assert.ok(driverReady, driverStderr || 'HTTP driver exited before readiness');

      if (mode === 'input') {
        const runtime = createTmuxSessions({ isStopping: () => stopping,
          invalidateTmuxSnapshot: stream.invalidateTmuxSnapshot,
          refreshTmuxSnapshotAsync: stream.refreshTmuxSnapshotAsync });
        runtime.scheduleTmuxInputRefresh(session);
      } else {
        stream.startTmuxReplacePoller(session);
        // Exercise the actual interval callback without waiting for the
        // separate four-second inactivity threshold as well.
        session.lastBroadcastTime = Date.now() - 5000;
      }

      await driverClosed;
      assert.deepEqual(driverExit, { code: 0, signal: null }, JSON.stringify(driverResult) + driverStderr);
      assert.equal(driverResult.status, 200);
      assert.equal(driverResult.body.product, 'http-refresh-fixture');
      assert.equal(driverResult.body.api_version, 2);
      assert.equal(driverResult.body.sessions, 1);
      assert.equal(driverResult.captureAlive, true, 'HTTP responded after the capture child had exited');
      assert.equal(driverResult.releaseExisted, false, 'HTTP only responded after capture was released');
      assert.equal(driverResult.captureFinished, false, 'HTTP only responded after capture finished');
      await waitFor(() => broadcasts.length > 0, 'released capture did not publish its snapshot');
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].target, session);
      assert.equal(broadcasts[0].message.type, 'replace');
      assert.match(broadcasts[0].message.data, /^barrier capture/);
      assert.equal(broadcasts[0].message.data, session.buffer);
      assert.deepEqual(fs.readFileSync(file('commands'), 'utf8').trim().split('\n'),
        ['capture-pane', 'display-message']);
    });
}
