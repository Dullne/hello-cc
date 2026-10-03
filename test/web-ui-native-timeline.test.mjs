import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { nativeTimeline, nativeTimelineScript } from '../lib/web/ui-native-timeline.mjs';
import { nativePanelHtml } from '../lib/web/ui-native.mjs';

const events = (provider, values) => values.map((payload, index) => ({ id: index + 1, payload: { provider, sessionId: 's', turnId: 't', ...payload } }));
const messages = value => value.filter(record => record.kind === 'message');

test('Codex final messages replace their own deltas and completion does not duplicate the reply', () => {
  const result = nativeTimeline(events('codex', [
    { type: 'delta', itemId: 'one', text: 'Hel' }, { type: 'delta', itemId: 'one', text: 'lo' },
    { type: 'message', itemId: 'one', text: 'Hello' },
    { type: 'message', itemId: 'two', text: 'Second message' },
    { type: 'completed', status: 'completed', text: 'Second message' }
  ]));
  assert.deepEqual(messages(result).map(record => record.text), ['Hello', 'Second message']);
  assert.equal(result.at(-1).status, 'completed');
});

test('different Codex item identities never collapse into one streaming message', () => {
  const result = nativeTimeline(events('codex', [
    { type: 'delta', itemId: 'one', text: 'A' }, { type: 'delta', itemId: 'two', text: 'B' },
    { type: 'delta', itemId: 'one', text: 'C' }
  ]));
  assert.deepEqual(messages(result).map(record => record.text), ['AC', 'B']);
});

test('Claude anonymous deltas reconcile the final UUID without merging another parent tool turn', () => {
  const result = nativeTimeline(events('claude', [
    { type: 'delta', text: 'Draft' }, { type: 'message', messageId: 'uuid', role: 'assistant', text: 'Final' },
    { type: 'message', messageId: 'uuid', role: 'assistant', text: 'Final' },
    { type: 'message', messageId: 'nested', parentToolUseId: 'child', text: 'Subtask' },
    { type: 'completed', status: 'completed', text: 'Final' }
  ]));
  assert.deepEqual(messages(result).map(record => record.text), ['Final', 'Subtask']);
});

test('Claude child-agent messages use their parent tool identity when the adapter omits turn and submission IDs', () => {
  const child = { turnId: null, submissionId: null, parentToolUseId: 'child-tool' };
  const result = nativeTimeline(events('claude', [
    { ...child, type: 'delta', text: 'Hello ' }, { ...child, type: 'delta', text: 'world' },
    { ...child, type: 'message', messageId: 'child-message', text: 'Hello world' }
  ]));
  assert.equal(messages(result).length, 1);
  assert.equal(messages(result)[0].text, 'Hello world');
  assert.equal(messages(result)[0].parentToolUseId, 'child-tool');
  const f = fixture(); f.render(events('claude', [{ ...child, type: 'message', text: 'Child output' }]));
  assert.match(f.element('nativeEvents').innerHTML, /Assistant · Subtask/);
});

test('dsh persisted semantic chunks and cumulative completion produce one answer', () => {
  const result = nativeTimeline(events('dsh', [
    { type: 'session.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } },
    { type: 'session.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } },
    { type: 'completed', status: 'completed', text: 'Hello world' }
  ]));
  assert.deepEqual(messages(result).map(record => record.text), ['Hello world']);
});

test('dsh paired adapter output and semantic update never duplicate text', () => {
  const result = nativeTimeline(events('dsh', [
    { type: 'output', text: 'Hi' },
    { type: 'session.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } },
    { type: 'completed', status: 'completed', text: 'Hi' }
  ]));
  assert.deepEqual(messages(result).map(record => record.text), ['Hi']);
});

test('dsh completion replaces a retained tail while tools remain and explicit user chunks keep their role', () => {
  const result = nativeTimeline(events('dsh', [
    { type: 'session.update', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Question' } } },
    { type: 'session.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail' } } },
    { type: 'session.update', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'pending' } },
    { type: 'completed', status: 'completed', text: 'Earlier text and tail' }
  ]));
  assert.deepEqual(messages(result).map(record => [record.role, record.text]), [['user', 'Question'], ['assistant', 'Earlier text and tail']]);
  assert.equal(result.filter(record => record.kind === 'tool').length, 1);
});

test('tool updates retain actual input and status, file changes and failures stay distinct', () => {
  const result = nativeTimeline(events('dsh', [
    { type: 'session.update', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read file', rawInput: { path: 'src/a' }, status: 'pending' } },
    { type: 'session.update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Missing file' } }] } },
    { type: 'item', phase: 'completed', item: { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: 'src/b', diff: '+hello' }] } },
    { type: 'completed', status: 'failed', text: 'Execution failed' }
  ]));
  const tool = result.find(record => record.kind === 'tool');
  assert.match(tool.input, /src\/a/); assert.equal(tool.status, 'failed'); assert.equal(tool.text, 'Missing file');
  assert.equal(result.filter(record => record.kind === 'tool').length, 1);
  assert.equal(result.find(record => record.kind === 'files').changes[0].path, 'src/b');
  assert.equal(result.find(record => record.kind === 'error').text, 'Execution failed');
  assert.equal(messages(result).length, 0, 'a failed result is not fabricated as an assistant reply');
});

test('partial Codex completion retains the known command and unknown event formats stay inspectable', () => {
  const result = nativeTimeline(events('codex', [
    { type: 'item', phase: 'started', item: { id: 'command', type: 'commandExecution', command: 'echo one', arguments: { cwd: '/project' } } },
    { type: 'item', phase: 'completed', item: { id: 'command', type: 'commandExecution', status: 'completed', aggregatedOutput: 'one' } },
    { type: 'future.event', text: 'Important update' },
    { type: 'session.update', update: { sessionUpdate: 'future_update', text: 'New ACP event' } }
  ]));
  assert.equal(result[0].command, 'echo one'); assert.match(result[0].input, /project/); assert.equal(result[0].text, 'one');
  assert.equal(result.filter(record => record.kind === 'tool').length, 1);
  assert.equal(result.filter(record => record.kind === 'event').length, 2);
  assert.match(result[1].text, /Important update/); assert.match(result[2].text, /New ACP event/);
});

test('bounded event windows and missing identity never invent prompt text, roles or completion', () => {
  const result = nativeTimeline(Array.from({ length: 140 }, (_, id) => ({ id, payload: { type: 'message', text: 'output ' + id } })));
  assert.equal(result.length, 100); assert.equal(result[0].text, 'output 40');
  assert.ok(result.every(record => record.role === 'output' && record.status === ''));
  assert.deepEqual(nativeTimeline(events('codex', [{ type: 'queued', message_id: 10, submission_id: 'receipt' }])), []);
});

function fixture() {
  const nodes = new Map(), copied = [];
  const element = id => {
    if (nodes.has(id)) return nodes.get(id);
    const node = { id, dataset: {}, hidden: false, open: false, textContent: '', scrollTop: 0, scrollLeft: 0,
      scrollHeight: 2000, clientHeight: 400, listeners: new Map(), details: [], codes: [], writes: 0,
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      setAttribute(name, value) { this[name] = value; },
      querySelectorAll(selector) { return selector.startsWith('details') ? this.details : selector.startsWith('pre') ? this.codes : []; },
      contains() { return true; }, emit(type, event = {}) { return this.listeners.get(type)?.(event); } };
    Object.defineProperty(node, 'innerHTML', { get() { return this.html || ''; }, set(value) {
      this.html = value; this.writes++;
      this.details = [...value.matchAll(/<details data-native-detail="([^"]+)"( open)?>/g)].map(match => ({ dataset: { nativeDetail: match[1].replaceAll('&quot;', '"') }, open: Boolean(match[2]) }));
      this.codes = [...value.matchAll(/data-native-code="([^"]+)"/g)].map(match => ({ dataset: { nativeCode: match[1].replaceAll('&quot;', '"') }, scrollTop: 0, scrollLeft: 0 }));
    } });
    nodes.set(id, node); return node;
  };
  const window = { navigator: { clipboard: { async writeText(value) { copied.push(value); } } } };
  vm.runInNewContext(nativeTimelineScript(), { window });
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  let language = 'en';
  const view = window.hccNativeTimelineView({ document: { getElementById: element }, window, escape, text: (en, zh) => language === 'en' ? en : zh });
  const render = (data, scope = 'a', state = {}) => view.render(data, { provider: 'codex', ...state }, scope);
  const action = dataset => element('nativeEvents').emit('click', { target: { closest: () => ({ dataset }) } });
  return { element, render, action, copied, setLanguage(value) { language = value; } };
}

test('native rendering reuses unchanged DOM and restores reading, tool expansion and technical details after switching', () => {
  const f = fixture(), data = events('codex', [
    { type: 'message', itemId: 'message', text: '**Hello** <img src=x>' },
    { type: 'item', item: { id: 'tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/project', status: 'completed' } }
  ]);
  f.render(data); const output = f.element('nativeEvents');
  assert.match(output.innerHTML, /<strong>Hello<\/strong>/); assert.match(output.innerHTML, /&lt;img src=x&gt;/);
  const writes = output.writes; f.render(data); assert.equal(output.writes, writes);
  f.element('nativeScroll').scrollTop = 180; f.element('nativeScroll').emit('scroll');
  output.details[0].open = true; f.element('nativeIdentityDetails').open = true;
  f.render(data, 'b'); f.render(data, 'a');
  assert.equal(f.element('nativeScroll').scrollTop, 180); assert.equal(output.details[0].open, true);
  assert.equal(f.element('nativeIdentityDetails').open, true);
  f.element('nativeJump').emit('click'); assert.equal(f.element('nativeScroll').scrollTop, 2000);
});

test('changing local disclosure state preserves nodes on unchanged snapshots and restores it on content updates', () => {
  const f = fixture(), data = events('codex', [
    { type: 'item', item: { id: 'tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/project', status: 'completed' } }
  ]);
  f.render(data);
  const output = f.element('nativeEvents'), detail = output.details[0], code = output.codes[0], writes = output.writes;
  f.element('nativeScroll').scrollTop = 180; f.element('nativeScroll').emit('scroll');
  detail.open = true; code.scrollTop = 35; code.scrollLeft = 12;
  f.render(structuredClone(data), 'a', { deliveries: [{ message_id: 1 }] });
  assert.equal(output.writes, writes, 'a receipt refresh must not rebuild an expanded timeline');
  assert.equal(output.details[0], detail); assert.equal(output.codes[0], code);
  assert.equal(detail.open, true); assert.equal(code.scrollTop, 35); assert.equal(code.scrollLeft, 12);
  assert.equal(f.element('nativeScroll').scrollTop, 180);

  detail.open = false; f.render(structuredClone(data));
  assert.equal(output.writes, writes, 'collapsing the detail must not rebuild unchanged content');
  assert.equal(output.details[0], detail); assert.equal(detail.open, false);

  detail.open = true;
  const updated = structuredClone(data); updated[0].payload.item.aggregatedOutput = '/project/updated';
  f.render(updated);
  assert.notEqual(output.details[0], detail, 'new provider content still updates the timeline');
  assert.equal(output.details[0].open, true); assert.equal(output.codes[0].scrollTop, 35);
  assert.match(output.innerHTML, /\/project\/updated/);
  assert.equal(f.element('nativeScroll').scrollTop, 180);

  f.element('nativeTrace').emit('click');
  const trace = output.details[0], traceWrites = output.writes;
  trace.open = true; f.render(structuredClone(updated));
  assert.equal(output.details[0], trace); assert.equal(output.writes, traceWrites); assert.equal(trace.open, true);
});

test('native long content renders bounded sections, copies complete source, and preserves section through language changes', async () => {
  const f = fixture(), source = 'x'.repeat(11999) + '😀' + 'y'.repeat(13000);
  const data = events('codex', [{ type: 'message', itemId: 'message', text: source }]);
  f.render(data); const output = f.element('nativeEvents');
  assert.ok(output.innerHTML.length < 14000); assert.doesNotMatch(output.innerHTML, /\uD83D(?!\uDE00)/);
  await f.action({ nativeCopy: '0' }); assert.equal(f.copied[0], source);
  await f.action({ nativePage: '0', step: '1' }); assert.match(output.innerHTML, /😀/);
  f.setLanguage('zh'); f.render(data); assert.match(output.innerHTML, /2 \/ 3/); assert.match(output.innerHTML, /复制全文/);
});

test('event trace makes otherwise hidden events inspectable and the history limit and pending response remain visible', () => {
  const f = fixture(), data = events('codex', [{ type: 'account', state: 'fixture' }]);
  f.render(data, 'a', { pendingApprovals: [{ requestId: 'request' }] });
  assert.equal(f.element('nativeApprovalJump').hidden, false);
  assert.match(f.element('nativeHistoryRange').textContent, /1\/100.*not a full transcript/);
  f.element('nativeTrace').emit('click'); assert.match(f.element('nativeEvents').innerHTML, /account/);
  assert.equal(f.element('nativeTrace')['aria-pressed'], 'true');
  assert.match(nativePanelHtml(), /id="nativeApprovals"/);
  assert.match(nativePanelHtml(), /id="nativeReceiptsDetails" class="native-meta">/);
});

test('native search combines turn, failure and query filters and reports an evicted selected turn', () => {
  const f=fixture(), data=events('codex',[
    {turnId:'first',type:'item',item:{id:'cmd',type:'commandExecution',command:'npm test',status:'completed',exitCode:1,aggregatedOutput:'missing package'}},
    {turnId:'second',type:'item',item:{id:'file',type:'fileChange',status:'completed',changes:[{path:'src/a.mjs',diff:'+new'}]}}
  ]);
  f.render(data);
  f.element('nativeTraceTurn').value='first';f.element('nativeTraceKind').value='failed';f.element('nativeTraceQuery').value='missing npm';f.element('nativeTraceQuery').emit('input');
  assert.match(f.element('nativeEvents').innerHTML,/npm test/);assert.doesNotMatch(f.element('nativeEvents').innerHTML,/src\/a.mjs/);
  assert.match(f.element('nativeTraceCount').textContent,/1 \/ 2/);
  f.render(data.slice(1));assert.match(f.element('nativeTraceTurn').innerHTML,/first.*Outside retained history/);
  assert.match(f.element('nativeEvents').innerHTML,/No matching retained records/);
  f.element('nativeTraceClear').emit('click');assert.match(f.element('nativeEvents').innerHTML,/src\/a.mjs/);
});

test('native results locate their contributing raw events and return with tool details expanded', async () => {
  const f=fixture(), data=events('codex',[
    {type:'item',phase:'started',item:{id:'cmd',type:'commandExecution',command:'echo hello'}},
    {type:'item',phase:'completed',item:{id:'cmd',type:'commandExecution',status:'completed',aggregatedOutput:'hello'}}
  ]);
  assert.deepEqual(nativeTimeline(data)[0].eventIds,[1,2]);
  f.render(data);await f.action({nativeLocate:'2'});
  assert.equal(f.element('nativeTrace')['aria-pressed'],'true');
  assert.equal(f.element('nativeEvents').details.find(detail => detail.dataset.nativeDetail === 'trace:2').open,true);
  await f.action({nativeResult:'1'});
  assert.equal(f.element('nativeConversation')['aria-pressed'],'true');
  assert.equal(f.element('nativeEvents').details[0].open,true);
  assert.match(f.element('nativeEvents').innerHTML,/hello/);
});
