# Web and Runtime API v2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an explicit Runtime API v2 with bounded browser sessions, session-scoped terminal input, CSP, secret redaction, and symlink-safe project databases.

**Architecture:** Central helpers own API negotiation, redaction, token comparison, and canonical path validation. The HTTP and WebSocket entry points enforce these helpers before routing while preserving the accepted plaintext-LAN and arbitrary-root behaviors.

**Tech Stack:** Node.js 24 HTTP/HTTPS, `ws`, browser WebSocket/fetch, `node:test`, real filesystem integration tests.

---

## File Map

- Create `lib/web/api-version.mjs` and `test/web-api-version.test.mjs`.
- Create `lib/shared/redact.mjs` and `test/redact.test.mjs`.
- Create `lib/runtime/project-path.mjs` and `test/project-path.test.mjs`.
- Modify `lib/web/http.mjs`, `lib/web/runtime.mjs`, `lib/runtime/client.mjs`.
- Modify `bin/hcc.mjs` HTTP/WS routing, cookie lifecycle, logging, and TLS use.
- Modify `lib/web/ui-template.mjs` for API headers, WS version query, and CSP nonce.
- Modify `lib/web/tls.mjs` only where focused tests show a contract gap.
- Modify `scripts/regression.mjs` for real HTTP/HTTPS/WS tests.

### Task 1: Add Runtime API v2 negotiation

**Files:**
- Create: `lib/web/api-version.mjs`
- Create: `test/web-api-version.test.mjs`
- Modify: `lib/runtime/client.mjs:7-35`
- Modify: `lib/web/runtime.mjs:11-185`
- Modify: `bin/hcc.mjs:4675-5190`
- Modify: `lib/web/ui-template.mjs:1-2100`

- [ ] **Step 1: Write failing negotiation tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, readHttpApiVersion, readWebSocketApiVersion } from '../lib/web/api-version.mjs';

test('reads API v2 from the HTTP header', () => {
  assert.equal(API_VERSION, 2);
  assert.deepEqual(readHttpApiVersion({ headers: { 'x-hcc-api-version': '2' } }), { ok: true, version: 2 });
});

test('rejects missing and old protected API versions', () => {
  assert.deepEqual(readHttpApiVersion({ headers: {} }), { ok: false, version: null });
  assert.deepEqual(readHttpApiVersion({ headers: { 'x-hcc-api-version': '1' } }), { ok: false, version: 1 });
});

test('reads browser WebSocket version from query', () => {
  assert.deepEqual(readWebSocketApiVersion(new URL('http://localhost/ws?api_version=2')), { ok: true, version: 2 });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/web-api-version.test.mjs`.

Expected: missing-module failure.

- [ ] **Step 3: Implement and enforce v2**

```js
export const API_VERSION = 2;

function result(value) {
  const version = Number.parseInt(String(value ?? ''), 10);
  return { ok: version === API_VERSION, version: Number.isFinite(version) ? version : null };
}

export function readHttpApiVersion(req) {
  return result(req?.headers?.['x-hcc-api-version']);
}

export function readWebSocketApiVersion(url) {
  return result(url?.searchParams?.get('api_version'));
}
```

Before every protected `/api/*` route, return status 426 and:

```json
{"ok":false,"error":{"code":"API_VERSION_UNSUPPORTED","message":"Runtime API version 2 is required","supported_version":2}}
```

Expose `api_version: 2` from runtime metadata. Add `X-HCC-API-Version: 2` in `runtimeRequest` and every browser fetch wrapper. Add `api_version=2` to terminal WebSocket URLs and reject old/missing WS versions before authentication/session lookup.

- [ ] **Step 4: Verify GREEN and real compatibility rejection**

Run unit tests. Add regression requests with missing/1/2 headers plus WS query 1/2. Public `/`, `/login`, and static assets must remain exempt.

Run: `npm run test:regression`.

- [ ] **Step 5: Commit**

```bash
git add lib/web/api-version.mjs test/web-api-version.test.mjs lib/runtime/client.mjs lib/web/runtime.mjs lib/web/ui-template.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "feat: require Runtime API v2"
```

### Task 2: Enforce administrator and session-action token semantics

**Files:**
- Modify: `lib/web/http.mjs:62-122`
- Modify: `bin/hcc.mjs:2382-2465,2475-2580,4675-4955,5100-5185`
- Modify: `lib/web/ui-template.mjs:1570-1760,2050-2110`
- Modify: `scripts/regression.mjs:1193-1355,1974-2115,2866-3300`

- [ ] **Step 1: Add failing privilege-boundary tests**

Through real HTTP and WebSocket connections assert:

```text
admin bearer -> create/stop/inject allowed
admin cookie + same Origin -> create/stop/inject allowed
admin cookie + foreign Origin -> mutation denied
session action token absent from GET /api/sessions
wrong/missing session action token -> WS input denied
correct token for another session -> WS input denied
logout/expiry/eviction -> existing cookie WS closed and future input denied
```

Also assert tokenless non-loopback startup fails while tokenless loopback still works.
Because constant-time behavior is not safely distinguishable with a timing test,
add a static security assertion that extracts `resolveWebActionSession` from
`bin/hcc.mjs`, requires `tokenMatches(provided, expected)`, and rejects direct
`provided !== expected` comparison. This is the repeatable validation artifact
for the timing boundary; the integration cases remain the behavior proof.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Expected: FAIL on the static constant-time assertion while the current code uses
direct inequality. Any additional integration failure is fixed through the same
boundary, but is not required to establish RED.

- [ ] **Step 3: Apply one shared token comparator and explicit roles**

Use `tokenMatches(provided, expected)` for administrator and session action tokens. Keep `webAuthMode` results `token` and `cookie`, document both as administrator roles, and keep same-origin enforcement on every cookie mutation. Track each cookie-authenticated WS in its server session record and validate the record before inbound and outbound frames.

Do not put action tokens in serialized session lists. Deliver them only in the corresponding terminal snapshot frame. Preserve CLI injection through administrator bearer authentication without requiring the session token.

- [ ] **Step 4: Verify GREEN and alternate bypasses**

Run the regression suite, then repeat token tests with same-length wrong tokens, URL-encoded peer IDs, revoked cookies, and a token from a sibling project session.

Expected: legitimate admin and matching-session behavior remains; all bypasses fail.

- [ ] **Step 5: Commit**

```bash
git add lib/web/http.mjs bin/hcc.mjs lib/web/ui-template.mjs scripts/regression.mjs
git commit -m "fix: enforce Web administrator and session tokens"
```

### Task 3: Add structured secret redaction and CSP

**Files:**
- Create: `lib/shared/redact.mjs`
- Create: `test/redact.test.mjs`
- Modify: `lib/web/http.mjs:33-59`
- Modify: `lib/web/ui-template.mjs:1-2150`
- Modify: `bin/hcc.mjs:2180-2250,2368-2470,5290-5300`
- Modify: `scripts/regression.mjs:1841-2115,3894-4300`

- [ ] **Step 1: Write failing redaction tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../lib/shared/redact.mjs';

test('redacts CLI, URL, headers, cookies, and structured tokens', () => {
  const secret = 's3cr3t-value';
  const value = {
    command: `hcc web --token ${secret}`,
    url: `http://host/?token=${secret}&root=/tmp/x`,
    headers: { authorization: `Bearer ${secret}`, cookie: `hcc_sid=${secret}` },
    action_token: secret
  };
  const redacted = JSON.stringify(redactSecrets(value));
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes('[REDACTED]'), true);
});
```

Add an HTML test that extracts the CSP nonce, verifies the script tag uses it, and asserts a second un-nonced inline script would violate the generated `script-src` policy.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/redact.test.mjs`.

Expected: missing-module failure.

- [ ] **Step 3: Implement redaction and nonce responses**

`redactSecrets(value)` recursively clones arrays/objects, replaces secret-key values, redacts bearer/cookie fragments, replaces `--token` arguments, and deletes URL `token` parameter values. It must handle cycles with a `WeakSet` and replace them with `[Circular]`.

Pass all startup/error logging through this helper before stringification. Never log raw request headers or URLs.

Generate a random nonce per HTML response and call `webIndexHtml({ nonce })` or `webLoginPage({ nonce })`. Add the nonce to every inline script. Emit CSP:

```text
default-src 'self'; script-src 'self' 'nonce-<value>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

- [ ] **Step 4: Verify GREEN and leak controls**

Run unit tests. Start Web with unique test secrets, exercise login/WS/errors, stop it, and scan all generated logs/runtime output. Assert no supplied secret appears. Verify browser HTML contains a matching nonce and no un-nonced script.

Run: `npm run test:regression`.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/redact.mjs test/redact.test.mjs lib/web/http.mjs lib/web/ui-template.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "fix: redact Web secrets and enforce CSP"
```

### Task 4: Canonicalize arbitrary project roots without symlink escape

**Files:**
- Create: `lib/runtime/project-path.mjs`
- Create: `test/project-path.test.mjs`
- Modify: `bin/hcc.mjs:2479-2525`
- Modify: `scripts/regression.mjs:2866-3300,6300-6700`

- [ ] **Step 1: Write failing real-filesystem tests**

Create temporary roots for: normal project, missing `.hello-cc`, `.hello-cc` symlink to an outside directory, nested DB symlink escape, `/proc` pseudo-file target on Linux, and a normal custom DB below `.hello-cc`.

Use the intended API:

```js
const safe = resolveProjectDatabase({ root, db: path.join(root, '.hello-cc', 'mesh.db'), createStateDir: true });
assert.equal(safe.db.startsWith(safe.stateDir + path.sep), true);
assert.throws(() => resolveProjectDatabase({ root: escapedRoot, db: escapedDb, createStateDir: true }), /PROJECT_PATH_FORBIDDEN/);
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/project-path.test.mjs`.

Expected: missing-module failure.

- [ ] **Step 3: Implement canonical containment**

Resolve an existing root with `realpathSync`. Create `.hello-cc` with mode `0700` only when requested and absent. Reject it when `lstat` reports a symlink or when its real path is outside root. Resolve the DB parent, reject symlink components escaping the state directory, and require an existing DB target to be a regular file.

Replace `assertDbUnderRoot`/lexical-only checks with `resolveProjectDatabase`. Continue allowing every existing canonical root after administrator authentication.

- [ ] **Step 4: Verify GREEN and HTTP boundary**

Run unit tests, then issue real authenticated Web requests for normal arbitrary roots and each escape fixture. Require normal requests to work and every escape to return `PROJECT_PATH_FORBIDDEN` without creating/opening the outside DB.

Run: `npm run test:regression`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/project-path.mjs test/project-path.test.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "fix: prevent project database symlink escape"
```

### Task 5: Finish TLS and trusted-proxy mode coverage

**Files:**
- Track/modify: `lib/web/tls.mjs`
- Modify: `lib/web/runtime.mjs:80-190`
- Modify: `lib/runtime/state.mjs:91-123`
- Modify: `lib/web/http.mjs:76-112`
- Modify: `scripts/regression.mjs:6440-6600`

- [ ] **Step 1: Add failing mode-matrix tests**

Cover direct self-signed TLS, expired certificate rejection, SAN mismatch regeneration, key mismatch regeneration, loopback trusted proxy, forwarded headers from non-loopback, and accepted plaintext LAN. Assert `Secure` cookie only for direct TLS or trusted loopback proxy reporting HTTPS.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Expected: any uncovered certificate generation race or proxy-origin discrepancy fails with the specific mode fixture.

- [ ] **Step 3: Make only evidence-required production changes**

Keep generation directories, `.creating`/`.published`, atomic `current.json`, SAN/date/key validation, and CA-scoped runtime requests. Ensure proxy host/proto is consumed only when `--trust-proxy` is enabled and socket remote address is loopback. Do not make TLS mandatory or change the accepted default listener.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit`.

Run: `npm run test:regression`.

Expected: all three supported modes pass and every spoofed forwarded-header control fails closed.

- [ ] **Step 5: Commit**

```bash
git add lib/web/tls.mjs lib/web/runtime.mjs lib/runtime/state.mjs lib/web/http.mjs scripts/regression.mjs
git commit -m "test: close Web transport mode coverage"
```
