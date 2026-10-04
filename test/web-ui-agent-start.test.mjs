import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { agentStartHtml, agentStartScript } from '../lib/web/ui-agent-start.mjs';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';
import { webIndexHtml } from '../lib/web/ui-template.mjs';
import { fetchJson } from '../lib/web/browser/project-data.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(storage = new Map()) {
  const nodes = new Map(), requests = [], opened = [], refreshes = [], listeners = new Map();
  let root = '/project-a', sessions = [], refresh = () => Promise.resolve(), consent = false, language = 'en';
  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const element = { id, value:'', checked:false, hidden:false, disabled:false, required:false,
      textContent:'', style:{}, options:[], listeners:new Map(), attributes:{},
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      emit(name, event = {}) { return this.listeners.get(name)?.({ currentTarget:this, preventDefault() {}, ...event }); },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; }
    };
    Object.defineProperty(element, 'innerHTML', { get() { return this.html || ''; }, set(html) {
      this.html = html;
      this.options = [...html.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value:match[1] }));
      this.value = this.options[0]?.value || '';
    } });
    nodes.set(id, element); return element;
  };
  node('kind').value = 'codex'; node('transport').value = 'native'; node('startMode').value = 'new'; node('startDialog').hidden = true;
  const window = { crypto:{ randomUUID }, confirm: () => consent, addEventListener:(name,listener)=>listeners.set(name,listener),
    hccUi:{ safeGet:key=>storage.get(key),safeSet:(key,value)=>storage.set(key,value) }, hccHandoff: {
    get projectRoot() { return root; },
    get sessions() { return sessions; },
    tr: (key, fallback = '') => UI_TRANSLATIONS[language][key] || fallback || key,
    esc: value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character])),
    api(path, options) { const request = { path, options, ...deferred() }; requests.push(request); return request.promise; },
    refreshSessions() { refreshes.push(root); return refresh(); },
    openManaged(id) { opened.push({ root, id }); },
    openDialog(dialog) { dialog.hidden = false; },
    closeDialog(dialog) { window.hccAgentStart.closed(); dialog.hidden = true; }
  } };
  vm.runInNewContext(agentStartScript(), { window, document: {
    getElementById:node,
    querySelector:selector => node(selector === '[data-resume-custom]' ? 'resumeCustomField' : 'resumeField')
  } });
  return { node, requests, opened, refreshes, storage, start:window.hccAgentStart,
    defaults(reader) { window.hccAgentDefaults={read:reader}; },
    change(id, value) { node(id).value = value; return node(id).emit('change'); },
    submit: () => node('startForm').emit('submit'),
    project(value) { window.hccAgentStart.reset(); root = value; },
    close() { window.hccHandoff.closeDialog(node('startDialog')); },
    preferences(value) { language=value; listeners.get('hcc:preferences')?.(); },
    setRefresh(fn) { refresh = fn; }, setSessions(value) { sessions = value; }, consent(value) { consent = value; }
  };
}

test('shipped new Agent form exposes all providers and keeps connection modes in advanced options', () => {
  const html = agentStartHtml();
  for (const provider of ['codex','claude','dsh','shell']) assert.match(html, new RegExp('value="' + provider + '"'));
  assert.match(html, /<details id="agentAdvanced">[\s\S]*id="transport"/);
  assert.match(html, /id="agentModel" type="text"/);
  const shipped = webIndexHtml({ nonce:'agent-creation-test-nonce' });
  assert.match(shipped, /src="\/assets\/web\/browser\/core\.mjs"/);
  const bootstrap = fs.readFileSync(new URL('../lib/web/browser/core.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /import \{ installAgentStart \} from '\.\.\/ui-agent-start\.mjs'/);
  assert.match(bootstrap, /installAgentStart\(\)/);
  assert.match(bootstrap, /window\.hccAgentStart\?\.reset\(\)/);
  assert.match(bootstrap, /dialog.id === 'startDialog'.*hccAgentStart\?\.closed\(\)/);
});

for (const provider of ['codex','claude','dsh']) {
  test(provider + ' defaults to a native Agent, allocates a stable peer and opens the returned worker', async () => {
    const f = fixture(); f.start.open(); f.change('kind', provider);
    assert.equal(f.node('transport').value, 'native');
    assert.equal(f.node('agentCwd').value, '/project-a');
    const submitting = f.submit();
    const payload = JSON.parse(f.requests[0].options.body);
    assert.match(payload.id, /^web-[a-f0-9-]{36}$/);
    assert.deepEqual(payload, { transport:'native', kind:provider, cwd:'/project-a', id:payload.id, model:null });
    assert.equal(f.requests[0].path, '/api/sessions');
    f.requests[0].resolve({ session:{ id:'native-created', type:'native' } }); await submitting;
    assert.deepEqual(f.refreshes, ['/project-a']);
    assert.deepEqual(f.opened, [{ root:'/project-a', id:'native-created' }]);
    assert.equal(f.node('startDialog').hidden, true);
  });
}

test('native submission trims optional fields, rejects duplicate submits and preserves fields on backend failure', async () => {
  const f = fixture(); f.start.open();
  f.node('agentName').value = ' reviewer-1 '; f.node('agentCwd').value = ' /project-a/packages/ui '; f.node('agentModel').value = ' model-choice ';
  const submitting = f.submit(); await f.submit();
  assert.equal(f.requests.length, 1);
  assert.equal(f.node('agentStartBtn').disabled, true);
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { kind:'codex',transport:'native',id:'reviewer-1',cwd:'/project-a/packages/ui',model:'model-choice' });
  f.requests[0].reject(Object.assign(new Error('denied'), { code:'PROJECT_PATH_FORBIDDEN',detail:'Directory is outside the project' }));
  await submitting;
  assert.equal(f.node('startDialogError').textContent, 'Directory is outside the project');
  assert.equal(f.node('agentName').value, ' reviewer-1 ');
  assert.equal(f.node('agentModel').value, ' model-choice ');
  assert.equal(f.node('agentCwd').value, ' /project-a/packages/ui ');
  assert.equal(f.node('agentStartBtn').disabled, false);
  assert.equal(f.node('startDialog').hidden, false);
  assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')), null, 'a definite refusal releases recovery after retaining the form');
});

test('invalid or reserved Agent names fail before any creation request', async () => {
  const f = fixture(); f.start.open();
  for (const name of ['all','ALL','reviewer space','中文','-reviewer','a'.repeat(129)]) {
    f.node('agentName').value = name; await f.submit();
    assert.equal(f.requests.length, 0);
    assert.equal(f.node('startDialogError').hidden, false);
  }
});

test('native and shell switches clear hidden resume state and never send unsupported model or resume fields', async () => {
  const f = fixture(); f.start.open(); f.change('transport','app-server'); f.change('startMode','resume');
  f.node('resumeArg').value = 'old-thread'; f.node('appServerResumeConfirm').checked = true;
  f.change('transport','native');
  assert.equal(f.node('startMode').value, 'new');
  assert.equal(f.node('resumeArg').value, '');
  assert.equal(f.node('appServerResumeConfirm').checked, false);
  f.node('agentModel').value = 'native-model'; f.change('kind','shell');
  assert.equal(f.node('transport').value, 'tmux');
  assert.equal(f.node('transport').disabled, true);
  assert.equal(f.node('agentModelField').hidden, true);
  const submitting = f.submit();
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { kind:'shell',cwd:'/project-a',mode:'new' });
  f.requests.at(-1).resolve({ session:{ id:'shell-new' } }); await submitting;
  f.requests[0].resolve({ resumable:[{ provider:'codex',resume:'late-thread',peer:'late-peer' }] }); await settle();
  assert.equal(f.node('resumeSelect').innerHTML, '');
  f.start.open(); f.change('kind','dsh');
  assert.equal(f.node('transport').value, 'native');
  assert.equal(f.node('transport').disabled, true);
});

test('explicit advanced modes survive provider switches and preserve guarded Codex and terminal resume contracts', async () => {
  const f = fixture(); f.start.open(); f.change('transport','app-server');
  f.change('kind','claude'); assert.equal(f.node('transport').value,'native');
  f.change('transport','tmux'); f.change('kind','codex'); assert.equal(f.node('transport').value,'app-server');
  f.change('startMode','resume');
  f.requests.at(-1).resolve({ resumable:[{ provider:'codex',resume:'thread-7',peer:'saved-peer' }] }); await settle();
  await f.submit(); assert.equal(f.requests.filter(item=>item.options?.method === 'POST').length,0);
  f.node('appServerResumeConfirm').checked = true;
  const submitting = f.submit();
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { kind:'codex',cwd:'/project-a',transport:'app-server',mode:'resume',resume:'thread-7',handoffConfirmed:true });
  f.requests.at(-1).resolve({ session:{ id:'resumed' } }); await submitting;
  f.start.open(); f.change('kind','claude'); assert.equal(f.node('transport').value,'native');
  f.change('transport','tmux');
  f.change('startMode','continue');
  const terminal = f.submit();
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { kind:'claude',cwd:'/project-a',mode:'continue' });
  f.requests.at(-1).resolve({ session:{ id:'terminal-claude' } }); await terminal;
});

test('close and project changes fence late creation errors and success even after returning to the original project', async () => {
  for (const action of ['close','project']) {
    const f = fixture(); f.start.open(); const submitting = f.submit();
    if (action === 'close') f.close(); else { f.project('/project-b'); f.project('/project-a'); }
    f.requests[0].resolve({ session:{ id:'late-worker' } }); await submitting;
    assert.equal(f.opened.length, 0); assert.equal(f.refreshes.length, 0);
    f.start.open(); assert.equal(f.node('agentStartBtn').textContent,'Check original Agent');
    await f.submit(); assert.equal(f.requests.length,1);
    assert.equal(f.opened.length,0);
    const failed = fixture(); failed.start.open(); const next = failed.submit(); failed.close();
    failed.requests[0].reject(Object.assign(new Error('old definite failure'),{code:'PROJECT_PATH_FORBIDDEN',status:403})); await next;
    failed.start.open(); assert.equal(failed.node('startDialogError').hidden,true);
  }
});

test('a project switch during list refresh cannot open the newly created worker in another project', async () => {
  const f = fixture(), refreshing = deferred(); f.setRefresh(() => refreshing.promise);
  f.start.open(); const submitting = f.submit();
  f.requests[0].resolve({ session:{ id:'created-a' } }); await settle();
  f.project('/project-b'); refreshing.resolve(); await submitting;
  assert.equal(f.opened.length,0);
  f.start.open(); assert.equal(f.node('agentCwd').value,'/project-b');
});

test('successful creation followed by a failed refresh retries opening the same Agent without another POST', async () => {
  const f = fixture(); f.setRefresh(() => Promise.reject(new Error('temporary list error')));
  f.start.open(); const submitting = f.submit();
  f.requests[0].resolve({ session:{ id:'created-worker' } }); await submitting;
  assert.match(f.node('startDialogError').textContent, /created-worker was created/);
  assert.match(f.node('startDialogError').textContent, /temporary list error/);
  assert.equal(f.node('agentStartBtn').textContent, 'Open created Agent');
  f.setRefresh(() => Promise.resolve()); await f.submit();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.opened, [{ root:'/project-a',id:'created-worker' }]);
});

for (const transportFailure of [false,true]) {
  test('confirmed creation survives ' + (transportFailure ? 'network' : 'HTTP 500') + ' list failure and page reload without another POST', async () => {
    const f = fixture();
    const failure = transportFailure ? new TypeError('refresh network lost')
      : Object.assign(new Error('list failed'),{code:'SERVER_ERROR',status:500});
    f.setRefresh(() => Promise.reject(failure));
    f.start.open(); const submitting = f.submit();
    const peer = JSON.parse(f.requests[0].options.body).id;
    f.requests[0].resolve({session:{id:peer,type:'native'}}); await submitting;
    const persisted = JSON.parse(f.storage.get('hcc.agentCreation:/project-a'));
    assert.equal(persisted.id,peer); assert.equal(persisted.confirmed,true);
    f.close();
    const reloaded = fixture(f.storage); reloaded.start.open();
    assert.match(reloaded.node('startDialogError').textContent,/was created/);
    await reloaded.submit(); assert.equal(reloaded.requests.length,0);
    assert.equal(reloaded.opened.length,0);
    assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')).confirmed,true);
    reloaded.setSessions([{id:peer,type:'native'}]); await reloaded.submit();
    assert.equal(reloaded.requests.length,0);
    assert.deepEqual(reloaded.opened,[{root:'/project-a',id:peer}]);
  });
}

test('browser HTTP errors retain native recovery metadata', async () => {
  const extra = { peer:'native-recovery',created:true,provider:'codex' };
  await assert.rejects(fetchJson('/api/sessions', {}, { fetchImpl: async () => ({ ok:false,status:409,
    async json() { return { error:{ code:'NATIVE_WORKER_DISCOVERY_FAILED',message:'Worker exists; inspect native status',extra } }; }
  }) }), error => error.code === 'NATIVE_WORKER_DISCOVERY_FAILED' && error.status === 409
    && error.detail === 'Worker exists; inspect native status' && assert.deepEqual(error.extra,extra) === undefined);
});

for (const code of ['NATIVE_CREATE_UNCONFIRMED','NATIVE_WORKER_DISCOVERY_FAILED','REQUEST_TIMEOUT','NETWORK_ERROR']) {
  test(code + ' retains the submitted peer and only checks for its original native worker', async () => {
    const f = fixture(); f.start.open(); const submitting = f.submit();
    const payload = JSON.parse(f.requests[0].options.body);
    const failure = code === 'NETWORK_ERROR' ? new TypeError('network lost') : Object.assign(new Error('check native status'), {
      code, ...(code === 'REQUEST_TIMEOUT' ? {} : { status:409, extra:{ peer:payload.id,
        created:code === 'NATIVE_WORKER_DISCOVERY_FAILED',uncertain:code === 'NATIVE_CREATE_UNCONFIRMED' } })
    });
    f.requests[0].reject(failure); await submitting;
    assert.equal(f.node('agentName').value,'', 'the generated peer does not replace the optional user name');
    assert.match(f.node('startDialogError').textContent,new RegExp(payload.id));
    assert.equal(f.node('agentStartBtn').textContent,'Check original Agent');
    f.setSessions([{id:payload.id,type:'tmux'}]); await f.submit();
    assert.equal(f.requests.length,1); assert.equal(f.opened.length,0);
    assert.match(f.node('startDialogError').textContent,/not visible yet/);
    f.close(); f.project('/project-b'); f.project('/project-a'); f.start.open();
    assert.equal(f.node('agentStartBtn').textContent,'Check original Agent');
    f.setSessions([{id:'native-view',peer_id:payload.id,type:'native'}]); await f.submit();
    assert.equal(f.requests.length,1);
    assert.deepEqual(f.opened,[{root:'/project-a',id:'native-view'}]);
  });
}

test('a native peer is persisted before POST and a reloaded page only checks that peer', async () => {
  const f = fixture(); f.start.open(); const submitting = f.submit();
  const payload = JSON.parse(f.requests[0].options.body);
  assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')).id,payload.id);
  f.close();
  const reloaded = fixture(f.storage); reloaded.start.open();
  assert.equal(reloaded.node('agentStartBtn').textContent,'Check original Agent');
  await reloaded.submit(); assert.equal(reloaded.requests.length,0);
  assert.match(reloaded.node('startDialogError').textContent,/not visible yet/);
  f.requests[0].reject(Object.assign(new Error('page closed'),{code:'REQUEST_SUPERSEDED'})); await submitting;
});

test('only an explicit review confirmation forgets recovery and allows another creation', async () => {
  const f = fixture(); f.start.open(); const submitting = f.submit();
  const original = JSON.parse(f.requests[0].options.body).id;
  f.requests[0].reject(new TypeError('connection failed')); await submitting;
  assert.equal(f.node('agentForgetRecovery').hidden,false);
  await f.node('agentForgetRecovery').emit('click');
  assert.equal(f.node('agentStartBtn').textContent,'Check original Agent');
  assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')).id,original);
  f.consent(true); await f.node('agentForgetRecovery').emit('click');
  assert.equal(f.node('agentStartBtn').textContent,'Start');
  assert.equal(f.node('agentForgetRecovery').hidden,true);
  assert.equal(f.requests.length,1, 'confirming does not submit a new creation');
  const retried = f.submit();
  const replacement = JSON.parse(f.requests[1].options.body).id;
  assert.notEqual(replacement,original);
  f.requests[1].resolve({session:{id:replacement,type:'native'}}); await retried;
});

const savedWorker = (extra = {}) => ({peer:'saved-worker',provider:'codex',sessionId:'saved-thread',owner:'old-executor',status:'closed',owned:false,resumable:true,cwd:'/project-a',...extra});
const resumedSession = (extra = {}) => ({id:'saved-worker',peer_id:'saved-worker',kind:'codex',type:'native',status:'running',native_connected:true,executor_id:'new-executor',binding:{provider_session_id:'saved-thread'},...extra});

test('native history restore reuses the recorded peer and persists its identity before one confirmed POST', async () => {
  const f=fixture(); const action=f.start.resumeNative(savedWorker());
  assert.equal(f.node('agentLaunchFields').hidden,true);
  assert.equal(f.node('startDialogTitle').textContent,'Resume recorded Agent');
  assert.equal(f.requests[0].path,'/api/native/history/saved-worker/resume');
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{owner:'old-executor',sessionId:'saved-thread',confirmed:true});
  const saved=JSON.parse(f.storage.get('hcc.agentCreation:/project-a'));
  assert.equal(saved.operation,'resume'); assert.equal(saved.oldOwner,'old-executor'); assert.equal(saved.sessionId,'saved-thread');
  await f.start.resumeNative(savedWorker()); await f.submit(); assert.equal(f.requests.length,1);
  f.setSessions([resumedSession()]); f.requests[0].resolve({session:resumedSession()}); await action;
  assert.deepEqual(f.opened,[{root:'/project-a',id:'saved-worker'}]);
  assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')),null);
});

test('active, uncertain or unsupported native history cannot start a resume request', async () => {
  const f=fixture();
  for (const change of [{status:'disconnected'},{status:'error'},{owned:true},{resumable:false},{owner:null},{sessionId:null}]) await f.start.resumeNative(savedWorker(change));
  assert.equal(f.requests.length,0); assert.equal(f.node('startDialog').hidden,true);
});

for (const code of ['NATIVE_RESUME_UNCONFIRMED','REQUEST_TIMEOUT','NATIVE_WORKER_DISCOVERY_FAILED']) {
  test(code+' retains the original resume identity and a page reload only discovers the new executor', async () => {
    const storage=new Map(), f=fixture(storage); const action=f.start.resumeNative(savedWorker());
    f.requests[0].reject(Object.assign(new Error('uncertain resume'),{code,extra:{peer:'wrong-peer',created:code==='NATIVE_WORKER_DISCOVERY_FAILED',...(code==='NATIVE_WORKER_DISCOVERY_FAILED' ? {executorId:'new-executor'} : {})}})); await action;
    assert.equal(JSON.parse(storage.get('hcc.agentCreation:/project-a')).id,'saved-worker');
    const reloaded=fixture(storage); reloaded.start.open();
    const invalid=[resumedSession({executor_id:'old-executor'}),resumedSession({kind:'claude'}),resumedSession({status:'exited'}),resumedSession({native_connected:false}),resumedSession({binding:{provider_session_id:'other-thread'}})];
    for (const session of invalid) { reloaded.setSessions([session]); await reloaded.submit(); assert.equal(reloaded.opened.length,0); }
    reloaded.setSessions([resumedSession()]); await reloaded.submit();
    assert.equal(reloaded.requests.length,0); assert.deepEqual(reloaded.opened,[{root:'/project-a',id:'saved-worker'}]);
  });
}

test('a known resume receipt also fences later workers with a different new executor', async () => {
  const f=fixture(), action=f.start.resumeNative(savedWorker());
  f.setRefresh(()=>Promise.reject(new Error('list unavailable'))); f.requests[0].resolve({session:resumedSession()}); await action;
  const saved=JSON.parse(f.storage.get('hcc.agentCreation:/project-a')); assert.equal(saved.confirmed,true); assert.equal(saved.executorId,'new-executor');
  f.setRefresh(()=>Promise.resolve()); f.setSessions([resumedSession({executor_id:'unrelated-new-executor'})]); await f.submit();
  assert.equal(f.opened.length,0); assert.equal(f.requests.length,1);
  f.setSessions([resumedSession()]); await f.submit(); assert.equal(f.opened.length,1);
});

test('a failed native resume that definitely did not start requires selecting history again', async () => {
  const f=fixture(), action=f.start.resumeNative(savedWorker());
  f.requests[0].reject(Object.assign(new Error('saved owner changed'),{status:409,code:'NATIVE_OWNER_CHANGED'})); await action;
  assert.equal(f.node('agentStartBtn').disabled,true); assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')),null);
  await f.submit(); assert.equal(f.requests.length,1);
  f.close(); f.start.open(); assert.equal(f.node('agentLaunchFields').hidden,false); assert.equal(f.node('agentStartBtn').disabled,false);
});

test('an outstanding creation or resume recovery takes precedence over selecting another history worker', async () => {
  const f=fixture(); f.start.open(); const action=f.submit();
  f.requests[0].reject(Object.assign(new Error('create uncertain'),{code:'NATIVE_CREATE_UNCONFIRMED'})); await action;
  f.close(); await f.start.resumeNative(savedWorker());
  assert.equal(f.requests.length,1); assert.equal(f.node('agentStartBtn').textContent,UI_TRANSLATIONS.en['agent.checkCreated']);
});

test('a late resume receipt remains recoverable but cannot open after a project A-B-A visit', async () => {
  const f=fixture(), action=f.start.resumeNative(savedWorker());
  f.project('/project-b'); f.project('/project-a');
  f.requests[0].resolve({session:resumedSession()}); await action;
  assert.equal(f.opened.length,0); assert.equal(JSON.parse(f.storage.get('hcc.agentCreation:/project-a')).confirmed,true);
  f.setSessions([resumedSession()]); f.start.open(); await f.submit();
  assert.deepEqual(f.opened,[{root:'/project-a',id:'saved-worker'}]); assert.equal(f.requests.length,1);
});

test('resume recovery hides creation instructions and preserves its action after language changes', async () => {
  const f=fixture(), action=f.start.resumeNative(savedWorker());
  assert.equal(f.node('startDialogHelp').hidden,true); assert.equal(f.node('agentLaunchFields').hidden,true);
  f.requests[0].reject(Object.assign(new Error('uncertain'),{code:'NATIVE_RESUME_UNCONFIRMED'})); await action;
  f.preferences('zh');
  assert.equal(f.node('startDialogTitle').attributes['data-i18n'],'agent.resumeTitle');
  assert.equal(f.node('agentStartBtn').attributes['data-i18n'],'agent.checkCreated');
  assert.equal(f.node('startDialogTitle').textContent,UI_TRANSLATIONS.zh['agent.resumeTitle']);
  assert.equal(f.node('agentStartBtn').textContent,UI_TRANSLATIONS.zh['agent.checkCreated']);
  assert.match(f.node('agentResumeInfo').textContent,/saved-thread.*saved-worker/);
  f.consent(true); f.node('agentForgetRecovery').emit('click');
  assert.equal(f.node('startDialogHelp').hidden,false); assert.equal(f.node('agentStartBtn').attributes['data-i18n'],'start');
});

const projectDefaults = (extra={}) => ({revision:1,defaultProvider:'dsh',providers:{codex:{model:'codex-model',cwd:'packages/codex'},claude:{model:'claude-model',cwd:'packages/claude'},dsh:{model:'dsh-model',cwd:'packages/dsh'}},...extra});
function defaultsFixture() {
  const f=fixture(), reads=[];
  f.defaults(root=>{const request={root,...deferred()}; reads.push(request); return request.promise;});
  return {...f,reads};
}
async function defaultsReady(f,value=projectDefaults()) { f.start.open(); f.reads.at(-1).resolve(value); await settle(); }

test('new Agent waits for project defaults, then prefills provider-specific cwd and model', async () => {
  const f=defaultsFixture(); f.start.open(); assert.equal(f.reads[0].root,'/project-a');
  assert.equal(f.node('agentStartBtn').disabled,true); await f.submit(); assert.equal(f.requests.length,0);
  f.reads[0].resolve(projectDefaults()); await settle();
  assert.equal(f.node('kind').value,'dsh'); assert.equal(f.node('agentCwd').value,'/project-a/packages/dsh'); assert.equal(f.node('agentModel').value,'dsh-model');
  assert.equal(f.node('agentStartBtn').disabled,false);
  const action=f.submit(); const body=JSON.parse(f.requests[0].options.body);
  assert.equal(body.kind,'dsh'); assert.equal(body.cwd,'/project-a/packages/dsh'); assert.equal(body.model,'dsh-model');
  f.requests[0].resolve({session:{id:'new-dsh',type:'native'}}); await action;
});

test('late defaults preserve edited provider, cwd and model fields including an intentionally empty model', async () => {
  const f=defaultsFixture(); f.start.open(); f.change('kind','claude');
  f.node('agentCwd').value='/project-a/manual'; f.node('agentCwd').emit('input'); f.node('agentModel').value=''; f.node('agentModel').emit('input');
  f.reads[0].resolve(projectDefaults()); await settle();
  assert.equal(f.node('kind').value,'claude'); assert.equal(f.node('agentCwd').value,'/project-a/manual'); assert.equal(f.node('agentModel').value,'');
  const action=f.submit(); assert.equal(JSON.parse(f.requests[0].options.body).model,null);
  f.requests[0].resolve({session:{id:'created',type:'native'}}); await action;
});

test('editing a launch field before defaults arrive keeps the selected provider while filling untouched fields', async () => {
  const f=defaultsFixture(); f.start.open(); f.node('agentCwd').value='/project-a/typed'; f.node('agentCwd').emit('input');
  f.reads[0].resolve(projectDefaults()); await settle();
  assert.equal(f.node('kind').value,'codex'); assert.equal(f.node('agentCwd').value,'/project-a/typed'); assert.equal(f.node('agentModel').value,'codex-model');
});

test('native, terminal and App Server keep separate working-directory drafts and only native inherits defaults', async () => {
  const f=defaultsFixture(); await defaultsReady(f,projectDefaults({defaultProvider:'codex'}));
  f.node('agentCwd').value='/project-a/native-manual'; f.node('agentCwd').emit('input');
  f.change('transport','tmux'); assert.equal(f.node('agentCwd').value,'/project-a');
  f.node('agentCwd').value='/project-a/terminal-manual'; f.node('agentCwd').emit('input');
  f.change('transport','app-server'); assert.equal(f.node('agentCwd').value,'/project-a');
  f.node('agentCwd').value='/project-a/app-server-manual'; f.node('agentCwd').emit('input');
  f.change('transport','native'); assert.equal(f.node('agentCwd').value,'/project-a/native-manual'); assert.equal(f.node('agentModel').value,'codex-model');
  f.change('transport','tmux'); assert.equal(f.node('agentCwd').value,'/project-a/terminal-manual');
  f.change('transport','app-server'); assert.equal(f.node('agentCwd').value,'/project-a/app-server-manual');
  const action=f.submit(); assert.deepEqual(JSON.parse(f.requests[0].options.body),{kind:'codex',cwd:'/project-a/app-server-manual',mode:'new',transport:'app-server'});
  f.requests[0].resolve({session:{id:'app-server'}}); await action;
});

test('provider switches preserve each provider model draft and untouched values use that provider defaults', async () => {
  const f=defaultsFixture(); await defaultsReady(f,projectDefaults({defaultProvider:'codex'}));
  f.node('agentModel').value='custom codex'; f.node('agentModel').emit('input'); f.change('kind','claude');
  assert.equal(f.node('agentModel').value,'claude-model'); assert.equal(f.node('agentCwd').value,'/project-a/packages/claude');
  f.change('kind','codex'); assert.equal(f.node('agentModel').value,'custom codex');
});

test('late defaults reads cannot replace a newer project A-B-A visit', async () => {
  const f=defaultsFixture(); f.start.open(); f.project('/project-b'); f.start.open(); f.project('/project-a'); f.start.open();
  f.reads[2].resolve(projectDefaults({defaultProvider:'claude'})); await settle();
  f.reads[0].resolve(projectDefaults()); f.reads[1].reject(new Error('old read failed')); await settle();
  assert.equal(f.node('kind').value,'claude'); assert.equal(f.node('agentCwd').value,'/project-a/packages/claude');
  assert.equal(f.node('agentDefaultsNotice').hidden,true); assert.equal(f.node('agentStartBtn').disabled,false);
});

test('failed defaults reads allow explicit visible values and retry only fills untouched fields', async () => {
  const f=defaultsFixture(); f.start.open(); f.reads[0].reject(new Error('offline')); await settle();
  assert.equal(f.node('agentStartBtn').disabled,false); assert.equal(f.node('agentDefaultsRetry').hidden,false);
  f.node('agentModel').value='manual'; f.node('agentModel').emit('input'); const retry=f.node('agentDefaultsRetry').emit('click');
  f.reads[1].resolve(projectDefaults()); await retry;
  assert.equal(f.node('kind').value,'codex'); assert.equal(f.node('agentModel').value,'manual');
  f.close(); f.start.open(); f.reads[2].reject(new Error('offline again')); await settle();
  f.node('agentModel').value=''; f.node('agentModel').emit('input'); const action=f.submit();
  assert.equal(JSON.parse(f.requests[0].options.body).model,null); assert.equal(JSON.parse(f.requests[0].options.body).cwd,f.node('agentCwd').value);
  f.requests[0].resolve({session:{id:'fallback'}}); await action;
});

test('cancelled creation preserves the draft but successful creation consumes it before reading new defaults', async () => {
  const f=defaultsFixture(); await defaultsReady(f,projectDefaults({defaultProvider:'codex'}));
  f.node('agentName').value='my-agent'; f.node('agentModel').value='manual'; f.node('agentModel').emit('input');
  f.close(); f.start.open(); f.reads[1].resolve(projectDefaults()); await settle();
  assert.equal(f.node('kind').value,'codex'); assert.equal(f.node('agentModel').value,'manual'); assert.equal(f.node('agentName').value,'my-agent');
  const action=f.submit(); f.requests[0].resolve({session:{id:'my-agent',type:'native'}}); await action;
  f.start.open(); f.reads[2].resolve(projectDefaults()); await settle();
  assert.equal(f.node('kind').value,'dsh'); assert.equal(f.node('agentModel').value,'dsh-model'); assert.equal(f.node('agentCwd').value,'/project-a/packages/dsh'); assert.equal(f.node('agentName').value,'');
});

test('native history restore never reads or applies project launch defaults', async () => {
  const f=defaultsFixture(), action=f.start.resumeNative(savedWorker());
  assert.equal(f.reads.length,0); assert.equal(f.requests[0].path,'/api/native/history/saved-worker/resume');
  f.setSessions([resumedSession()]); f.requests[0].resolve({session:resumedSession()}); await action;
});
