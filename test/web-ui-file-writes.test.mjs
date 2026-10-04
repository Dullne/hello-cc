import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {createFileWrites,editableFile} from '../lib/web/ui-file-writes.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const value=(content='original',extra={})=>({path:'note.txt',name:'note.txt',kind:'text',encoding:'utf8',content,size:Buffer.byteLength(content),revision:'r1',editable:true,newline:'none',...extra});
function fixture(storage=new Map()) {
  const nodes=new Map(),requests=[],updates=[],uploads=[],listeners=new Map(),requestListeners=new Set();
  let consent=false;
  const node=id=>{
    if (!nodes.has(id)) nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,files:[],listeners:new Map(),
      addEventListener(name,callback){this.listeners.set(name,callback);},focus(){},emit(name){return this.listeners.get(name)?.({preventDefault(){}});}});
    return nodes.get(id);
  };
  const state={root:'/project',identity:'inode-a',directory:'',path:'note.txt',value:value(),visit:1,hidden:false};
  const bridge={projectRoot:'/project',projectIdentity:'inode-a',draftScope:'',tr:key=>key,
    api(path,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({path,options,resolve,reject});for(const listener of requestListeners) listener();return promise;}};
  const window={hccHandoff:bridge,confirm:()=>consent,addEventListener:(name,listener)=>listeners.set(name,listener),hccUi:{safeGet:key=>storage.get(key),safeSet:(key,value)=>storage.set(key,value)}};
  const writer=createFileWrites({browser:{window,document:{getElementById:node},TextEncoder,Uint8Array,crypto:webcrypto,btoa},
    context:()=>state,updated:next=>{updates.push(next);state.value=next;writer.select();},uploaded:path=>uploads.push(path)});
  writer.select();
  return {node,state,bridge,writer,requests,updates,uploads,listeners,storage,
    onRequest(listener){requestListeners.add(listener);return()=>requestListeners.delete(listener);},
    edit(text){node('filesEdit').emit('click');node('filesEditor').value=text;node('filesEditor').emit('input');},
    select(next){writer.suspend();Object.assign(state,next,{visit:state.visit+1});writer.select();},
    consent(value){consent=value;},
    choose(text,name='upload.txt') {const bytes=Buffer.from(text); node('filesUploadInput').files=[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}];node('filesUploadInput').emit('change');},
    click:id=>node(id).emit('click'),upload:()=>node('filesUploadForm').emit('submit')};
}
async function requestReady(f,index=0) {
  if (f.requests[index]) return f.requests[index];
  // File reads and WebCrypto may span arbitrarily many event-loop turns.
  // Observe the actual API invocation; the timeout only bounds a missing call.
  return new Promise((resolve,reject)=>{
    const unsubscribe=f.onRequest(()=>{
      if (!f.requests[index]) return;
      clearTimeout(timeout);unsubscribe();resolve(f.requests[index]);
    });
    const timeout=setTimeout(()=>{unsubscribe();reject(new Error('API request '+index+' did not start within 5 seconds'));},5000);
  });
}
const saveReceipt=(content,revision='r2')=>({saved:true,path:'note.txt',revision,size:Buffer.byteLength(content),contentHash:hash(content)});

test('only complete bounded UTF-8 text with a revision is editable',()=>{
  assert.equal(editableFile(value()),true);
  for(const extra of [{editable:false},{kind:'image'},{truncated:true},{revision:null},{encoding:'base64'},{size:1024*1024+1}]) assert.equal(editableFile(value('x',extra)),false);
});

test('editing is explicit and a save sends the original revision and content without model calls',async()=>{
  const f=fixture();assert.equal(f.node('filesEdit').hidden,false);assert.equal(f.node('filesEditPanel').hidden,true);
  f.edit('updated');assert.equal(f.node('filesPreview').hidden,true);assert.equal(f.requests.length,0);
  const saving=f.click('filesSave');assert.equal(f.requests[0].path,'/api/files/content?root=%2Fproject');
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{path:'note.txt',revision:'r1',content:'updated'});
  await f.click('filesSave');assert.equal(f.requests.length,1);
  f.requests[0].resolve(saveReceipt('updated'));await saving;
  assert.equal(f.node('filesSave').disabled,true);assert.equal(f.updates[0].content,'updated');assert.equal(f.node('filesEditStatus').textContent,'files.saved');
});

test('save acknowledgements keep edits typed after submission and advance the revision',async()=>{
  const f=fixture();f.edit('submitted');const saving=f.click('filesSave');f.node('filesEditor').value='later draft';f.node('filesEditor').emit('input');
  f.requests[0].resolve(saveReceipt('submitted'));await saving;
  assert.equal(f.node('filesEditor').value,'later draft');assert.equal(f.node('filesSave').disabled,false);assert.equal(f.node('filesEditStatus').textContent,'files.savedWithDraft');
  const next=f.click('filesSave');assert.equal(JSON.parse(f.requests[1].options.body).revision,'r2');f.requests[1].resolve(saveReceipt('later draft','r3'));await next;
});

test('file switching, dialog closure and project switches retain drafts without mixing project identities',()=>{
  const f=fixture();f.edit('unsaved A');f.click('filesCancelEdit');assert.equal(f.node('filesEditPanel').hidden,true);
  f.select({path:'other.txt',value:value('other',{path:'other.txt'})});assert.equal(f.node('filesEditPanel').hidden,true);
  f.select({path:'note.txt',value:value()});f.click('filesEdit');assert.equal(f.node('filesEditor').value,'unsaved A');
  f.select({hidden:true});f.select({hidden:false});assert.equal(f.node('filesEditor').value,'unsaved A');
  f.bridge.projectIdentity='inode-replacement';f.select({identity:'inode-replacement',value:value('new directory file')});
  assert.equal(f.node('filesEditPanel').hidden,true);f.click('filesEdit');assert.equal(f.node('filesEditor').value,'new directory file');
  f.bridge.projectIdentity='inode-a';f.select({identity:'inode-a',value:value()});assert.equal(f.node('filesEditor').value,'unsaved A');
});

test('409 preserves the draft and requires independent readback or explicit discard',async()=>{
  const f=fixture();f.edit('my draft');const saving=f.click('filesSave');f.requests[0].reject(Object.assign(new Error('changed'),{status:409,code:'PROJECT_FILE_CONFLICT'}));await saving;
  assert.equal(f.node('filesEditor').value,'my draft');assert.equal(f.node('filesSave').disabled,true);
  await f.click('filesSave');assert.equal(f.requests.length,1);
  const reading=f.click('filesVerifySave');f.requests[1].resolve(value('external',{revision:'r2'}));await reading;
  assert.equal(f.node('filesEditor').value,'my draft');assert.equal(f.node('filesServerContent').textContent,'external');assert.equal(f.node('filesSave').disabled,true);
  await f.click('filesDiscardEdit');assert.equal(f.requests.length,2);
  f.consent(true);const discarding=f.click('filesDiscardEdit');f.requests[2].resolve(value('external',{revision:'r2'}));await discarding;
  assert.equal(f.node('filesEditPanel').hidden,true);f.click('filesEdit');assert.equal(f.node('filesEditor').value,'external');
});

test('an uncertain save can only read back until matching saved content is confirmed',async()=>{
  const f=fixture();f.edit('submitted');const saving=f.click('filesSave');f.requests[0].reject(Object.assign(new Error('timeout'),{code:'REQUEST_TIMEOUT'}));await saving;
  assert.equal(f.node('filesSave').disabled,true);assert.equal(f.node('filesEditStatus').textContent,'files.saveUncertain timeout');
  f.node('filesEditor').value='new edits';f.node('filesEditor').emit('input');await f.click('filesSave');assert.equal(f.requests.length,1);
  const reading=f.click('filesVerifySave');assert.equal(f.requests[1].options,undefined);f.requests[1].resolve(value('submitted',{revision:'r2'}));await reading;
  assert.equal(f.node('filesEditor').value,'new edits');assert.equal(f.node('filesSave').disabled,false);assert.equal(f.node('filesEditStatus').textContent,'files.savedWithDraft');
});

test('late save receipts and explicit discard reads cannot replace a newer file visit',async()=>{
  const f=fixture();f.edit('submitted');const saving=f.click('filesSave');f.select({path:'other.txt',value:value('other',{path:'other.txt'})});
  f.requests[0].resolve(saveReceipt('submitted'));await saving;assert.equal(f.updates.length,0);assert.equal(f.state.path,'other.txt');
  f.select({path:'note.txt',value:value('submitted',{revision:'r2'})});f.edit('retained');f.consent(true);const discarding=f.click('filesDiscardEdit');
  f.select({path:'other.txt',value:value('other',{path:'other.txt'})});f.requests[1].resolve(value('external',{revision:'r3'}));await discarding;
  assert.equal(f.updates.length,0);f.select({path:'note.txt',value:value('submitted',{revision:'r2'})});assert.equal(f.node('filesEditor').value,'retained');
});

test('CRLF and BOM survive explicit edits, and unedited normalized text cannot be saved',async()=>{
  const f=fixture();f.select({value:value('\ufeffone\r\ntwo\r\n',{newline:'crlf',bom:true})});f.click('filesEdit');
  assert.equal(f.node('filesEditor').value,'\ufeffone\ntwo\n');assert.equal(f.node('filesSave').disabled,true);await f.click('filesSave');assert.equal(f.requests.length,0);
  f.node('filesEditor').value+='three\n';f.node('filesEditor').emit('input');const saving=f.click('filesSave');
  assert.equal(JSON.parse(f.requests[0].options.body).content,'\ufeffone\r\ntwo\r\nthree\r\n');f.requests[0].resolve(saveReceipt('\ufeffone\r\ntwo\r\nthree\r\n'));await saving;
  assert.equal(f.node('filesSave').disabled,true);
});

test('mixed line endings and UTF-8 edit limits are explicit, and page departure warns for drafts',async()=>{
  const f=fixture();f.select({value:value('a\r\nb\n',{newline:'mixed'})});f.click('filesEdit');assert.match(f.node('filesEditStatus').textContent,/files.mixedNewlines/);
  f.node('filesEditor').value='中'.repeat(350000);f.node('filesEditor').emit('input');await f.click('filesSave');assert.equal(f.requests.length,0);assert.match(f.node('filesEditStatus').textContent,/files.textTooLarge/);
  let prevented=false;f.listeners.get('beforeunload')({preventDefault(){prevented=true;}});assert.equal(prevented,true);
});

test('upload preserves the filename and exact bytes then selects the successfully created path',async()=>{
  const f=fixture();f.select({directory:'artifacts'});f.choose('binary\u0000data','report.bin');assert.equal(f.node('filesUploadName').value,'report.bin');
  const uploading=f.upload(), request=await requestReady(f);assert.equal(request.path,'/api/files/upload?root=%2Fproject');
  assert.deepEqual(JSON.parse(request.options.body),{path:'artifacts/report.bin',encoding:'base64',content:Buffer.from('binary\u0000data').toString('base64')});
  request.resolve({created:true,path:'artifacts/report.bin',size:11,contentHash:hash('binary\u0000data')});await uploading;
  assert.deepEqual(f.uploads,['artifacts/report.bin']);assert.equal(f.node('filesUploadStatus').textContent,'files.uploaded');
});

test('uploads reject path names and excessive size locally, and existing targets never trigger overwrite',async()=>{
  const f=fixture();f.choose('text');f.node('filesUploadName').value='../outside';f.node('filesUploadName').emit('input');await f.upload();assert.equal(f.requests.length,0);
  f.choose('text');f.node('filesUploadInput').files=[{name:'huge.bin',size:10*1024*1024+1}];f.node('filesUploadInput').emit('change');await f.upload();assert.equal(f.requests.length,0);
  f.choose('text');const uploading=f.upload();const request=await requestReady(f);request.reject(Object.assign(new Error('exists'),{status:409}));await uploading;
  assert.match(f.node('filesUploadStatus').textContent,/files.uploadExists/);assert.equal(f.uploads.length,0);assert.equal(f.requests.length,1);
});

test('an unknown upload result is recovered after reload with a content hash read, never another POST',async()=>{
  const storage=new Map(), f=fixture(storage);f.choose('content','kept.txt');const uploading=f.upload();const request=await requestReady(f);
  request.reject(Object.assign(new Error('lost'),{code:'REQUEST_TIMEOUT'}));await uploading;assert.equal(f.node('filesUploadBtn').disabled,true);
  const reloaded=fixture(storage);assert.equal(reloaded.node('filesUploadCheck').hidden,false);assert.equal(reloaded.node('filesUploadName').value,'kept.txt');
  await reloaded.upload();assert.equal(reloaded.requests.length,0);const checking=reloaded.click('filesUploadCheck');
  assert.equal(reloaded.requests[0].path,'/api/files/status?path=kept.txt&root=%2Fproject');assert.equal(reloaded.requests[0].options,undefined);
  reloaded.requests[0].resolve({path:'kept.txt',size:7,contentHash:hash('content')});await checking;
  assert.equal(reloaded.node('filesUploadStatus').textContent,'files.uploadVerified');assert.deepEqual(reloaded.uploads,['kept.txt']);
});

test('upload verification distinguishes mismatched content from missing files before allowing a new attempt',async()=>{
  const f=fixture();f.choose('content','same.txt');const uploading=f.upload();const request=await requestReady(f);request.reject(new Error('lost'));await uploading;
  const checking=f.click('filesUploadCheck');f.requests[1].resolve({path:'same.txt',size:7,contentHash:hash('different')});await checking;
  assert.equal(f.uploads.length,0);assert.equal(f.node('filesUploadBtn').disabled,true);assert.equal(f.node('filesUploadName').disabled,false);
  await f.upload();assert.equal(f.requests.length,2);f.node('filesUploadName').value='other.txt';f.node('filesUploadName').emit('input');assert.equal(f.node('filesUploadBtn').disabled,false);
  const retry=f.upload();const next=await requestReady(f,2);next.reject(new Error('lost too'));await retry;
  const checkAbsent=f.click('filesUploadCheck');f.requests[3].reject(Object.assign(new Error('missing'),{status:404}));await checkAbsent;
  assert.equal(f.node('filesUploadBtn').disabled,false);assert.equal(f.requests.length,4);assert.match(f.node('filesUploadStatus').textContent,/files.uploadAbsent/);
});

test('late upload acknowledgements and preflight reads stay bound to their original visit and directory',async()=>{
  const f=fixture();f.choose('one');const uploading=f.upload(), request=await requestReady(f);f.select({directory:'other'});
  f.choose('other selection','other.txt');request.resolve({created:true,path:'upload.txt',size:3,contentHash:hash('one')});await uploading;
  assert.equal(f.uploads.length,0);assert.equal(f.node('filesUploadName').value,'other.txt');assert.equal(f.node('filesUploadInput').files[0].name,'other.txt');
  const pending=fixture();let resolve;pending.node('filesUploadInput').files=[{name:'late.txt',size:1,arrayBuffer:()=>new Promise(yes=>{resolve=yes;})}];pending.node('filesUploadInput').emit('change');
  const reading=pending.upload();pending.select({hidden:true});resolve(new Uint8Array([1]).buffer);await reading;assert.equal(pending.requests.length,0);
});

test('upload recoveries and text drafts cannot be applied after same-path project identity replacement',async()=>{
  const f=fixture();f.choose('same');const uploading=f.upload();const request=await requestReady(f);request.reject(new Error('lost'));await uploading;
  f.bridge.projectIdentity='replacement';f.select({identity:'replacement'});assert.equal(f.node('filesUploadCheck').hidden,true);assert.equal(f.node('filesUploadName').value,'');
  f.edit('replacement draft');f.bridge.projectIdentity='inode-a';await f.click('filesSave');assert.equal(f.requests.length,1);
});

test('auxiliary pane mutation controls never issue writes',async()=>{
  const f=fixture();f.bridge.draftScope='auxiliary';f.writer.sync();f.edit('no write');f.choose('no upload');await f.click('filesSave');await f.upload();
  assert.equal(f.requests.length,0);assert.equal(f.node('filesUploadPanel').hidden,true);assert.equal(f.node('filesEdit').hidden,true);
});

test('discard confirmation freezes the textarea and never deletes edits made after confirmation',async()=>{
  const f=fixture();f.edit('original draft');f.consent(true);const discarding=f.click('filesDiscardEdit');assert.equal(f.node('filesEditor').disabled,true);
  f.node('filesEditor').value='newer draft';f.node('filesEditor').emit('input');f.requests[0].resolve(value('remote',{revision:'r2'}));await discarding;
  assert.equal(f.node('filesEditor').value,'newer draft');assert.equal(f.node('filesEditor').disabled,false);assert.equal(f.updates.length,0);
  assert.equal(f.node('filesEditStatus').textContent,'files.discardChanged');
});
