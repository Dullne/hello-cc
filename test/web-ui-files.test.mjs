import test from 'node:test';
import assert from 'node:assert/strict';
import { installFiles, renderFileMarkdown, staticPreviewCss, staticPreviewNode, staticHtmlPreview } from '../lib/web/ui-files.mjs';

const textNode = textContent => ({ nodeType:3,textContent });
const htmlNode = (localName, attributes = {}, childNodes = [], namespaceURI = 'http://www.w3.org/1999/xhtml') => ({
  nodeType:1, localName, namespaceURI, attributes:Object.entries(attributes).map(([name,value]) => ({name,value})), childNodes,
  textContent:childNodes.map(child => child.textContent || '').join('')
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve,reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };

function fixture({ auxiliary = false, parent } = {}) {
  const nodes = new Map(), requests = [], pending = [], created = [], revoked = [], listeners = new Map();
  function element(tag = 'div') {
    return { tag, value:'', textContent:'', innerHTML:'', children:[], dataset:{}, attributes:{}, listeners:new Map(), hidden:false,
      addEventListener(name, listener) { this.listeners.set(name,listener); },
      setAttribute(name,value) { this.attributes[name]=String(value); },
      removeAttribute(name) { delete this.attributes[name]; if (name === 'href') delete this.href; },
      replaceChildren(...values) { this.children=values; this.textContent=''; this.innerHTML=''; },
      appendChild(value) { this.children.push(value); return value; },
      focus() { this.focused=true; },
      click() { return this.listeners.get('click')?.({target:this}); }
    };
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id,element()); return nodes.get(id); };
  node('filesDialog').hidden=true;
  const bridge = { projectRoot:'/project-a',draftScope:auxiliary ? 'auxiliary' : '',tr:key=>key,
    api(url) { const wait=defer(); requests.push(url); pending.push(wait); return wait.promise; },
    openDialog(dialog) { dialog.hidden=false; },
    closeDialog(dialog) { window.hccFiles.closed(); dialog.hidden=true; }
  };
  const window = { hccHandoff:bridge,addEventListener:(name,listener)=>listeners.set(name,listener) };
  window.parent=parent || window;
  const document = { getElementById:node,createElement:tag=> {
    const value=element(tag);
    if (tag === 'template') value.content={childNodes:[htmlNode('h1',{},[textNode('Safe heading')])]};
    return value;
  } };
  installFiles({window,document,Uint8Array,atob,Blob,URL:{
    createObjectURL(blob) { const url='blob:test-'+created.length; created.push({url,blob}); return url; },
    revokeObjectURL:url=>revoked.push(url)
  }});
  return {node,window,document,bridge,requests,pending,created,revoked,listeners};
}

const preview = (path,kind='text',content='Plain content',extra={}) => ({path,name:path.split('/').at(-1),size:20,kind,mime:'text/plain',encoding:'utf8',content,...extra});
const emptyTree = {path:'',entries:[],truncated:false};

test('Markdown keeps raw markup and fenced code escaped while rendering prose structure', () => {
  const html=renderFileMarkdown('# Title\n\n**Safe** <em>literal</em>\n\n```html\n<img src="local">\n```\n\n- Item');
  assert.match(html,/<h1>Title<\/h1>/); assert.match(html,/<strong>Safe<\/strong>/);
  assert.match(html,/&lt;em&gt;literal&lt;\/em&gt;/); assert.doesNotMatch(html,/<em>|<img/);
  assert.match(html,/<pre><code>&lt;img src=&quot;local&quot;&gt;<\/code><\/pre>/);
  assert.match(html,/<ul><li>Item<\/li><\/ul>/);
  assert.match(renderFileMarkdown('~~~\n<script>\n'),/<pre><code>&lt;script&gt;\n<\/code><\/pre>/);
});

test('static HTML preserves basic styling and ids but omits metadata, active elements and external resources', () => {
  const body=htmlNode('div',{id:'report',class:'card',onclick:'ignored',style:'color: red'},[
    htmlNode('title',{},[textNode('Hidden title')]),
    htmlNode('script',{},[textNode('ignored')]),
    htmlNode('a',{href:'https://example.invalid',target:'_top'},[textNode('Label')]),
    htmlNode('img',{src:'https://example.invalid/image.png',srcset:'other 2x'}),
    htmlNode('img',{src:'data:image/png;base64,AA==',alt:'<preview>'}),
    htmlNode('svg',{},[], 'http://www.w3.org/2000/svg'),
    htmlNode('style',{},[textNode('#report { color: blue; }')])
  ]);
  const html=staticPreviewNode(body);
  assert.match(html,/id="report" class="card" style="color: red"/);
  assert.match(html,/<a>Label<\/a>/); assert.match(html,/<style>#report/);
  assert.match(html,/src="data:image\/png;base64,AA==" alt="&lt;preview&gt;"/);
  assert.doesNotMatch(html,/Hidden title|script|onclick|https:|href|srcset|target|svg/);
  for (const css of ['background:url(a)','@import "a"','image-set("a" 1x)','color: \\72 ed','@font-face{font-family:x}']) assert.equal(staticPreviewCss(css),'');
  assert.equal(staticPreviewCss('/* comment */ p { color:red }'),' p { color:red }');
});

test('static HTML wrapper enforces its own network and script CSP after inert template parsing', () => {
  const f=fixture(); const html=staticHtmlPreview('ignored fixture input',f.document);
  assert.match(html,/Content-Security-Policy/); assert.match(html,/default-src &#39;none&#39;/);
  assert.match(html,/script-src &#39;none&#39;/); assert.match(html,/connect-src &#39;none&#39;/);
  assert.match(html,/form-action &#39;none&#39;/); assert.match(html,/<h1>Safe heading<\/h1>/);
});

test('opening the file browser requires no session and shows empty, error and truncated directory states', async () => {
  const f=fixture(); f.window.hccFiles.open();
  assert.equal(f.node('filesDialog').hidden,false); assert.deepEqual(f.requests,['/api/files/tree?path=']);
  assert.equal(f.node('filesPreview').textContent,'files.select');
  f.pending.shift().resolve(emptyTree); await tick(); assert.equal(f.node('filesTreeStatus').textContent,'files.empty');
  f.node('filesRefresh').click(); f.pending.shift().reject(new Error('Directory changed')); await tick();
  assert.equal(f.node('filesTreeStatus').textContent,'Directory changed');
  f.node('filesRefresh').click(); f.pending.shift().resolve({path:'',entries:[{name:'report',path:'report',type:'directory'}],truncated:true}); await tick();
  assert.equal(f.node('filesTreeStatus').textContent,'files.treeTruncated');
  f.node('filesEntries').children[0].click(); assert.equal(f.requests.at(-1),'/api/files/tree?path=report');
});

test('late files, tree reads and errors cannot repopulate a closed or newer project visit', async () => {
  const f=fixture(); f.window.hccFiles.open('old.txt'); const [oldTree,oldFile]=f.pending.splice(0);
  f.bridge.closeDialog(f.node('filesDialog')); f.bridge.projectRoot='/project-b'; f.window.hccFiles.reset();
  f.bridge.projectRoot='/project-a'; f.window.hccFiles.open('new.txt'); const [newTree,newFile]=f.pending.splice(0);
  newTree.resolve(emptyTree); newFile.resolve(preview('new.txt')); await tick();
  oldTree.resolve({path:'old',entries:[{name:'old',path:'old',type:'file'}]}); oldFile.reject(new Error('Old failure')); await tick();
  assert.equal(f.node('filesName').textContent,'new.txt'); assert.equal(f.node('filesPreviewStatus').textContent,'');
  assert.equal(f.node('filesPath').value,''); assert.equal(f.node('filesEntries').children.length,0);
  f.node('filesReload').click(); const late=f.pending.shift(); f.bridge.closeDialog(f.node('filesDialog'));
  late.resolve(preview('new.txt','text','Late secret')); await tick();
  assert.equal(f.node('filesPreview').children.length,0); assert.equal(f.node('filesName').textContent,'');
});

test('switching files fences the older response and text always uses textContent', async () => {
  const f=fixture(); f.window.hccFiles.open(); f.pending.shift().resolve({path:'',entries:[
    {name:'a',path:'a.txt',type:'file'},{name:'b',path:'b.txt',type:'file'}]}); await tick();
  const [a,b]=f.node('filesEntries').children; a.click(); const old=f.pending.shift(); b.click(); const next=f.pending.shift();
  next.resolve(preview('b.txt','text','<b>plain</b>')); await tick(); old.resolve(preview('a.txt')); await tick();
  assert.equal(f.node('filesName').textContent,'b.txt'); assert.equal(b.attributes['aria-current'],'true');
  assert.equal(a.attributes['aria-current'],'false'); const pre=f.node('filesPreview').children[0];
  assert.equal(pre.tag,'pre'); assert.equal(pre.textContent,'<b>plain</b>'); assert.equal(pre.innerHTML,'');
});

test('HTML uses an empty sandbox, source mode is literal and truncated HTML has no rendered mode', async () => {
  const f=fixture(); f.window.hccFiles.open('report.html'); f.pending.shift().resolve(emptyTree);
  f.pending.shift().resolve(preview('report.html','html','<h1>Source</h1>')); await tick();
  const frame=f.node('filesPreview').children[0]; assert.equal(frame.tag,'iframe'); assert.equal(frame.attributes.sandbox,'');
  assert.match(frame.srcdoc,/Content-Security-Policy/); f.node('filesSourceBtn').click();
  assert.equal(f.node('filesPreview').children[0].textContent,'<h1>Source</h1>');
  f.node('filesReload').click(); f.pending.shift().resolve(preview('report.html','html','<h1>Partial',{truncated:true})); await tick();
  assert.equal(f.node('filesPreview').children[0].tag,'pre'); assert.equal(f.node('filesSourceBtn').hidden,true);
  assert.match(f.node('filesPreviewStatus').textContent,/files.truncated/);
});

test('raster and PDF Blob URLs are revoked on replacement, closure and project reset', async () => {
  const f=fixture(); f.window.hccFiles.open('image.png'); f.pending.shift().resolve(emptyTree);
  f.pending.shift().resolve(preview('image.png','image','AA==',{mime:'image/png',encoding:'base64'})); await tick();
  assert.equal(f.node('filesPreview').children[0].tag,'img'); assert.equal(f.created[0].blob.type,'image/png');
  f.window.hccFiles.open('report.pdf'); assert.deepEqual(f.revoked,['blob:test-0']); f.pending.shift().resolve(emptyTree);
  f.pending.shift().resolve(preview('report.pdf','pdf',Buffer.from('%PDF-1.7\n').toString('base64'),{mime:'application/pdf',encoding:'base64'})); await tick();
  assert.equal(f.created[1].blob.type,'application/pdf'); const frame=f.node('filesPreview').children[0];
  assert.equal(frame.tag,'iframe'); assert.equal(frame.attributes.sandbox,undefined); assert.equal(frame.src,'blob:test-1');
  assert.equal(f.node('filesDownload').href,'blob:test-1'); assert.equal(f.node('filesDownload').hidden,false);
  f.window.hccFiles.reset(); assert.deepEqual(f.revoked,['blob:test-0','blob:test-1']);
  assert.equal(f.node('filesDownload').href,undefined); assert.equal(f.node('filesDialog').hidden,true);
});

test('unsupported media cannot create frames or object URLs', async () => {
  const f=fixture();
  for (const value of [preview('wrong.pdf','pdf','AA==',{mime:'application/pdf',encoding:'base64'}),
    preview('image.svg','image','AA==',{mime:'image/svg+xml',encoding:'base64'}),preview('data.bin','unsupported','')]) {
    f.window.hccFiles.open(value.path); f.pending.shift().resolve(emptyTree); f.pending.shift().resolve(value); await tick();
    assert.equal(f.node('filesPreview').textContent,'files.unsupported'); assert.equal(f.node('filesPreview').children.length,0);
  }
  assert.equal(f.created.length,0);
});

test('auxiliary panes delegate only to the matching parent project and never create nested preview frames', () => {
  const opened=[], parent={hccHandoff:{projectRoot:'/project-a'},hccFiles:{open:path=>opened.push(path)}};
  const f=fixture({auxiliary:true,parent}); f.window.hccFiles.open('report.html');
  assert.deepEqual(opened,['report.html']); assert.equal(f.requests.length,0); assert.equal(f.node('filesDialog').hidden,true);
  parent.hccHandoff.projectRoot='/other'; f.window.hccFiles.open('report.html');
  assert.equal(f.node('filesPreview').textContent,'files.mainWindowRequired'); assert.equal(f.requests.length,0);
  f.node('filesRefresh').click(); f.node('filesReload').click(); assert.equal(f.requests.length,0);
  assert.equal(f.node('filesPreview').children.length,0);
});
