import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountState } from '../lib/integrations/codex-account.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const chatgpt = { account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test', accessToken: 'secret-token' }, requiresOpenaiAuth: true };
const quota = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
  secondary: { usedPercent: 0, windowDurationMins: 10080 }, planType: 'plus', credits: { hasCredits: true, unlimited: false, balance: 'private-balance' } } };
function fixture(handler = method => method === 'account/read' ? chatgpt : quota) {
  const calls = [], changes = [];
  const account = createCodexAccountState({ request: async (method, params) => { calls.push({ method, params }); return handler(method, params); },
    now: () => 123456, onChange: state => changes.push(state) });
  return { account, calls, changes };
}
function privateDataAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const needle of ['private@example.test', 'secret-token', 'private-balance', 'accessToken', 'userCode', 'loginId', 'raw-secret-error']) assert.ok(!serialized.includes(needle), needle);
}

test('account refresh is single-flight, read-only, and projects only public status fields', async () => {
  const f = fixture();
  const [a,b] = await Promise.all([f.account.refresh(),f.account.refresh()]);
  assert.deepEqual(a,b);
  assert.deepEqual(f.calls, [{ method: 'account/read', params: { refreshToken: false } }, { method: 'account/rateLimits/read', params: {} }]);
  assert.equal(a.authentication, 'authenticated'); assert.equal(a.type,'chatgpt'); assert.equal(a.planType,'plus');
  assert.equal(a.rateLimits.buckets[0].secondary.usedPercent,0);
  assert.equal(a.rateLimits.buckets[0].secondary.resetsAt,null);
  privateDataAbsent([a,f.changes]);
});

test('custom-provider, API key, Bedrock and missing login states never claim a subscription quota', async () => {
  for (const [value,expected] of [
    [{ account: null, requiresOpenaiAuth: false },'providerManaged'],
    [{ account: { type:'apiKey' }, requiresOpenaiAuth: true },'authenticated'],
    [{ account: { type:'amazonBedrock' }, requiresOpenaiAuth: false },'providerManaged'],
    [{ account: null, requiresOpenaiAuth: true },'required'],
    [{ account: chatgpt.account, requiresOpenaiAuth: false },'providerManaged']]) {
    const f = fixture(() => value), result = await f.account.refresh();
    assert.equal(result.authentication, expected);
    assert.equal(result.rateLimits.status,'notApplicable'); assert.deepEqual(result.rateLimits.buckets,[]);
    assert.equal(f.calls.length,1);
  }
});

test('multi-bucket quotas retain window identity and bounded data, rather than summing independent limits', async () => {
  const f = fixture(method => method === 'account/read' ? chatgpt : { ...quota, rateLimitsByLimitId: {
    codex: quota.rateLimits, review: { primary: { usedPercent: 100 }, accessToken: 'secret-token' }, broken: { primary: { usedPercent: '0' } } } });
  const result = await f.account.refresh();
  assert.deepEqual(result.rateLimits.buckets.map(b=>b.id),['codex','review']);
  assert.equal(result.rateLimits.buckets[1].secondary,null); privateDataAbsent(result);
});

test('quota unsupported or failed does not turn a successful account read into sign-out or zero usage', async () => {
  for (const code of [{ extra: { rpcCode:-32601 } }, { extra:{ rpc_code:-32601 } }, {}]) {
    const f = fixture(method => { if(method==='account/read') return chatgpt; throw Object.assign(new Error('raw-secret-error'),code); });
    const result = await f.account.refresh();
    assert.equal(result.status,'ready'); assert.equal(result.authentication,'authenticated');
    assert.equal(result.rateLimits.status,'unavailable'); assert.deepEqual(result.rateLimits.buckets,[]);
    assert.equal(result.rateLimits.reason, Object.keys(code).length ? 'unsupported' : 'unavailable'); privateDataAbsent([result,f.changes]);
  }
});

test('malformed account data is unknown rather than provider-managed or signed out', async () => {
  for (const value of [{}, { requiresOpenaiAuth:'false' }, { requiresOpenaiAuth:true, account:{ type:'newSecretType' } }]) {
    const f = fixture(()=>value), result = await f.account.refresh();
    assert.equal(result.status,'unavailable'); assert.equal(result.authentication,'unknown'); assert.equal(f.calls.length,1);
  }
});

test('refresh failure marks previously read data stale without publishing raw account errors', async () => {
  let fail = false;
  const f = fixture(method => { if(fail) throw new Error('raw-secret-error'); return method==='account/read'?chatgpt:quota; });
  await f.account.refresh(); fail=true;
  const result = await f.account.refresh();
  assert.equal(result.status,'unavailable'); assert.equal(result.stale,true); assert.equal(result.authentication,'unknown');
  assert.equal(result.rateLimits.stale,true); assert.equal(result.rateLimits.buckets[0].primary.usedPercent,25);
  privateDataAbsent([result,f.changes]);
});

test('rolling quota updates merge only their own bucket and preserve nullable metadata', async () => {
  const f = fixture(); await f.account.refresh();
  assert.equal(f.account.notification('account/rateLimits/updated', { rateLimits:{ limitId:'codex', planType:null,
    primary:{ usedPercent:50 }, secondary:null, credits:null, email:'private@example.test' } }),true);
  const value=f.account.snapshot().rateLimits.buckets[0];
  assert.equal(value.primary.usedPercent,50); assert.equal(value.secondary.usedPercent,0); assert.equal(value.planType,'plus');
  assert.equal(value.credits.hasCredits,true); privateDataAbsent(f.changes);
  assert.equal(f.account.notification('other',{}),false);
});

test('a rolling update arriving during quota fetch cannot be overwritten by its older reply', async () => {
  let finish, reads=0;
  const f=fixture(method=>method==='account/read'?chatgpt:(++reads===1?quota:new Promise(resolve=>{finish=resolve;})));
  await f.account.refresh(); const refresh=f.account.refresh(); await tick();
  f.account.notification('account/rateLimits/updated',{rateLimits:{limitId:'codex',primary:{usedPercent:90}}});
  finish(quota); await refresh;
  assert.equal(f.account.snapshot().rateLimits.buckets[0].primary.usedPercent,90);
});

test('account changes invalidate old quotas and late reads, then reread current executor account', async () => {
  let finish, reads=0;
  const f=fixture(method=>method==='account/read'?(++reads===1?new Promise(resolve=>{finish=resolve;}):{account:null,requiresOpenaiAuth:true}):quota);
  const refresh=f.account.refresh(); await tick();
  f.account.notification('account/updated',{authMode:'chatgpt',planType:'plus',email:'private@example.test',accessToken:'secret-token'});
  finish(chatgpt); await refresh; await tick();
  const result=f.account.snapshot(); assert.equal(result.authentication,'required'); assert.deepEqual(result.rateLimits.buckets,[]);
  assert.equal(f.calls.filter(c=>c.method==='account/rateLimits/read').length,0); privateDataAbsent(f.changes);
});

test('opening or completing login elsewhere never proves login from success flag alone', async () => {
  const f=fixture(()=>({ account:null,requiresOpenaiAuth:true }));
  f.account.notification('account/login/completed',{success:true,loginId:'secret-token',error:'raw-secret-error',userCode:'secret-token'});
  await tick();
  assert.equal(f.account.snapshot().authentication,'required'); privateDataAbsent(f.changes);
  assert.deepEqual(f.calls.map(c=>c.method),['account/read']);
});

test('a disconnected executor cannot be resurrected by a late account response', async () => {
  let finish;
  const f=fixture(()=>new Promise(resolve=>{finish=resolve;})); const refresh=f.account.refresh(); await tick();
  f.account.close(); finish(chatgpt); await refresh;
  assert.equal(f.account.snapshot().reason,'disconnected'); assert.equal(f.account.snapshot().authentication,'unknown');
  await f.account.refresh(); assert.equal(f.calls.length,1);
});
