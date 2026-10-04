export const fileWritesCss = `
  .files-upload { border:1px solid var(--border); border-radius:8px; padding:8px; }
  .files-upload form { display:grid; gap:6px; padding-top:8px; }
  .files-upload input { width:100%; min-width:0; }
  .files-upload input[type=file] { height:auto; font-size:var(--small-font); }
  .files-editor { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; }
  .files-editor textarea { flex:1; min-height:150px; width:100%; resize:vertical; background:var(--input-bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px; font:var(--small-font)/1.6 var(--mono); }
  .files-write-status { margin:0; overflow-wrap:anywhere; font-size:var(--small-font); color:var(--muted); }
  .files-server-copy { overflow:auto; max-height:160px; }
  .files-server-copy pre { white-space:pre-wrap; overflow-wrap:anywhere; }
`;
export function fileUploadHtml() {
  return `<details class="files-upload" id="filesUploadPanel"><summary data-i18n="files.upload">Upload file</summary><form id="filesUploadForm">
    <input id="filesUploadInput" type="file" data-i18n-aria="files.chooseUpload" aria-label="Choose one file to upload">
    <label><span data-i18n="files.uploadName">Target file name</span><input id="filesUploadName" type="text" autocomplete="off" maxlength="255"></label>
    <p id="filesUploadTarget" class="files-write-status"></p><p class="files-write-status" data-i18n="files.uploadHelp">One file, up to 10 MiB. Existing files will not be replaced.</p>
    <div class="files-toolbar"><button id="filesUploadBtn" type="submit" data-i18n="files.upload">Upload file</button><button id="filesUploadCheck" type="button" data-i18n="files.checkUpload" hidden>Check target file</button></div>
    <p id="filesUploadStatus" class="files-write-status" role="status" aria-live="polite"></p></form></details>`;
}
export function fileEditorHtml() {
  return `<div class="files-toolbar"><button id="filesEdit" type="button" data-i18n="files.edit" hidden>Edit text</button></div>
    <div id="filesEditPanel" class="files-editor" hidden><p class="files-write-status" data-i18n="files.draftHelp">Drafts stay in this page when you switch files or close this window. Reloading the page can discard them.</p>
      <textarea id="filesEditor" spellcheck="false" data-i18n-aria="files.editText" aria-label="File text"></textarea>
      <div class="files-toolbar"><button id="filesSave" type="button" data-i18n="files.save">Save file</button><button id="filesCancelEdit" type="button" data-i18n="files.keepDraft">Back to preview</button><button id="filesVerifySave" type="button" data-i18n="files.verifySave" hidden>Read saved file</button><button id="filesDiscardEdit" type="button" data-i18n="files.discardEdit">Discard draft and reload</button></div>
      <p id="filesEditStatus" class="files-write-status" role="status" aria-live="polite"></p><details id="filesServerCopy" class="files-server-copy" hidden><summary data-i18n="files.serverCopy">Current saved content</summary><pre id="filesServerContent"></pre></details>
    </div>`;
}
export function editableFile(value) {
  return Boolean(value && value.editable !== false && ['text','markdown','html'].includes(value.kind) && value.encoding === 'utf8' && !value.truncated
    && typeof value.revision === 'string' && value.revision && typeof value.content === 'string' && value.size <= 1024*1024);
}

export function createFileWrites({browser=globalThis,context,updated,uploaded}) {
  const {window,document}=browser, bridge=window.hccHandoff, node=id=>document.getElementById(id), tr=key=>bridge.tr(key);
  const drafts=new Map(), uploads=new Map(); let active=null, upload=null;
  const key=(root,path,identity='')=>JSON.stringify([root,identity,path]);
  const route=(path,root)=>path+(path.includes('?') ? '&' : '?')+'root='+encodeURIComponent(root);
  const writable=()=>bridge.draftScope!=='auxiliary';
  const bound=now=>!now.hidden && now.root===bridge.projectRoot && (now.identity || '')===(bridge.projectIdentity || '');
  const visible=target=>{ const now=context(); return bound(now) && now.root===target.root && now.identity===target.identity && now.path===target.path; };
  const uploadVisible=target=>{ const now=context(); return bound(now) && now.root===target.root && now.identity===target.identity && now.directory===target.directory; };
  const sameVisit=visit=>{const now=context();return bound(now) && now.root===visit.root && now.identity===visit.identity && now.visit===visit.visit && now.path===visit.path;};
  const editorText=value=>value.replace(/\r\n?/g,'\n');
  const utf8=value=>new browser.TextEncoder().encode(value);
  const hash=async bytes=>Array.from(new browser.Uint8Array(await browser.crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  const uncertain=error=>!error.status || error.status>=500 || ['REQUEST_TIMEOUT','REQUEST_SUPERSEDED','FILE_WRITE_UNCONFIRMED'].includes(error.code);
  function saveUploadRecovery(target) {
    const value=target.uncertain ? {path:target.path,name:target.name,size:target.size,hash:target.hash,uncertain:true} : null;
    window.hccUi?.safeSet('hcc.fileUpload:'+key(target.root,target.directory,target.identity),JSON.stringify(value));
  }
  function uploadFor(root,directory,identity) {
    const storageKey=key(root,directory,identity);
    if (!uploads.has(storageKey)) {
      const target={root,directory,identity,file:null,name:'',status:'',error:'',busy:false,uncertain:false};
      try {
        const saved=JSON.parse(window.hccUi?.safeGet('hcc.fileUpload:'+storageKey)||'null');
        if (saved?.uncertain && typeof saved.path==='string' && typeof saved.hash==='string' && /^[a-f0-9]{64}$/.test(saved.hash) && Number.isSafeInteger(saved.size)) Object.assign(target,saved,{status:'files.uploadUncertain'});
      } catch {}
      uploads.set(storageKey,target);
    }
    return uploads.get(storageKey);
  }
  function editorRender() {
    const now=context(), candidate=now.value, target=active;
    const eligible=writable() && (editableFile(candidate) || Boolean(target));
    node('filesEdit').hidden=!eligible || Boolean(target?.editing);
    node('filesEdit').textContent=tr(target?.content!==target?.base ? 'files.resumeDraft' : 'files.edit');
    const editing=Boolean(target?.editing && visible(target));
    node('filesEditPanel').hidden=!editing; node('filesPreview').hidden=editing;
    if (!editing) return;
    if (node('filesEditor').value!==target.content) node('filesEditor').value=target.content;
    node('filesEditor').disabled=Boolean(target.discarding);
    node('filesSave').disabled=target.busy || target.checking || target.conflict || target.uncertain || target.content===target.base;
    node('filesDiscardEdit').disabled=target.busy || target.checking;
    node('filesVerifySave').hidden=!target.conflict && !target.uncertain;
    node('filesVerifySave').disabled=target.busy || target.checking;
    node('filesEditStatus').textContent=tr(target.status || (target.content===target.base ? 'files.editReady' : 'files.unsaved'))
      +(target.newline==='mixed' ? ' '+tr('files.mixedNewlines') : '')+(target.error ? ' '+target.error : '');
    node('filesServerCopy').hidden=!target.latest;
    node('filesServerContent').textContent=target.latest?.content || '';
  }
  function uploadRender() {
    const now=context();
    node('filesUploadPanel').hidden=!writable();
    if (!writable() || !now.root) return;
    const next=uploadFor(now.root,now.directory,now.identity);
    if (upload!==next) { upload=next; node('filesUploadInput').value=''; }
    node('filesUploadName').value=upload.name;
    const locked=upload.busy || upload.uncertain;
    node('filesUploadInput').disabled=locked; node('filesUploadName').disabled=locked;
    node('filesUploadBtn').disabled=locked || !upload.file || !upload.name || upload.blockedName===upload.name;
    node('filesUploadCheck').hidden=!upload.uncertain; node('filesUploadCheck').disabled=upload.busy;
    const path=upload.path && locked ? upload.path : [now.directory,upload.name].filter(Boolean).join('/');
    node('filesUploadTarget').textContent=path ? tr('files.uploadTarget')+' '+path : '';
    node('filesUploadStatus').textContent=(upload.status ? tr(upload.status) : '')+(upload.error ? ' '+upload.error : '');
  }
  function sync() { editorRender(); uploadRender(); }
  function select() {
    const now=context(); active=drafts.get(key(now.root,now.path,now.identity)) || null;
    if (active && now.value && !active.busy && !active.uncertain && now.value.revision!==active.revision) {
      if (active.content===active.base && editableFile(now.value)) {
        active.content=editorText(now.value.content); active.base=active.content; active.revision=now.value.revision; active.newline=now.value.newline;
      } else { active.conflict=true; active.status='files.editConflict'; }
    }
    sync();
  }
  function suspend() { active=null; node('filesEditPanel').hidden=true; node('filesEdit').hidden=true; node('filesPreview').hidden=false; }
  function begin() {
    const now=context(); if (!writable() || !bound(now)) return;
    if (!active) {
      if (!editableFile(now.value)) return;
      active={root:now.root,identity:now.identity,path:now.path,revision:now.value.revision,base:editorText(now.value.content),content:editorText(now.value.content),newline:now.value.newline,status:'',error:'',editing:true,busy:false,conflict:false,uncertain:false};
      drafts.set(key(now.root,now.path,now.identity),active);
    }
    active.editing=true; editorRender(); node('filesEditor').focus();
  }
  async function save() {
    const target=active, visit={...context()};
    if (!writable() || !target || !visible(target) || target.busy || target.checking || target.conflict || target.uncertain || target.content===target.base) return;
    const submittedEditor=target.content, content=target.newline==='crlf' ? target.content.replace(/\n/g,'\r\n') : target.content;
    if (utf8(content).length>1024*1024) { target.status='files.textTooLarge'; editorRender(); return; }
    target.submitted=content; target.busy=true; target.status='files.saving'; target.error=''; editorRender();
    try {
      const result=await bridge.api(route('/api/files/content',target.root),{method:'PUT',body:JSON.stringify({path:target.path,revision:target.revision,content})});
      if (result.saved!==true || result.path!==target.path || typeof result.revision!=='string') throw new Error(tr('files.saveUncertain'));
      const next={...visit.value,...result,content,bom:content.startsWith('\uFEFF'),newline:content.includes('\r\n') ? 'crlf' : content.includes('\n') ? 'lf' : 'none'};
      target.base=submittedEditor; target.revision=next.revision; target.newline=next.newline; target.status=target.content===submittedEditor ? 'files.saved' : 'files.savedWithDraft'; target.submitted=null;
      if (sameVisit(visit)) updated(next);
    } catch (error) {
      target.error=error.detail || error.message;
      if (error.status===409) { target.conflict=true; target.status='files.editConflict'; }
      else if (uncertain(error)) { target.uncertain=true; target.status='files.saveUncertain'; }
      else { target.status='files.saveFailed'; target.submitted=null; }
    } finally { target.busy=false; if (visible(target)) editorRender(); }
  }
  async function verify() {
    const target=active, visit={...context()};
    if (!writable() || !target || !visible(target) || target.busy || target.checking) return;
    target.checking=true; target.error=''; editorRender();
    try {
      const next=await bridge.api(route('/api/files/preview?path='+encodeURIComponent(target.path),target.root));
      target.latest=next;
      if (editableFile(next) && target.submitted!==null && target.submitted!==undefined && next.content===target.submitted) {
        target.base=editorText(next.content); target.revision=next.revision; target.newline=next.newline; target.uncertain=false; target.conflict=false; target.submitted=null;
        target.status=target.content===target.base ? 'files.savedVerified' : 'files.savedWithDraft';
        if (sameVisit(visit)) updated(next);
      } else { target.conflict=true; target.uncertain=false; target.status='files.readbackDifferent'; }
    } catch (error) { target.error=error.detail || error.message; }
    finally { target.checking=false; if (visible(target)) editorRender(); }
  }
  async function discard() {
    const target=active, visit={...context()};
    if (!writable() || !target || !visible(target) || target.busy || target.checking) return;
    if ((target.content!==target.base || target.uncertain || target.conflict) && !window.confirm(tr('files.discardConfirm'))) return;
    const confirmedContent=target.content;
    target.checking=true; target.discarding=true; target.error=''; editorRender();
    try {
      const next=await bridge.api(route('/api/files/preview?path='+encodeURIComponent(target.path),target.root));
      if (!sameVisit(visit)) return;
      if (target.content!==confirmedContent) { target.latest=next; target.status='files.discardChanged'; return; }
      drafts.delete(key(target.root,target.path,target.identity)); active=null; updated(next); select();
    } catch (error) { target.error=error.detail || error.message; }
    finally { target.checking=false; target.discarding=false; if (visible(target)) editorRender(); }
  }
  async function uploadFile(event) {
    event?.preventDefault(); const target=upload, visit={...context()};
    if (!writable() || !target || !uploadVisible(target) || target.busy || target.uncertain || !target.file || target.blockedName===target.name) return;
    if (!target.name || ['.','..'].includes(target.name) || /[\\/\u0000-\u001f\u007f]/.test(target.name)) { target.status='files.badUploadName'; uploadRender(); return; }
    if (target.file.size>10*1024*1024) { target.status='files.uploadTooLarge'; uploadRender(); return; }
    target.path=[target.directory,target.name].filter(Boolean).join('/'); target.size=target.file.size; target.busy=true; target.status='files.uploading'; target.error=''; uploadRender();
    let sent=false;
    try {
      const bytes=new browser.Uint8Array(await target.file.arrayBuffer());
      target.hash=await hash(bytes);
      // File reading and hashing can outlive the selection. Only this visit may
      // begin a write; a started request then retains its original root/path.
      if (!sameVisit(visit) || context().directory!==target.directory) { target.status='files.uploadReady'; return; }
      let binary=''; for (let offset=0;offset<bytes.length;offset+=32768) binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
      target.uncertain=true; saveUploadRecovery(target); sent=true;
      const result=await bridge.api(route('/api/files/upload',target.root),{method:'POST',body:JSON.stringify({path:target.path,encoding:'base64',content:browser.btoa(binary)})});
      if (result.created!==true || result.path!==target.path || result.contentHash!==target.hash || result.size!==target.size) throw new Error(tr('files.uploadUncertain'));
      target.uncertain=false; saveUploadRecovery(target); target.status='files.uploaded'; target.file=null;
      if (uploadVisible(target)) node('filesUploadInput').value='';
      if (sameVisit(visit) && context().directory===target.directory) uploaded(result.path || target.path);
    } catch (error) {
      target.error=error.detail || error.message;
      target.uncertain=sent && uncertain(error); saveUploadRecovery(target);
      target.status=target.uncertain ? 'files.uploadUncertain' : error.status===409 ? 'files.uploadExists' : 'files.uploadFailed';
    } finally { target.busy=false; if (uploadVisible(target)) uploadRender(); }
  }
  async function checkUpload() {
    const target=upload, visit={...context()};
    if (!writable() || !target?.uncertain || target.busy || !uploadVisible(target)) return;
    target.busy=true; target.error=''; uploadRender();
    try {
      const result=await bridge.api(route('/api/files/status?path='+encodeURIComponent(target.path),target.root));
      if (result.size===target.size && result.contentHash===target.hash) {
        target.uncertain=false; target.file=null; target.status='files.uploadVerified'; saveUploadRecovery(target);
        if (sameVisit(visit) && context().directory===target.directory) uploaded(target.path);
      } else { target.status='files.uploadDifferent'; target.uncertain=false; target.blockedName=target.name; saveUploadRecovery(target); }
    } catch (error) {
      target.error=error.detail || error.message;
      if (error.status===404) { target.uncertain=false; target.status='files.uploadAbsent'; saveUploadRecovery(target); }
    } finally { target.busy=false; if (uploadVisible(target)) uploadRender(); }
  }
  node('filesEdit').addEventListener('click',begin);
  node('filesEditor').addEventListener('input',()=>{if(active) {active.content=node('filesEditor').value; if(!active.busy&&!active.conflict&&!active.uncertain) active.status=''; editorRender();}});
  node('filesSave').addEventListener('click',save); node('filesVerifySave').addEventListener('click',verify); node('filesDiscardEdit').addEventListener('click',discard);
  node('filesCancelEdit').addEventListener('click',()=>{if(active) {active.editing=false;editorRender();}});
  node('filesUploadForm').addEventListener('submit',uploadFile); node('filesUploadCheck').addEventListener('click',checkUpload);
  node('filesUploadInput').addEventListener('change',()=>{
    if(!upload || upload.busy || upload.uncertain) return;
    upload.file=node('filesUploadInput').files?.[0] || null; upload.name=upload.file?.name || ''; upload.status=''; upload.error=''; upload.path=''; uploadRender();
  });
  node('filesUploadName').addEventListener('input',()=>{if(upload&&!upload.busy&&!upload.uncertain) {upload.name=node('filesUploadName').value;upload.path='';uploadRender();}});
  window.addEventListener('beforeunload',event=>{
    if ([...drafts.values()].some(draft=>draft.content!==draft.base || draft.busy || draft.uncertain)) { event.preventDefault(); event.returnValue=''; }
  });
  return {select,suspend,sync};
}
