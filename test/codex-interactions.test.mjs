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

test('MCP responses require explicit form content and refuse auth URLs or malformed schemas', () => {
  const params = { mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} } };
  for (const altered of [{ ...params, mode: 'url' }, { ...params, mode: 'openai/userVerification' },
    { ...params, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
    { ...params, requestedSchema: { type: 'object', properties: {}, allOf: [{ required: ['secret'] }] } }]) {
    const request = { kind: 'mcp', method: 'mcpServer/elicitation/request', params: altered };
    assert.throws(() => respond(request, { decision: 'accept' }), { code: 'INTERACTION_RESPONSE_INVALID' });
    assert.deepEqual(respond(request, { decision: 'cancel' }), { action: 'cancel' });
  }
});

const formRequest = (properties, required = Object.keys(properties)) => ({ kind: 'mcp', method: 'mcpServer/elicitation/request',
  params: { mode: 'form', message: 'Fill in project preferences', requestedSchema: { type: 'object', properties, required } } });

test('MCP form returns typed explicit content, supports titled/legacy enums and never copies approval metadata', () => {
  const request = formRequest({ name: { type: 'string', minLength: 2, maxLength: 6 }, count: { type: 'integer', minimum: 1, maximum: 4 },
    ratio: { type: 'number', minimum: 0, maximum: 1 }, enabled: { type: 'boolean' }, region: { type: 'string', enum: ['us', 'eu'], enumNames: ['USA', 'Europe'] },
    plan: { type: 'string', oneOf: [{ const: 'small', title: 'Small' }, { const: 'large', title: 'Large' }] },
    features: { type: 'array', items: { type: 'string', enum: ['logs', 'tests'] }, minItems: 1, maxItems: 2 },
    optional: { type: 'string', default: 'unused' } }, ['name', 'count', 'ratio', 'enabled', 'region', 'plan', 'features']);
  request.params._meta = { codex_approval_kind: 'mcp_tool_call', persist: ['always'] };
  const content = { name: '项目😀', count: 2, ratio: 0.5, enabled: false, region: 'eu', plan: 'small', features: ['tests'] };
  const result = respond(request, { decision: 'accept', content, _meta: { persist: 'always' } });
  assert.deepEqual(result, { action: 'accept', content });
  assert.equal(Object.hasOwn(result.content, 'optional'), false);
  assert.notEqual(result.content.features, content.features);
  assert.deepEqual(respond(request, { decision: 'cancel', content }), { action: 'cancel' });
});

test('MCP form enforces required identities, types, bounds and exact option values before responding', () => {
  const request = formRequest({ name: { type: 'string', minLength: 2, maxLength: 4 }, count: { type: 'integer', minimum: 1, maximum: 3 },
    enabled: { type: 'boolean' }, plan: { type: 'string', enum: ['basic', 'pro'] }, features: { type: 'array', minItems: 1, maxItems: 1, items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } } });
  const valid = { name: '😀😀', count: 2, enabled: false, plan: 'basic', features: ['b'] };
  assert.deepEqual(respond(request, { decision: 'accept', content: valid }).content, valid);
  for (const bad of [{ name: 'x' }, { name: 'long-name' }, { name: null }, { count: '2' }, { count: 1.5 }, { count: 0 }, { count: 4 },
    { count: Infinity }, { count: NaN }, { enabled: 'false' }, { plan: 'Basic' }, { features: [] }, { features: ['a', 'a'] }, { features: ['missing'] }, { extra: true }]) {
    assert.throws(() => respond(request, { decision: 'accept', content: { ...valid, ...bad } }), { code: 'INTERACTION_RESPONSE_INVALID' });
  }
  for (const content of [undefined, null, [], { ...valid, name: undefined }]) assert.throws(() => respond(request, { decision: 'accept', content }), { code: 'INTERACTION_RESPONSE_INVALID' });
  const missing = { ...valid }; delete missing.enabled;
  assert.throws(() => respond(request, { decision: 'accept', content: missing }), /Required MCP field/);
});

test('MCP format constraints reject invalid calendar values and retain date-time offsets', () => {
  const request = formRequest({ email: { type: 'string', format: 'email' }, uri: { type: 'string', format: 'uri' },
    date: { type: 'string', format: 'date' }, time: { type: 'string', format: 'date-time' } });
  const valid = { email: 'user@example.com', uri: 'urn:example:item', date: '2024-02-29', time: '2024-02-29T13:05:01+08:00' };
  assert.deepEqual(respond(request, { decision: 'accept', content: valid }).content, valid);
  for (const invalid of [{ email: 'invalid' }, { email: 'a@#' }, { email: '.a@example.com' }, { email: 'a@-example.com' }, { uri: '/relative' }, { uri: 'https://example.com/<raw>' }, { uri: 'https://example.com/%XX' }, { date: '2025-02-29' },
    { time: '2024-02-30T00:00:00Z' }, { time: '2024-02-29T25:00:00Z' }, { time: '2024-02-29T00:00:00+25:00' }]) {
    assert.throws(() => respond(request, { decision: 'accept', content: { ...valid, ...invalid } }));
  }
});

test('MCP forms reject unsupported schemas and invalid defaults instead of silently ignoring constraints', () => {
  for (const definition of [{ type: 'object', properties: {} }, { type: 'string', pattern: '^safe$' }, { type: 'string', format: 'password' },
    { type: 'string', enum: ['a', 'a'] }, { type: 'string', enum: ['a'], enumNames: [] }, { type: 'string', minLength: 5, maxLength: 3 },
    { type: 'integer', default: 1.5 }, { type: 'number', minimum: 5, maximum: 3 }, { type: 'boolean', default: 'true' },
    { type: 'array', items: { type: 'string' } }, { type: 'array', minItems: 2, items: { type: 'string', enum: ['a'] } },
    { type: 'string', oneOf: [{ const: 'a', title: 'A', extra: true }] }]) {
    const request = formRequest({ field: definition });
    assert.throws(() => respond(request, { decision: 'accept', content: {} }));
    assert.deepEqual(respond(request, { decision: 'decline' }), { action: 'decline' });
  }
  for (const required of [null, ['missing'], ['field', 'field']]) {
    assert.throws(() => respond(formRequest({ field: { type: 'string' } }, required), { decision: 'accept', content: { field: 'ok' } }));
  }
});

test('MCP request and response limits bound field counts, lengths, options and prototype names', () => {
  const content = JSON.parse('{"__proto__":"explicit","constructor":"own"}');
  const properties = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"string"}}');
  const result = respond(formRequest(properties), { decision: 'accept', content });
  assert.equal(Object.hasOwn(result.content, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(result.content), Object.prototype);
  assert.deepEqual(result.content, content);
  for (const request of [formRequest(Object.fromEntries(Array.from({ length: 51 }, (_, i) => ['f'+i, { type: 'boolean' }]))),
    formRequest({ field: { type: 'string', enum: Array.from({ length: 101 }, (_, i) => String(i)) } }),
    formRequest({ field: { type: 'string', minLength: 8193 } })]) assert.throws(() => respond(request, { decision: 'accept', content: {} }));
  assert.throws(() => respond(formRequest({ field: { type: 'string' } }), { decision: 'accept', content: { field: 'x'.repeat(8193) } }));
});

test('native MCP content stays pending after invalid/stale replies and disappears after the original request is answered', async () => {
  const events = [], controller = createNativeInteractions({ executorId: 'mcp-worker', isActive: () => true, onChange: event => events.push(event) });
  const request = formRequest({ note: { type: 'string', minLength: 3 } });
  const response = controller.request({ ...request, requestId: 0, sessionId: 'session', turnId: 'turn', validate: respond, cancelled: { action: 'cancel' } });
  const pending = controller.snapshot()[0];
  assert.throws(() => controller.respond({ ...pending, turnId: 'old', decision: 'accept', content: { note: 'private-input' } }), { code: 'NATIVE_APPROVAL_MISMATCH' });
  assert.throws(() => controller.respond({ ...pending, decision: 'accept', content: { note: 'x' } }));
  assert.equal(controller.snapshot().length, 1);
  const receipt = controller.respond({ ...pending, decision: 'accept', content: { note: 'private-input' } });
  assert.deepEqual(await response, { action: 'accept', content: { note: 'private-input' } });
  assert.equal(controller.snapshot().length, 0);
  assert.equal(JSON.stringify({ receipt, events }).includes('private-input'), false);
});

const urlRequest = (overrides = {}) => ({ kind: 'mcp', method: 'mcpServer/elicitation/request', params: {
  mode: 'url', serverName: 'authorization-server', elicitationId: 'opaque-flow', url: 'https://auth.example/device?code=synthetic-code', ...overrides } });

test('MCP URL decisions acknowledge a valid out-of-band flow without form content or persistent grants', () => {
  for (const url of ['https://auth.example/device?code=synthetic', 'http://localhost:34000/authorize', 'http://127.0.0.1:34000/authorize', 'http://[::1]:34000/authorize']) {
    assert.deepEqual(respond(urlRequest({ url }), { decision: 'accept' }), { action: 'accept' });
  }
  for (const content of [{}, '', null]) assert.throws(() => respond(urlRequest(), { decision: 'accept', content }));
  for (const extra of [{ answers: {} }, { permissions: {} }]) assert.throws(() => respond(urlRequest(), { decision: 'accept', ...extra }));
  assert.deepEqual(respond(urlRequest(), { decision: 'decline' }), { action: 'decline' });
  assert.throws(() => respond({ ...urlRequest(), truncated: true }, { decision: 'accept' }), { code: 'INTERACTION_TRUNCATED' });
});

test('MCP URL acceptance rejects unsafe schemes, ambiguous targets and missing identities; cancellation remains available', () => {
  const invalid = [{ elicitationId: undefined }, { elicitationId: '' }, { elicitationId: 'x'.repeat(513) }, { elicitationId: 'a\n' },
    ...['javascript:alert(1)', 'data:text/html,unsafe', '/authorize', '//auth.example', 'https://user:pass@auth.example',
      'http://auth.example', 'http://localhost.attacker.example', 'https://auth.example/ with-space', 'https:\\auth.example',
      'https://auth.example/\u0000', 'https://auth.example/' + 'x'.repeat(8192)].map(url => ({ url }))];
  for (const override of invalid) {
    assert.throws(() => respond(urlRequest(override), { decision: 'accept' }), { code: 'INTERACTION_RESPONSE_INVALID' });
    assert.deepEqual(respond(urlRequest(override), { decision: 'cancel' }), { action: 'cancel' });
  }
});

test('native URL links and device identifiers are transient; expired request zero cannot be revived', async () => {
  const events = [], controller = createNativeInteractions({ executorId: 'url-worker', isActive: () => true, onChange: event => events.push(event) });
  const request = urlRequest({ message: 'Code synthetic-private-code', _meta: { redirect: 'private-redirect' } });
  const response = controller.request({ ...request, requestId: 0, sessionId: 'session', turnId: 'turn', validate: respond, cancelled: { action: 'cancel' } });
  const pending = controller.snapshot()[0];
  assert.equal(pending.params.url, request.params.url);
  assert.equal(JSON.stringify(events).includes('synthetic-code'), false);
  assert.equal(JSON.stringify(events).includes('synthetic-private-code'), false);
  assert.equal(JSON.stringify(events).includes('opaque-flow'), false);
  assert.equal(JSON.stringify(events).includes('private-redirect'), false);
  controller.resolved(0);
  assert.deepEqual(await response, { action: 'cancel' });
  assert.throws(() => controller.respond({ ...pending, decision: 'accept' }), { code: 'NATIVE_APPROVAL_MISMATCH' });
});
