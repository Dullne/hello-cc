import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { codexPanelHtml, codexPanelScript } from '../lib/web/ui-codex.mjs';

function fixture() {
  const elements = new Map(), storage = new Map(), requests = [], copied = [], windowListeners = new Map();
  let virtualSequence = 0;
  const metrics = { escaped: 0 };
  const selection = { active: 'a', projectRoot: '/project-a', actionToken: 'token-a', epoch: 1, canControl: true, draftScope: '' };
  const makeNode = () => ({
    value: '', textContent: '', hidden: false, disabled: false, dataset: {}, buttons: [], details: [], listeners: new Map(),
    scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 500, attributes: new Map(),
    getBoundingClientRect() { return { top: 0, bottom: 0 }; },
    focus() {},
    setAttribute(name, value) { this.attributes.set(name, value); },
    querySelectorAll(selector) {
      if (selector.startsWith('details')) return this.details;
      if (selector === '[data-card-key]') return [];
      if (selector === 'button[data-approval]') return this.buttons.filter(button => button.dataset.approval !== undefined);
      if (selector === 'button[data-copy]') return this.buttons.filter(button => button.dataset.copy !== undefined);
      if (selector === 'button[data-segment]') return this.buttons.filter(button => button.dataset.segment !== undefined);
      if (selector === 'pre[data-code-page]') return this.codeNodes || [];
      return this.buttons;
    },
    querySelector(selector) {
      if (selector === '[role="status"]') return makeNode();
      const action = /data-segment-action="([^"]+)"/.exec(selector)?.[1];
      return this.buttons.find(button => button.dataset.segmentAction === action && !button.disabled);
    },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    click() { if (!this.disabled) return this.listeners.get('click')?.(); }
  });
  const element = id => {
    if (!elements.has(id)) {
      const node = makeNode();
      Object.defineProperty(node, 'innerHTML', {
        get() { return this.html || ''; },
        set(value) {
          this.writes = (this.writes || 0) + 1;
          this.html = value;
          this.buttons = [...value.matchAll(/<button([^>]*)>/g)].map(match => {
            const button = makeNode();
            for (const [, name, content] of match[1].matchAll(/data-(approval|decision|copy|request-key|segment|segment-action|truncated)="([^"]+)"/g)) {
              button.dataset[name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = content.replaceAll('&quot;', '"');
            }
            button.disabled = /(?:^|\s)disabled(?:\s|$)/.test(match[1]);
            if (this.wrapper) button.closest = () => this.wrapper;
            return button;
          });
          this.details = [...value.matchAll(/<details([^>]*)>/g)].map(match => {
            const detail = makeNode();
            detail.dataset.detailsKey = /data-details-key="([^"]+)"/.exec(match[1])?.[1];
            detail.open = / open(?:\s|$)/.test(match[1]);
            return detail;
          });
          this.codeNodes = [...value.matchAll(/<pre\b([^>]*)data-code-page="(\d+)"[^>]*>/g)].map(match => {
            const pre = makeNode(), identity = [...value.slice(0, match.index).matchAll(/data-code-key="([^"]*)"/g)].at(-1)?.[1];
            pre.dataset.codePage = match[2];
            pre.closest = () => this.wrapper || { dataset: { codeKey: identity } };
            return pre;
          });
          this.segments = [...value.matchAll(/data-segment-block="(\d+)"[\s\S]*?<div data-segment-content>([\s\S]*?<\/nav><pre tabindex="0" data-code-page="\d+"><code>[\s\S]*?<\/code><\/pre>)<\/div>/g)].map(match => {
            const wrapper = makeNode(), body = element('virtual-segment-' + virtualSequence++);
            wrapper.dataset.codeKey = [...value.slice(0, match.index).matchAll(/data-code-key="([^"]*)"/g)].at(-1)?.[1];
            body.wrapper = wrapper; body.innerHTML = match[2];
            wrapper.querySelector = () => body; wrapper.body = body;
            for (const button of this.buttons) if (button.dataset.segment === match[1]) button.closest = () => wrapper;
            return wrapper;
          });
        }
      });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const bridge = { ...Object.fromEntries(Object.keys(selection).map(name => [name, null])),
    esc: text => { metrics.escaped += 1; return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }, api(path, options) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ path, options, resolve, reject }); return promise;
    } };
  for (const name of Object.keys(selection)) Object.defineProperty(bridge, name, { get: () => selection[name] });
  const window = { hccHandoff: bridge, hccUi: { language: 'en', safeGet: key => storage.get(key), safeSet: (key, value) => storage.set(key, value) },
    addEventListener(name, listener) { windowListeners.set(name, listener); } };
  vm.runInNewContext(codexPanelScript(), { window, document: { getElementById: element }, crypto: { randomUUID }, confirm: () => true,
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } } });
  const render = (id = selection.active) => window.hccCodex.render({ status: 'ready', threadId: 'thread-' + id, threads: [{ id: 'thread-' + id, turns: [] }], pendingApprovals: [] });
  const fill = text => { element('codexDraft').value = text; element('codexDraft').listeners.get('input')(); };
  const click = id => element(id).listeners.get('click')();
  return { element, storage, requests, selection, window, windowListeners, copied, render, fill, click, metrics };
}

test('late submission receipt clears only its original project/session draft', async () => {
  const f = fixture(); f.render(); f.fill('same message');
  const sending = f.click('codexSend');
  assert.match(f.requests[0].path, /sessions\/a\/codex\/turn\?root=%2Fproject-a/);
  const sent = JSON.parse(f.requests[0].options.body);
  assert.equal(sent.action_token, 'token-a'); assert.equal(sent.epoch, 1);
  f.selection.active = 'b'; f.selection.projectRoot = '/project-b'; f.selection.actionToken = 'token-b';
  f.render(); f.fill('same message');
  f.requests[0].resolve({ turn: { id: 'turn-a' } }); await sending;
  assert.equal(f.element('codexDraft').value, 'same message');
  assert.equal(JSON.parse(f.storage.get('hcc.codexDraft:/project-b:b')).text, 'same message');
  assert.deepEqual(JSON.parse(f.storage.get('hcc.codexDraft:/project-a:a')), { text: '', pending: null });
  assert.doesNotMatch(f.element('codexSubmission').textContent, /confirmed/);
});

test('late history read cannot render the previous subject into the newly selected session', async () => {
  const f = fixture(); f.render();
  const reading = f.click('codexRecover');
  f.selection.active = 'b'; f.render();
  f.requests[0].resolve({ thread: { id: 'thread-a' } }); await reading;
  assert.equal(f.requests.length, 1, 'no follow-up state request on the new subject');
  assert.match(f.element('codexStatus').textContent, /thread-b/);
});

test('a delayed state read cannot replace newer streamed output or a newly pending approval', async () => {
  const f = fixture(), oldState = singleItemState({ id: 'message', type: 'agentMessage', text: 'old HTTP output' });
  f.window.hccCodex.render(oldState);
  const reading = f.click('codexRecover'); f.requests[0].resolve({}); await new Promise(resolve => setImmediate(resolve));
  const liveState = singleItemState({ id: 'message', type: 'agentMessage', text: 'new streamed output' }, {
    pendingApprovals: [{ requestId: 'new-approval', params: { command: 'echo new approval' } }]
  });
  f.window.hccCodex.render(liveState);
  f.requests[1].resolve({ state: oldState }); await reading;
  assert.match(f.element('codexTimeline').innerHTML, /new streamed output/);
  assert.match(f.element('codexApprovals').innerHTML, /echo new approval/);
  assert.equal(f.element('codexApprovalJump').hidden, false);
});

test('returning to the same session does not revive a read started before leaving it', async () => {
  for (const phase of ['read', 'state']) {
    const f = fixture(); f.render();
    const reading = f.click('codexRecover');
    if (phase === 'state') { f.requests[0].resolve({}); await new Promise(resolve => setImmediate(resolve)); }
    f.selection.active = 'b'; f.window.hccCodex.sync();
    f.selection.active = 'a'; f.window.hccCodex.sync();
    f.requests.at(-1).resolve(phase === 'read' ? {} : { state: singleItemState({ id: 'old', type: 'agentMessage', text: 'old visit' }) }); await reading;
    assert.equal(f.requests.length, phase === 'read' ? 1 : 2, 'an old A-B-A read must not start another state request');
    assert.equal(f.element('codexStatus').textContent, '', phase + ' must not restore state from an earlier visit');
  }
});

test('local history paging and preference redraws do not discard a valid state read', async () => {
  const f = fixture(), state = longHistory(200);
  f.window.hccCodex.render(state);
  const reading = f.click('codexRecover'); f.requests[0].resolve({}); await new Promise(resolve => setImmediate(resolve));
  f.click('codexEarlier');
  f.window.hccUi.language = 'zh'; f.windowListeners.get('hcc:preferences')();
  f.requests[1].resolve({ state: { ...state, status: 'disconnected' } }); await reading;
  assert.match(f.element('codexStatus').textContent, /已断开/);
  assert.match(f.element('codexHistoryRange').textContent, /41–120/);
});

test('only the latest overlapping explicit read may render its response', async () => {
  const f = fixture(); f.render();
  const first = f.click('codexRecover'), second = f.click('codexRecover');
  f.requests[1].resolve({}); await new Promise(resolve => setImmediate(resolve));
  f.requests[0].resolve({}); await first;
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ state: singleItemState({ id: 'message', type: 'agentMessage', text: 'latest read' }) }); await second;
  assert.match(f.element('codexTimeline').innerHTML, /latest read/);
});

test('uncertain submission preserves its subject and never retries automatically', async () => {
  const f = fixture(); f.render(); f.fill('keep this');
  const sending = f.click('codexSend');
  f.requests[0].reject(Object.assign(new Error('network failed'), { detail: 'executor admission uncertain' }));
  await sending;
  assert.equal(f.element('codexDraft').value, 'keep this');
  assert.ok(JSON.parse(f.storage.get('hcc.codexDraft:/project-a:a')).pending);
  f.window.hccCodex.sync();
  assert.equal(f.element('codexSend').disabled, true); assert.equal(f.requests.length, 1);
});

test('approvals keep their executor/request subject and use the current controller epoch after takeover', async () => {
  const f = fixture(); f.selection.canControl = false;
  f.window.hccCodex.render({ executorId: 'executor-a', status: 'ready', threadId: 'thread-a', turnId: 'turn-a',
    threads: [{ id: 'thread-a', activeTurnId: 'turn-a', turns: [] }],
    pendingApprovals: [{ threadId: 'thread-a', turnId: 'turn-a', requestId: 'approval-a', params: { command: 'echo okay' } }] });
  const approve = f.element('codexApprovals').querySelectorAll('button[data-approval]')[0];
  assert.equal(approve.disabled, true);
  f.selection.actionToken = 'takeover-token'; f.selection.epoch = 2; f.selection.canControl = true;
  f.window.hccCodex.sync(); assert.equal(approve.disabled, false);
  const approving = approve.listeners.get('click')();
  const sent = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(sent, { executorId: 'executor-a', threadId: 'thread-a', turnId: 'turn-a', requestId: 'approval-a',
    decision: 'accept', action_token: 'takeover-token', epoch: 2 });
  f.requests[0].resolve({}); await approving;
});

test('turn cards distinguish messages and tools, escape content, and copy fenced code exactly', async () => {
  const f = fixture();
  f.window.hccCodex.render({ status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [
    { id: 'turn-1', status: 'completed', items: [
      { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '<img src=x onerror=evil()> Please check' }] },
      { id: 'agent-1', type: 'agentMessage', text: 'Result\n```js\nconst value = "<script>";\n```' },
      { id: 'cmd-1', type: 'commandExecution', status: 'completed', command: 'echo okay', aggregatedOutput: 'okay\n', exitCode: 0 },
      { id: 'cmd-2', type: 'commandExecution', status: 'failed', command: 'exit 1', aggregatedOutput: 'failed\n', exitCode: 1 }
    ] }
  ] }], pendingApprovals: [] });
  const timeline = f.element('codexTimeline');
  assert.match(timeline.innerHTML, /codex-card-user/);
  assert.match(timeline.innerHTML, /codex-card-agent/);
  assert.match(timeline.innerHTML, /&lt;img src=x onerror=evil\(\)&gt;/);
  assert.doesNotMatch(timeline.innerHTML, /<img|<script>/);
  assert.equal(timeline.details.find(detail => detail.dataset.detailsKey === 'turn-1:cmd-1').open, false);
  assert.equal(timeline.details.find(detail => detail.dataset.detailsKey === 'turn-1:cmd-2').open, true);
  assert.match(timeline.innerHTML, /okay\n/);
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.deepEqual(f.copied, ['const value = "<script>";']);
});

test('history reading survives updates and session switches until jumping to latest', () => {
  const f = fixture();
  const state = text => ({ status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [
    { id: 'turn-1', status: 'inProgress', items: [{ id: 'agent-1', type: 'agentMessage', text }] }
  ] }], pendingApprovals: [] });
  f.window.hccCodex.render(state('first'));
  const scroll = f.element('codexScroll');
  scroll.scrollTop = 240; scroll.listeners.get('scroll')();
  f.window.hccCodex.render(state('first plus more'));
  assert.equal(scroll.scrollTop, 240);
  assert.equal(f.element('codexJumpBar').hidden, false);
  assert.match(f.element('codexJump').textContent, /New updates/);
  f.selection.active = 'b'; f.render();
  f.selection.active = 'a'; f.window.hccCodex.render(state('first plus more'));
  assert.equal(scroll.scrollTop, 240);
  f.click('codexJump');
  assert.equal(scroll.scrollTop, scroll.scrollHeight);
  assert.equal(f.element('codexJumpBar').hidden, true);
  f.window.hccCodex.render(state('latest output'));
  assert.equal(scroll.scrollTop, scroll.scrollHeight);
});

test('empty DOM scroll events before the next subject state do not erase its saved reading position', () => {
  const f = fixture(); f.render();
  const scroll = f.element('codexScroll');
  scroll.scrollTop = 800; scroll.listeners.get('scroll')();
  f.selection.active = 'b'; f.window.hccCodex.sync();
  scroll.scrollTop = 0; scroll.listeners.get('scroll')();
  f.render();
  f.selection.active = 'a'; f.window.hccCodex.sync();
  // A browser clamps scrollTop when the cleared timeline has no height.
  scroll.scrollTop = 0; scroll.listeners.get('scroll')();
  // Repeated control/preference syncs while waiting for state also preserve the cache.
  f.window.hccCodex.sync();
  f.render();
  assert.equal(scroll.scrollTop, 800);
  assert.equal(f.element('codexJumpBar').hidden, false);
});

test('expanded tool details survive updates and preference changes localize plans and approvals', () => {
  const f = fixture();
  const state = { status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [
    { id: 'turn-1', status: 'completed', plan: [{ step: 'Run tests', status: 'completed' }],
      diff: 'diff --git a/a b/a\n-old\n+new',
      items: [{ id: 'cmd-1', type: 'commandExecution', status: 'completed', command: 'npm test' }] }
  ] }], pendingApprovals: [{ requestId: 'approve-1', method: 'item/commandExecution/requestApproval',
    params: { command: 'npm test', cwd: '/project-a', reason: 'Check the patch' } }] };
  f.window.hccCodex.render(state);
  const detail = f.element('codexTimeline').details[0];
  detail.open = true; detail.listeners.get('toggle')();
  f.window.hccUi.language = 'zh'; f.windowListeners.get('hcc:preferences')();
  assert.equal(f.element('codexTimeline').details[0].open, true);
  assert.match(f.element('codexPlan').innerHTML, /执行计划.*已完成/);
  assert.match(f.element('codexApprovals').innerHTML, /<dt>命令<\/dt><dd>npm test<\/dd>/);
  assert.match(f.element('codexApprovals').innerHTML, /<dt>目录<\/dt><dd>\/project-a<\/dd>/);
  assert.match(f.element('codexApprovals').innerHTML, /Check the patch/);
  assert.match(f.element('codexApprovals').innerHTML, /原始参数/);
  assert.match(f.element('codexDiff').innerHTML, /codex-diff-add/);
  assert.match(f.element('codexStatus').textContent, /执行器.*会话/);
  assert.equal(f.element('codexReview').hidden, false);
});

test('copy remains available without control and shortcut respects composition and uncertain submissions', async () => {
  const f = fixture(); f.selection.canControl = false;
  f.window.hccCodex.render({ status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [] }],
    pendingApprovals: [{ requestId: 'approve-1', params: { command: 'npm test' } }] });
  f.window.hccCodex.sync();
  assert.equal(f.element('codexApprovals').querySelectorAll('button[data-copy]')[0].disabled, false);
  assert.equal(f.element('codexApprovals').querySelectorAll('button[data-approval]')[0].disabled, true);
  f.selection.canControl = true; f.render(); f.fill('send once');
  const shortcut = f.element('codexDraft').listeners.get('keydown');
  shortcut({ key: 'Enter', ctrlKey: true, isComposing: true, preventDefault() { assert.fail('IME input must be left intact'); } });
  assert.equal(f.requests.length, 0);
  shortcut({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.equal(f.requests.length, 1);
  shortcut({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.equal(f.requests.length, 1, 'pending admission is never resubmitted by shortcut');
  f.requests[0].reject(new Error('uncertain'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('codexDraft').value, 'send once');
});

test('composer stays outside the independently scrollable conversation', () => {
  const html = codexPanelHtml();
  assert.match(html, /id="codexScroll"[\s\S]*<\/div>\s*<div id="codexJumpBar"[\s\S]*<footer class="codex-composer"/);
  assert.match(html, /#codexPanel\[hidden\] \{ display:none; \}/);
});

test('pending approvals have a fixed navigation entry and disable both decisions during admission', async () => {
  const f = fixture();
  const state = { executorId: 'executor-a', status: 'ready', threadId: 'thread-a',
    threads: [{ id: 'thread-a', turns: [] }], pendingApprovals: [
      { threadId: 'thread-a', turnId: 'turn-a', requestId: 'approval-a', params: { command: 'npm test' } }
    ] };
  f.window.hccCodex.render(state);
  const jump = f.element('codexApprovalJump');
  assert.equal(jump.hidden, false);
  assert.match(jump.textContent, /Approval required: 1/);
  assert.equal(f.element('codexScroll').scrollTop, 2000);
  f.click('codexApprovalJump');
  assert.equal(f.element('codexScroll').scrollTop, 0);
  const buttons = f.element('codexApprovals').querySelectorAll('button[data-approval]');
  const approving = buttons[0].click();
  assert.ok(buttons.every(button => button.disabled));
  await buttons[1].listeners.get('click')();
  assert.equal(f.requests.length, 1, 'opposite decision cannot be submitted concurrently');
  f.window.hccCodex.render(state);
  assert.ok(f.element('codexApprovals').querySelectorAll('button[data-approval]').every(button => button.disabled));
  f.requests[0].resolve({}); await approving;
  f.window.hccCodex.render({ ...state, pendingApprovals: [] });
  assert.equal(jump.hidden, true);
});

test('basic Markdown uses block semantics and inline formatting without trusting HTML or URLs', () => {
  const f = fixture();
  f.window.hccCodex.render({ status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [
    { id: 'turn-1', status: 'completed', items: [
      { id: 'agent-1', type: 'agentMessage', text: [
        '## Findings <script>alert(1)</script>',
        '',
        '- **First** item with `<img src=x>`',
        '- Second item',
        '',
        '3. Check',
        '4. Verify',
        '',
        '> __Keep__ this quoted',
        '> <svg onload=evil()>',
        '',
        '**Inline `**literal**`** and [click](javascript:evil())',
        '',
        '```html',
        '## not a heading',
        '<script>alert(2)</script>',
        '```'
      ].join('\n') }
    ] }
  ] }], pendingApprovals: [] });
  const html = f.element('codexTimeline').innerHTML;
  assert.match(html, /<h2>Findings &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h2>/);
  assert.match(html, /<ul><li><strong>First<\/strong> item with <code>&lt;img src=x&gt;<\/code><\/li><li>Second item<\/li><\/ul>/);
  assert.match(html, /<ol start="3"><li>Check<\/li><li>Verify<\/li><\/ol>/);
  assert.match(html, /<blockquote><strong>Keep<\/strong> this quoted<br>&lt;svg onload=evil\(\)&gt;<\/blockquote>/);
  assert.match(html, /<strong>Inline <code>\*\*literal\*\*<\/code><\/strong>/);
  assert.match(html, /\[click\]\(javascript:evil\(\)\)/);
  assert.match(html, /<pre data-code-page="0"><code>## not a heading\n&lt;script&gt;alert\(2\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|<img|<svg|<a[\s>]/);
});

function longHistory(count = 1000, itemsPerTurn = 100) {
  const turns = Array.from({ length: Math.ceil(count / itemsPerTurn) }, (_, index) => ({
    id: 'turn-' + index, status: 'completed', items: Array.from({ length: Math.min(itemsPerTurn, count - index * itemsPerTurn) }, (_, offset) => ({
      id: 'item-' + (index * itemsPerTurn + offset), type: 'commandExecution', status: 'completed',
      command: 'echo item-' + (index * itemsPerTurn + offset)
    }))
  }));
  return { status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns }], pendingApprovals: [] };
}

test('long history renders at most 80 cards and every retained event remains reachable by paging', () => {
  const f = fixture(), state = longHistory();
  f.window.hccCodex.render(state);
  const timeline = f.element('codexTimeline'), seen = new Set();
  const collect = () => {
    const ids = [...timeline.innerHTML.matchAll(/data-card-key="[^"]*:(item-\d+)"/g)].map(match => match[1]);
    assert.ok(ids.length <= 80);
    ids.forEach(id => seen.add(id));
    return ids;
  };
  assert.equal(collect()[0], 'item-920');
  assert.equal(f.element('codexHistory').hidden, false);
  assert.equal(f.element('codexLater').disabled, true);
  for (let page = 0; page < 20 && !f.element('codexEarlier').disabled; page += 1) { f.click('codexEarlier'); collect(); }
  assert.equal(seen.size, 1000, 'no event is dropped between pages');
  assert.equal(f.element('codexEarlier').disabled, true);
  assert.match(f.element('codexHistoryRange').textContent, /1–80 of 1000/);
  f.click('codexLater');
  assert.equal(collect()[0], 'item-80');
  f.click('codexJump');
  assert.equal(collect()[0], 'item-920');
  assert.equal(f.element('codexJumpBar').hidden, true);
});

test('a tool-heavy single turn is paged and unchanged snapshots skip Markdown and DOM reconstruction', async () => {
  const f = fixture(), state = longHistory(100, 100);
  f.window.hccCodex.render(state);
  const timeline = f.element('codexTimeline'), writes = timeline.writes, escaped = f.metrics.escaped;
  assert.equal((timeline.innerHTML.match(/data-card-key=/g) || []).length, 80);
  f.window.hccCodex.render(structuredClone(state));
  assert.equal(timeline.writes, writes);
  assert.equal(f.metrics.escaped, escaped, 'the unchanged page is not re-parsed or escaped');
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.deepEqual(f.copied, ['echo item-20']);
  state.threads[0].turns[0].items[99].command = 'echo updated';
  f.window.hccCodex.render(state);
  assert.match(timeline.innerHTML, /echo updated/);
  assert.equal(timeline.writes, writes + 1);
});

test('reading an older page keeps its range, scroll, tool expansion, draft and copy content through streaming updates', async () => {
  const f = fixture(), state = longHistory(200);
  f.window.hccCodex.render(state); f.fill('keep this draft'); f.click('codexEarlier');
  const timeline = f.element('codexTimeline'), scroll = f.element('codexScroll');
  const detail = timeline.details[0]; detail.open = true; detail.listeners.get('toggle')();
  scroll.scrollTop = 240; scroll.listeners.get('scroll')();
  const writes = timeline.writes;
  const next = structuredClone(state);
  next.threads[0].turns.push({ id: 'turn-2', status: 'inProgress', items: [{ id: 'item-200', type: 'agentMessage', text: 'new output' }] });
  f.window.hccCodex.render(next);
  assert.equal(timeline.writes, writes, 'updates outside this page leave its DOM intact');
  assert.equal(scroll.scrollTop, 240);
  assert.match(f.element('codexHistoryRange').textContent, /41–120 of 201/);
  assert.match(f.element('codexJump').textContent, /New updates/);
  assert.equal(f.element('codexDraft').value, 'keep this draft');
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.deepEqual(f.copied, ['echo item-40']);
  // Reaching the bottom of an older page must not silently jump to the live tail.
  scroll.scrollTop = 1500; scroll.listeners.get('scroll')();
  f.window.hccCodex.render(next);
  assert.match(f.element('codexHistoryRange').textContent, /41–120 of 201/);
  f.selection.active = 'b'; f.render(); f.selection.active = 'a'; f.window.hccCodex.render(next);
  assert.match(f.element('codexHistoryRange').textContent, /41–120 of 201/);
  assert.equal(timeline.details[0].open, true);
  assert.equal(scroll.scrollTop, 1500);
  assert.equal(f.element('codexDraft').value, 'keep this draft');
});

test('retention anchors surviving history and falls back to the oldest remaining event when the page is evicted', () => {
  const f = fixture(), state = longHistory(200);
  f.window.hccCodex.render(state); f.click('codexEarlier');
  state.threads[0].turns[0].items.splice(0, 20);
  f.window.hccCodex.render(state);
  assert.match(f.element('codexHistoryRange').textContent, /21–100 of 180/);
  assert.match(f.element('codexTimeline').innerHTML, /data-card-key="turn-0:item-40"/);
  state.threads[0].turns[0].items.splice(0, 40);
  f.window.hccCodex.render(state);
  assert.match(f.element('codexHistoryRange').textContent, /1–80 of 140/);
  assert.match(f.element('codexTimeline').innerHTML, /data-card-key="turn-0:item-60"/);
});

test('pending approvals stay reachable and actionable while an unrelated history page is visible', async () => {
  const f = fixture(), state = longHistory(200);
  state.executorId = 'executor-a';
  state.pendingApprovals = [{ requestId: 'approval-a', threadId: 'thread-a', turnId: 'turn-1', params: { command: 'echo newest' } }];
  f.window.hccCodex.render(state); f.click('codexEarlier');
  assert.equal(f.element('codexApprovalJump').hidden, false);
  f.click('codexApprovalJump');
  assert.equal(f.element('codexScroll').scrollTop, 0);
  assert.match(f.element('codexHistoryRange').textContent, /41–120 of 200/);
  const approving = f.element('codexApprovals').querySelectorAll('button[data-approval]')[0].click();
  assert.equal(JSON.parse(f.requests[0].options.body).requestId, 'approval-a');
  f.requests[0].resolve({}); await approving;
});

test('secondary-pane drafts use their own storage scope while primary-pane keys remain compatible', () => {
  const f = fixture(); f.render(); f.fill('primary draft');
  f.selection.draftScope = 'auxiliary'; f.render();
  assert.equal(f.element('codexDraft').value, '');
  f.fill('secondary draft');
  assert.equal(JSON.parse(f.storage.get('hcc.codexDraft:/project-a:a:auxiliary')).text, 'secondary draft');
  f.selection.draftScope = ''; f.render();
  assert.equal(f.element('codexDraft').value, 'primary draft');
  assert.equal(JSON.parse(f.storage.get('hcc.codexDraft:/project-a:a')).text, 'primary draft');
});

function singleItemState(item, extra = {}) {
  return { status: 'ready', threadId: 'thread-a', threads: [{ id: 'thread-a', turns: [{ id: 'large-turn', status: 'completed', items: [item] }] }], pendingApprovals: [], ...extra };
}

function visibleSegment(wrapper) {
  return wrapper.body.innerHTML.match(/<pre tabindex="0" data-code-page="\d+"><code>([\s\S]*)<\/code><\/pre>/)[1]
    .replace(/<span class="[^"]*">/g, '').replaceAll('</span>', '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

test('huge diffs render a bounded section and copy the complete original diff', async () => {
  const f = fixture(), diff = '+ changed <tag> controlled line\n'.repeat(30000);
  f.window.hccCodex.render(singleItemState({ id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: 'huge.txt', diff }] }));
  const timeline = f.element('codexTimeline');
  assert.ok(timeline.innerHTML.length < 20000, 'only one section is escaped into markup');
  assert.ok((timeline.innerHTML.match(/<span class="codex-diff-add">/g) || []).length <= 200);
  assert.match(timeline.innerHTML, /Section 1 of 150/);
  assert.match(timeline.innerHTML, /Copy full text/);
  assert.doesNotMatch(timeline.innerHTML, /<tag>/);
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.deepEqual(f.copied, [diff]);
  const last = timeline.querySelectorAll('button[data-segment]').find(button => button.dataset.segmentAction === 'last');
  last.click();
  assert.match(timeline.segments[0].body.innerHTML, /Section 150 of 150/);
  assert.equal(visibleSegment(timeline.segments[0]), diff.slice(-6400));
});

test('text sections expose every character without splitting surrogate pairs or trusting markup', () => {
  const f = fixture(), output = 'a'.repeat(11999) + '😀<script>alert(1)</script>\n' + 'controlled\n'.repeat(500);
  f.window.hccCodex.render(singleItemState({ id: 'command', type: 'commandExecution', status: 'completed', aggregatedOutput: output }));
  const timeline = f.element('codexTimeline'), wrapper = timeline.segments[0], chunks = [];
  let buttons = timeline.querySelectorAll('button[data-segment]');
  for (let page = 0; page < 20; page += 1) {
    const chunk = visibleSegment(wrapper); chunks.push(chunk);
    assert.ok(chunk.length <= 12000);
    assert.ok(chunk.split('\n').length <= 201);
    assert.doesNotMatch(wrapper.body.innerHTML, /<script>/);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'a high surrogate is never stranded at a page boundary');
    const next = buttons.find(button => button.dataset.segmentAction === 'next');
    if (next.disabled) break;
    next.click(); buttons = wrapper.body.querySelectorAll('button[data-segment]');
  }
  assert.equal(chunks.join(''), output);
  assert.ok(chunks.length > 2);
});

test('long messages explicitly use bounded plain-text sections and preserve complete source for copying', async () => {
  const f = fixture(), message = '## Controlled heading\n\nParagraph **bold** and `code`.\n\n'.repeat(5000);
  f.window.hccCodex.render(singleItemState({ id: 'message', type: 'agentMessage', text: message }));
  const timeline = f.element('codexTimeline');
  assert.match(timeline.innerHTML, /Long message · Plain-text sections/);
  assert.ok(timeline.innerHTML.length < 14000);
  assert.ok((timeline.innerHTML.match(/<\w/g) || []).length < 40, 'the full Markdown tree is not created');
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.deepEqual(f.copied, [message]);
});

test('an unchanged visible section still copies and opens the latest hidden output after a same-length update', async () => {
  const f = fixture(), state = singleItemState({ id: 'command', type: 'commandExecution', status: 'completed', aggregatedOutput: 'x'.repeat(12000) + 'old tail' });
  f.window.hccCodex.render(state);
  const timeline = f.element('codexTimeline'), writes = timeline.writes;
  state.threads[0].turns[0].items[0].aggregatedOutput = 'x'.repeat(12000) + 'new tail';
  f.window.hccCodex.render(state);
  assert.equal(timeline.writes, writes, 'unchanged first section retains its DOM');
  await timeline.querySelectorAll('button[data-copy]')[0].click();
  assert.equal(f.copied[0], state.threads[0].turns[0].items[0].aggregatedOutput);
  timeline.querySelectorAll('button[data-segment]').find(button => button.dataset.segmentAction === 'last').click();
  assert.equal(visibleSegment(timeline.segments[0]), 'new tail');
});

test('section position survives output updates, preference changes, session switches and unchanged-cache hits', () => {
  const f = fixture(), state = singleItemState({ id: 'command', type: 'commandExecution', status: 'completed', aggregatedOutput: 'line\n'.repeat(1000) });
  f.window.hccCodex.render(state);
  let timeline = f.element('codexTimeline');
  timeline.querySelectorAll('button[data-segment]').find(button => button.dataset.segmentAction === 'next').click();
  assert.match(timeline.segments[0].body.innerHTML, /Section 2 of 5/);
  const writes = timeline.writes;
  f.window.hccCodex.render(structuredClone(state));
  assert.equal(timeline.writes, writes);
  assert.match(timeline.segments[0].body.innerHTML, /Section 2 of 5/);
  state.threads[0].turns[0].items[0].aggregatedOutput += 'new line\n'.repeat(200);
  f.window.hccCodex.render(state);
  assert.match(timeline.innerHTML, /Section 2 of 6/);
  f.window.hccUi.language = 'zh'; f.windowListeners.get('hcc:preferences')();
  assert.match(timeline.innerHTML, /第 2 \/ 6 段 · 可查阅全文/);
  assert.match(timeline.innerHTML, /复制全文/);
  f.selection.active = 'b'; f.render(); f.selection.active = 'a'; f.window.hccCodex.render(state);
  assert.match(timeline.innerHTML, /第 2 \/ 6 段/);
});

test('inner code scrolling survives streamed rebuilds and session changes while changing sections resets it', () => {
  const f = fixture(), state = singleItemState({ id: 'message', type: 'agentMessage', text: 'controlled line\n'.repeat(400) });
  f.window.hccCodex.render(state);
  const timeline = f.element('codexTimeline'), scroll = f.element('codexScroll');
  let pre = timeline.codeNodes[0];
  scroll.scrollTop = 150;
  pre.scrollTop = 450; pre.scrollLeft = 20; pre.listeners.get('scroll')();
  assert.equal(f.element('codexJumpBar').hidden, false, 'reading inside a code block pauses outer follow');
  const updated = structuredClone(state);
  updated.threads[0].turns.push({ id: 'next-turn', status: 'inProgress', items: [{ id: 'next', type: 'agentMessage', text: 'new turn' }] });
  updated.pendingApprovals = [{ requestId: 'next-approval', params: { command: 'echo approval' } }];
  f.window.hccCodex.render(updated);
  pre = timeline.codeNodes[0];
  assert.equal(pre.scrollTop, 450); assert.equal(pre.scrollLeft, 20);
  assert.equal(scroll.scrollTop, 150);
  f.selection.active = 'b'; f.render(); f.selection.active = 'a'; f.window.hccCodex.render(updated);
  assert.equal(timeline.codeNodes[0].scrollTop, 450);
  f.click('codexJump');
  // A delayed browser event caused by restoring the same coordinates must
  // not cancel an explicit jump to latest.
  timeline.codeNodes[0].listeners.get('scroll')();
  assert.equal(f.element('codexJumpBar').hidden, true);
  timeline.querySelectorAll('button[data-segment]').find(button => button.dataset.segmentAction === 'next').click();
  assert.equal(timeline.segments[0].body.codeNodes[0].scrollTop, 0);
  assert.equal(timeline.segments[0].body.codeNodes[0].scrollLeft, 0);
  f.window.hccCodex.render({ ...updated, status: 'disconnected' });
  assert.equal(timeline.segments[0].body.codeNodes[0].scrollTop, 0, 'an old page offset is not restored into a different section');
});

test('oversized approval fields and raw parameters remain fully readable and backend truncation still blocks approval', async () => {
  const f = fixture(), command = 'echo <unsafe>\n'.repeat(1000);
  const state = singleItemState({ id: 'message', type: 'agentMessage', text: 'Ready' }, {
    executorId: 'executor-a', pendingApprovals: [{ requestId: 'approval-a', method: 'item/commandExecution/requestApproval', truncated: true, params: { command } }]
  });
  f.window.hccCodex.render(state);
  const approvals = f.element('codexApprovals');
  assert.equal(approvals.segments.length, 2, 'both the visible command and raw JSON are segmented');
  assert.match(approvals.innerHTML, /Full value/);
  assert.match(approvals.innerHTML, /Parameters are truncated/);
  assert.doesNotMatch(approvals.innerHTML, /<unsafe>/);
  assert.equal(approvals.querySelectorAll('button[data-approval]')[0].disabled, true);
  await approvals.querySelectorAll('button[data-copy]')[0].click();
  await approvals.querySelectorAll('button[data-copy]')[1].click();
  assert.equal(f.copied[0], command);
  assert.deepEqual(JSON.parse(f.copied[1]), { command });
  assert.equal(f.requests.length, 0);
});
