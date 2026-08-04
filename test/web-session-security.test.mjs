import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestOriginMatches } from '../lib/web/http.mjs';
import { webIndexHtml } from '../lib/web/ui-template.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccSource = fs.readFileSync(path.join(repoRoot, 'bin', 'hcc.mjs'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = hccSource.indexOf(start);
  const endIndex = hccSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return hccSource.slice(startIndex, endIndex);
}

test('one shared constant-time comparator protects action tokens', async () => {
  const webHttp = await import('../lib/web/http.mjs');
  assert.equal(typeof webHttp.tokenMatches, 'function');
  assert.equal(webHttp.tokenMatches('same-length-a', 'same-length-b'), false);
  assert.equal(webHttp.tokenMatches('matching', 'matching'), true);

  assert.doesNotMatch(hccSource, /function tokenMatches\s*\(/);
  const actionResolver = sourceBetween(
    'function resolveWebActionSession(',
    'function knownPeerIds('
  );
  assert.match(actionResolver, /tokenMatches\(provided, expected\)/);
  assert.doesNotMatch(actionResolver, /provided\s*!==\s*expected/);

  const socketInput = sourceBetween("ws.on('message', (raw) => {", "ws.on('close', () => {");
  assert.match(socketInput, /tokenMatches\(msg\.action_token, session\.actionToken\)/);
  assert.doesNotMatch(socketInput, /msg\.action_token\s*!==\s*session\.actionToken/);
});

test('browser receives action tokens only from snapshots and sends them on input', () => {
  const html = webIndexHtml({ nonce: 'test-session-nonce' });
  assert.match(html, /const sessionActionTokens = new Map\(\);/);
  assert.match(html, /sessionActionTokens\.set\(id, msg\.action_token\)/);
  assert.match(html, /type: 'input', data, action_token: sessionActionTokens\.get\(active\) \|\| ''/);
  assert.match(html, /type: 'input', data: text \+ '\\r', action_token: sessionActionTokens\.get\(active\) \|\| ''/);
  assert.doesNotMatch(html, /session\.action_token/);
});

test('browser logout revokes the cookie session', () => {
  const html = webIndexHtml({ nonce: 'test-session-nonce' });
  assert.match(html, /id="logoutBtn"/);
  assert.match(html, /fetch\('\/logout', \{ method: 'POST', headers \}\)/);
});

test('expired and evicted browser sessions close their attached sockets', () => {
  const lifecycle = sourceBetween(
    'function closeWebSession(',
    'const webSessionPruner = setInterval('
  );
  assert.match(lifecycle, /ws\.close\(4001, reason\)/);
  assert.match(lifecycle, /session\.expiresAt <= t\) closeWebSession\(sid, 'session expired'\)/);
  assert.match(lifecycle, /while \(webSessions\.size >= MAX_WEB_SESSIONS\)/);
  assert.match(lifecycle, /closeWebSession\(oldest, 'session limit reached'\)/);
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

  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443'), { trustProxy: true }), true);
  assert.equal(requestOriginMatches(proxied('http://public.example.test', 'public.example.test:80', 'http'), { trustProxy: true }), true);
  assert.equal(requestOriginMatches({
    headers: { origin: 'https://public.example.test', host: 'public.example.test:443' },
    socket: { encrypted: true, remoteAddress: '203.0.113.9' }
  }), true);

  assert.equal(requestOriginMatches(proxied('https://public.example.test:444', 'public.example.test:443'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://other.example.test', 'public.example.test:443'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443', 'http'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'attacker@public.example.test:443'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443/path'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', '[::1'), { trustProxy: true }), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443')), false);
  assert.equal(requestOriginMatches(proxied('https://public.example.test', 'public.example.test:443', 'https', '203.0.113.9'), { trustProxy: true }), false);
});
