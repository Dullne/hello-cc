import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';
import { codexHistoryScript } from '../lib/web/ui-history.mjs';
import { reviewPanelScript } from '../lib/web/ui-review.mjs';
import { nativePanelScript } from '../lib/web/ui-native.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(script, type = 'app-server') {
  const elements = new Map(), storage = new Map(), requests = [], opened = [], listeners = new Map();
  const selection = { active: 'a', projectRoot: '/project-a', actionToken: 'token-a', epoch: 1,
    canControl: true, session: { id: 'a', peer_id: 'peer-a', type, task: { id: 7 } }, sessions: [] };
  function node() {
    return { value: '', checked: false, textContent: '', hidden: false, disabled: false, dataset: {}, listeners: new Map(), buttons: [],
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      querySelectorAll(selector) {
        if (selector === 'button[data-response]') return this.buttons.filter(button => button.dataset.response !== undefined);
        if (selector === '[data-interaction-field]') return [];
        return this.buttons;
      },
      async emit(name, event = {}) { return this.listeners.get(name)?.(event); } };
  }
  function element(id) {
    if (!elements.has(id)) {
      const value = node();
      Object.defineProperty(value, 'innerHTML', { get() { return this.html || ''; }, set(html) {
        this.html = html;
        this.buttons = [...html.matchAll(/<button([^>]*)>/g)].map(match => {
          const button = node();
          for (const [, name, content] of match[1].matchAll(/data-(thread|response|decision|truncated|request-key)="([^"]+)"/g)) {
            button.dataset[name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = content.replaceAll('&quot;', '"');
          }
          return button;
        });
      } });
      elements.set(id, value);
    }
    return elements.get(id);
  }
  element('historyDialog').hidden = true; element('reviewDialog').hidden = true;
  const bridge = {
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character])),
    tr: (key, fallback = '') => UI_TRANSLATIONS.en[key] || fallback || key,
    api(path, options) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ path, options, resolve, reject }); return promise;
    },
    async refreshSessions() {}, openManaged(id) { opened.push(id); },
    openDialog(dialog) { dialog.hidden = false; }, closeDialog(dialog) { dialog.hidden = true; }
  };
  for (const key of Object.keys(selection)) Object.defineProperty(bridge, key, { get: () => selection[key] });
  const window = { hccHandoff: bridge, hccUi: { safeGet:key=>storage.get(key), safeSet:(key,value)=>storage.set(key,value) },
    addEventListener(name, listener) { listeners.set(name, listener); } };
  vm.runInNewContext(script(), { window, document: { getElementById: element }, crypto: { randomUUID }, URLSearchParams, confirm: () => true });
  const click = id => element(id).emit('click');
  const fill = (id, value) => { element(id).value = value; return element(id).emit('input'); };
  return { element, selection, window, storage, requests, opened, click, fill, listeners };
}

async function historyReady(f, id = 'thread-a') {
  f.window.hccHistory.open('codex');
  f.requests.at(-1).resolve({ threads: [{ id, preview: '<script>saved</script>' }], nextCursor: null }); await settle();
  const selecting = f.element('historyThreads').buttons[0].emit('click');
  f.requests.at(-1).resolve({ thread: { id, turns: [{ status: 'completed', items: [{ type:'agentMessage', text:'saved result' }] }] } });
  await selecting;
}

test('history pagination merges thread IDs and never inserts provider HTML', async () => {
  const f = fixture(codexHistoryScript); f.window.hccHistory.open('codex');
  f.requests[0].resolve({ threads:[{ id:'thread-a', preview:'<img src=x>' }], nextCursor:'cursor +' }); await settle();
  assert.match(f.element('historyThreads').innerHTML, /&lt;img src=x&gt;/);
  const more = f.click('historyMore'); assert.match(f.requests[1].path, /cursor=cursor%20%2B&root=%2Fproject-a/);
  f.requests[1].resolve({ threads:[{ id:'thread-a' },{ id:'thread-b' }], nextCursor:null }); await more;
  assert.equal(f.element('historyThreads').buttons.length, 2); assert.equal(f.element('historyMore').hidden, true);
});

test('Codex history explains hidden unverified entries without offering an unsafe reopen', async () => {
  const f = fixture(codexHistoryScript); f.window.hccHistory.open('codex');
  f.requests[0].resolve({ threads: [], unverifiedCount: 2, nextCursor: 'next' }); await settle();
  assert.equal(f.element('historyThreads').buttons.length, 0);
  assert.match(f.element('historyUnverified').textContent, /2 Codex history entries.*cannot be verified/);
  assert.equal(f.element('historyResume').disabled, true);
  assert.equal(f.element('historyFork').disabled, true);
  const more = f.click('historyMore');
  f.requests[1].resolve({ threads: [], unverifiedCount: 1, nextCursor: null }); await more;
  assert.match(f.element('historyUnverified').textContent, /3 Codex history entries/);
  f.window.hccHandoff.tr = (key, fallback = '') => UI_TRANSLATIONS.zh[key] || fallback || key;
  f.listeners.get('hcc:preferences')();
  assert.match(f.element('historyUnverified').textContent, /3 条 Codex 历史缺少可信的原始目录身份/);
  f.element('historySource').value = 'native'; await f.element('historySource').emit('change');
  assert.equal(f.element('historyUnverified').textContent, '');
  f.requests.at(-1).resolve({ workers: [] }); await settle();
});

test('late history lists and thread reads cannot overwrite a newly opened project', async () => {
  const f = fixture(codexHistoryScript); f.window.hccHistory.open('codex');
  f.selection.projectRoot = '/project-b'; f.window.hccHistory.open('codex');
  f.requests[1].resolve({ threads:[{ id:'thread-b' }] }); await settle();
  f.requests[0].resolve({ threads:[{ id:'stale-a' }] }); await settle();
  assert.match(f.element('historyThreads').innerHTML, /thread-b/); assert.doesNotMatch(f.element('historyThreads').innerHTML, /stale-a/);
  const reading = f.element('historyThreads').buttons[0].emit('click');
  f.selection.projectRoot = '/project-c'; f.window.hccHistory.open('codex');
  f.requests[3].resolve({ threads:[] }); await settle();
  f.requests[2].resolve({ thread:{ id:'thread-b', turns:[{ items:[{ text:'stale output' }] }] } }); await reading;
  assert.doesNotMatch(f.element('historyContent').innerHTML, /stale output/);
});

test('resume and fork require explicit confirmation and use distinct API contracts', async () => {
  const f = fixture(codexHistoryScript); await historyReady(f);
  await f.click('historyResume'); assert.equal(f.requests.length, 2);
  f.element('historyConfirmed').checked = true; await f.element('historyConfirmed').emit('change');
  const resume = f.click('historyResume');
  assert.deepEqual(JSON.parse(f.requests[2].options.body), { kind:'codex',transport:'app-server',mode:'resume',resume:'thread-a',handoffConfirmed:true });
  f.requests[2].resolve({ session:{ id:'resumed' } }); await resume; assert.deepEqual(f.opened,['resumed']);
  await historyReady(f); f.element('historyConfirmed').checked = true;
  const fork = f.click('historyFork'); assert.deepEqual(JSON.parse(f.requests.at(-1).options.body),{confirmed:true});
  f.requests.at(-1).reject(new Error('network failed')); await fork;
  f.window.hccHistory.sync(); assert.equal(f.requests.length,6,'failed creation is never automatically retried');
});

test('forking a live source uses its current control epoch and observers get a takeover hint', async () => {
  const f = fixture(codexHistoryScript); await historyReady(f);
  f.selection.sessions = [{ id:'a',status:'running',binding:{provider:'codex',provider_session_id:'thread-a'} }];
  f.element('historyConfirmed').checked = true; f.selection.canControl = false; f.window.hccHistory.sync();
  assert.equal(f.element('historyFork').disabled,true); assert.match(f.element('historyNotice').textContent,/take browser control/);
  await f.click('historyFork'); assert.equal(f.requests.length,2);
  f.selection.canControl = true; f.selection.actionToken = 'new-token'; f.selection.epoch = 3; f.window.hccHistory.sync();
  assert.equal(f.element('historyResume').disabled,true);
  const fork = f.click('historyFork'); assert.deepEqual(JSON.parse(f.requests[2].options.body),{confirmed:true,actionToken:'new-token',epoch:3});
  f.requests[2].resolve({session:{id:'forked'}}); await fork;
});

async function reviewReady(f) {
  f.window.hccReview.open(); f.requests.at(-1).resolve({ current_task:{id:7,title:'Review task',owner:'peer-a'},results:[],summary:{} }); await settle();
}
function fillReview(f, title = 'Tests passed') {
  f.fill('verificationTitle', title); f.fill('verificationDetails','Local checks complete; publication pending');
  f.fill('verificationEvidence','/tmp/test-output.txt'); f.fill('verificationStatus','passed');
  f.element('verificationForm').emit('input');
}

test('result evidence writes bind project, task owner and the current browser lease', async () => {
  const f = fixture(reviewPanelScript); await reviewReady(f); fillReview(f);
  f.selection.canControl = false; f.window.hccReview.sync(); assert.equal(f.element('verificationSave').disabled,true);
  f.selection.canControl = true; f.selection.actionToken='takeover'; f.selection.epoch=5;
  const saving = f.element('verificationForm').emit('submit',{preventDefault(){}});
  assert.match(f.requests[1].path,/sessions\/a\/results\?root=%2Fproject-a/);
  assert.deepEqual(JSON.parse(f.requests[1].options.body),{actionToken:'takeover',epoch:5,taskId:7,stage:'local',status:'passed',title:'Tests passed',details:'Local checks complete; publication pending',evidence:['/tmp/test-output.txt']});
  f.requests[1].reject(new Error('owner changed')); await saving;
  assert.match(f.element('reviewNotice').textContent,/owner changed/); assert.equal(f.element('verificationTitle').value,'Tests passed');
});

test('late result acknowledgements clear only unchanged drafts from the original task', async () => {
  const f = fixture(reviewPanelScript); await reviewReady(f); fillReview(f);
  const saving = f.element('verificationForm').emit('submit',{preventDefault(){}});
  f.selection.active='b'; f.selection.projectRoot='/project-b'; f.selection.session={id:'b',peer_id:'peer-b',type:'native',task:{id:9}};
  f.window.hccReview.open(); f.requests[2].resolve({current_task:{id:9,title:'Other task',owner:'peer-b'},results:[],summary:{}}); await settle();
  fillReview(f,'Second task evidence');
  f.requests[1].resolve({result:{id:1}}); await saving;
  assert.equal(f.element('verificationTitle').value,'Second task evidence');
  assert.equal(JSON.parse(f.storage.get('hcc.reviewDraft:["/project-b","b",9]')).verificationTitle,'Second task evidence');
  assert.equal(f.requests.length,3,'old save cannot start a read on the new task');
});

test('results remain read only without the task owner and distinguish manual source in summaries', async () => {
  const f = fixture(reviewPanelScript); f.window.hccReview.open();
  f.requests[0].resolve({current_task:{id:7,owner:'other'},results:[{title:'<script>evidence</script>',stage:'business',status:'passed',source:'user'}],summary:{business:{status:'passed',source:'user'}}}); await settle();
  assert.equal(f.element('verificationSave').disabled,true);
  assert.match(f.element('reviewSummary').innerHTML,/Business acceptance: Passed · Manually recorded evidence/);
  assert.match(f.element('reviewRecords').innerHTML,/&lt;script&gt;evidence&lt;\/script&gt;/);
});

test('a current task change immediately fences a stale evidence form', async () => {
  const f = fixture(reviewPanelScript); await reviewReady(f); fillReview(f);
  f.selection.session = { ...f.selection.session, task:{id:8} }; f.window.hccReview.sync();
  assert.equal(f.element('verificationSave').disabled,true);
  await f.element('verificationForm').emit('submit',{preventDefault(){}});
  assert.equal(f.requests.length,1);
});

const nativeState = (extra={}) => ({peer:'peer-a',root:'/project-a',provider:'codex',sessionId:'native-thread',status:'idle',connected:true,generation:1,owner:'worker-a',capabilities:{send:true,interrupt:true},events:[],deliveries:[],...extra});

test('native output updates retain unchanged approval controls and their handlers use the current lease', async () => {
  const f = fixture(nativePanelScript, 'native');
  const pendingApprovals = [{ requestId: 'approval', executorId: 'worker-a', sessionId: 'native-thread', turnId: 'turn', kind: 'command', params: { command: 'pwd' } }];
  f.window.hccNative.render(nativeState({ executorId: 'worker-a', pendingApprovals }));
  const original = f.element('nativeApprovals').buttons[0];
  f.window.hccNative.render(nativeState({ executorId: 'worker-a', pendingApprovals, events: [{ id: 1, payload: { type: 'message', text: 'Live output' } }] }));
  assert.equal(f.element('nativeApprovals').buttons[0], original, 'streamed text must not replace the pending form DOM');
  f.selection.epoch = 5;
  const answering = original.emit('click');
  assert.equal(JSON.parse(f.requests[0].options.body).epoch, 5);
  f.requests[0].resolve({ state: nativeState() }); await answering;
});

test('native queue receipt clears only its original draft and uses lease credentials once', async () => {
  const f=fixture(nativePanelScript,'native'); f.window.hccNative.render(nativeState()); f.fill('nativeDraft','send once');
  const sending=f.click('nativeSend'), body=JSON.parse(f.requests[0].options.body);
  assert.equal(body.action_token,'token-a'); assert.equal(body.epoch,1); assert.match(body.submissionId,/^s_/);
  await f.click('nativeSend'); assert.equal(f.requests.length,1);
  f.fill('nativeDraft','new edits');
  f.requests[0].resolve({receipt:{submission_id:body.submissionId,message_id:11,state:'queued'}}); await sending;
  assert.equal(f.element('nativeDraft').value,'new edits'); assert.equal(JSON.parse([...f.storage.values()][0]).pending,null);
  assert.match(f.element('nativeNotice').textContent,/HCC queue, awaiting executor receipt/);
});

test('uncertain native submission reconciles durable receipt without resending', async () => {
  const f=fixture(nativePanelScript,'native'); f.window.hccNative.render(nativeState()); f.fill('nativeDraft','retained');
  const sending=f.click('nativeSend'), id=JSON.parse(f.requests[0].options.body).submissionId;
  f.requests[0].reject(new Error('admission uncertain')); await sending;
  assert.equal(f.element('nativeDraft').value,'retained'); f.window.hccNative.sync(); await f.click('nativeSend'); assert.equal(f.requests.length,1);
  const reading=f.click('nativeRead'); f.requests[1].resolve({state:nativeState({deliveries:[{submission_id:id,message_id:12,state:'uncertain'}],quarantined:true})}); await reading;
  assert.equal(f.element('nativeDraft').value,''); assert.equal(f.requests.length,2); assert.equal(f.element('nativeSend').disabled,true);
  assert.match(f.element('nativeReceipts').innerHTML,/Receipt uncertain/);
});

test('native generation and owner changes reset stop consent and reject stale reads and events', async () => {
  const f=fixture(nativePanelScript,'native'); f.window.hccNative.render(nativeState());
  f.element('nativeCloseConfirmed').checked=true; await f.element('nativeCloseConfirmed').emit('change');
  f.element('nativeNotice').textContent='Executor closed.';
  const reading=f.click('nativeRead');
  f.window.hccNative.render(nativeState({generation:2,owner:'worker-b',events:[{id:2,payload:{type:'output',text:'current'}}]}));
  assert.equal(f.element('nativeCloseConfirmed').checked,false); assert.equal(f.element('nativeClose').disabled,true);
  assert.equal(f.element('nativeNotice').textContent,'', 'replacement executor must clear the former executor notice');
  f.requests[0].resolve({state:nativeState({events:[{id:1,payload:{type:'output',text:'stale'}}]})}); await reading;
  f.window.hccNative.render(nativeState({events:[{id:1,payload:{type:'output',text:'stale'}}]}));
  assert.match(f.element('nativeEvents').innerHTML,/current/); assert.doesNotMatch(f.element('nativeEvents').innerHTML,/stale/);
});

test('late native admission receipt cannot clear a different project draft', async () => {
  const f=fixture(nativePanelScript,'native'); f.window.hccNative.render(nativeState()); f.fill('nativeDraft','same message');
  const sending=f.click('nativeSend'), id=JSON.parse(f.requests[0].options.body).submissionId;
  f.selection.active='b'; f.selection.projectRoot='/project-b'; f.selection.session={id:'b',peer_id:'peer-b',type:'native'};
  f.window.hccNative.render(nativeState({root:'/project-b',peer:'peer-b'})); f.fill('nativeDraft','same message');
  f.requests[0].resolve({receipt:{submission_id:id,message_id:13,state:'queued'}}); await sending;
  assert.equal(f.element('nativeDraft').value,'same message'); assert.equal(f.requests.length,1);
  assert.equal(JSON.parse(f.storage.get('hcc.nativeDraft:["/project-b","b"]')).text,'same message');
});

test('native send respects observer, connection, quarantine and provider capabilities', () => {
  const f=fixture(nativePanelScript,'native'); f.window.hccNative.render(nativeState({connected:false})); f.fill('nativeDraft','message'); assert.equal(f.element('nativeSend').disabled,true);
  f.window.hccNative.render(nativeState({capabilities:{send:false}})); assert.equal(f.element('nativeSend').disabled,true);
  f.selection.canControl=false; f.window.hccNative.render(nativeState()); assert.equal(f.element('nativeSend').disabled,true);
  f.selection.canControl=true; f.window.hccNative.sync(); assert.equal(f.element('nativeSend').disabled,false);
});

const nativeStringState = (extra = {}) => nativeState({ generation: 'generation-a', owner: 'worker-a', ...extra });
const approval = id => ({ requestId: id, executorId: 'worker-a', sessionId: 'native-thread', turnId: 'turn-live',
  kind: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'echo ' + id } });

test('late native send receipts acknowledge the draft without replacing newer streamed approvals or delivery stages', async () => {
  const f = fixture(nativePanelScript, 'native'), initial = nativeStringState();
  f.window.hccNative.render(initial); f.fill('nativeDraft', 'send once');
  const sending = f.click('nativeSend'), id = JSON.parse(f.requests[0].options.body).submissionId;
  f.window.hccNative.render(nativeStringState({ status: 'working', pendingApprovals: [approval('new-approval')],
    deliveries: [{ submission_id: id, message_id: 12, state: 'completed' }] }));
  f.requests[0].resolve({ receipt: { submission_id: id, message_id: 12, state: 'queued' },
    state: nativeStringState({ deliveries: [{ submission_id: id, message_id: 12, state: 'queued' }] }) });
  await sending;
  assert.match(f.element('nativeApprovals').innerHTML, /echo new-approval/);
  assert.match(f.element('nativeReceipts').innerHTML, new RegExp(UI_TRANSLATIONS.en['native.delivery.completed']));
  assert.equal(f.element('nativeDraft').value, '');
  assert.equal(JSON.parse([...f.storage.values()][0]).pending, null);
});

test('native receipt reconciliation survives A-B-A before the new snapshot and preserves edits made after returning', async () => {
  for (const edited of [false, true]) {
    const f = fixture(nativePanelScript, 'native');
    f.window.hccNative.render(nativeStringState()); f.fill('nativeDraft', 'submitted text');
    const sending = f.click('nativeSend'), id = JSON.parse(f.requests[0].options.body).submissionId;
    f.selection.active = 'b'; f.selection.session = { id: 'b', peer_id: 'peer-b', type: 'native' }; f.window.hccNative.sync();
    f.selection.active = 'a'; f.selection.session = { id: 'a', peer_id: 'peer-a', type: 'native' }; f.window.hccNative.sync();
    if (edited) f.fill('nativeDraft', 'edits made after returning');
    f.requests[0].resolve({ receipt: { submission_id: id, message_id: 15, state: 'queued' }, state: nativeStringState() }); await sending;
    const stored = JSON.parse(f.storage.get('hcc.nativeDraft:["/project-a","a"]'));
    assert.equal(stored.pending, null);
    assert.equal(stored.text, edited ? 'edits made after returning' : '');
    assert.equal(f.element('nativeDraft').value, stored.text);
    assert.equal(f.element('nativeReviewPending').hidden, true);
    f.window.hccNative.render(nativeStringState({ deliveries: [{ submission_id: id, message_id: 15, state: 'completed' }] }));
    if (!edited) f.fill('nativeDraft', 'next message');
    assert.equal(f.element('nativeSend').disabled, false, 'a reconciled submission must not keep the next draft blocked');
    assert.equal(JSON.parse(f.storage.get('hcc.nativeDraft:["/project-a","a"]')).pending, null, 'editing must not revive the old pending marker');
  }
});

test('late native approval responses retain the next streamed request and bind the decision to the current lease', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('original')] }));
  f.selection.actionToken = 'takeover-token'; f.selection.epoch = 7; f.window.hccNative.sync();
  const responding = f.element('nativeApprovals').buttons[0].emit('click');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { executorId: 'worker-a', sessionId: 'native-thread',
    turnId: 'turn-live', requestId: 'original', decision: 'accept', action_token: 'takeover-token', epoch: 7 });
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('next-request')] }));
  f.requests[0].resolve({ state: nativeStringState({ pendingApprovals: [] }) }); await responding;
  assert.match(f.element('nativeApprovals').innerHTML, /echo next-request/);
  assert.doesNotMatch(f.element('nativeApprovals').innerHTML, /echo original/);
});

test('a late send transport error does not mark an already acknowledged native delivery uncertain', async () => {
  const f = fixture(nativePanelScript, 'native'); f.window.hccNative.render(nativeStringState()); f.fill('nativeDraft', 'send once');
  const sending = f.click('nativeSend'), id = JSON.parse(f.requests[0].options.body).submissionId;
  f.window.hccNative.render(nativeStringState({ deliveries: [{ submission_id: id, message_id: 13, state: 'completed' }] }));
  f.requests[0].reject(new Error('late transport failure')); await sending;
  assert.equal(JSON.parse([...f.storage.values()][0]).pending, null);
  assert.equal(f.element('nativeDraft').value, '');
  assert.doesNotMatch(f.element('nativeNotice').textContent, /late transport failure|unconfirmed|uncertain/i);
});

test('a resolved native request is not replaced by the error from its superseded response', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('original')] }));
  const responding = f.element('nativeApprovals').buttons[0].emit('click');
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('next-request')] }));
  f.requests[0].reject(new Error('late old approval failure')); await responding;
  assert.match(f.element('nativeApprovals').innerHTML, /echo next-request/);
  assert.doesNotMatch(f.element('nativeNotice').textContent, /late old approval failure/);
});

test('a failed native response still reports its error while that exact request remains pending', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('original')] }));
  const responding = f.element('nativeApprovals').buttons[0].emit('click');
  f.window.hccNative.render(nativeStringState({ events: [{ id: 1, payload: { type: 'output', text: 'unrelated progress' } }], pendingApprovals: [approval('original')] }));
  f.requests[0].reject(new Error('response was not admitted')); await responding;
  assert.match(f.element('nativeNotice').textContent, /response was not admitted/);
  assert.match(f.element('nativeApprovals').innerHTML, /echo original/);
  assert.equal(f.element('nativeApprovals').buttons[0].disabled, false, 'the current controller can retry the still-pending request');
});

test('retrying a native response clears the previous error without replaying the request', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState({ pendingApprovals: [approval('original')] }));
  const failed = f.element('nativeApprovals').buttons[0].emit('click');
  f.requests[0].reject(new Error('Invalid value for MCP field: count')); await failed;
  assert.match(f.element('nativeNotice').textContent, /Invalid value/);
  assert.equal(f.requests.length, 1);
  const retried = f.element('nativeApprovals').buttons[0].emit('click');
  assert.equal(f.element('nativeNotice').textContent, '');
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(f.requests[1].options.body).requestId, 'original');
  f.window.hccNative.render(nativeStringState({ status: 'idle', pendingApprovals: [],
    events: [{ id: 1, payload: { type: 'completed', text: 'form completed' } }] }));
  f.requests[1].resolve({ state: nativeStringState({ pendingApprovals: [approval('original')] }) }); await retried;
  assert.equal(f.element('nativeNotice').textContent, '');
  assert.equal(f.element('nativeApprovals').buttons.length, 0, 'late response must not revive a completed request');
  assert.match(f.element('nativeEvents').innerHTML, /form completed/);
  assert.equal(f.requests.length, 2, 'a completed request is never automatically retried');
});

test('native preference redraws keep valid send and response snapshots eligible', async () => {
  for (const operation of ['send', 'respond']) {
    const f = fixture(nativePanelScript, 'native');
    f.window.hccNative.render(nativeStringState({ pendingApprovals: operation === 'respond' ? [approval('original')] : [] }));
    if (operation === 'send') f.fill('nativeDraft', 'send once');
    const pending = operation === 'send' ? f.click('nativeSend') : f.element('nativeApprovals').buttons[0].emit('click');
    f.window.hccUi.language = 'zh'; f.listeners.get('hcc:preferences')();
    const submitted = JSON.parse(f.requests[0].options.body);
    f.requests[0].resolve({ receipt: { submission_id: submitted.submissionId, message_id: 14 },
      state: nativeStringState({ pendingApprovals: [approval('fresh-response')] }) });
    await pending;
    assert.match(f.element('nativeApprovals').innerHTML, /echo fresh-response/, operation + ' response was wrongly ignored after a local redraw');
  }
});


test('a replacement native identity reads its account without waiting for its predecessor', async () => {
  for (const change of [{ generation: 2 }, { owner: 'worker-b' }, { sessionId: 'new-thread' }]) {
    for (const outcome of ['resolve', 'reject']) {
      const f = fixture(nativePanelScript, 'native'), original = nativeState({ capabilities: { send: true, accountRead: true } });
      f.window.hccNative.render(original);
      f.window.hccNative.render({ ...original, ...change });
      assert.equal(f.requests.length, 2, 'every executor identity field scopes a new account read');
      assert.ok(f.requests[1].path.includes('/native/account?'));
      assert.equal(f.requests[1].options, undefined);
      if (outcome === 'resolve') f.requests[0].resolve({ state: { ...original, account: { status: 'ready', authentication: 'authenticated', type: 'chatgpt', planType: 'pro' } } });
      else f.requests[0].reject(new Error('obsolete native account read failed'));
      await settle();
      assert.equal(f.element('nativeAccountRead').disabled, true);
      assert.doesNotMatch(f.element('nativeAccountSummary').textContent, /Signed in/);
      assert.doesNotMatch(f.element('nativeNotice').textContent, /obsolete/);
      f.requests[1].resolve({ state: { ...original, ...change, account: { status: 'ready', authentication: 'providerManaged', rateLimits: { status: 'notApplicable', buckets: [] } } } });
      await settle();
      assert.equal(f.element('nativeAccountRead').disabled, false);
      assert.match(f.element('nativeAccountSummary').textContent, /Provider-managed/);
      assert.equal(f.storage.size, 0);
    }
  }
});

test('an obsolete native account error does not overwrite a streamed account update', async () => {
  const f = fixture(nativePanelScript, 'native'), original = nativeState({ capabilities: { accountRead: true } });
  f.window.hccNative.render(original);
  f.window.hccNative.render({ ...original, account: { status: 'ready', authentication: 'authenticated', type: 'chatgpt', planType: 'plus' } });
  f.requests[0].reject(new Error('obsolete native account read failed')); await settle();
  assert.match(f.element('nativeAccountSummary').textContent, /Signed in/);
  assert.doesNotMatch(f.element('nativeNotice').textContent, /obsolete/);
  assert.equal(f.element('nativeAccountRead').disabled, false);
});

test('returning to native permits account refresh without reviving the previous visit response', async () => {
  const f = fixture(nativePanelScript, 'native'), original = nativeState({ capabilities: { accountRead: true } });
  f.window.hccNative.render(original);
  f.selection.active = 'b'; f.selection.session = { id: 'b', peer_id: 'peer-b', type: 'native' }; f.window.hccNative.sync();
  f.selection.active = 'a'; f.selection.session = { id: 'a', peer_id: 'peer-a', type: 'native' }; f.window.hccNative.sync(); f.window.hccNative.render(original);
  f.requests[0].resolve({ state: { ...original, account: { status: 'ready', authentication: 'authenticated', type: 'chatgpt', planType: 'pro' } } });
  await settle();
  assert.doesNotMatch(f.element('nativeAccountSummary').textContent, /Signed in/);
  assert.equal(f.element('nativeAccountRead').disabled, false);
  const reading = f.click('nativeAccountRead');
  f.requests[1].resolve({ state: { ...original, account: { status: 'ready', authentication: 'required' } } }); await reading;
  assert.match(f.element('nativeAccountSummary').textContent, /sign-in required/i);
  assert.equal(f.requests.length, 2); assert.equal(f.storage.size, 0);
});

const historyWorker = (extra={}) => ({peer:'saved-peer',provider:'codex',sessionId:'saved-session',owner:'old-owner',status:'closed',owned:false,resumable:true,cwd:'/project-a',updatedAt:1791046800000,...extra});
const historyEvent = (id,text='saved output') => ({id,payload:{type:'message',provider:'codex',role:'assistant',text,turnId:'turn-'+id}});
async function retainedHistoryReady(f, worker=historyWorker(), result={}) {
  f.window.hccHistory.open(); f.requests.at(-1).resolve({workers:[worker],runtimeAvailable:true}); await settle();
  const selecting=f.element('historyThreads').buttons[0].emit('click');
  f.requests.at(-1).resolve({worker,events:[historyEvent(1)],deliveries:[],truncated:false,nextAfter:1,...result}); await selecting;
}

test('default history reads only HCC records and filters providers without querying provider accounts', async () => {
  const f=fixture(codexHistoryScript); f.window.hccHistory.open();
  assert.equal(f.requests[0].path,'/api/native/history?root=%2Fproject-a');
  f.requests[0].resolve({workers:[historyWorker(),historyWorker({peer:'claude-peer',provider:'claude'}),historyWorker({peer:'dsh-peer',provider:'dsh'})],runtimeAvailable:true,truncated:true}); await settle();
  assert.equal(f.element('historyThreads').buttons.length,3); assert.match(f.element('historyNotice').textContent,/first 100/);
  f.element('historyProvider').value='claude'; await f.element('historyProvider').emit('change');
  assert.equal(f.element('historyThreads').buttons.length,1); assert.match(f.element('historyThreads').innerHTML,/claude-peer/);
  assert.equal(f.requests.length,1); assert.equal(f.element('historyMore').hidden,true);
  assert.doesNotMatch(f.element('historyThreads').innerHTML,/1791046800000/);
});

test('filtering providers while the initial list is pending keeps its response and applies the latest filter', async () => {
  const f=fixture(codexHistoryScript); f.window.hccHistory.open();
  f.element('historyProvider').value='claude'; await f.element('historyProvider').emit('change');
  f.requests[0].resolve({workers:[historyWorker(),historyWorker({peer:'claude-only',provider:'claude'})]}); await settle();
  assert.equal(f.element('historyThreads').buttons.length,1); assert.match(f.element('historyThreads').innerHTML,/claude-only/);
  assert.equal(f.element('historyRefresh').disabled,false); assert.equal(f.requests.length,1);
});

test('native retained events page forward and backward and a final cursor never enables an empty extra page', async () => {
  const f=fixture(codexHistoryScript); await retainedHistoryReady(f,historyWorker(),{events:[historyEvent(1,'<script>literal</script>'),historyEvent(100)],truncated:true,nextAfter:100,deliveries:[{state:'accepted'}]});
  assert.equal(f.element('historyEventsNext').disabled,false); assert.equal(f.element('historyEventsPrevious').disabled,true);
  assert.match(f.element('historyRetention').textContent,/2,000.*not a full transcript/);
  assert.match(f.element('historyContent').innerHTML,/&lt;script&gt;literal&lt;\/script&gt;/); assert.doesNotMatch(f.element('historyContent').innerHTML,/<script>/);
  const next=f.click('historyEventsNext'); assert.match(f.requests.at(-1).path,/after=100&root=/);
  f.requests.at(-1).resolve({worker:historyWorker(),events:[historyEvent(101),historyEvent(130)],deliveries:[],truncated:false,deliveriesTruncated:true,nextAfter:130}); await next;
  assert.equal(f.element('historyEventsNext').disabled,true); assert.equal(f.element('historyEventsPrevious').disabled,false);
  const before=f.requests.length; await f.click('historyEventsNext'); assert.equal(f.requests.length,before);
  const previous=f.click('historyEventsPrevious'); assert.match(f.requests.at(-1).path,/after=0&root=/);
  f.requests.at(-1).resolve({worker:historyWorker(),events:[historyEvent(1)],deliveries:[],truncated:true,nextAfter:100}); await previous;
  assert.match(f.element('historyEventPage').textContent,/Page 1/);
});

test('native trace mode exposes escaped retained records and receipts without a write', async () => {
  const f=fixture(codexHistoryScript); await retainedHistoryReady(f,historyWorker(),{events:[{id:9,payload:{type:'usage',reported:'<unsafe>'}}],deliveries:[{state:'uncertain',detail:'<receipt>'}]});
  f.element('historyNativeView').value='trace'; await f.element('historyNativeView').emit('change');
  assert.match(f.element('historyContent').innerHTML,/#9.*usage/); assert.match(f.element('historyContent').innerHTML,/&lt;unsafe&gt;/);
  assert.equal(f.element('historyReceipts').hidden,false); assert.match(f.element('historyReceiptContent').textContent,/<receipt>/);
  assert.equal(f.requests.length,2); assert.ok(f.requests.every(request=>!request.options));
});

test('native resume needs explicit confirmation and delegates the saved identity to the protected Agent flow', async () => {
  const f=fixture(codexHistoryScript), restored=[]; f.window.hccAgentStart={pending:false,resumeNative:worker=>restored.push(worker)};
  await retainedHistoryReady(f); assert.equal(f.element('historyResume').disabled,true); assert.equal(f.element('historyFork').hidden,true);
  await f.click('historyResume'); assert.equal(restored.length,0);
  f.element('historyConfirmed').checked=true; await f.element('historyConfirmed').emit('change'); assert.equal(f.element('historyResume').disabled,false);
  await f.click('historyResume'); assert.equal(restored.length,1); assert.equal(restored[0].owner,'old-owner'); assert.equal(restored[0].sessionId,'saved-session');
  assert.equal(f.requests.length,2); assert.equal(f.element('historyDialog').hidden,true);
});

test('active, disconnected and unsupported recorded workers cannot resume or fork', async () => {
  for (const [reason,extra] of [['active',{owned:true,status:'idle'}],['not_closed',{status:'disconnected'}],['capability_unknown',{}],['provider_unsupported',{}]]) {
    const f=fixture(codexHistoryScript); let restores=0; f.window.hccAgentStart={resumeNative:()=>restores++};
    await retainedHistoryReady(f,historyWorker({resumable:false,resumeReason:reason,...extra}));
    f.element('historyConfirmed').checked=true; await f.element('historyConfirmed').emit('change');
    assert.equal(f.element('historyResume').disabled,true); assert.ok(f.element('historyResumeReason').textContent);
    await f.click('historyResume'); await f.click('historyFork'); assert.equal(restores,0); assert.equal(f.requests.length,2);
  }
});

test('a late native detail cannot survive a provider change, source change or closed dialog', async () => {
  const f=fixture(codexHistoryScript); f.window.hccHistory.open();
  f.requests[0].resolve({workers:[historyWorker()]}); await settle();
  const reading=f.element('historyThreads').buttons[0].emit('click');
  f.element('historyProvider').value='claude'; await f.element('historyProvider').emit('change');
  f.requests[1].resolve({worker:historyWorker(),events:[historyEvent(1,'stale native output')]}); await reading;
  assert.doesNotMatch(f.element('historyContent').innerHTML,/stale native output/); assert.equal(f.element('historyResume').disabled,true);
  f.element('historySource').value='codex'; await f.element('historySource').emit('change');
  assert.match(f.requests[2].path,/\/api\/codex\/threads/); await f.click('historyClose');
  f.requests[2].resolve({threads:[{id:'too-late'}]}); await settle(); assert.doesNotMatch(f.element('historyThreads').innerHTML,/too-late/);
});

test('offline retained history remains readable and distinguishes service state from retention limits', async () => {
  const f=fixture(codexHistoryScript); f.window.hccHistory.open();
  f.requests[0].resolve({workers:[historyWorker()],runtimeAvailable:false}); await settle();
  assert.match(f.element('historyNotice').textContent,/service is unavailable/);
  const reading=f.element('historyThreads').buttons[0].emit('click');
  f.requests[1].resolve({worker:historyWorker(),events:[historyEvent(2,'offline output')],deliveries:[],runtimeAvailable:false,truncated:false,nextAfter:2}); await reading;
  assert.match(f.element('historyContent').innerHTML,/offline output/); assert.match(f.element('historyNotice').textContent,/retained history/);
  assert.equal(f.requests.length,2);
});

test('history opened before project initialization explains the wait and loads when the project becomes ready', async () => {
  const f=fixture(codexHistoryScript); f.selection.projectRoot=''; f.window.hccHistory.open();
  assert.equal(f.requests.length,0); assert.match(f.element('historyNotice').textContent,/Waiting for the selected project/);
  f.selection.projectRoot='/project-a'; f.window.hccHistory.sync();
  assert.equal(f.requests.length,1); assert.equal(f.requests[0].path,'/api/native/history?root=%2Fproject-a');
  f.requests[0].resolve({workers:[historyWorker()],runtimeAvailable:true}); await settle();
  assert.equal(f.element('historyThreads').buttons.length,1); assert.equal(f.element('historyRefresh').disabled,false);
});


test('native retry sends only the original pending payload with the current control lease', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState()); f.fill('nativeDraft', 'original pending message');
  const first = f.click('nativeSend'), original = JSON.parse(f.requests[0].options.body);
  f.requests[0].reject(new Error('queue receipt lost')); await first;
  assert.equal(f.element('nativeRetryPending').hidden, false);
  assert.equal(f.element('nativeRetryPending').disabled, false);
  f.fill('nativeDraft', 'new draft edits');
  f.selection.epoch = 4; f.selection.actionToken = 'lease-refreshed';
  const retrying = f.click('nativeRetryPending');
  const retry = JSON.parse(f.requests[1].options.body);
  assert.equal(retry.submissionId, original.submissionId);
  assert.equal(retry.text, 'original pending message');
  assert.equal(retry.retry, true);
  assert.equal(retry.epoch, 4); assert.equal(retry.action_token, 'lease-refreshed');
  await f.click('nativeRetryPending'); assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ receipt: { submission_id: retry.submissionId, message_id: 12, state: 'queued' },
    state: nativeStringState({ deliveries: [{ submission_id: retry.submissionId, message_id: 12, state: 'queued' }] }) });
  await retrying;
  assert.equal(f.element('nativeDraft').value, 'new draft edits');
  assert.equal(f.element('nativeRetryPending').hidden, true);
  assert.equal(JSON.parse([...f.storage.values()][0]).pending, null);
});

test('native retry stays fenced after an executor replacement or loss of control', async () => {
  const f = fixture(nativePanelScript, 'native');
  f.window.hccNative.render(nativeStringState()); f.fill('nativeDraft', 'retained pending message');
  const sending = f.click('nativeSend'); f.requests[0].reject(new Error('queue receipt lost')); await sending;
  f.selection.canControl = false; f.window.hccNative.sync();
  assert.equal(f.element('nativeRetryPending').disabled, true);
  await f.click('nativeRetryPending'); assert.equal(f.requests.length, 1);
  f.selection.canControl = true;
  f.window.hccNative.render(nativeStringState({ owner: 'replacement-worker', generation: 'replacement-generation' }));
  assert.equal(f.element('nativeRetryPending').disabled, true);
  await f.click('nativeRetryPending'); assert.equal(f.requests.length, 1);
  assert.equal(f.element('nativeDraft').value, 'retained pending message');
  assert.ok(JSON.parse([...f.storage.values()][0]).pending);
});
