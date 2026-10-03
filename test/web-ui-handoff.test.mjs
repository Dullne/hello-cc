import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHandoffStore, uiHandoffScript } from '../lib/web/ui-handoff.mjs';

function persistentStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('refresh restores the chosen session and draft within the same project only', () => {
  const storage = persistentStorage();
  const before = createHandoffStore(storage);
  before.select('/one', 'managed', 'second-session');
  before.select('/two', 'detected', 'peer-A');
  before.saveDraft('/one', 'second-session', 'continue the local task');
  before.saveDraft('/two', 'second-session', 'another project');
  const after = createHandoffStore(storage);
  assert.deepEqual(after.selected('/one'), { type: 'managed', id: 'second-session' });
  assert.deepEqual(after.selected('/two'), { type: 'detected', id: 'peer-A' });
  assert.equal(after.selected('/three'), null);
  assert.equal(after.draft('/one', 'second-session').text, 'continue the local task');
  assert.equal(after.draft('/two', 'second-session').text, 'another project');
  assert.equal(after.draft('/one', 'first-session').text, '');
});

test('an uncertain submission survives refresh and requires manual review before another send', () => {
  const storage = persistentStorage();
  const before = createHandoffStore(storage);
  before.saveDraft('/project', 'session', 'echo important');
  assert.equal(before.submit('/project', 'session', 'receipt-1', 'echo important'), true);
  before.uncertain('/project', 'session');
  const after = createHandoffStore(storage);
  assert.equal(after.draft('/project', 'session').pending.status, 'uncertain');
  assert.equal(after.submit('/project', 'session', 'receipt-2', 'echo important'), false);
  assert.equal(after.acknowledge('/project', 'session', 'other-connection'), false);
  assert.equal(after.draft('/project', 'session').text, 'echo important');
  after.review('/project', 'session');
  assert.equal(after.draft('/project', 'session').pending, null);
  assert.equal(after.draft('/project', 'session').text, 'echo important');
  assert.equal(after.submit('/project', 'session', 'receipt-2', 'echo important'), true);
});

test('matching input receipts clear the submitted draft without clearing later edits', () => {
  const store = createHandoffStore(persistentStorage());
  store.saveDraft('/project', 'session', 'first instruction');
  store.submit('/project', 'session', 'input-1', 'first instruction');
  store.saveDraft('/project', 'session', 'second instruction while awaiting receipt');
  assert.equal(store.acknowledge('/project', 'session', 'input-1'), true);
  assert.deepEqual(store.draft('/project', 'session'), { text: 'second instruction while awaiting receipt', pending: null });
  store.submit('/project', 'session', 'input-2', 'second instruction while awaiting receipt');
  assert.equal(store.acknowledge('/project', 'session', 'input-2'), true);
  assert.deepEqual(store.draft('/project', 'session'), { text: '', pending: null });
});

test('blocked storage retains working drafts and delivery state for the open page', () => {
  const store = createHandoffStore({
    getItem() { throw new Error('Storage blocked'); },
    setItem() { throw new Error('Storage blocked'); }
  });
  store.select('/project', 'managed', 'session');
  store.saveDraft('/project', 'session', 'a draft');
  store.submit('/project', 'session', 'input', 'a draft');
  store.uncertain('/project', 'session');
  assert.equal(store.selected('/project').id, 'session');
  assert.equal(store.draft('/project', 'session').text, 'a draft');
  assert.equal(store.draft('/project', 'session').pending.status, 'uncertain');
});

test('browser bootstrap survives a throwing localStorage getter and installs a usable store', () => {
  const window = Object.defineProperty({}, 'localStorage', { get() { throw new Error('Blocked'); } });
  new vm.Script(uiHandoffScript()).runInNewContext({ window });
  window.hccHandoffStore.saveDraft('/project', 'session', 'safe');
  assert.equal(window.hccHandoffStore.draft('/project', 'session').text, 'safe');
});

test('primary and auxiliary panes retain independent selection, drafts and delivery receipts across reload', () => {
  const storage = persistentStorage();
  const primary = createHandoffStore(storage);
  const auxiliary = createHandoffStore(storage, { scope: 'auxiliary' });
  primary.select('/project', 'managed', 'first');
  auxiliary.select('/project', 'managed', 'second');
  primary.saveDraft('/project', 'same-session', 'primary draft');
  auxiliary.saveDraft('/project', 'same-session', 'auxiliary draft');
  primary.submit('/project', 'same-session', 'primary-input', 'primary draft');
  auxiliary.submit('/project', 'same-session', 'auxiliary-input', 'auxiliary draft');
  auxiliary.uncertain('/project', 'same-session');
  assert.equal(primary.acknowledge('/project', 'same-session', 'auxiliary-input'), false);
  assert.equal(auxiliary.acknowledge('/project', 'same-session', 'primary-input'), false);
  assert.equal(primary.acknowledge('/project', 'same-session', 'primary-input'), true);

  const reloadedPrimary = createHandoffStore(storage);
  const reloadedAuxiliary = createHandoffStore(storage, { scope: 'auxiliary' });
  assert.equal(reloadedPrimary.selected('/project').id, 'first');
  assert.equal(reloadedAuxiliary.selected('/project').id, 'second');
  assert.deepEqual(reloadedPrimary.draft('/project', 'same-session'), { text: '', pending: null });
  assert.deepEqual(reloadedAuxiliary.draft('/project', 'same-session'), {
    text: 'auxiliary draft', pending: { inputId: 'auxiliary-input', text: 'auxiliary draft', status: 'uncertain' }
  });
  reloadedAuxiliary.review('/project', 'same-session');
  assert.equal(createHandoffStore(storage).draft('/project', 'same-session').pending, null);
  assert.equal(createHandoffStore(storage, { scope: 'auxiliary' }).draft('/project', 'same-session').text, 'auxiliary draft');
});

test('empty pane scope preserves existing persisted handoff keys', () => {
  const storage = persistentStorage();
  storage.setItem('hcc.handoff.v1.selected:["/project",""]', JSON.stringify({ type: 'managed', id: 'legacy' }));
  storage.setItem('hcc.handoff.v1.draft:["/project","legacy"]', JSON.stringify({ text: 'existing draft', pending: null }));
  const primary = createHandoffStore(storage, { scope: '' });
  assert.equal(primary.selected('/project').id, 'legacy');
  assert.equal(primary.draft('/project', 'legacy').text, 'existing draft');
  assert.equal(createHandoffStore(storage, { scope: 'auxiliary' }).selected('/project'), null);
});

test('browser bootstrap uses the pane scope without sharing another document draft', () => {
  const storage = persistentStorage();
  const primaryWindow = { localStorage: storage };
  const paneWindow = { localStorage: storage, hccDraftScope: 'auxiliary' };
  for (const window of [primaryWindow, paneWindow]) new vm.Script(uiHandoffScript()).runInNewContext({ window });
  primaryWindow.hccHandoffStore.saveDraft('/project', 'session', 'main text');
  paneWindow.hccHandoffStore.saveDraft('/project', 'session', 'pane text');
  const reloadedWindow = { localStorage: storage, hccUi: { draftScope: 'auxiliary' } };
  new vm.Script(uiHandoffScript()).runInNewContext({ window: reloadedWindow });
  assert.equal(reloadedWindow.hccHandoffStore.draft('/project', 'session').text, 'pane text');
  assert.equal(createHandoffStore(storage).draft('/project', 'session').text, 'main text');
});
