import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { interactionPanelScript } from '../lib/web/ui-interactions.mjs';
import { codexInteractionResponse } from '../lib/integrations/codex-interactions.mjs';

function panel() {
  const context = { window: {}, document: {} };
  vm.runInNewContext(interactionPanelScript(), context);
  return context.window.hccInteractions;
}
const permission = (access, value) => ({ access, path: { type: 'path', path: value } });
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

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
