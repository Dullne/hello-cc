import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { interactionPanelScript, installInteractionPanel } from '../lib/web/ui-interactions.mjs';
import { codexInteractionResponse } from '../lib/integrations/codex-interactions.mjs';

function panel(window = {}) {
  const context = { window, document: {}, URL };
  vm.runInNewContext(interactionPanelScript(), context);
  return context.window.hccInteractions;
}
const permission = (access, value) => ({ access, path: { type: 'path', path: value } });
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('actual ESM installer resolves shared form and URL validators without inline factory injection', t => {
  // The shipped browser imports this initializer directly; testing only its
  // legacy string wrapper would miss broken ESM dependency/default bindings.
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete globalThis.window; });
  globalThis.window = {};
  installInteractionPanel();
  const ui = globalThis.window.hccInteractions;
  const request = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: {
    type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count']
  } } };
  const control = { value: '3' }, container = { querySelectorAll: () => [control] };
  const answer = ui.payload(request, container, 'accept');
  assert.deepEqual(answer, { decision: 'accept', content: { count: 3 } });
  assert.deepEqual(codexInteractionResponse(request, answer), { action: 'accept', content: { count: 3 } });
  control.value = '1.5';
  assert.throws(() => ui.payload(request, container, 'accept'), /Invalid value/);
  const authorization = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: {
    mode: 'url', elicitationId: 'fixture', url: 'https://auth.example/flow'
  } };
  assert.equal(ui.approvalBlocked(authorization), false);
  assert.deepEqual(codexInteractionResponse(authorization, ui.payload(authorization, null, 'accept')), { action: 'accept' });
  assert.equal(ui.approvalBlocked({ ...authorization, params: { ...authorization.params, url: 'invalid-url' } }), true);
  installInteractionPanel();
  assert.equal(globalThis.window.hccInteractions, ui);
});

test('mirrored Codex permission paths render once and keep original entry indices and denials', () => {
  const entries = [permission('deny', '/private'), permission('write', '/requested')];
  const request = { kind: 'permissions', params: { permissions: { fileSystem: { write: ['/requested', '/legacy-only'], entries } } } };
  const ui = panel(), html = ui.form(request, 'owner', esc, en => en);
  assert.equal((html.match(/data-permission="entries"/g) || []).length, 1);
  assert.equal((html.match(/data-permission="write"/g) || []).length, 1);
  assert.match(html, /data-permission="write" data-index="1"/);
  assert.match(html, /data-permission="entries" data-index="1"/);
  assert.match(html, /Retained denial/);
  const container = {
    querySelectorAll: () => [{ checked: true, dataset: { permission: 'entries', index: '1' } }],
    querySelector: () => ({ value: 'turn' })
  };
  const answer = JSON.parse(JSON.stringify(ui.payload(request, container, 'accept')));
  assert.deepEqual(answer.permissions, { fileSystem: { entries: [entries[1], entries[0]] } });
  assert.deepEqual(codexInteractionResponse(request, answer), { permissions: answer.permissions, scope: 'turn' });
  assert.deepEqual(request.params.permissions.fileSystem.write, ['/requested', '/legacy-only']);
});

test('distinct read scopes, glob entries and legacy paths remain selectable and escaped', () => {
  const request = { kind: 'permissions', params: { permissions: { fileSystem: {
    read: ['/requested', '/<legacy>'], write: ['/requested'], entries: [permission('write', '/requested'), { access: 'read', path: { type: 'glob', glob: '/other/**' } }]
  } } } };
  const html = panel().form(request, 'owner', esc, en => en);
  assert.equal((html.match(/data-permission="read"/g) || []).length, 2);
  assert.equal((html.match(/data-permission="write"/g) || []).length, 0);
  assert.equal((html.match(/data-permission="entries"/g) || []).length, 2);
  assert.match(html, /&lt;legacy>/); assert.equal(html.includes('/<legacy>'), false);
});


test('native ACP preview shows the bounded operation, escapes inputs and retains complete collapsed details', () => {
  const request = { kind: 'approval', method: 'session/request_permission', params: {
    toolCall: { title: 'write', rawInput: { file_path: '/<target>', content: '<script>bad()</script>' + 'x'.repeat(1200) } },
    options: [{ kind: 'allow_once', optionId: 'approve-one-operation' }]
  } };
  const ui = panel(), html = ui.preview(request, 'owner:0', esc, en => en);
  assert.match(html, /<dt>Tool<\/dt><dd>write<\/dd>/);
  assert.match(html, /&lt;target>/); assert.equal(html.includes('/<target>'), false);
  assert.equal(html.includes('<script>bad()'), false);
  assert.match(html, /Approval applies only to this operation/);
  assert.match(html, /Preview shortened/);
  assert.match(html, /data-interaction-details="owner:0"><summary>/);
  assert.ok(html.includes(esc(JSON.stringify(request.params, null, 2))), 'full operation remains available');
  assert.equal(ui.approvalBlocked(request), false);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.payload(request, null, 'accept'))), { decision: 'accept' });
});

test('native approval remains disabled for missing ACP context or absent one-time permission', () => {
  const ui = panel();
  for (const toolCall of [undefined, { toolCallId: 'missing' }, { rawInput: {}, contextPending: true }, { rawInput: {}, contextTruncated: true }]) {
    const request = { kind: 'approval', method: 'session/request_permission', params: { toolCall, options: [{ kind: 'allow_once' }] } };
    assert.equal(ui.approvalBlocked(request), true);
    assert.match(ui.preview(request, 'owner', esc, en => en), /Only rejection is available/);
  }
  assert.equal(ui.approvalBlocked({ method: 'session/request_permission', params: { toolCall: { rawInput: {} }, options: [{ kind: 'allow_always' }] } }), true);
  assert.equal(ui.approvalBlocked({ kind: 'userInput', truncated: true }), true);
  assert.equal(ui.approvalBlocked({ method: 'claude/canUseTool', kind: 'approval', params: { tool: 'Write', input: { file_path: '/tmp/file' } } }), false);
});

test('native operation details stay expanded across refresh and are forgotten after the decision', () => {
  const ui = panel();
  const detail = { dataset: { interactionDetails: 'owner:request' }, open: true };
  const container = { querySelectorAll: selector => selector === '[data-interaction-details]' ? [detail] : [] };
  ui.remember(container); detail.open = false; ui.restore(container); assert.equal(detail.open, true);
  detail.open = false; ui.remember(container); detail.open = true; ui.restore(container); assert.equal(detail.open, false);
  ui.forget('owner:request'); detail.open = true; ui.restore(container); assert.equal(detail.open, true);
});

test('MCP Web form maps indexed selections to typed values and deliberately omits optional defaults', () => {
  const request = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: {
    type: 'object', properties: { name: { type: 'string', title: '<Name>', description: '<script>bad()</script>', minLength: 2 },
      count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' }, region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }] },
      features: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } }, optional: { type: 'string', default: 'suggested' } },
    required: ['name', 'count', 'enabled', 'region', 'features'] } } };
  const ui = panel(), html = ui.form(request, '<owner>', esc, en => en);
  assert.equal(ui.requiresInput(request), true); assert.equal(ui.approvalBlocked(request), false);
  assert.equal(html.includes('<script>'), false); assert.match(html, /&lt;Name>/); assert.match(html, /&lt;owner>/);
  assert.match(html, /Europe/); assert.match(html, /Provide this optional field/); assert.match(html, /Min selections: 1/);
  const controls = [[{ value: 'Project' }], [{ value: '2' }], [{ value: '1' }], [{ value: '0' }],
    [{ checked: false, dataset: { mcpOption: '0' } }, { checked: true, dataset: { mcpOption: '1' } }], [{ value: 'suggested' }]];
  const optional = { checked: false };
  const container = { querySelector: () => optional, querySelectorAll: selector => controls[Number(selector.match(/"(\d+)"/)[1])] };
  const answer = JSON.parse(JSON.stringify(ui.payload(request, container, 'accept')));
  assert.deepEqual(answer, { decision: 'accept', content: { name: 'Project', count: 2, enabled: false, region: 'eu', features: ['b'] } });
  assert.deepEqual(codexInteractionResponse(request, answer), { action: 'accept', content: answer.content });
  optional.checked = true;
  assert.equal(ui.payload(request, container, 'accept').content.optional, 'suggested');
  controls[1][0].value = '';
  assert.throws(() => ui.payload(request, container, 'accept'), /Enter a number/);
  controls[1][0].value = '1.5';
  assert.throws(() => ui.payload(request, container, 'accept'), /Invalid value/);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.payload(request, null, 'cancel'))), { decision: 'cancel' });
});

test('MCP unsupported modes and schemas show an explanation and disable only acceptance', () => {
  const ui = panel();
  for (const params of [{ mode: 'url', url: 'https://auth.example' }, { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } }]) {
    const request = { kind: 'mcp', params };
    assert.equal(ui.approvalBlocked(request), true);
    assert.match(ui.form(request, 'owner', esc, en => en), /role="alert"/);
    assert.match(ui.form(request, 'owner', esc, en => en), /Decline or cancel/);
    assert.throws(() => ui.payload(request, null, 'accept'));
    assert.deepEqual(JSON.parse(JSON.stringify(ui.payload(request, null, 'decline'))), { decision: 'decline' });
  }
});

test('MCP drafts live only in memory during rerender and all fields clear after a decision', () => {
  const ui = panel();
  const value = { type: 'text', value: 'private-form-value', dataset: { interactionField: 'owner:form:mcp:0' } };
  const choice = { type: 'checkbox', checked: true, value: '', dataset: { interactionField: 'owner:form:mcp:1:0' } };
  const container = { querySelectorAll: selector => selector === '[data-interaction-field]' ? [value, choice] : [] };
  ui.remember(container); value.value = ''; choice.checked = false; ui.restore(container);
  assert.equal(value.value, 'private-form-value'); assert.equal(choice.checked, true);
  ui.forget('owner:form'); value.value = ''; choice.checked = false; ui.restore(container);
  assert.equal(value.value, ''); assert.equal(choice.checked, false);
});


test('MCP larger selection forms keep early text fields during refresh', () => {
  const ui = panel();
  const controls = Array.from({ length: 600 }, (_, i) => ({ type: i ? 'checkbox' : 'text', value: i ? '' : 'keep-first-field', checked: true,
    dataset: { interactionField: 'owner:large:mcp:' + i } }));
  const container = { querySelectorAll: selector => selector === '[data-interaction-field]' ? controls : [] };
  ui.remember(container); controls[0].value = ''; controls[10].checked = false; ui.restore(container);
  assert.equal(controls[0].value, 'keep-first-field'); assert.equal(controls[10].checked, true);
});

const urlRequest = (overrides = {}) => ({ kind: 'mcp', method: 'mcpServer/elicitation/request', params: {
  mode: 'url', elicitationId: 'private-identity', serverName: 'synthetic-server', url: 'https://auth.example/device?code=private-code', ...overrides } });

test('URL approval shows the destination, sends no content and hides opaque URL details', () => {
  const ui = panel(), request = urlRequest();
  const html = ui.form(request, 'owner', esc, en => en) + ui.preview(request, 'owner', esc, en => en);
  assert.equal(ui.approvalBlocked(request), false);
  assert.match(html, /https:\/\/auth.example/);
  assert.match(html, /does not confirm authorization/);
  assert.equal(html.includes('private-code'), false);
  assert.equal(html.includes('private-identity'), false);
  assert.equal(ui.acceptLabel(request, en => en), 'Open authorization page');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.payload(request, null, 'accept'))), { decision: 'accept' });
  const loopback = ui.form(urlRequest({ url: 'http://127.0.0.1:3000/authorize' }), 'owner', esc, en => en);
  assert.match(loopback, /another device may not reach it/);
});

test('URL popup is reserved in a click but receives the auth URL only after acceptance; failed requests close it', () => {
  const opened = [], navigations = [], page = { closed: false, opener: 'original', document: { write() {}, close() {} },
    location: { replace(url) { navigations.push(url); } }, close() { this.closed = true; } };
  const ui = panel({ open(...args) { opened.push(args); return page; } });
  assert.equal(ui.prepareUrl(urlRequest(), 'decline', en => en), null);
  assert.equal(opened.length, 0);
  let authorization = ui.prepareUrl(urlRequest(), 'accept', en => en);
  assert.equal(page.opener, null);
  assert.deepEqual(opened[0], ['about:blank', '_blank']);
  assert.equal(navigations.length, 0);
  authorization.cancel(); assert.equal(page.closed, true);
  page.closed = false;
  authorization = ui.prepareUrl(urlRequest(), 'accept', en => en);
  assert.match(authorization.complete(), /does not confirm authorization/);
  assert.deepEqual(navigations, ['https://auth.example/device?code=private-code']);
  authorization.cancel(); assert.equal(page.closed, false);
});

test('blocked popups and invalid URL requests leave acceptance unavailable', () => {
  const ui = panel({ open() { return null; } });
  assert.throws(() => ui.prepareUrl(urlRequest(), 'accept', en => en), /request has not been accepted/);
  for (const overrides of [{ url: 'javascript:alert(1)' }, { url: 'https://user:password@auth.example' }, { elicitationId: null }]) {
    const request = urlRequest(overrides);
    assert.equal(ui.approvalBlocked(request), true);
    assert.match(ui.form(request, 'owner', esc, en => en), /role="alert"/);
    assert.throws(() => ui.payload(request, null, 'accept'));
    assert.throws(() => ui.prepareUrl(request, 'accept', en => en), /cannot be opened/);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.payload(request, null, 'cancel'))), { decision: 'cancel' });
  }
});
