import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// These assertions use the actual Web HTTP/native bridge with a simulated
// adapter. They never invoke a model, execute the displayed command, or send a draft.
export async function runSessionToolsChecks({ page, adapters, root, check, shot }) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.evaluate(() => window.hccHandoff.active), 'qa-codex');
  const adapter = adapters.get('codex'), before = adapter.sent || 0;
  const initialDraft = await page.locator('#nativeDraft').inputValue();
  const priorMetrics = adapter.state.metrics, priorMetadata = adapter.state.runtimeMetadata;
  const directory = fs.mkdtempSync(path.join(root, 'context-check-'));
  const relative = path.basename(directory) + '/reference.txt';
  const content = 'FIXTURE_CONTENT_MUST_NOT_BE_READ_OR_INSERTED';
  fs.writeFileSync(path.join(directory, 'reference.txt'), content);
  const expand = async label => {
    if (!await page.locator(label).evaluate(element => element.parentElement.open)) await page.locator(label).click();
  };
  try {
    await expand('#nativeContextLabel');
    const listing = page.waitForResponse(response => response.url().includes('/api/context/files?') && response.request().method() === 'GET');
    await page.locator('#nativeFileQuery').fill(relative);
    await page.locator('#nativeFileSearch').click();
    const response = await listing; assert.equal(response.status(), 200);
    const body = await response.json(); assert.ok(body.paths.includes(relative));
    assert.ok(body.paths.every(value => !path.isAbsolute(value)));
    assert.equal(JSON.stringify(body).includes(content), false);
    await page.waitForFunction(relative => [...document.querySelectorAll('#nativeFileResults option')].some(option => option.textContent === relative), relative);
    const fileValue = await page.locator('#nativeFileResults option').filter({ hasText: relative }).getAttribute('value');
    await page.locator('#nativeFileResults').selectOption(fileValue);
    await page.locator('#nativeFileInsert').click();
    assert.ok((await page.locator('#nativeDraft').inputValue()).includes('[file reference: ' + JSON.stringify(relative) + ']'));
    await expand('#nativeContextLabel');
    const sessionValue = await page.locator('#nativeSessionResults').evaluate(element => [...element.options].find(option => option.textContent.includes('qa-claude'))?.value);
    assert.notEqual(sessionValue, undefined); await page.locator('#nativeSessionResults').selectOption(sessionValue);
    await page.locator('#nativeSessionInsert').click();
    const draft = await page.locator('#nativeDraft').inputValue();
    assert.match(draft, /\[session reference: "claude:qa-claude/);
    assert.equal(draft.includes(content), false); assert.equal(adapter.sent || 0, before);
    assert.match(await page.locator('#nativeContextHelp').innerText(), /不会读取|not read/);
    check('context file endpoint returns only relative names and file/session references edit the existing draft without sending');

    await expand('#nativeMetricsLabel');
    assert.match(await page.locator('#nativeMetricsSource').innerText(), /未报告|No upstream metrics/);
    adapter.state.metrics = { source: 'fixture: codex thread/tokenUsage/updated', scope: 'session', observedAt: Date.now(), inputTokens: 0, outputTokens: 7, cachedInputTokens: 0, totalTokens: 7, contextWindow: 128000 };
    adapter.state.runtimeMetadata = { model: 'fixture-reported-model', permissionMode: 'on-request' };
    adapter.emit({ type: 'usage', metrics: adapter.state.metrics });
    adapter.emit({ type: 'metadata', runtimeMetadata: adapter.state.runtimeMetadata });
    await page.locator('#nativeRead').click();
    await page.waitForFunction(() => document.getElementById('nativeMetricsSource').textContent.includes('fixture: codex thread/tokenUsage/updated'));
    const metricRows = await page.locator('#nativeMetrics').evaluate(element => Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling.textContent])));
    assert.equal(metricRows['输入 token'] ?? metricRows['Input tokens'], '0');
    assert.equal(metricRows['总 token'] ?? metricRows['Total tokens'], '7');
    assert.match(metricRows['上下文占用'] ?? metricRows['Context occupancy'], /未报告|Not reported/);
    assert.equal(metricRows['上下文窗口上限'] ?? metricRows['Context window limit'], '128000');
    await expand('#nativeContextLabel');
    assert.match(await page.locator('#nativeCapabilitySummary').innerText(), /fixture-reported-model/);
    assert.match(await page.locator('#nativeCapabilitySummary').innerText(), /只读|read only/);
    assert.equal(await page.locator('#nativeCommandRow').isVisible(), false);
    assert.equal(adapter.sent || 0, before);
    check('reported metrics preserve actual zero and source/scope while missing context occupancy remains unknown and settings stay read only');

    adapter.emit({type:'item',turnId:'trace-turn-a',phase:'completed',item:{id:'trace-failure',type:'commandExecution',status:'failed',exitCode:2,command:'npm run fixture-check',aggregatedOutput:'TRACE_FAILURE missing fixture package'}});
    adapter.emit({type:'item',turnId:'trace-turn-b',phase:'completed',item:{id:'trace-file',type:'fileChange',status:'completed',changes:[{path:'acceptance/changed.mjs',diff:'+TRACE_FILE_CHANGE'}]}});
    adapter.emit({type:'message',turnId:'trace-turn-b',itemId:'trace-other',text:'TRACE_OTHER unrelated answer'});
    await page.locator('#nativeRead').click();
    await page.waitForFunction(() => document.getElementById('nativeEvents').textContent.includes('npm run fixture-check'));
    await expand('#nativeTraceFilterLabel');
    await page.locator('#nativeTraceKind').selectOption('failed');
    await page.locator('#nativeTraceTurn').selectOption('trace-turn-a');
    await page.locator('#nativeTraceQuery').fill('TRACE_FAILURE npm');
    await page.waitForFunction(() => document.querySelectorAll('#nativeEvents [data-native-card]').length === 1);
    assert.equal(await page.locator('#nativeEvents [data-native-card]').count(), 1);
    assert.match(await page.locator('#nativeEvents').innerText(), /npm run fixture-check/);
    assert.doesNotMatch(await page.locator('#nativeEvents').innerText(), /TRACE_OTHER|acceptance\/changed/);
    await page.locator('#nativeTraceTurn').selectOption('trace-turn-b');
    assert.match(await page.locator('#nativeEvents').innerText(), /没有匹配|No matching/);
    await page.locator('#nativeTraceTurn').selectOption('trace-turn-a');
    await page.locator('#nativeEvents button[data-native-locate]').click();
    assert.equal(await page.locator('#nativeTrace').getAttribute('aria-pressed'), 'true');
    const raw = page.locator('#nativeEvents article').filter({has:page.locator('details[open]')}).filter({hasText:'TRACE_FAILURE'});
    assert.equal(await raw.count(), 1);assert.match(await raw.innerText(), /exitCode/);
    await raw.locator('button[data-native-result]').click();
    assert.equal(await page.locator('#nativeConversation').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#nativeTraceKind').inputValue(), 'all');
    assert.equal(await page.locator('#nativeTraceQuery').inputValue(), '');
    assert.equal(await page.locator('#nativeEvents details[open]').filter({hasText:'TRACE_FAILURE'}).count(), 1);
    await page.locator('#nativeTraceKind').selectOption('files');
    await page.locator('#nativeTraceTurn').selectOption('trace-turn-b');
    await page.locator('#nativeTraceQuery').fill('acceptance/changed.mjs');
    assert.equal(await page.locator('#nativeEvents [data-native-card]').count(), 1);
    const changedFile = page.locator('#nativeEvents [data-native-card] details').first();
    if (!await changedFile.evaluate(element => element.open)) await changedFile.locator('summary').click();
    assert.match(await page.locator('#nativeEvents').innerText(), /acceptance\/changed.mjs/);
    await page.locator('#nativeTraceClear').click();
    assert.ok(await page.locator('#nativeEvents [data-native-card]').count() > 1);
    assert.equal(adapter.sent || 0, before);
    check('native retained-history query/turn/kind filters combine with AND and results locate raw events and return to expanded results');
    await shot(page, 'desktop-session-context-and-metrics');
  } finally {
    adapter.state.metrics = priorMetrics;
    adapter.state.runtimeMetadata = priorMetadata;
    adapter.emit({ type: 'metadata', runtimeMetadata: priorMetadata || {} });
    if (await page.locator('#nativeTraceClear').isVisible()) await page.locator('#nativeTraceClear').click();
    await page.locator('#nativeConversation').click().catch(() => {});
    await page.locator('#nativeDraft').fill(initialDraft);
    await page.locator('#nativeRead').click();
    for (const label of ['#nativeContextLabel', '#nativeMetricsLabel', '#nativeTraceFilterLabel']) if (await page.locator(label).evaluate(element => element.parentElement.open)) await page.locator(label).click();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
