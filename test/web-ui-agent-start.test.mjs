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
  const nodes = new Map(), requests = [], opened = [], refreshes = [];
  let root = '/project-a', sessions = [], refresh = () => Promise.resolve(), consent = false;
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
  const window = { crypto:{ randomUUID }, confirm: () => consent,
    hccUi:{ safeGet:key=>storage.get(key),safeSet:(key,value)=>storage.set(key,value) }, hccHandoff: {
    get projectRoot() { return root; },
    get sessions() { return sessions; },
    tr: (key, fallback = '') => UI_TRANSLATIONS.en[key] || fallback || key,
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
    change(id, value) { node(id).value = value; return node(id).emit('change'); },
    submit: () => node('startForm').emit('submit'),
    project(value) { window.hccAgentStart.reset(); root = value; },
    close() { window.hccHandoff.closeDialog(node('startDialog')); },
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
    assert.deepEqual(payload, { transport:'native', kind:provider, cwd:'/project-a', id:payload.id });
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
  f.start.open(); f.change('kind','claude'); assert.equal(f.node('transport').value,'tmux');
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
