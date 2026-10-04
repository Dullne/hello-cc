export const agentDefaultsCss = `
  .settings-dialog { width:min(700px,calc(100vw - 28px)); max-width:none; max-height:90dvh; overflow:auto; }
  .agent-defaults { margin-top:22px; padding-top:18px; border-top:1px solid var(--border); display:grid; gap:12px; }
  .agent-defaults h4,.agent-defaults p { margin:0; }
  .agent-defaults fieldset { min-width:0; border:1px solid var(--border); border-radius:8px; padding:12px; display:grid; gap:10px; }
  .agent-defaults legend { padding:0 6px; }
  .agent-defaults label { min-width:0; }
  .agent-defaults input,.agent-defaults select { width:100%; min-width:0; }
  .agent-defaults .btns { flex-wrap:wrap; }
  #agentDefaultsProject { overflow-wrap:anywhere; }
  .agent-defaults [hidden] { display:none; }
`;

export function agentDefaultsHtml() {
  const providerFields=[['Codex','Codex'],['Claude','Claude'],['Dsh','DeepSeek Harness']].map(([id,label]) =>
    '<fieldset><legend>'+label+'</legend><label><span data-i18n="agent.model">Model (optional)</span><input id="agentDefaults'+id+'Model" type="text" maxlength="256" autocomplete="off" data-i18n-placeholder="agent.modelPlaceholder" placeholder="Provider default"></label>'
    +'<label><span data-i18n="agentDefaults.cwd">Project relative working directory</span><input id="agentDefaults'+id+'Cwd" type="text" required autocomplete="off" placeholder="."></label></fieldset>').join('');
  return `<form id="agentDefaultsForm" class="agent-defaults">
    <h4 data-i18n="agentDefaults.title">Project Agent defaults</h4><p id="agentDefaultsProject" class="dialog-help"></p>
    <p class="dialog-help" data-i18n="agentDefaults.help">Saved for this project and used for new background Agents. Existing Agents, history restores, accounts and API keys are unchanged.</p>
    <label><span data-i18n="agentDefaults.provider">Default Agent</span><select id="agentDefaultsProvider"><option value="codex">Codex</option><option value="claude">Claude</option><option value="dsh">DeepSeek Harness</option></select></label>
    ${providerFields}
    <p class="dialog-help" data-i18n="agentDefaults.fieldsHelp">Use . for the project directory. An empty model uses the provider default.</p>
    <p id="agentDefaultsStatus" class="dialog-help" role="status" aria-live="polite"></p>
    <div class="btns"><button id="agentDefaultsReload" type="button" data-i18n="agentDefaults.reload">Reload saved values</button><button id="agentDefaultsReset" type="button" data-i18n="agentDefaults.reset">Restore initial values</button><button id="agentDefaultsSave" type="submit" class="primary" data-i18n="agentDefaults.save">Save project defaults</button></div>
  </form>`;
}

export function installAgentDefaults(browser = globalThis) {
  const {window,document}=browser, bridge=window.hccHandoff, node=id=>document.getElementById(id);
  const providers=[['codex','Codex'],['claude','Claude'],['dsh','Dsh']], records=new Map();
  const fields=['agentDefaultsProvider',...providers.flatMap(([,label])=>['agentDefaults'+label+'Model','agentDefaults'+label+'Cwd'])];
  let record=null, visit=0;
  const empty=()=>({defaultProvider:'codex',providers:Object.fromEntries(providers.map(([provider])=>[provider,{model:null,cwd:'.'}]))});
  const copy=value=>JSON.parse(JSON.stringify(value));
  const values=value=>({defaultProvider:value.defaultProvider,providers:copy(value.providers)});
  const signature=value=>JSON.stringify(values(value));
  const route=root=>'/api/agent-defaults?root='+encodeURIComponent(root);
  const visible=target=>record===target && target.root===bridge.projectRoot && !node('settingsDialog').hidden;
  const tr=key=>bridge.tr(key);
  function renderStatus() {
    if (!record) return;
    const message=tr(record.status || 'agentDefaults.ready');
    node('agentDefaultsStatus').textContent=message+(record.error ? ' '+record.error : '');
  }
  function sync() {
    if (!node('settingsDialog').hidden && (!record || record.root!==bridge.projectRoot)) { open(); return; }
    if (!record) return;
    const blocked=!record.loaded || record.loading || record.root!==bridge.projectRoot;
    for (const id of fields) node(id).disabled=blocked;
    node('agentDefaultsSave').disabled=blocked || record.saving || record.conflict || record.uncertain || !record.dirty;
    node('agentDefaultsReset').disabled=blocked || record.saving;
    node('agentDefaultsReload').disabled=record.loading || record.saving || !record.root;
    node('agentDefaultsForm').setAttribute('aria-busy',String(record.loading || record.saving));
    renderStatus();
  }
  function render() {
    if (!record) return;
    node('agentDefaultsProject').textContent=record.root;
    node('agentDefaultsProvider').value=record.value.defaultProvider;
    for (const [provider,label] of providers) {
      node('agentDefaults'+label+'Model').value=record.value.providers[provider].model || '';
      node('agentDefaults'+label+'Cwd').value=record.value.providers[provider].cwd;
    }
    sync();
  }
  function changed() {
    if (!record || !record.loaded || record.loading || record.root!==bridge.projectRoot) return;
    record.value={defaultProvider:node('agentDefaultsProvider').value,providers:Object.fromEntries(providers.map(([provider,label])=>[provider,{
      model:node('agentDefaults'+label+'Model').value.trim() || null,cwd:node('agentDefaults'+label+'Cwd').value.trim()
    }]))};
    record.dirty=signature(record.value)!==record.saved;
    if (!record.conflict && !record.uncertain && !record.saving) { record.status=record.dirty ? 'agentDefaults.unsaved' : 'agentDefaults.ready'; record.error=''; }
    sync();
  }
  async function read(root=bridge.projectRoot) {
    if (!root) throw new Error(tr('agentDefaults.projectLoading'));
    return bridge.api(route(root));
  }
  async function reload() {
    if (!record || record.loading || record.saving || !record.root) return;
    const target=record, version=visit;
    target.loadVersion=version;
    target.loading=true; target.status='agentDefaults.loading'; target.error=''; sync();
    try {
      const result=await read(target.root);
      if (!visible(target) || version!==visit) return;
      target.value=values(result); target.revision=result.revision; target.saved=signature(target.value);
      target.loaded=true; target.dirty=false; target.conflict=false; target.uncertain=false; target.status='agentDefaults.ready';
    } catch (error) {
      if (visible(target) && version===visit) { target.status='agentDefaults.loadFailed'; target.error=error.detail || error.message; }
    } finally {
      if (target.loadVersion===version) target.loading=false;
      if (visible(target) && version===visit) render();
    }
  }
  function open() {
    visit++;
    const root=bridge.projectRoot;
    if (!records.has(root)) records.set(root,{root,value:empty(),loaded:false,loading:false,saving:false,dirty:false,revision:null,status:'agentDefaults.ready',error:''});
    record=records.get(root);
    record.loading=false;
    while (records.size>20) {
      const removable=[...records.entries()].find(([key,value])=>key!==root && !value.saving && !value.dirty);
      if (!removable) break;
      records.delete(removable[0]);
    }
    if (!root) { record.status='agentDefaults.projectLoading'; render(); return; }
    render();
    if (!record.dirty && !record.saving && !record.conflict && !record.uncertain) void reload();
  }
  function closed() { visit++; }
  function reset() { closed(); record=null; }
  async function save(event) {
    event?.preventDefault(); changed();
    const target=record;
    if (!target || !visible(target) || !target.loaded || target.loading || target.saving || target.conflict || target.uncertain || !target.dirty) return;
    const submitted=copy(target.value), sentSignature=signature(submitted), revision=target.revision;
    target.saving=true; target.status='agentDefaults.saving'; target.error=''; sync();
    try {
      const result=await bridge.api(route(target.root),{method:'PUT',body:JSON.stringify({revision,...submitted})});
      target.revision=result.revision; target.saved=signature(result);
      // The server receipt belongs to the submitted snapshot. Edits typed while
      // it was saving remain a draft on top of the new revision.
      if (signature(target.value)===sentSignature) target.value=values(result);
      target.dirty=signature(target.value)!==target.saved;
      target.status=target.dirty ? 'agentDefaults.savedWithEdits' : 'agentDefaults.saved';
    } catch (error) {
      target.error=error.detail || error.message;
      if (error.status===409 || error.code==='AGENT_DEFAULTS_CONFLICT') { target.conflict=true; target.status='agentDefaults.conflict'; }
      else if (!error.status || ['REQUEST_TIMEOUT','REQUEST_SUPERSEDED'].includes(error.code)) { target.uncertain=true; target.status='agentDefaults.uncertain'; }
      else target.status='agentDefaults.saveFailed';
    } finally {
      target.saving=false;
      if (visible(target)) render();
    }
  }
  node('agentDefaultsForm').addEventListener('submit',save);
  for (const id of fields) { node(id).addEventListener('input',changed); node(id).addEventListener('change',changed); }
  node('agentDefaultsReload').addEventListener('click',reload);
  node('agentDefaultsReset').addEventListener('click',()=>{
    if (!record || !record.loaded || record.loading || record.saving || record.root!==bridge.projectRoot) return;
    record.value=empty(); record.dirty=signature(record.value)!==record.saved;
    if (!record.conflict && !record.uncertain) { record.status='agentDefaults.resetDraft'; record.error=''; }
    render();
  });
  window.addEventListener('hcc:preferences',()=>{ if (record && visible(record)) sync(); });
  window.hccAgentDefaults={open,closed,reset,sync,read};
}
