import test from 'node:test';
import assert from 'node:assert/strict';
import { codexInteractionResponse as respond, cancelCodexInteraction } from '../lib/integrations/codex-interactions.mjs';
import { createNativeInteractions } from '../lib/integrations/native/interactions.mjs';

const denied = { access: 'deny', path: { type: 'path', path: '/private/key' } };
const path = { access: 'write', path: { type: 'path', path: '/project/file' } };
const requested = { network: { enabled: true }, fileSystem: { read: ['/read/a','/read/b'], write: ['/project'], entries: [denied, path], globScanMaxDepth: 2 } };
const request = { kind: 'permissions', params: { permissions: requested } };

test('permissions allow explicit subsets and preserve requested deny rules', () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/read/a'], entries: [denied], globScanMaxDepth: 2 } };
  assert.deepEqual(respond(request, { decision: 'accept', permissions, scope: 'turn' }), { permissions, scope: 'turn' });
  assert.deepEqual(respond(request, { decision: 'accept', permissions: {}, scope: 'session' }), { permissions: {}, scope: 'session' });
  assert.deepEqual(respond(request, { decision: 'decline', permissions: requested, scope: 'session' }), { permissions: {}, scope: 'turn' });
});

test('permissions refuse widened paths, access modes, network, dropped denials and implicit duration', () => {
  for (const permissions of [ { network: { enabled: true, host: '*' } }, { fileSystem: { write: ['/'] } },
    { fileSystem: { read: ['/read/a'] } }, { fileSystem: { entries: [denied, { ...path, path: { type: 'special', value: { kind: 'root' } } }] } },
    { fileSystem: { entries: [denied], globScanMaxDepth: 9 } }, { fileSystem: { entries: [denied], write: ['/project','/project'] } }, { all: true } ]) {
    assert.throws(() => respond(request, { decision: 'accept', permissions, scope: 'turn' }), { code: 'INTERACTION_RESPONSE_INVALID' });
  }
  assert.throws(() => respond({ kind: 'permissions', params: { permissions: {} } }, { decision: 'accept', permissions: { network: { enabled: true } }, scope: 'turn' }));
  assert.throws(() => respond(request, { decision: 'accept', permissions: {} }));
});

test('questions require exact IDs and offered labels, and explicitly allow freeform or Other answers', () => {
  const question = { id: 'color', options: [{ label: 'Blue' }, { label: 'Red' }] };
  const userInput = { kind: 'userInput', params: { questions: [question] } };
  assert.deepEqual(JSON.parse(JSON.stringify(respond(userInput, { answers: { color: { answers: ['Blue'] } } }))), { answers: { color: { answers: ['Blue'] } } });
  for (const answers of [ {}, { different: { answers: ['Blue'] } }, { color: { answers: ['Green'] } }, { color: { answers: ['Blue','Red'] } }, { color: { answers: [''] } }, { color: { answers: ['Blue'], option: 0 } } ]) assert.throws(() => respond(userInput, { answers }));
  assert.equal(respond({ kind: 'userInput', params: { questions: [{ ...question, isOther: true }] } }, { answers: { color: { answers: ['Green'] } } }).answers.color.answers[0], 'Green');
  assert.equal(respond({ kind: 'userInput', params: { questions: [{ id: 'secret', isSecret: true }] } }, { answers: { secret: { answers: ['password'] } } }).answers.secret.answers[0], 'password');
  assert.deepEqual(respond(userInput, { decision: 'cancel' }), { answers: {} });
  assert.throws(() => respond({ kind: 'userInput', params: { questions: [question, question] } }, { answers: { color: { answers: ['Blue'] } } }));
});

test('truncated interactions cannot grant permissions or answer unseen questions', () => {
  assert.throws(() => respond({ ...request, truncated: true }, { decision: 'accept', permissions: {}, scope: 'turn' }), { code: 'INTERACTION_TRUNCATED' });
  assert.throws(() => respond({ kind: 'userInput', truncated: true, params: {} }, { answers: {} }), { code: 'INTERACTION_TRUNCATED' });
  assert.deepEqual(cancelCodexInteraction('item/tool/requestUserInput'), { answers: {} });
});

test('native request exact identities fence duplicate decisions and never retain secret answers', async () => {
  const events = [], controller = createNativeInteractions({ executorId: 'worker-1', isActive: () => true, onChange: e => events.push(e) });
  const result = controller.request({ requestId: 5, sessionId: 'session-1', turnId: 'turn-1', kind: 'userInput',
    params: { questions: [{ id: 'secret', isSecret: true }] }, validate: respond, cancelled: { answers: {} } });
  const pending = controller.snapshot()[0];
  for (const bad of [{ executorId: 'other' }, { sessionId: 'other' }, { turnId: 'other' }, { requestId: '5' }]) assert.throws(() => controller.respond({ ...pending, ...bad, answers: { secret: { answers: ['hidden-value'] } } }), { code: 'NATIVE_APPROVAL_MISMATCH' });
  assert.equal(controller.respond({ ...pending, answers: { secret: { answers: ['hidden-value'] } } }).status, 'submitted');
  assert.equal((await result).answers.secret.answers[0], 'hidden-value');
  assert.equal(JSON.stringify([events, controller.snapshot()]).includes('hidden-value'), false);
  assert.throws(() => controller.respond({ ...pending, answers: {} }), { code: 'NATIVE_APPROVAL_MISMATCH' });
});

test('native cancellation, provider resolution and abort settle waiters without auto-granting', async () => {
  const controller = createNativeInteractions({ executorId: 'worker', isActive: () => true });
  for (const [id, cancel] of [[1, () => controller.expire('turn')], [2, () => controller.resolved(2)]]) {
    const p = controller.request({ requestId: id, sessionId: 'session', turnId: 'turn', params: {}, cancelled: { decision: 'cancel' } });
    cancel(); assert.deepEqual(await p, { decision: 'cancel' }); assert.equal(controller.snapshot().length, 0);
  }
  const abort = new AbortController(), p = controller.request({ requestId: 3, sessionId: 'session', turnId: 'turn', params: {}, signal: abort.signal, cancelled: { decision: 'cancel' } });
  abort.abort(); assert.deepEqual(await p, { decision: 'cancel' });
});


test('MCP tool approvals use official one-call action/content without persisting permission', () => {
  const request = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: {
    mode: 'form', serverName: 'hello_cc_scoped', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    requestedSchema: { type: 'object', properties: {} } } };
  assert.deepEqual(respond(request, { decision: 'accept' }), { action: 'accept', content: {} });
  assert.deepEqual(respond(request, { decision: 'decline' }), { action: 'decline' });
  assert.deepEqual(cancelCodexInteraction(request.method), { action: 'cancel' });
  assert.throws(() => respond({ ...request, truncated: true }, { decision: 'accept' }), { code: 'INTERACTION_TRUNCATED' });
});

test('MCP approvals do not silently answer forms, follow auth URLs or grant malformed schema requests', () => {
  const params = { mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } };
  for (const altered of [{ ...params, mode: 'url' }, { ...params, _meta: {} },
    { ...params, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
    { ...params, requestedSchema: { type: 'object', properties: {}, allOf: [{ required: ['secret'] }] } }]) {
    const request = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: altered };
    assert.throws(() => respond(request, { decision: 'accept' }), { code: 'INTERACTION_RESPONSE_INVALID' });
    assert.deepEqual(respond(request, { decision: 'cancel' }), { action: 'cancel' });
  }
});
