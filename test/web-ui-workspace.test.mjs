import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeWorkspaceLayout, workspaceMessageValid, workspaceScript } from '../lib/web/ui-workspace.mjs';

const origin = 'http://127.0.0.1:51945';
const copy = value => JSON.parse(JSON.stringify(value));
const message = (action, project = '/a', extra = {}) => ({ type: 'hcc-workspace', version: 1, action, project, ...extra });

function fixture({ embedded = false, paneAllowed = true, parent, stored = {}, mobile = false, active = 'one' } = {}) {
  const elements = new Map(), frames = [], sent = [], writes = [], effects = [], timers = new Map(), listeners = new Map();
  const storage = new Map(Object.entries(stored));
  let timerId = 0;
  const state = { root: '/a', active, ready: true, sessions: [{ id: 'one', status: 'running' }, { id: 'two', status: 'running' }] };
  function node(id = '') {
    const classes = new Set(), handlers = new Map();
    return { id, hidden: false, disabled: false, inert: false, value: '', textContent: '', innerHTML: '', dataset: {}, attributes: {}, children: [],
      style: { setProperty(name, value) { this[name] = value; } },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, force) { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; } },
      addEventListener(type, callback) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(callback); },
      emit(type, event = {}) { for (const callback of handlers.get(type) || []) callback({ preventDefault() {}, ...event }); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); child.parentNode = this; },
      remove() { this.removed = true; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
      focus() { document.activeElement = this; }, setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 800 }; }
    };
  }
  const element = id => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const document = { activeElement: null, getElementById: element,
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const frame = node();
      frame.contentWindow = { postMessage(data, targetOrigin) {
        const record = { data: copy(data), targetOrigin, target: frame.contentWindow };
        sent.push(record); frame.deliver?.(record);
      } };
      frames.push(frame); return frame;
    } };
  const media = { matches: mobile, addEventListener(_name, callback) { this.onchange = callback; } };
  const window = { parent, matchMedia: () => media,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); } };
  const dispatch = (type, event = {}) => { for (const callback of listeners.get(type) || []) callback(event); };
  if (!parent) window.parent = window;
  const ui = { preferences: { theme: 'light', language: 'en' }, tr: key => key,
    safeGet: key => storage.get(key), safeSet(key, value) { storage.set(key, value); writes.push([key, value]); },
    update(patch) {
      if (!patch || typeof patch !== 'object') return;
      const changed = Object.keys(patch).filter(key => patch[key] !== this.preferences[key]);
      this.preferences = { ...this.preferences, ...patch };
      if (changed.length) dispatch('hcc:preferences', { detail: { changed, preferences: this.preferences } });
    } };
  const app = element('app'); app.dataset.view = 'terminal';
  const host = { embedded, paneAllowed, app, primary: element('workspacePrimaryPane'), project: () => state.root, active: () => state.active,
    ready: () => state.ready, sessions: () => state.sessions,
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    showTerminal() { app.dataset.view = 'terminal'; }, layoutChanged() {},
    stop() { effects.push('stop'); }, release() { effects.push('release'); } };
  window.hccWorkspaceHost = host; window.hccUi = ui;
  vm.runInNewContext(workspaceScript(), { window, document, location: { origin, href: origin + '/?token=private-token' }, URL,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(...args) { effects.push(['fetch', ...args]); throw new Error('Workspace must not perform session mutations'); },
    WebSocket: class { constructor(...args) { effects.push(['websocket', ...args]); } }
  });
  return { window, ui, state, storage, frames, sent, writes, effects, timers, element, media, dispatch,
    workspace: window.hccWorkspace, frame: () => frames.findLast(frame => !frame.removed),
    receive(data, source = frames.findLast(frame => !frame.removed)?.contentWindow, sourceOrigin = origin) { dispatch('message', { source, origin: sourceOrigin, data }); },
    fireTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

test('layout normalization retains only versioned presentation fields and bounds dimensions', () => {
  assert.deepEqual(normalizeWorkspaceLayout(null), { version: 1, open: false, direction: 'columns', ratio: .5, session: '' });
  assert.deepEqual(normalizeWorkspaceLayout({ version: 9, open: true, direction: 'rows', ratio: 4, session: 'two',
    token: 'secret', action_token: 'connection-secret', epoch: 99, preferences: { token: 'secret' } }),
  { version: 1, open: true, direction: 'rows', ratio: .75, session: 'two' });
  assert.equal(normalizeWorkspaceLayout({ ratio: -2 }).ratio, .25);
  assert.equal(normalizeWorkspaceLayout({ ratio: 'invalid' }).ratio, .5);
  assert.equal(normalizeWorkspaceLayout({ session: 'x'.repeat(513), open: 'true', direction: 'invalid' }).session, '');
  assert.equal(normalizeWorkspaceLayout({ open: 'true' }).open, false);
});

test('messages require the exact frame, origin, project, version and supported payload schema', () => {
  const source = {}, valid = { source, origin, data: message('selection', '/a', { session: 'two' }) };
  assert.equal(workspaceMessageValid(valid, source, origin, '/a'), true);
  for (const event of [
    { ...valid, source: {} }, { ...valid, origin: 'https://attacker.example' },
    { ...valid, data: message('selection', '/b') }, { ...valid, data: { ...valid.data, version: 2 } },
    { ...valid, data: message('execute') }, { ...valid, data: message('selection', '/a', { session: {} }) },
    { ...valid, data: message('selection', '/a', { session: 'x'.repeat(513) }) },
    { ...valid, data: message('preferences', '/a', { preferences: [] }) }, { ...valid, data: null }
  ]) assert.equal(workspaceMessageValid(event, source, origin, '/a'), false);
  assert.equal(workspaceMessageValid(valid, null, origin, '/a'), false);
});

test('restored layouts and frame URLs never retain credentials and saved dimensions survive recreation', () => {
  const f = fixture({ stored: { 'hcc.workspace:/a': JSON.stringify({ open: true, direction: 'rows', ratio: .6, session: 'two', token: 'secret', action_token: 'private', epoch: 2 }) } });
  assert.equal(f.workspace.isOpen, true);
  const frameUrl = new URL(f.frame().src);
  assert.equal(frameUrl.pathname, '/pane');
  assert.deepEqual([...frameUrl.searchParams.keys()], ['project', 'session']);
  assert.equal(frameUrl.searchParams.get('project'), '/a');
  assert.equal(frameUrl.searchParams.get('session'), 'two');
  f.element('workspaceDivider').emit('keydown', { key: 'End' });
  const saved = JSON.parse(f.storage.get('hcc.workspace:/a'));
  assert.deepEqual(saved, { version: 1, open: true, direction: 'rows', ratio: .75, session: 'two' });
  assert.doesNotMatch(JSON.stringify(f.writes), /private-token|secret|action_token|epoch/);
  const restored = fixture({ stored: Object.fromEntries(f.storage) });
  assert.equal(restored.element('workspacePanes').dataset.direction, 'rows');
  assert.equal(restored.element('workspaceDivider').attributes['aria-valuenow'], '75');
  assert.equal(new URL(restored.frame().src).searchParams.get('session'), 'two');
});

test('project switches remove the old frame and reject its delayed messages even with a forged current project', () => {
  const f = fixture({ stored: { 'hcc.workspace:/b': JSON.stringify({ open: true, session: 'b-two' }) } });
  f.workspace.open(); const old = f.frame();
  f.workspace.reset(); f.state.root = '/b'; f.state.active = 'b-one'; f.state.ready = false; f.state.sessions = [];
  f.workspace.sync();
  assert.equal(old.removed, true); assert.equal(f.frame(), undefined);
  f.receive(message('selection', '/b', { session: 'b-one' }), old.contentWindow);
  f.state.ready = true; f.state.sessions = [{ id: 'b-one', status: 'running' }, { id: 'b-two', status: 'running' }]; f.workspace.sync();
  const current = f.frame(); assert.notEqual(current.contentWindow, old.contentWindow);
  f.receive(message('selection', '/b', { session: 'b-one' }), old.contentWindow);
  f.receive(message('selection', '/a', { session: 'b-one' }), current.contentWindow);
  f.receive(message('selection', '/b', { session: 'b-one' }), current.contentWindow, 'https://attacker.example');
  assert.equal(f.element('workspaceSession').value, 'b-two');
  assert.equal(f.timers.size, 1);
  f.receive(message('selection', '/b', { session: 'b-two' }));
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.parse(f.storage.get('hcc.workspace:/b')).session, 'b-two');
});

test('missing or exited restored sessions remain explicit and never auto-attach another running session', () => {
  for (const session of ['missing', 'exited']) {
    const f = fixture({ stored: { 'hcc.workspace:/a': JSON.stringify({ open: true, session }) } });
    f.state.sessions.push({ id: 'exited', status: 'exited' }); f.workspace.sync();
    assert.equal(f.workspace.isOpen, true);
    assert.equal(f.frames.length, 0);
    assert.equal(f.element('workspaceSession').value, session);
    assert.equal(f.element('workspaceStatus').textContent, 'workspace.missing');
    f.workspace.close(); f.workspace.open();
    assert.equal(f.frames.length, 0, 'reopening does not silently choose an unrelated session');
    assert.equal(JSON.parse(f.storage.get('hcc.workspace:/a')).session, session);
    f.element('workspaceSession').value = 'one'; f.element('workspaceSession').emit('change');
    assert.equal(new URL(f.frame().src).searchParams.get('session'), 'one', 'explicit selection is allowed');
  }
});

test('early ready only performs the preferences handshake and leaves timeout active until a valid selection', () => {
  const f = fixture(); f.workspace.open();
  f.receive(message('ready'));
  assert.equal(f.sent.at(-1).data.action, 'preferences');
  assert.equal(f.sent.at(-1).targetOrigin, origin);
  assert.equal(f.timers.size, 1); assert.equal(f.element('workspaceStatus').hidden, false);
  f.receive(message('selection', '/a', { session: '' }));
  f.receive(message('selection', '/a', { session: 'nonexistent' }));
  assert.equal(f.timers.size, 1);
  f.fireTimers();
  assert.equal(f.element('workspaceStatus').textContent, 'workspace.failed');
  assert.equal(f.element('workspaceRetry').hidden, false);
  f.element('workspaceRetry').emit('click');
  assert.equal(f.timers.size, 1);
  f.receive(message('selection', '/a', { session: 'two' }));
  assert.equal(f.timers.size, 0); assert.equal(f.element('workspaceStatus').hidden, true); assert.equal(f.element('workspaceRetry').hidden, true);
});

test('parent and child preferences converge without echoes after interleaved local updates', () => {
  const queue = [], f = fixture(); f.workspace.open(); const frame = f.frame();
  let child, delivered = 0;
  const parentEndpoint = { postMessage(data, targetOrigin) { assert.equal(targetOrigin, origin); const snapshot = copy(data); queue.push(() => f.receive(snapshot, frame.contentWindow)); } };
  frame.deliver = ({ data, targetOrigin }) => { assert.equal(targetOrigin, origin); queue.push(() => child.receive(data, parentEndpoint)); };
  child = fixture({ embedded: true, parent: parentEndpoint, active: 'two' });
  function flush() {
    let count = 0;
    while (queue.length) { assert.ok(++count < 20, 'preference messages must converge instead of echoing indefinitely'); queue.shift()(); delivered++; }
    return count;
  }
  flush();
  assert.deepEqual(child.ui.preferences, f.ui.preferences);
  f.ui.update({ theme: 'dark', language: 'zh' }); child.ui.update({ theme: 'system', language: 'en' });
  assert.equal(queue.length, 2, 'both changes happen before either message is delivered');
  const count = flush();
  assert.ok(count <= 3);
  assert.deepEqual(child.ui.preferences, f.ui.preferences);
  assert.deepEqual(f.ui.preferences, { theme: 'system', language: 'en' });
  const before = delivered; f.ui.update({ theme: 'light' });
  assert.equal(flush(), 1, 'child does not echo a parent-originated update');
  assert.equal(delivered, before + 1);
  child.ui.update({ theme: 'dark' }); assert.equal(flush(), 2, 'child change is relayed once through the parent');
  assert.deepEqual(child.ui.preferences, f.ui.preferences);
});

test('closing a pane preserves its layout choice, removes the frame, and performs no session or lease mutation', () => {
  const f = fixture(); f.workspace.open(); const frame = f.frame();
  f.receive(message('selection', '/a', { session: 'two' }));
  f.workspace.close();
  assert.equal(frame.removed, true); assert.equal(f.frame(), undefined); assert.equal(f.workspace.isOpen, false);
  assert.equal(f.element('workspaceSecondPane').hidden, true); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.effects, []);
  assert.equal(f.sent.some(entry => ['stop', 'release', 'claim'].includes(entry.data.action)), false);
  assert.deepEqual(JSON.parse(f.storage.get('hcc.workspace:/a')), { version: 1, open: false, direction: 'columns', ratio: .5, session: 'two' });
  f.receive(message('selection', '/a', { session: 'one' }), frame.contentWindow);
  assert.equal(JSON.parse(f.storage.get('hcc.workspace:/a')).session, 'two');
});

test('mobile pane switching keeps the hidden pane inert and closing returns access to the main pane', () => {
  const f = fixture({ mobile: true }); f.workspace.open();
  assert.equal(f.element('workspace').dataset.activePane, 'secondary');
  assert.equal(f.element('workspacePrimaryPane').inert, true); assert.equal(f.element('workspaceSecondPane').inert, false);
  f.element('workspacePrimary').emit('click');
  assert.equal(f.element('workspacePrimaryPane').inert, false); assert.equal(f.element('workspaceSecondPane').inert, true);
  f.element('app').dataset.view = 'sessions'; f.workspace.access();
  assert.equal(f.element('workspacePrimaryPane').inert, true); assert.equal(f.element('workspaceSecondPane').inert, true);
  f.element('workspaceSecondary').emit('click'); f.workspace.close();
  assert.equal(f.element('workspacePrimaryPane').inert, false); assert.equal(f.frame(), undefined);
});


test('a page without a browser session cannot mount split panes or restore a saved open layout', () => {
  const saved = JSON.stringify({ version: 1, open: true, direction: 'rows', ratio: .6, session: 'two' });
  const f = fixture({ paneAllowed: false, stored: { 'hcc.workspace:/a': saved } });
  assert.equal(f.element('splitBtn').disabled, true);
  assert.equal(f.element('splitBtn').attributes.title, 'workspace.requiresBrowserSession');
  assert.equal(f.workspace.isOpen, false);
  assert.equal(f.frames.length, 0);
  f.element('splitBtn').emit('click');
  f.workspace.open();
  f.workspace.sync();
  assert.equal(f.frames.length, 0);
  assert.equal(f.element('workspaceSecondPane').hidden, true);
  assert.equal(f.state.active, 'one');
  assert.equal(f.storage.get('hcc.workspace:/a'), saved, 'the layout remains available after a later sign-in');
  assert.deepEqual(f.effects, []);
});
