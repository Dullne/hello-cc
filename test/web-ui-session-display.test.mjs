import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webIndexHtml } from '../lib/web/ui-template.mjs';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';

// Exercise the same inline renderer the browser receives, without booting a
// terminal/runtime or reaching the user's project registry.
const shippedSource = [...webIndexHtml({ nonce:'session-display-test-nonce' }).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('function renderSections()'));
function shippedFunction(name) {
  const start = shippedSource.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, 'Shipped UI must provide ' + name);
  const end = shippedSource.indexOf('\n    }', start);
  assert.ok(end > start, 'Shipped function must close: ' + name);
  return shippedSource.slice(start, end + 6);
}
function fixture() {
  const elements = new Map(), opened = [];
  function node(dataset = {}) {
    return { dataset, listeners:new Map(), open:false, scrollTop:17,
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() {}, getAttribute() { return null; } };
  }
  const box = { ...node(), cards:[], details:[], querySelectorAll(selector) {
    if (selector === 'details[open]') return this.details.filter(detail => detail.open);
    if (selector === 'details') return this.details;
    if (selector.startsWith('.session[data-type=')) {
      const type = /"(managed|detected)"/.exec(selector)[1];
      return this.cards.filter(card => card.dataset.type === type);
    }
    return [];
  }, contains() { return false; } };
  Object.defineProperty(box,'innerHTML',{get() { return this.html || ''; },set(html) {
    this.html=html;
    this.cards=[...html.matchAll(/<div class="session[^>]*data-id="([^"]+)" data-type="([^"]+)"/g)]
      .map(match=>node({id:match[1],type:match[2]}));
    this.details=[...html.matchAll(/<details class="session-details" data-detail-key="([^"]+)"/g)]
      .map(match=>node({detailKey:match[1]}));
  }});
  elements.set('sessions',box);
  const state = { active:'managed-a',activeDetected:null,activeType:'managed',sessionSearchQuery:'',sessionStatusFilter:'all',sessionKindFilter:'all',showStaleDetected:true,
    lastStateNow:100,activePeerTtl:30,lang:'en',
    sessions:[{id:'managed-a',peer_id:'peer-a',kind:'codex',status:'running',type:'tmux',cwd:'/project <qa>/src',command:'codex --resume "thread-qa" <untrusted>',task:{title:'Continue local work'},binding:{provider:'codex',provider_session_id:'thread-qa',runtime_target:'pane:%42'}}],
    detected:[{id:'detected-a',kind:'claude',status:'idle',age_sec:2,worktree:'/detected <qa>',command:'claude <untrusted>'},
      {id:'stale-b',kind:'codex',status:'running',age_sec:60,cwd:'/stale'},{id:'dsh-c',kind:'dsh',provider:'dsh',transport:'hook',status:'idle',age_sec:2,cwd:'/dsh'}]
  };
  const context = vm.createContext({...state, window:{},
    document:{activeElement:null,getElementById(id) { if(!elements.has(id))elements.set(id,node());return elements.get(id); }},
    tr:(key,fallback='')=>UI_TRANSLATIONS.en[key]||fallback||key,
    hccUi:{safeSet(){}},preserveFocus:()=>()=>{},kindMatches:()=>true,
    connectManaged:id=>opened.push({type:'managed',id}),connectDetected:id=>opened.push({type:'detected',id})
  });
  const functions=['esc','badgeClass','fmtAge','sessionPeerId','sessionBinding','sessionRuntimeTarget','sessionProvider','sessionProviderSessionValue','statusText',
    'peerIsActive','dshCoordinationPeer','detectedPeerCanStop','peerStateView','sessionMatchesSearch','sessionDetailsHtml','renderSections'];
  vm.runInContext(functions.map(shippedFunction).join('\n'),context);
  const render=()=>vm.runInContext('renderSections()',context);
  render();
  return {box,context,opened,render};
}

test('managed disclosure renders runtime, provider history, command and directory while the title stays readable',()=>{
  const f=fixture();
  assert.match(f.box.innerHTML,/<strong>Continue local work<\/strong>/);
  assert.match(f.box.innerHTML,/<dt>runtime<\/dt><dd>pane:%42<\/dd>/i);
  assert.match(f.box.innerHTML,/<dt>provider session<\/dt><dd>codex:thread-qa<\/dd>/i);
  assert.match(f.box.innerHTML,/<dt>command<\/dt><dd>codex --resume &quot;thread-qa&quot; &lt;untrusted&gt;<\/dd>/i);
  assert.match(f.box.innerHTML,/<dt>cwd<\/dt><dd>\/project &lt;qa&gt;\/src<\/dd>/);
  assert.doesNotMatch(f.box.innerHTML,/<untrusted>|<qa>/);
});

test('unknown provider history remains explicit instead of presenting a runtime ID as provider history',()=>{
  const f=fixture();f.context.sessions[0].binding={provider:'codex',runtime_target:'pane:%42'};f.render();
  assert.match(f.box.innerHTML,/<dt>provider session<\/dt><dd>codex:unknown<\/dd>/i);
  assert.doesNotMatch(f.box.innerHTML,/provider session<\/dt><dd>codex:managed-a/i);
});

test('opening session details and local action controls never selects another executor',()=>{
  const f=fixture();
  for(const card of f.box.cards){
    const click=card.listeners.get('click');
    for(const subject of ['details','[data-action]'])click({target:{closest(selector){assert.ok(selector.includes(subject));return {};}}});
  }
  assert.deepEqual(f.opened,[]);
  for(const card of f.box.cards)card.listeners.get('click')({target:{closest(){return null;}}});
  assert.deepEqual(f.opened,f.box.cards.map(card=>({type:card.dataset.type,id:card.dataset.id})));
});

test('detected actions follow peer liveness and respect the dsh hook boundary',()=>{
  const f=fixture();
  assert.match(f.box.innerHTML,/data-action="stop-detected" data-id="detected-a"/);
  assert.match(f.box.innerHTML,/data-action="restart-detected" data-id="stale-b"/);
  assert.doesNotMatch(f.box.innerHTML,/data-action="(?:stop|restart)-detected" data-id="dsh-c"/);
});

test('polling preserves expanded identity disclosures and the session list reading position',()=>{
  const f=fixture();f.box.details.find(detail=>detail.dataset.detailKey==='managed:managed-a').open=true;f.box.scrollTop=89;f.render();
  assert.equal(f.box.details.find(detail=>detail.dataset.detailKey==='managed:managed-a').open,true);
  assert.equal(f.box.scrollTop,89);
});
