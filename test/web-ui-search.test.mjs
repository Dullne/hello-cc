import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { filterCommands, shortcutAction, commandPaletteScript } from '../lib/web/ui-command-palette.mjs';
import { terminalFindScript } from '../lib/web/ui-terminal-find.mjs';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';
import { webIndexHtml } from '../lib/web/ui-template.mjs';

function element() {
  return {hidden:false,value:'',checked:false,disabled:false,tabIndex:0,scrollTop:0,textContent:'',innerHTML:'',attributes:{},listeners:new Map(),
    setAttribute(key,value) { this.attributes[key]=String(value); }, removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(key,fn) { this.listeners.set(key,fn); }, querySelectorAll() { return []; },getClientRects() { return [{}]; },
    focus() { this.focused=true; }, select() {}, scrollIntoView() {}, contains(node) { return node===this; },
    emit(key,event={}) { return this.listeners.get(key)?.({target:this,preventDefault(){this.prevented=true;},stopPropagation(){},...event}); }};
}
function environment() {
  const elements=new Map(),documentListeners=new Map(),windowListeners=new Map(),timers=new Map();let timerId=0;
  const node=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const window={hccUi:{tr:key=>UI_TRANSLATIONS.en[key]},addEventListener(key,fn){windowListeners.set(key,fn);}};
  const document={documentElement:{},getElementById:node,addEventListener(key,fn){documentListeners.set(key,fn);}};
  const context=vm.createContext({window,document,Promise,getComputedStyle:()=>({getPropertyValue:()=> '#123456'}),
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
  return {node,window,context,documentListeners,windowListeners,flush(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());}};
}
function paletteFixture() {
  const f=environment(),ran=[],errors=[];
  let commands=[{id:'session:project-a:a',label:'Codex <script>alert(1)</script>',detail:'/project/a',group:'Sessions',run(){ran.push('open-a');}},
    {id:'settings',label:'Settings',group:'Pages',run(){ran.push('settings');}},
    {id:'disabled',label:'Terminated executor',group:'Sessions',enabled:false,run(){ran.push('disabled');}}];
  f.node('commandDialog').hidden=true;
  f.window.hccCommandHost={commands:()=>commands,modalOpen:()=>!f.node('commandDialog').hidden,terminalAvailable:()=>true,
    openDialog(dialog,input){dialog.hidden=false;input.focus();},closeDialog(dialog){dialog.hidden=true;ran.push('close');},
    focusSessions(){ran.push('search-sessions');},error:error=>errors.push(error)};
  f.window.hccTerminalFind={open(){ran.push('find');},capturesEscape:()=>false};
  vm.runInContext(commandPaletteScript(),f.context);
  return {...f,ran,errors,setCommands:value=>commands=value};
}
function terminalFixture({cacheOptions=false}={}) {
  const f=environment(),calls=[];let subject='project-a:terminal-a',available=true,listener,index=0;
  let cachedQuery=null,matchCount=3;
  f.node('terminalFind').hidden=true;
  const addon={onDidChangeResults(fn){listener=fn;},clearDecorations(){cachedQuery=null;calls.push({kind:'clear'});},
    findNext(query,options){
      calls.push({kind:'next',query,options});
      if(cacheOptions && cachedQuery!==query)matchCount=options.caseSensitive?(options.wholeWord?1:2):3;
      cachedQuery=query;listener({resultCount:matchCount,resultIndex:index++%matchCount});return true;
    },
    findPrevious(query,options){calls.push({kind:'prev',query,options});listener({resultCount:3,resultIndex:2});return true;}};
  const terminal=element();
  f.window.hccTerminalFindHost={addon,term:{element:terminal,focus(){calls.push({kind:'focus'});}},subject:()=>subject,available:()=>available,showTerminal(){calls.push({kind:'show'});}};
  vm.runInContext(terminalFindScript(),f.context);
  return {...f,calls,terminal,emitResults:listener,changeSubject:value=>subject=value,available:value=>available=value};
}

test('command filtering matches every word across labels, groups, paths and IDs before bounding rendered rows',()=>{
  const commands=Array.from({length:130},(_,id)=>({id:String(id),label:'Codex '+id,detail:'/Projects/UI',group:'Sessions',keywords:'thread-'+id}));
  assert.equal(filterCommands(commands,'CODEX /projects').length,80);
  assert.equal(filterCommands(commands,'thread-129 ui')[0].id,'129');
  assert.deepEqual(filterCommands(commands,'codex absent'),[]);
});

test('shortcuts do not steal ordinary terminal keys, IME input, repeats or other dialogs',()=>{
  const chord={key:'p',ctrlKey:true,shiftKey:true};
  assert.equal(shortcutAction(chord),'palette');
  assert.equal(shortcutAction({...chord,metaKey:true,ctrlKey:false}),'palette');
  for(const key of ['f','k','p'])assert.equal(shortcutAction({key,ctrlKey:true}),null);
  for(const override of [{isComposing:true},{repeat:true},{altKey:true}])assert.equal(shortcutAction({...chord,...override}),null);
  assert.equal(shortcutAction(chord,{modalOpen:true}),null);
  assert.equal(shortcutAction(chord,{modalOpen:true,paletteOpen:true}),'palette');
  assert.equal(shortcutAction({...chord,key:'f'},{terminalAvailable:false}),null);
  assert.equal(shortcutAction({...chord,key:'f'},{terminalAvailable:true}),'terminal-find');
});

test('palette escapes user-controlled labels and opens keyboard selection after closing its modal',()=>{
  const f=paletteFixture();f.window.hccCommandPalette.open();
  assert.match(f.node('commandList').innerHTML,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(f.node('commandList').innerHTML,/<script>/);
  f.node('commandQuery').emit('keydown',{key:'ArrowDown'});
  assert.equal(f.node('commandQuery').attributes['aria-activedescendant'],'commandOption-1');
  f.node('commandQuery').emit('keydown',{key:'Enter'});
  assert.deepEqual(f.ran,['close','settings']);assert.equal(f.node('commandDialog').hidden,true);
});

test('palette re-resolves selection after project changes and never invokes a stale or disabled command',()=>{
  const f=paletteFixture();f.window.hccCommandPalette.open();
  f.setCommands([{id:'session:project-b:a',label:'Different project',group:'Sessions',run(){f.ran.push('wrong-project');}}]);
  f.node('commandQuery').emit('keydown',{key:'Enter'});
  assert.deepEqual(f.ran,[]);assert.equal(f.node('commandDialog').hidden,false);
  assert.equal(f.node('commandHint').textContent,UI_TRANSLATIONS.en['commands.unavailable']);
  f.setCommands([{id:'session:project-b:a',label:'Now unavailable',group:'Sessions',enabled:false,run(){f.ran.push('disabled');}}]);
  f.node('commandQuery').emit('keydown',{key:'Enter'});assert.deepEqual(f.ran,[]);
});

test('palette ignores composition and shortcuts already handled by another listener',()=>{
  const f=paletteFixture();f.window.hccCommandPalette.open();
  f.node('commandQuery').emit('keydown',{key:'Enter',isComposing:true});assert.deepEqual(f.ran,[]);
  f.node('commandDialog').hidden=true;
  f.documentListeners.get('keydown')({key:'l',ctrlKey:true,shiftKey:true,preventDefault(){}});
  assert.deepEqual(f.ran,['search-sessions']);
  f.documentListeners.get('keydown')({key:'p',ctrlKey:true,shiftKey:true,defaultPrevented:true,preventDefault(){throw new Error('Must not handle');}});
  assert.equal(f.node('commandDialog').hidden,true);
});

test('dialog Tab loop excludes palette options that use negative tabindex',()=>{
  const f=environment(),html=webIndexHtml({nonce:'dialog-tab-loop-nonce'});
  const source=html.slice(html.indexOf('[settingsDialog, stopDialog, projectDialog, startDialog'),html.indexOf('    function preserveFocus(root)'));
  const close=f.node('commandClose'),input=f.node('commandQuery'),option=f.node('commandOption-0');option.tabIndex=-1;
  f.node('commandDialog').querySelectorAll=()=>[close,input,option];
  for(const id of ['settingsDialog','stopDialog','projectDialog','startDialog'])f.context[id]=f.node(id);
  f.context.closeDialog=()=>{};vm.runInContext(source,f.context);
  f.context.document.activeElement=input;
  let prevented=false;f.node('commandDialog').emit('keydown',{key:'Tab',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(close.focused,true);assert.equal(option.focused,undefined);
  f.context.document.activeElement=close;
  f.node('commandDialog').emit('keydown',{key:'Tab',shiftKey:true});assert.equal(input.focused,true);
});

test('terminal find debounces literal queries, reports results and passes case/word options without backend writes',()=>{
  const f=terminalFixture();f.window.hccTerminalFind.open();
  const input=f.node('terminalFindQuery');input.value='ready';input.emit('input');input.emit('input');f.flush();
  assert.equal(f.calls.filter(call=>call.kind==='next').length,1);
  const search=f.calls.find(call=>call.kind==='next');assert.equal(search.options.regex,false);assert.equal(search.options.incremental,true);
  assert.equal(f.node('terminalFindResult').textContent,'1 of 3');
  f.node('terminalFindCase').checked=true;f.node('terminalFindCase').emit('change');
  assert.equal(f.calls.at(-1).options.caseSensitive,true);
  f.node('terminalFindWord').checked=true;f.node('terminalFindWord').emit('change');
  assert.equal(f.calls.at(-1).options.wholeWord,true);
  input.emit('keydown',{key:'Enter',shiftKey:true});assert.equal(f.calls.at(-1).kind,'prev');
});

test('terminal find invalidates same-query highlight counts and theme colors when options change',()=>{
  const f=terminalFixture({cacheOptions:true});f.window.hccTerminalFind.open();
  f.node('terminalFindQuery').value='alpha';f.node('terminalFindQuery').emit('input');f.flush();
  assert.match(f.node('terminalFindResult').textContent,/of 3$/);
  f.node('terminalFindCase').checked=true;f.node('terminalFindCase').emit('change');
  assert.match(f.node('terminalFindResult').textContent,/of 2$/);
  assert.deepEqual(f.calls.slice(-2).map(call=>call.kind),['clear','next']);
  f.node('terminalFindWord').checked=true;f.node('terminalFindWord').emit('change');
  assert.equal(f.node('terminalFindResult').textContent,'1 of 1');
  f.windowListeners.get('hcc:preferences')();
  assert.deepEqual(f.calls.slice(-2).map(call=>call.kind),['clear','next']);
});

test('terminal enables the decoration API required by local search highlighting',()=>{
  assert.match(webIndexHtml({nonce:'terminal-search-nonce'}),/allowProposedApi:\s*true/);
});

test('terminal find respects IME, stops pending queries on session changes, and is unavailable for nonterminal views',()=>{
  const f=terminalFixture();f.window.hccTerminalFind.open();const input=f.node('terminalFindQuery');input.value='正在输入';
  input.emit('compositionstart');input.emit('input',{isComposing:true});input.emit('keydown',{key:'Enter',isComposing:true});f.flush();
  assert.equal(f.calls.filter(call=>call.kind==='next').length,0);
  input.emit('compositionend');f.changeSubject('project-b:terminal-a');f.window.hccTerminalFind.sync();f.flush();
  assert.equal(f.calls.filter(call=>call.kind==='next').length,0);assert.equal(input.value,'');assert.equal(f.node('terminalFind').hidden,true);
  f.available(false);f.window.hccTerminalFind.open();assert.equal(f.node('terminalFind').hidden,true);assert.equal(f.node('terminalFindBtn').disabled,true);
});

test('terminal find remains display-only and closes highlights without losing the located viewport',()=>{
  const f=terminalFixture();f.window.hccTerminalFind.open();f.node('terminalFindQuery').value='word';f.node('terminalFindQuery').emit('input');f.flush();
  assert.equal(f.window.hccTerminalFind.capturesEscape({key:'Escape',target:f.terminal}),true);
  assert.equal(f.window.hccTerminalFind.capturesEscape({key:'Escape',target:{}}),false);
  f.emitResults({resultCount:1000,resultIndex:-1});assert.equal(f.node('terminalFindResult').textContent,'1000+ matches; refine your search');
  f.window.hccTerminalFind.close();assert.equal(f.node('terminalFind').hidden,true);assert.equal(f.node('terminalFindBtn').attributes['aria-expanded'],'false');
  assert.deepEqual(f.calls.slice(-2).map(call=>call.kind),['clear','focus']);
});
