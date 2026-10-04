// Browser lifecycle checks against deterministic native adapters, with no model calls.
import assert from 'node:assert/strict';

export async function runNativeHandoffChecks({ browser, base, token, adaptersByPeer, api, service, select, check, shot, watch, browserInstrumentation, evidence, stopWeb }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(browserInstrumentation);
  const peer = 'qa-web-created', submitted = 'Fixture input submitted once before closing Web';
  const draft = 'Unsent background Agent draft survives page close';
  const requests = { launch: [], resume: [] };
  const watchMutations = page => page.on('request', request => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/sessions' && request.postDataJSON()?.id === peer) requests.launch.push(request.postDataJSON());
    if (pathname === '/api/native/history/' + peer + '/resume') requests.resume.push(request.postDataJSON());
  });
  let page = await context.newPage(); watch(page); watchMutations(page);
  try {
    evidence.phase = 'Web background Agent creation and lifecycle';
    await page.goto(base + '/?token=' + token);
    await select(page, 'qa-codex');
    await page.locator('#openStartDialog').click();
    await page.locator('#startDialog').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('agentStartBtn').disabled);
    assert.equal(await page.locator('#kind').inputValue(), 'codex');
    assert.equal(await page.locator('#transport').inputValue(), 'native');
    await page.locator('#agentName').fill(peer);
    await page.locator('#agentStartBtn').click();
    await page.waitForFunction(peer => window.hccHandoff?.active === peer && window.hccHandoff.canControl &&
      /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent), peer);
    const initial = await api('GET', '/workers/' + peer + '/state');
    const serviceBefore = await api('GET', '/status');
    const original = adaptersByPeer.get(peer);
    assert.ok(original && initial.owner && initial.snapshot.sessionId);
    assert.equal(requests.launch.length, 1);
    assert.equal(requests.launch[0].transport, 'native');
    assert.equal(original.opens.length, 1);
    assert.equal(original.sent || 0, 0);
    await shot(page, 'desktop-web-created-native');
    check('visible New Agent form creates one independent native worker with the default background interface');

    await page.locator('#nativeDraft').fill(submitted);
    await page.locator('#nativeSend').click();
    await page.waitForFunction(() => document.getElementById('nativeDraft').value === '');
    // The fixture uses a long automatic poll interval; drain the durable queue now.
    await service.poll();
    const active = await api('GET', '/workers/' + peer + '/state');
    assert.equal(original.sent, 1);
    assert.ok(active.active_delivery && active.snapshot.turnId);
    await page.locator('#nativeDraft').fill(draft);
    await page.close();
    original.emit({ type: 'message', itemId: 'background-live-output', text: 'BACKGROUND_EXECUTOR_CONTINUED_WITHOUT_WEB' });
    const detached = await api('GET', '/workers/' + peer + '/state');
    assert.equal(detached.owner, initial.owner);
    assert.equal(detached.generation, initial.generation);
    assert.equal(detached.snapshot.sessionId, initial.snapshot.sessionId);
    assert.equal(detached.snapshot.turnId, active.snapshot.turnId);
    page = await context.newPage(); watch(page); watchMutations(page);
    await page.goto(base + '/?token=' + token);
    await select(page, peer);
    await page.waitForFunction(() => document.getElementById('nativeEvents').textContent.includes('BACKGROUND_EXECUTOR_CONTINUED_WITHOUT_WEB'));
    assert.equal(await page.locator('#nativeDraft').inputValue(), draft);
    assert.equal(original.sent, 1);
    assert.equal(requests.launch.length, 1);
    if (!await page.evaluate(() => window.hccHandoff.canControl)) await page.locator('#claimControlBtn').click();
    await page.waitForFunction(() => window.hccHandoff.canControl);
    await shot(page, 'desktop-web-reconnected-native');
    check('closing and reopening Web preserves the new native owner, provider session, active turn and unsent draft without replay');

    original.state.status = 'idle'; original.state.turnId = null;
    original.emit({ type: 'completed', status: 'completed', turnId: active.snapshot.turnId });
    await page.locator('#nativeRead').click();
    await page.waitForFunction(() => document.getElementById('nativeInterrupt').disabled);
    await page.locator('#nativeCloseConfirmed').check();
    const closeReply = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/sessions/' + peer + '/native/close');
    await page.locator('#nativeClose').click();
    assert.equal((await closeReply).status(), 200);
    const closed = (await api('GET', '/status')).workers.find(worker => worker.peer === peer);
    assert.equal(closed.status, 'closed'); assert.equal(closed.owned, false);
    await page.locator('#openHistoryDialog').click();
    await page.locator('#historyThreads [data-thread="' + peer + '"]').click();
    await page.waitForFunction(() => document.getElementById('historySelected').textContent.includes('qa-web-created') &&
      !document.getElementById('historyConfirmed').disabled);
    assert.equal(await page.locator('#historyResume').isDisabled(), true);
    await page.locator('#historyConfirmed').check();
    // History confirmation submits restore directly; it does not require a second launch.
    await page.locator('#historyResume').click();
    await page.waitForFunction(peer => document.getElementById('startDialog').hidden &&
      window.hccHandoff?.active === peer && window.hccHandoff.actionToken &&
      /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent), peer);
    const resumed = await api('GET', '/workers/' + peer + '/state');
    const replacement = adaptersByPeer.get(peer);
    assert.notEqual(resumed.owner, initial.owner);
    assert.equal(resumed.snapshot.sessionId, initial.snapshot.sessionId);
    assert.equal(resumed.generation, initial.generation);
    assert.notEqual(replacement, original);
    assert.equal(replacement.opens.length, 1);
    assert.equal(replacement.opens[0].sessionId, initial.snapshot.sessionId);
    assert.equal(replacement.sent || 0, 0);
    assert.equal(requests.launch.length, 1); assert.equal(requests.resume.length, 1);
    assert.equal(await page.locator('#nativeNotice').innerText(), '');
    assert.equal(await page.locator('#nativeCloseConfirmed').isChecked(), false);
    assert.equal(await page.locator('#nativeDraft').inputValue(), draft);
    await shot(page, 'desktop-native-history-resumed');
    check('explicit retained-history confirmation resumes the same provider session in a new native owner without creating or replaying input');

    // Close every Web view before stopping its HTTP service; native has a separate owner.
    await Promise.all(browser.contexts().map(view => view.close()));
    await stopWeb();
    const serviceAfter = await api('GET', '/status');
    const afterWebShutdown = await api('GET', '/workers/' + peer + '/state');
    assert.equal(serviceAfter.pid, serviceBefore.pid);
    assert.equal(serviceAfter.generation, serviceBefore.generation);
    assert.equal(afterWebShutdown.owner, resumed.owner);
    assert.equal(afterWebShutdown.snapshot.sessionId, resumed.snapshot.sessionId);
    evidence.nativeHandoff = { providerMode: 'synthetic native adapter', nativeRuntimePid: serviceAfter.pid,
      generation: initial.generation, originalOwner: initial.owner, resumedOwner: resumed.owner,
      providerSessionId: resumed.snapshot.sessionId, launchRequests: requests.launch.length,
      resumeRequests: requests.resume.length, originalInputs: original.sent, replayedInputs: replacement.sent || 0,
      webShutdownPreservedNativeRuntime: true };
    check('Web shutdown keeps the independently owned native runtime and resumed worker alive');
  } catch (error) {
    evidence.nativeHandoffFailure = { requests, message: error.message, current: page.isClosed() ? null : await page.evaluate(() => ({ active: window.hccHandoff?.active, project: window.hccHandoff?.projectRoot, canControl: window.hccHandoff?.canControl, startError: document.getElementById('startDialogError').textContent, startHidden: document.getElementById('startDialog').hidden })) };
    evidence.nativeHandoffFailure.runtime = await api('GET', '/status');
    if (!page.isClosed()) await shot(page, 'native-handoff-failure');
    throw error;
  } finally { await context.close(); }
}
