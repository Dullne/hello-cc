// Real HTTP/browser retry checks against test-owned deterministic adapters only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const FAILURE_CODE = 'NATIVE_ACCEPTANCE_COMMIT_GAP';
const hash = text => createHash('sha256').update(text).digest('hex');
function readMesh(dbPath, read) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

export function createNativeRetryFault({ dbPath }) {
  const armed = new Set(), injected = [];
  return {
    injected,
    arm(peer) {
      assert.ok(peer.startsWith('qa-retry-'), 'Only acceptance-owned peers may receive the commit-gap fault');
      assert.ok(!armed.has(peer) && !injected.some(value => value.peer === peer), 'Inject once per owned worker');
      armed.add(peer);
    },
    afterMeshCommit({ submissionId, messageId }) {
      if (!armed.size) return;
      const intent = readMesh(dbPath, db => db.prepare(`SELECT u.peer,u.submission_id,u.message_id,m.body
        FROM native_user_submissions u JOIN messages m ON m.id=u.message_id
        WHERE u.submission_id=? AND u.message_id=?`).get(submissionId, messageId));
      if (!intent || !armed.has(intent.peer)) return;
      armed.delete(intent.peer);
      injected.push({ peer: intent.peer, submissionId, messageId, bodySha256: hash(intent.body) });
      throw Object.assign(new Error('Acceptance fault after durable mesh commit and before delivery projection'), { code: FAILURE_CODE });
    },
    assertConsumed() { assert.equal(armed.size, 0, 'Every armed commit-gap injection must be reached'); }
  };
}

export function assertExpectedBrowserErrors(evidence) {
  const matched = new Set();
  for (const expected of evidence.expectedErrors) {
    assert.equal(expected.status, 409);
    assert.equal(expected.code, FAILURE_CODE);
    assert.ok(expected.url && expected.responseVerified, 'Expected errors require a verified actual response URL');
    const indices = evidence.console.flatMap((entry, index) => entry.location?.url === expected.url &&
      entry.phase === expected.phase &&
      entry.text === 'Failed to load resource: the server responded with a status of 409 (Conflict)' ? [index] : []);
    assert.equal(indices.length, 1, 'Expect exactly one Chromium resource error for the injected URL and phase');
    assert.ok(!matched.has(indices[0]), 'An expected response cannot consume another expected console entry');
    expected.consoleIndex = indices[0]; matched.add(indices[0]);
  }
  evidence.unexpectedConsole = evidence.console.filter((_, index) => !matched.has(index));
  assert.deepEqual(evidence.unexpectedConsole, [], 'Every non-injected browser warning/error must remain a failure');
}

export async function runNativeRetryChecks({ browser, base, token, root, dbPath, adaptersByPeer, api,
  service, retryFault, select, check, shot, watch, browserInstrumentation, evidence }) {
  const receipt = evidence.nativeRetry = { modelCalls: false, scenarios: [],
    fault: 'One actual HTTP 409 after mesh message/intent commit, before native delivery projection, per viewport',
    pollIntervalMs: 1000000 };
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const peer = 'qa-retry-' + viewport.name, original = 'Original retry message for ' + viewport.name;
    const edited = 'Later unsent draft for ' + viewport.name;
    const route = '/api/sessions/' + peer + '/native/send';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(browserInstrumentation);
    const page = await context.newPage(); watch(page);
    const requests = [], responses = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === route) requests.push(request.postDataJSON());
    });
    page.on('response', response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === route) responses.push(response.status());
    });
    let observerContext, workerStarted = false, failure;
    try {
      evidence.phase = 'native retry ' + viewport.name + ' commit-gap response';
      await api('POST', '/workers', { peer, provider: 'codex' });
      workerStarted = true;
      await page.goto(base + '/?token=' + token); await select(page, peer);
      if (!await page.evaluate(() => window.hccHandoff.canControl)) await page.locator('#claimControlBtn').click();
      await page.waitForFunction(() => window.hccHandoff.canControl);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      if (viewport.width === 390) await page.locator('.mobile-nav [data-view="terminal"]').click();
      const originalState = await api('GET', '/workers/' + peer + '/state');
      const adapter = adaptersByPeer.get(peer);
      assert.equal(adapter.sent || 0, 0);
      retryFault.arm(peer);
      const expected = { phase: evidence.phase, status: 409, code: FAILURE_CODE, url: null, responseVerified: false };
      evidence.expectedErrors.push(expected);
      await page.locator('#nativeDraft').fill(original);
      const firstResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === route);
      await page.locator('#nativeSend').click();
      const failed = await firstResponse;
      expected.url = failed.url(); assert.equal(failed.status(), 409);
      assert.equal((await failed.json()).error.code, FAILURE_CODE); expected.responseVerified = true;
      await page.waitForFunction(() => !document.getElementById('nativeRetryPending').hidden && !document.getElementById('nativeRetryPending').disabled);
      assert.equal(requests.length, 1);
      const submissionId = requests[0].submissionId;
      assert.equal(requests[0].text, original); assert.equal(requests[0].retry, undefined);
      const readPending = () => page.evaluate(({ root, peer }) => JSON.parse(localStorage.getItem('hcc.nativeDraft:' + JSON.stringify([root, peer])) || '{}'), { root, peer });
      const saved = await readPending();
      assert.equal(saved.text, original); assert.equal(saved.pending.id, submissionId);
      assert.equal(saved.pending.text, original); assert.equal(saved.pending.owner, originalState.owner);
      assert.equal(saved.pending.generation, originalState.generation);
      assert.equal((await api('GET', '/workers/' + peer + '/state')).deliveries.length, 0);
      assert.equal(adapter.sent || 0, 0, 'Automatic polling must not repair the deliberately missing projection');
      const message = readMesh(dbPath, db => db.prepare('SELECT message_id FROM native_user_submissions WHERE submission_id=?').get(submissionId));
      assert.ok(message);
      await page.locator('#nativeDraft').fill(edited);
      await shot(page, viewport.name + '-native-retry-pending');

      observerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await observerContext.addInitScript(browserInstrumentation);
      const observer = await observerContext.newPage(); watch(observer);
      await observer.goto(base + '/?token=' + token); await select(observer, peer);
      await observer.locator('#claimControlBtn').click();
      await observer.waitForFunction(() => window.hccHandoff.canControl);
      await page.waitForFunction(() => !window.hccHandoff.canControl);
      assert.equal(await page.locator('#nativeRetryPending').isDisabled(), true);
      await page.locator('#nativeRetryPending').evaluate(button => button.click());
      assert.equal(requests.length, 1, 'An observer cannot send a retry');
      await page.locator('#claimControlBtn').click();
      await page.waitForFunction(() => window.hccHandoff.canControl && !document.getElementById('nativeRetryPending').disabled);
      const lease = await page.evaluate(() => ({ token: window.hccHandoff.actionToken, epoch: window.hccHandoff.epoch }));
      const retryResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === route);
      await page.locator('#nativeRetryPending').click();
      const repaired = await retryResponse;
      assert.equal(repaired.status(), 200);
      const result = await repaired.json();
      assert.equal(result.receipt.submission_id, submissionId); assert.equal(result.receipt.message_id, message.message_id);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].text, original); assert.equal(requests[1].submissionId, submissionId); assert.equal(requests[1].retry, true);
      assert.equal(requests[1].action_token, lease.token); assert.equal(requests[1].epoch, lease.epoch);
      await page.waitForFunction(() => document.getElementById('nativeRetryPending').hidden);
      assert.equal(await page.locator('#nativeDraft').inputValue(), edited);
      assert.deepEqual(await readPending(), { text: edited, pending: null });
      const counts = readMesh(dbPath, db => ({
        messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient=? AND body=?').get(peer, original).n,
        intents: db.prepare('SELECT COUNT(*) AS n FROM native_user_submissions WHERE submission_id=?').get(submissionId).n,
        pendingEvents: db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='native.web.submission.pending' AND json_extract(payload,'$.submission_id')=?").get(submissionId).n
      }));
      assert.deepEqual(counts, { messages: 1, intents: 1, pendingEvents: 1 });
      await service.poll();
      const active = await api('GET', '/workers/' + peer + '/state');
      assert.equal(active.deliveries.length, 1); assert.equal(active.deliveries[0].submission_id, submissionId);
      assert.equal(active.deliveries[0].message_id, message.message_id); assert.equal(active.deliveries[0].origin, 'user');
      assert.equal(adapter.sent, 1); assert.equal(adapter.active.submissionId, submissionId);
      await service.poll(); assert.equal(adapter.sent, 1, 'Repeated queue inspection must not dispatch the same message twice');
      await shot(page, viewport.name + '-native-retry-reconciled');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
      assert.deepEqual(responses, [409, 200]);
      receipt.scenarios.push({ viewport, peer, submissionId, messageId: message.message_id,
        owner: originalState.owner, generation: originalState.generation,
        requestCount: requests.length, responseStatuses: responses, expectedFailure: FAILURE_CODE,
        originalBodySha256: hash(original), laterDraftPreserved: true, observerRetryBlocked: true,
        messages: counts.messages, durableIntents: counts.intents, pendingEvents: counts.pendingEvents,
        deliveries: active.deliveries.length, userOriginRetained: true, providerInputs: adapter.sent });
      check('native retry ' + viewport.name + ': original durable submission repairs once; edited draft and observer fence survive');
    } catch (error) {
      failure = error;
      receipt.failure = { viewport: viewport.name, peer, message: error.message, requestCount: requests.length,
        responseStatuses: responses, injected: retryFault.injected.filter(value => value.peer === peer) };
      try { await shot(page, viewport.name + '-native-retry-failure'); } catch { /* Preserve the original assertion. */ }
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        observerContext?.close(), context.close(), workerStarted ? api('POST', '/close', { peer }) : undefined
      ]);
      const errors = cleanup.filter(value => value.status === 'rejected');
      if (errors.length) {
        receipt.cleanupErrors = errors.map(value => value.reason?.message || String(value.reason));
        if (!failure) throw errors[0].reason;
      }
    }
  }
  retryFault.assertConsumed();
  assert.equal(retryFault.injected.length, 2);
  receipt.injections = [...retryFault.injected];
}
