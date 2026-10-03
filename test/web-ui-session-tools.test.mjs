import test from 'node:test';
import assert from 'node:assert/strict';
import { contextReference, sessionCapabilities, reportedMetrics, traceMatches, createSessionTools, renderReportedMetrics } from '../lib/web/ui-session-tools.mjs';
import { codexUsage, claudeUsage, acpUsage } from '../lib/integrations/native/telemetry.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const text = (en, zh) => en;

function fixture() {
  const nodes = new Map(), requests = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, listeners: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); }, focus() {},
      click() { return this.listeners.get('click')?.(); } });
    return nodes.get(id);
  };
  let state = { executorId: 'executor-a', runtimeMetadata: { model: 'actual-model' } }, saves = 0;
  const current = { active: 'a', projectRoot: '/a', sessions: [{id: 'a',kind: 'codex',peer_id: 'worker',task:{title:'Task <unsafe>'},binding:{provider_session_id:'thread-a'}}],
    api: async url => { requests.push(url); return { paths: ['src/first.mjs', '../outside', '/absolute', 'src/<unsafe>.mjs'], truncated: true }; } };
  const document = { getElementById: node }, window = { hccSessionCapabilities: sessionCapabilities, hccContextReference: contextReference };
  const draft = node('draft'); draft.value = 'Please review';
  const tools = createSessionTools({ document, window, prefix:'qa',bridge:()=>current,draft,save:()=>{saves++;},state:()=>state,text,escape });
  tools.render();
  return { node, document, window, draft, current, requests, tools, setState(value){state=value;}, get saves(){return saves;} };
}

test('file references are explicit relative text markers and reject absolute, traversal and control paths', () => {
  assert.equal(contextReference('file','./src/a "quoted".mjs'),'[file reference: "src/a \\"quoted\\".mjs"]'.replaceAll('\\\\','\\'));
  assert.equal(contextReference('file','src\\a.mjs'),'[file reference: "src/a.mjs"]');
  for (const path of ['/etc/passwd','../outside','a/../../b','C:\\private','~/private','a\nb','a//b','']) assert.equal(contextReference('file',path),null,path);
  assert.equal(contextReference('session','codex:worker:thread'),'[session reference: "codex:worker:thread"]');
});

test('capability declarations expose only advertised text commands and never imply model or permission mutation', () => {
  const empty = sessionCapabilities({});
  assert.equal(empty.modelSelection,false); assert.equal(empty.permissionSelection,false);
  assert.equal(empty.fileUpload,false); assert.equal(empty.transcriptImport,false); assert.deepEqual(empty.commands,[]);
  const value = sessionCapabilities({capabilities:{interrupt:true,steer:false},runtimeMetadata:{commands:[{name:'review',description:'Review'},{name:'/status'},{name:'bad\ncommand'}, {name:'../run'}]}});
  assert.deepEqual(value.commands.map(command=>command.name),['/review','/status']);
  assert.equal(value.interrupt,true); assert.equal(value.steer,false);
});

test('composer references only list names and edit the existing draft; they never send or read file contents', async () => {
  const f=fixture(); f.node('qaFileQuery').value='src/';
  await f.node('qaFileSearch').click();
  assert.deepEqual(f.requests,['/api/context/files?root=%2Fa&query=src%2F']);
  assert.doesNotMatch(f.node('qaFileResults').innerHTML,/\.\.\/outside|\/absolute|<unsafe>/);
  assert.match(f.node('qaFileResults').innerHTML,/&lt;unsafe&gt;/);
  f.node('qaFileResults').value='0';f.node('qaFileInsert').click();
  assert.match(f.draft.value,/Please review\n\[file reference: "src\/first.mjs"\]/);
  f.node('qaSessionResults').value='0';f.node('qaSessionInsert').click();
  assert.match(f.draft.value,/\[session reference: "codex:worker:thread-a"\]/);
  assert.equal(f.saves,2);assert.equal(f.requests.length,1);
  assert.match(f.node('qaContextNotice').textContent,/nothing was sent or read/);
  assert.match(f.node('qaCapabilitySummary').textContent,/actual-model.*read only/);
  assert.equal(f.node('qaCommandRow').hidden,true);
});

test('late file search from an earlier A-B-A visit cannot replace the current project choices', async () => {
  const f=fixture(); let resolve;
  f.current.api=()=>new Promise(yes=>{resolve=yes;});
  const pending=f.node('qaFileSearch').click();
  f.current.projectRoot='/b';f.tools.render();f.current.projectRoot='/a';f.tools.render();
  resolve({paths:['old-sensitive-name'],truncated:false});await pending;
  assert.equal(f.node('qaFileResults').innerHTML,'');assert.equal(f.node('qaFileInsert').disabled,true);
  assert.equal(f.node('qaContextNotice').textContent,'');assert.equal(f.node('qaFileSearch').disabled,false);
});

test('a stale reference selection cannot be inserted after the selected executor changes', async () => {
  const f=fixture();await f.node('qaFileSearch').click();f.node('qaFileResults').value='0';
  f.current.active='another';f.node('qaFileInsert').click();
  assert.equal(f.saves,0);assert.equal(f.draft.value,'Please review');
  assert.match(f.node('qaContextNotice').textContent,/Session changed/);
});

test('opening a search result previews it without editing or sending the composer draft', async () => {
  const f=fixture(), opened=[]; f.window.hccFiles={open:path=>opened.push(path)};
  assert.equal(f.node('qaFileOpen').disabled,true);
  await f.node('qaFileSearch').click(); f.node('qaFileResults').value='0'; f.node('qaFileOpen').click();
  assert.deepEqual(opened,['src/first.mjs']); assert.equal(f.node('qaFileOpen').disabled,false);
  assert.equal(f.draft.value,'Please review'); assert.equal(f.saves,0); assert.equal(f.requests.length,1);
});

test('a stale search result cannot open against a different project or executor', async () => {
  const f=fixture(), opened=[]; f.window.hccFiles={open:path=>opened.push(path)};
  await f.node('qaFileSearch').click(); f.node('qaFileResults').value='0';
  f.current.projectRoot='/other'; f.node('qaFileOpen').click();
  assert.deepEqual(opened,[]); assert.equal(f.node('qaFileOpen').disabled,true);
  assert.match(f.node('qaContextNotice').textContent,/Session changed/); assert.equal(f.saves,0);
});

test('trace query, turn and event-kind filters combine with AND including failed commands and changed paths', () => {
  const record={kind:'tool',turnId:'t-1',status:'completed',exitCode:2,title:'Run command',text:'missing package',command:'npm test'};
  assert.equal(traceMatches(record,{kind:'failed',turnId:'t-1',query:'npm missing'}),true);
  assert.equal(traceMatches(record,{kind:'failed',turnId:'t-2',query:'npm'}),false);
  assert.equal(traceMatches(record,{kind:'files'}),false);
  assert.equal(traceMatches({kind:'files',turnId:'t-2',changes:[{path:'src/app.mjs',diff:'+new value'}]},{kind:'files',query:'app.mjs new'}),true);
});

test('reported counters preserve zero, reject invalid values, and never infer missing counters or context occupancy', () => {
  assert.equal(reportedMetrics({totalTokens:99}),null);
  const value=reportedMetrics({source:'fixture',scope:'session',inputTokens:0,outputTokens:-1,totalTokens:'99',contextTokens:NaN,durationMs:Infinity});
  assert.deepEqual(value,{source:'fixture',scope:'session',inputTokens:0});
  const f=fixture();renderReportedMetrics({document:f.document,prefix:'qa',state:{metrics:value},text,escape});
  assert.match(f.node('qaMetrics').innerHTML,/<dd>0<\/dd>/);assert.match(f.node('qaMetrics').innerHTML,/Not reported/);
  assert.match(f.node('qaMetricsSource').textContent,/Scope: session/);
  renderReportedMetrics({document:f.document,prefix:'qa',state:{},text,escape});
  assert.match(f.node('qaMetricsSource').textContent,/Unknown is not zero/);
});

test('provider telemetry mappings preserve their actual scope and do not convert total usage into context or invent totals', () => {
  const codex=codexUsage({turnId:'t',tokenUsage:{total:{inputTokens:8,outputTokens:2,cachedInputTokens:0,totalTokens:10},last:{totalTokens:4},modelContextWindow:128000}},123);
  assert.equal(codex.scope,'session');assert.equal(codex.totalTokens,10);assert.equal(codex.contextTokens,undefined);assert.equal(codex.contextWindow,128000);assert.equal(codex.durationMs,undefined);
  const claude=claudeUsage({usage:{input_tokens:12,output_tokens:3,cache_read_input_tokens:2},duration_ms:56},'owned',456);
  assert.equal(claude.scope,'turn');assert.equal(claude.turnId,'owned');assert.equal(claude.totalTokens,undefined);assert.equal(claude.durationMs,56);
  assert.deepEqual(acpUsage({sessionUpdate:'usage_update',used:25,size:64},789),{source:'ACP session/update usage_update',scope:'session',observedAt:789,contextTokens:25,contextWindow:64});
  assert.equal(acpUsage({sessionUpdate:'other',used:25}),null);assert.equal(codexUsage({tokenUsage:{total:{inputTokens:'12'}}}),null);
});
