export function agentStartHtml() {
  return `<div class="dialog-overlay" id="startDialog" role="dialog" aria-modal="true" aria-labelledby="startDialogTitle" hidden>
    <div class="dialog">
      <header class="dialog-heading"><h3 id="startDialogTitle">New Agent</h3><button id="startDialogClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <p class="dialog-help" id="startDialogHelp" data-i18n="startDialogHelp">Choose an agent and its working directory. It will keep running when this page closes.</p>
      <p class="dialog-help" id="startDialogError" role="alert" hidden></p>
      <div class="dialog-target"><span data-i18n="startProject">Target project</span>: <span id="startProjectPath"></span></div>
      <form class="form" id="startForm">
        <p class="dialog-help" id="agentResumeInfo" hidden></p><div id="agentLaunchFields">
        <p class="dialog-help" id="agentDefaultsNotice" role="status" hidden></p><button id="agentDefaultsRetry" type="button" data-i18n="agent.defaultsRetry" hidden>Reload defaults for unedited fields</button>
        <label><span data-i18n="agent.provider">Agent</span><select id="kind"><option value="codex">Codex</option><option value="claude">Claude</option><option value="dsh">DeepSeek Harness</option><option value="shell">Shell</option></select></label>
        <label><span data-i18n="agent.cwd">Working directory</span><input id="agentCwd" type="text" required autocomplete="off" aria-describedby="agentCwdHelp"></label>
        <p class="dialog-help" id="agentCwdHelp" data-i18n="agent.cwdHelp">Use this project directory or a subdirectory within it.</p>
        <label id="agentModelField"><span data-i18n="agent.model">Model (optional)</span><input id="agentModel" type="text" maxlength="256" autocomplete="off" data-i18n-placeholder="agent.modelPlaceholder" placeholder="Provider default"></label>
        <label><span data-i18n="agent.name">Name (optional)</span><input id="agentName" type="text" maxlength="128" autocomplete="off" aria-describedby="agentNameHelp"></label>
        <p class="dialog-help" id="agentNameHelp" data-i18n="agent.nameHelp">Leave blank for an automatic name, or use letters, numbers, dots, hyphens and underscores. Start with a letter or number.</p>
        <details id="agentAdvanced"><summary data-i18n="agent.advanced">Advanced options</summary>
          <label id="transportField"><span data-i18n="agent.interface">Interface</span><select id="transport"><option value="native" data-i18n="agent.background">Background Agent</option><option value="tmux" data-i18n="handoff.cli">Terminal CLI</option><option value="app-server" data-i18n="handoff.appServer">Structured App Server (opt in)</option></select></label>
          <p class="dialog-help" id="agentConfigHelp" data-i18n="agent.configHelp" hidden>Terminal CLI and App Server use the provider's existing model configuration.</p>
          <div class="start-options" id="agentModeFields" hidden>
            <label><span data-i18n="mode">Mode</span><select id="startMode"><option value="new" data-i18n="mode.new">new</option></select></label>
            <label data-resume-field><span data-i18n="session">Session</span><select id="resumeSelect"></select></label>
            <label data-resume-field data-resume-custom style="display:none"><span data-i18n="sessionId">Session id</span><input id="resumeArg" data-i18n-placeholder="sessionIdPlaceholder" placeholder="session id or name"></label>
          </div>
          <label id="appServerResumeField" hidden><span style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox" id="appServerResumeConfirm"><span data-i18n="handoff.resumeConfirm">I have stopped the original executor. Resuming history starts a separate executor.</span></span></label>
        </details>
        </div>
        <button id="agentForgetRecovery" type="button" data-i18n="agent.forgetRecovery" hidden>Reviewed; forget recovery record</button>
        <div class="btns"><button id="startCancelBtn" type="button" data-i18n="dialog.cancel">Cancel</button><button id="agentStartBtn" class="primary" type="submit" data-i18n="start">Start</button></div>
      </form>
    </div>
  </div>`;
}

function agentStartRuntime(browser = globalThis) {
  const { window, document } = browser;
  const bridge = window.hccHandoff, byId = id => document.getElementById(id);
  const dialog = byId('startDialog'), form = byId('startForm'), kind = byId('kind'), transport = byId('transport');
  const mode = byId('startMode'), resume = byId('resumeSelect'), argument = byId('resumeArg');
  const error = byId('startDialogError'), name = byId('agentName'), cwd = byId('agentCwd'), model = byId('agentModel');
  const choices = new Map(), recoveries = new Map();
  const launchDrafts = new Map();
  let pending = false, created = null, resumeTarget = null, revision = 0, resumeRequest = 0, project = '', previousKind = kind.value, previousMode = '';
  let defaults = null, defaultsLoading = false, defaultsFailed = false, defaultsRequest = 0;
  let launchProvider = kind.value, launchTransport = 'native', launchNative = true, providerTouched = false, interfaceTouched = false, shownCwd = '', shownModel = '', freshLaunch = false;
  const tr = key => bridge.tr(key);
  const native = () => transport.value === 'native';
  const current = visit => revision === visit && bridge.projectRoot === project && !dialog.hidden;
  const recoveryKey = root => 'hcc.agentCreation:' + root;
  function rememberRecovery(root, value) {
    if (value) recoveries.set(root, value); else recoveries.delete(root);
    window.hccUi?.safeSet(recoveryKey(root), JSON.stringify(value));
  }
  function recoveryFor(root) {
    if (recoveries.has(root)) return recoveries.get(root);
    try {
      const value = JSON.parse(window.hccUi?.safeGet(recoveryKey(root)) || 'null');
      if (value && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.id) && value.recovery === true
        && (value.operation !== 'resume' || (typeof value.oldOwner === 'string' && value.oldOwner && typeof value.sessionId === 'string' && value.sessionId))) return value;
    } catch (_) {}
    return null;
  }
  function nativePeer() {
    return 'web-' + (window.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  }
  function recoveryNotice(value) {
    if (value.operation === 'resume') return tr(value.confirmed ? 'agent.resumeRefreshFailed' : 'agent.resumeUnconfirmed').replace('{name}',value.id);
    return tr(value.confirmed ? 'agent.createdRefreshFailed' : 'agent.creationUnconfirmed').replace('{name}', value.id);
  }
  function recoveredSession(recovery) {
    return bridge.sessions?.find(item => item.type === 'native' && [item.id,item.peer_id].includes(recovery.id)
      && (recovery.operation !== 'resume' || (item.kind === recovery.provider && item.status === 'running' && item.native_connected === true
        && item.executor_id && item.executor_id !== recovery.oldOwner && (!recovery.executorId || item.executor_id === recovery.executorId)
        && item.binding?.provider_session_id === recovery.sessionId)));
  }
  function defaultCwd(provider) {
    const relative = defaults?.providers?.[provider]?.cwd;
    return relative && relative !== '.' ? project.replace(/[\\/]+$/, '') + '/' + relative : project;
  }
  function launchDraft(provider, connection = launchTransport) {
    const key = provider + ':' + connection;
    if (!launchDrafts.has(key)) launchDrafts.set(key,{provider,connection,cwd:connection === 'native' ? defaultCwd(provider) : project,
      model:connection === 'native' ? defaults?.providers?.[provider]?.model || '' : '',cwdTouched:false,modelTouched:false});
    return launchDrafts.get(key);
  }
  function captureLaunchDraft() {
    if (!project) return;
    const draft = launchDraft(launchProvider);
    if (cwd.value !== shownCwd) { draft.cwdTouched = true; draft.cwd = cwd.value; }
    if (launchNative && model.value !== shownModel) { draft.modelTouched = true; draft.model = model.value; }
  }
  function showLaunchDraft() {
    const draft = launchDraft(launchProvider);
    cwd.value = draft.cwdTouched || launchNative ? draft.cwd : project;
    model.value = draft.model;
    shownCwd = cwd.value; shownModel = model.value;
  }
  function defaultsStatus() {
    byId('agentDefaultsNotice').hidden = !defaultsLoading && !defaultsFailed;
    byId('agentDefaultsNotice').textContent = defaultsLoading ? tr('agent.defaultsLoading') : defaultsFailed ? tr('agent.defaultsFailed') : '';
    byId('agentDefaultsRetry').hidden = !defaultsFailed;
    byId('agentDefaultsRetry').disabled = pending || defaultsLoading;
  }
  async function readDefaults() {
    if (!window.hccAgentDefaults || created || resumeTarget || !project) return;
    const visit = revision, request = ++defaultsRequest, expectedProvider = kind.value;
    defaultsLoading = true; defaultsFailed = false; defaultsStatus(); setPending(pending);
    try {
      const result = await window.hccAgentDefaults.read(project);
      if (!current(visit) || request !== defaultsRequest || created || resumeTarget) return;
      captureLaunchDraft(); defaults = result;
      const currentDraft = launchDraft(launchProvider);
      const canChooseProvider = !providerTouched && !interfaceTouched && kind.value === expectedProvider && !currentDraft.cwdTouched && !currentDraft.modelTouched;
      for (const draft of launchDrafts.values()) {
        if (draft.connection !== 'native') continue;
        if (!draft.cwdTouched) draft.cwd = defaultCwd(draft.provider);
        if (!draft.modelTouched) draft.model = defaults.providers?.[draft.provider]?.model || '';
      }
      if (canChooseProvider && ['codex','claude','dsh'].includes(defaults.defaultProvider)) kind.value = defaults.defaultProvider;
      sync(); showLaunchDraft();
    } catch (_) {
      if (current(visit) && request === defaultsRequest) defaultsFailed = true;
    } finally {
      if (current(visit) && request === defaultsRequest) { defaultsLoading = false; defaultsStatus(); setPending(pending); }
    }
  }

  function toggleResume() {
    const custom = !native() && mode.value === 'resume' && resume.value === '__custom__';
    document.querySelector('[data-resume-custom]').style.display = custom ? '' : 'none';
    argument.required = custom;
  }
  async function loadResumable() {
    const visit = revision, request = ++resumeRequest, provider = kind.value, connection = transport.value;
    let entries = [];
    try { entries = (await bridge.api('/api/resumable')).resumable || []; } catch (_) {}
    if (!current(visit) || request !== resumeRequest || kind.value !== provider || transport.value !== connection || mode.value !== 'resume') return;
    const selected = resume.value;
    resume.innerHTML = entries.filter(item => item.provider === provider).map(item => {
      const id = item.resume || item.session_id || item.session_name || '';
      const label = (item.name && item.name !== id ? item.name + ' · ' : '') + id + ' (' + item.peer + ')';
      return '<option value="' + bridge.esc(id) + '">' + bridge.esc(label) + '</option>';
    }).join('') + '<option value="__custom__">' + bridge.esc(tr('customSession')) + '</option>';
    if ([...resume.options].some(option => option.value === selected)) resume.value = selected;
    toggleResume();
  }
  function clearResume() {
    resumeRequest++; resume.innerHTML = ''; argument.value = ''; argument.required = false;
    byId('appServerResumeConfirm').checked = false;
  }
  function sync() {
    captureLaunchDraft();
    const provider = kind.value;
    const allowed = provider === 'shell' ? ['tmux'] : provider === 'dsh' ? ['native']
      : provider === 'codex' ? ['native','tmux','app-server'] : ['native','tmux'];
    const changed = provider !== previousKind;
    const selected = changed ? choices.get(provider) : transport.value;
    transport.innerHTML = allowed.map(value => '<option value="' + value + '">' + bridge.esc(tr(value === 'native' ? 'agent.background' : value === 'tmux' ? 'handoff.cli' : 'handoff.appServer')) + '</option>').join('');
    transport.value = allowed.includes(selected) ? selected : allowed[0];
    choices.set(provider, transport.value);
    transport.disabled = allowed.length === 1;
    if (launchProvider !== provider || launchTransport !== transport.value) {
      launchProvider = provider; launchTransport = transport.value; launchNative = native(); showLaunchDraft();
    }
    const modes = native() || provider === 'shell' ? ['new'] : provider === 'claude' ? ['new','resume','continue']
      : transport.value === 'app-server' ? ['new','resume'] : ['new','resume','last'];
    const selectedMode = changed ? 'new' : mode.value;
    mode.innerHTML = modes.map(value => '<option value="' + value + '">' + bridge.esc(tr('mode.' + value)) + '</option>').join('');
    mode.value = modes.includes(selectedMode) ? selectedMode : 'new';
    if (changed || mode.value !== 'resume') clearResume();
    byId('agentModelField').hidden = !native(); model.disabled = !native();
    byId('agentModeFields').hidden = native() || provider === 'shell';
    byId('agentConfigHelp').hidden = native() || provider === 'shell';
    byId('appServerResumeField').hidden = !(transport.value === 'app-server' && mode.value === 'resume');
    document.querySelector('[data-resume-field]:not([data-resume-custom])').style.display = mode.value === 'resume' ? '' : 'none';
    const modeKey = [provider,transport.value,mode.value].join(':');
    previousKind = provider;
    if (mode.value === 'resume' && modeKey !== previousMode) void loadResumable();
    previousMode = modeKey;
    toggleResume();
  }
  function setPending(value) {
    pending = value;
    const resuming = resumeTarget || (created?.operation === 'resume' ? created : null);
    const titleKey = resuming ? 'agent.resumeTitle' : 'newSession';
    const actionKey = created?.recovery ? 'agent.checkCreated' : created ? 'agent.openCreated' : resuming ? 'history.resume' : 'start';
    byId('agentLaunchFields').hidden = Boolean(resuming);
    byId('startDialogHelp').hidden = Boolean(resuming);
    byId('agentResumeInfo').hidden = !resuming;
    byId('agentResumeInfo').textContent = resuming ? tr('agent.resumeInfo').replace('{name}',resuming.peer || resuming.id).replace('{session}',resuming.sessionId) : '';
    byId('startDialogTitle').setAttribute('data-i18n',titleKey);
    byId('startDialogTitle').textContent = tr(titleKey);
    byId('agentStartBtn').disabled = value || defaultsLoading || Boolean(resumeTarget?.rejected);
    byId('agentStartBtn').setAttribute('data-i18n',actionKey);
    byId('agentStartBtn').textContent = tr(actionKey);
    byId('agentForgetRecovery').hidden = !created?.recovery;
    byId('agentForgetRecovery').disabled = value;
    byId('openStartDialog').disabled = value;
    form.setAttribute('aria-busy', String(value));
    defaultsStatus();
  }
  function open(loadDefaults = true) {
    if (pending) return;
    resumeTarget = null;
    revision++;
    if (project !== bridge.projectRoot || freshLaunch) {
      project = bridge.projectRoot; cwd.value = project; name.value = ''; model.value = ''; clearResume(); mode.value = 'new';
      defaults = null; launchDrafts.clear(); choices.clear(); providerTouched = false; interfaceTouched = false;
      kind.value = 'codex'; transport.value = 'native'; launchProvider = 'codex'; launchTransport = 'native'; launchNative = true; shownCwd = project; shownModel = ''; freshLaunch = false;
    }
    created = recoveryFor(project);
    byId('startProjectPath').textContent = project;
    error.hidden = !created;
    if (created) error.textContent = recoveryNotice(created);
    byId('appServerResumeConfirm').checked = false;
    previousMode = '';
    bridge.openDialog(dialog, kind); sync(); setPending(false);
    if (loadDefaults && !created) void readDefaults();
  }
  function closed() { revision++; resumeRequest++; defaultsRequest++; defaultsLoading = false; defaultsFailed = false; created = null; resumeTarget = null; setPending(pending); }
  function reset() { closed(); if (!dialog.hidden) bridge.closeDialog(dialog); }
  async function submit(event) {
    event.preventDefault();
    if (pending || defaultsLoading || dialog.hidden || project !== bridge.projectRoot || resumeTarget?.rejected) return;
    const visit = revision, submittedProject = project;
    let attempted = null, admitted = false;
    error.hidden = true;
    try {
      if (!created) {
        let payload, endpoint = '/api/sessions';
        if (resumeTarget) {
          payload = {owner:resumeTarget.owner,sessionId:resumeTarget.sessionId,confirmed:true};
          endpoint = '/api/native/history/' + encodeURIComponent(resumeTarget.peer) + '/resume';
          attempted = {id:resumeTarget.peer,provider:resumeTarget.provider,operation:'resume',oldOwner:resumeTarget.owner,sessionId:resumeTarget.sessionId,recovery:true,confirmed:false};
        } else {
          sync();
        const id = name.value.trim(), directory = cwd.value.trim() || project;
        if (id && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || id.toLowerCase() === 'all')) {
          name.focus(); throw new Error(tr('agent.badName'));
        }
        payload = { kind:kind.value, cwd:directory, ...(id ? { id } : {}) };
        if (native()) {
          payload.transport = 'native';
          payload.id = id || nativePeer();
          payload.model = model.value.trim() || null;
        } else {
          payload.mode = mode.value;
          if (transport.value === 'app-server') payload.transport = 'app-server';
          if (mode.value === 'resume') {
            payload.resume = resume.value && resume.value !== '__custom__' ? resume.value : argument.value.trim();
            if (!payload.resume) { argument.focus(); throw new Error(tr('agent.resumeRequired')); }
            if (transport.value === 'app-server') {
              if (!byId('appServerResumeConfirm').checked) throw new Error(tr('handoff.resumeConfirm'));
              payload.handoffConfirmed = true;
            }
          }
        }
        if (native()) {
          attempted = { id:payload.id, provider:payload.kind, recovery:true, confirmed:false };
        }
        }
        setPending(true);
        // Save the original identity before a write. A lost response can only
        // trigger discovery of this operation, never another creation/resume.
        if (attempted) rememberRecovery(submittedProject,attempted);
        const result = await bridge.api(endpoint, { method:'POST', body:JSON.stringify(payload) });
        admitted = true;
        const receipt = attempted ? { ...attempted,confirmed:true,...(attempted.operation === 'resume' && result.session?.executor_id ? {executorId:result.session.executor_id} : {}) } : null;
        if (receipt) rememberRecovery(submittedProject,receipt);
        if (!current(visit)) return;
        created = attempted?.operation === 'resume' ? receipt : result.session;
      } else setPending(true);
      await bridge.refreshSessions();
      if (!current(visit)) return;
      const session = created.recovery ? recoveredSession(created) : created;
      if (!session) throw new Error(tr('agent.awaitingDiscovery'));
      if (created.operation !== 'resume' && !resumeTarget) freshLaunch = true;
      rememberRecovery(submittedProject, null);
      bridge.closeDialog(dialog);
      bridge.openManaged(session.id);
    } catch (failure) {
      const recoverable = ['NATIVE_CREATE_UNCONFIRMED','NATIVE_RESUME_UNCONFIRMED','NATIVE_WORKER_DISCOVERY_FAILED','REQUEST_TIMEOUT','REQUEST_SUPERSEDED'].includes(failure.code)
        || (!failure.status && !failure.code);
      if (attempted && !admitted && recoverable) {
        const peer = failure.extra?.peer;
        const recovery = { ...attempted, ...(attempted.operation !== 'resume' && typeof peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(peer) ? { id:peer } : {}),
          ...(attempted.operation === 'resume' && typeof failure.extra?.executorId === 'string' ? {executorId:failure.extra.executorId} : {}),
          confirmed: failure.extra?.created === true };
        rememberRecovery(submittedProject, recovery);
        if (current(visit)) created = recovery;
      } else if (attempted && !admitted) {
        rememberRecovery(submittedProject,null);
        if (current(visit) && attempted.operation === 'resume' && resumeTarget) resumeTarget.rejected = true;
      }
      if (!current(visit)) return;
      error.textContent = (created ? (created.recovery ? recoveryNotice(created) : tr('agent.createdRefreshFailed').replace('{name}', created.id)) + ' ' : '')
        + bridge.tr('error.' + failure.code, failure.detail || failure.message);
      error.hidden = false;
    } finally { setPending(false); }
  }
  form.addEventListener('submit',submit);
  function resumeNative(worker) {
    if (pending || !worker || worker.resumable !== true || worker.status !== 'closed' || worker.owned !== false || !worker.owner || !worker.sessionId) return;
    open(false);
    // An outstanding operation takes precedence over any newly selected worker.
    if (created) return;
    resumeTarget = {...worker}; setPending(false);
    return submit({preventDefault() {}});
  }
  kind.addEventListener('change', () => { providerTouched = true; sync(); });
  for (const field of [transport,mode]) field.addEventListener('change', () => { interfaceTouched = true; sync(); });
  cwd.addEventListener('input', () => { const draft = launchDraft(launchProvider); draft.cwdTouched = true; draft.cwd = cwd.value; shownCwd = cwd.value; });
  model.addEventListener('input', () => { const draft = launchDraft(launchProvider); draft.modelTouched = true; draft.model = model.value; shownModel = model.value; });
  byId('agentDefaultsRetry').addEventListener('click',readDefaults);
  resume.addEventListener('change', toggleResume);
  byId('agentForgetRecovery').addEventListener('click', () => {
    if (pending || !created?.recovery || dialog.hidden || bridge.projectRoot !== project) return;
    if (!window.confirm(tr('agent.forgetRecoveryConfirm').replace('{name}', created.id))) return;
    rememberRecovery(project, null); created = null; resumeTarget = null; error.hidden = true; setPending(false);
  });
  const controller = { open, sync, closed, reset, resumeNative };
  Object.defineProperty(controller, 'pending', { get: () => pending });
  window.hccAgentStart = controller;
  window.addEventListener?.('hcc:preferences',() => { if (!dialog.hidden) setPending(pending); });
  sync();
}

export function agentStartScript() { return '(' + agentStartRuntime.toString() + ')();'; }

export const installAgentStart = agentStartRuntime;
