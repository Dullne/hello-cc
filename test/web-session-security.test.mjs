import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  requestIsSecure,
  requestMatchesProxyOrigin,
  requestOriginMatches
} from '../lib/web/http.mjs';
import { webIndexHtml } from '../lib/web/ui-template.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccSource = fs.readFileSync(path.join(repoRoot, 'bin', 'hcc.mjs'), 'utf8');
const webRuntimeSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'runtime-main.mjs'), 'utf8');
const cookieAuthSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'cookie-auth.mjs'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = webRuntimeSource.indexOf(start);
  const endIndex = webRuntimeSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return webRuntimeSource.slice(startIndex, endIndex);
}

test('one shared constant-time comparator protects per-connection action tokens', async () => {
  const webHttp = await import('../lib/web/http.mjs');
  assert.equal(typeof webHttp.tokenMatches, 'function');
  assert.equal(webHttp.tokenMatches('same-length-a', 'same-length-b'), false);
  assert.equal(webHttp.tokenMatches('matching', 'matching'), true);

  assert.doesNotMatch(hccSource, /function tokenMatches\s*\(/);
  const actionResolver = sourceBetween(
    'function resolveWebActionSession(',
    'function knownPeerIds('
  );
  assert.match(actionResolver, /session\.actionTokens/);
  assert.match(actionResolver, /tokenMatches\(provided, candidate\)/);

  const socketInput = sourceBetween("ws.on('message', (raw) => {", "ws.on('close', () => {");
  assert.match(socketInput, /tokenMatches\(msg\.action_token, connectionActionToken\)/);
  assert.doesNotMatch(socketInput, /session\.actionToken/);
});

test('terminal sockets mint and revoke independent write tokens', () => {
  const upgrade = sourceBetween(
    'wss.handleUpgrade(req, socket, head, (ws) => {',
    '    } catch (err) {'
  );
  assert.match(upgrade, /const connectionActionToken = newSessionActionToken\(\)/);
  assert.match(upgrade, /session\.actionTokens\.add\(connectionActionToken\)/);
  assert.match(upgrade, /action_token: connectionActionToken/);
  assert.match(upgrade, /session\.actionTokens\.delete\(connectionActionToken\)/);
  assert.match(upgrade, /msg\.type === 'resize'.*tokenMatches\(msg\.action_token, connectionActionToken\)/s);
});

test('browser receives action tokens only from snapshots and sends them on input', () => {
  const html = webIndexHtml({ nonce: 'test-session-nonce' });
  assert.match(html, /const sessionActionTokens = new Map\(\);/);
  assert.match(html, /sessionActionTokens\.set\(id, msg\.action_token\)/);
  assert.match(html, /pendingTerminalInput/);
  assert.match(html, /flushPendingTerminalInput\(id/);
  assert.match(html, /sendTerminalInput\(data\)/);
  assert.match(html, /sendTerminalInput\(text \+ '\\r'\)/);
  assert.doesNotMatch(html, /session\.action_token/);
});

test('browser logout revokes the cookie session', () => {
  const html = webIndexHtml({ nonce: 'test-session-nonce' });
  assert.match(html, /id="logoutBtn"/);
  assert.match(html, /fetch\('\/logout', \{ method: 'POST', headers \}\)/);
  assert.match(html, /sessionStorage\.removeItem\('hcc_logged_out'\)/);
  assert.match(html, /if \(!res\.ok\).*sessionStorage\.setItem\('hcc_logged_out', '1'\)/s);
  assert.match(html, /socket\.onclose = \(event\).*event\.code === 4001.*signed out/s);
});

test('expired and evicted browser sessions close their attached sockets', () => {
  // Code moved to lib/web/cookie-auth.mjs — check that module instead.
  assert.match(cookieAuthSource, /ws\.close\(4001, reason\)/);
  assert.match(cookieAuthSource, /session\.expiresAt <= t\) closeWebSession\(sid, 'session expired'\)/);
  assert.match(cookieAuthSource, /webSessions\.size >= maxSessions/);
  assert.match(cookieAuthSource, /closeWebSession\(oldest, 'session limit reached'\)/);
});

test('origin matching normalizes only default ports on the selected authority', () => {
  const proxied = (origin, forwardedHost, forwardedProto = 'https', remoteAddress = '127.0.0.1') => ({
    headers: {
      origin,
      host: '127.0.0.1:8787',
      'x-forwarded-host': forwardedHost,
      'x-forwarded-proto': forwardedProto
    },
    socket: { encrypted: false, remoteAddress }
  });

  const secureProxy = { trustProxy: true, proxyOrigin: 'https://public.example.test' };
  const plainProxy = { trustProxy: true, proxyOrigin: 'http://public.example.test' };
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443'), secureProxy), true);
  assert.equal(requestOriginMatches(proxied('http://public.example.test', 'public.example.test:80', 'http'), plainProxy), true);
  assert.equal(requestOriginMatches({
    headers: { origin: 'https://public.example.test', host: 'public.example.test:443' },
    socket: { encrypted: true, remoteAddress: '203.0.113.9' }
  }), true);

  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test:444', 'public.example.test:443'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://other.example.test', 'public.example.test:443'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'other.example.test:443'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443', 'http'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'attacker@public.example.test:443'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443/path'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', '[::1'), secureProxy), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443')), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443', 'https', '203.0.113.9'), secureProxy), false);
  assert.equal(requestIsSecure(proxied('https://public.example.test', 'public.example.test:443'), secureProxy), true);
  assert.equal(requestIsSecure(proxied('https://public.example.test', 'other.example.test:443'), secureProxy), false);
  assert.equal(requestMatchesProxyOrigin(proxied('https://public.example.test', 'public.example.test:443'), secureProxy), true);
  assert.equal(requestMatchesProxyOrigin(proxied('https://public.example.test', 'other.example.test:443'), secureProxy), false);
});

test('server uses the tested shared proxy helpers and requires a fixed proxy origin', () => {
  assert.doesNotMatch(hccSource, /function requestIsSecure\s*\(/);
  assert.doesNotMatch(hccSource, /function requestOriginMatches\s*\(/);
  // proxyOriginForOpts moved to lib/web/startup.mjs
  const startupSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'startup.mjs'), 'utf8');
  assert.match(startupSource, /--trust-proxy requires --proxy-origin/);
  assert.match(webRuntimeSource, /proxy_origin: proxyOrigin/);
  assert.match(webRuntimeSource, /requestMatchesProxyOrigin\(req, \{ trustProxy, proxyOrigin \}\)/);
  assert.match(webRuntimeSource, /PROXY_ORIGIN_MISMATCH/);
});

test('active project requests refresh registry activity through the nonblocking throttle', () => {
  const rememberProject = sourceBetween(
    'function rememberProject(',
    'function knownProjects('
  );
  assert.match(rememberProject, /if \(activity\) registerProjectActivity\(normalized\)/);
  assert.match(rememberProject, /registerProject\(normalized, \{ nonblocking \}\)/);
  assert.match(webRuntimeSource, /\{ register: true, nonblocking: true \}/);
  // webErrorStatus (REGISTRY_BUSY -> 503) stayed in bin/hcc.mjs
  assert.match(hccSource, /REGISTRY_BUSY.*503/s);
});

test('trusted proxy startup rejects either half of the pinned-origin contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-proxy-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [
    path.join(repoRoot, 'bin', 'hcc.mjs'), '--root', root, 'web', ...args
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HCC_NO_AUTO_INSTALL_TMUX: '1' }
  });

  const missingOrigin = run('--trust-proxy');
  assert.notEqual(missingOrigin.status, 0);
  assert.match(`${missingOrigin.stdout}${missingOrigin.stderr}`, /--trust-proxy requires --proxy-origin/);
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);

  const missingTrust = run('--proxy-origin', 'https://proxy.example.test');
  assert.notEqual(missingTrust.status, 0);
  assert.match(`${missingTrust.stdout}${missingTrust.stderr}`, /--proxy-origin requires --trust-proxy/);
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
});
