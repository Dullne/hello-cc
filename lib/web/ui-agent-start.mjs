export function agentStartHtml() {
  return `<div class="dialog-overlay" id="startDialog" role="dialog" aria-modal="true" aria-labelledby="startDialogTitle" hidden>
    <div class="dialog">
      <header class="dialog-heading"><h3 id="startDialogTitle" data-i18n="newSession">New Agent</h3><button id="startDialogClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <p class="dialog-help" data-i18n="startDialogHelp">Choose an agent and its working directory. It will keep running when this page closes.</p>
      <p class="dialog-help" id="startDialogError" role="alert" hidden></p>
      <div class="dialog-target"><span data-i18n="startProject">Target project</span>: <span id="startProjectPath"></span></div>
      <form class="form" id="startForm">
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
  let pending = false, created = null, revision = 0, resumeRequest = 0, project = '', previousKind = kind.value, previousMode = '';
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
      if (value && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.id) && value.recovery === true) return value;
    } catch (_) {}
    return null;
  }
  function nativePeer() {
    return 'web-' + (window.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  }
  function recoveryNotice(value) {
    return tr(value.confirmed ? 'agent.createdRefreshFailed' : 'agent.creationUnconfirmed').replace('{name}', value.id);
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
    const provider = kind.value;
    const allowed = provider === 'shell' ? ['tmux'] : provider === 'dsh' ? ['native']
      : provider === 'codex' ? ['native','tmux','app-server'] : ['native','tmux'];
    const changed = provider !== previousKind;
    const selected = changed ? choices.get(provider) : transport.value;
    transport.innerHTML = allowed.map(value => '<option value="' + value + '">' + bridge.esc(tr(value === 'native' ? 'agent.background' : value === 'tmux' ? 'handoff.cli' : 'handoff.appServer')) + '</option>').join('');
    transport.value = allowed.includes(selected) ? selected : allowed[0];
    choices.set(provider, transport.value);
    transport.disabled = allowed.length === 1;
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
    byId('agentStartBtn').disabled = value;
    byId('agentStartBtn').textContent = tr(created?.recovery ? 'agent.checkCreated' : created ? 'agent.openCreated' : 'start');
    byId('agentForgetRecovery').hidden = !created?.recovery;
    byId('agentForgetRecovery').disabled = value;
    byId('openStartDialog').disabled = value;
    form.setAttribute('aria-busy', String(value));
  }
  function open() {
    if (pending) return;
    revision++;
    if (project !== bridge.projectRoot) {
      project = bridge.projectRoot; cwd.value = project; name.value = ''; model.value = ''; clearResume(); mode.value = 'new';
    }
    created = recoveryFor(project);
    byId('startProjectPath').textContent = project;
    error.hidden = !created;
    if (created) error.textContent = recoveryNotice(created);
    byId('appServerResumeConfirm').checked = false;
    previousMode = '';
    bridge.openDialog(dialog, kind); sync(); setPending(false);
  }
  function closed() { revision++; resumeRequest++; created = null; setPending(pending); }
  function reset() { closed(); if (!dialog.hidden) bridge.closeDialog(dialog); }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || dialog.hidden || project !== bridge.projectRoot) return;
    const visit = revision, submittedProject = project;
    let attempted = null, admitted = false;
    error.hidden = true;
    try {
      if (!created) {
        sync();
        const id = name.value.trim(), directory = cwd.value.trim() || project;
        if (id && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || id.toLowerCase() === 'all')) {
          name.focus(); throw new Error(tr('agent.badName'));
        }
        const payload = { kind:kind.value, cwd:directory, ...(id ? { id } : {}) };
        if (native()) {
          payload.transport = 'native';
          payload.id = id || nativePeer();
          if (model.value.trim()) payload.model = model.value.trim();
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
        setPending(true);
        if (native()) {
          attempted = { id:payload.id, provider:payload.kind, recovery:true, confirmed:false };
          // Save the stable peer before the write so a full page reload cannot
          // turn a lost create response into another worker on the next submit.
          rememberRecovery(submittedProject, attempted);
        }
        const result = await bridge.api('/api/sessions', { method:'POST', body:JSON.stringify(payload) });
        admitted = true;
        if (attempted) rememberRecovery(submittedProject, { ...attempted, confirmed:true });
        if (!current(visit)) return;
        created = result.session;
      } else setPending(true);
      await bridge.refreshSessions();
      if (!current(visit)) return;
      const session = created.recovery ? bridge.sessions?.find(item => item.type === 'native'
        && [item.id, item.peer_id].includes(created.id)) : created;
      if (!session) throw new Error(tr('agent.awaitingDiscovery'));
      rememberRecovery(submittedProject, null);
      bridge.closeDialog(dialog);
      bridge.openManaged(session.id);
    } catch (failure) {
      const recoverable = ['NATIVE_CREATE_UNCONFIRMED','NATIVE_WORKER_DISCOVERY_FAILED','REQUEST_TIMEOUT','REQUEST_SUPERSEDED'].includes(failure.code)
        || (!failure.status && !failure.code);
      if (attempted && !admitted && recoverable) {
        const peer = failure.extra?.peer;
        const recovery = { ...attempted, ...(typeof peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(peer) ? { id:peer } : {}),
          confirmed: failure.extra?.created === true };
        rememberRecovery(submittedProject, recovery);
        if (current(visit)) created = recovery;
      } else if (attempted && !admitted) rememberRecovery(submittedProject, null);
      if (!current(visit)) return;
      error.textContent = (created ? (created.recovery ? recoveryNotice(created) : tr('agent.createdRefreshFailed').replace('{name}', created.id)) + ' ' : '')
        + bridge.tr('error.' + failure.code, failure.detail || failure.message);
      error.hidden = false;
    } finally { setPending(false); }
  });
  for (const field of [kind,transport,mode]) field.addEventListener('change', sync);
  resume.addEventListener('change', toggleResume);
  byId('agentForgetRecovery').addEventListener('click', () => {
    if (pending || !created?.recovery || dialog.hidden || bridge.projectRoot !== project) return;
    if (!window.confirm(tr('agent.forgetRecoveryConfirm').replace('{name}', created.id))) return;
    rememberRecovery(project, null); created = null; error.hidden = true; setPending(false);
  });
  const controller = { open, sync, closed, reset };
  Object.defineProperty(controller, 'pending', { get: () => pending });
  window.hccAgentStart = controller;
  sync();
}

export function agentStartScript() { return '(' + agentStartRuntime.toString() + ')();'; }

export const installAgentStart = agentStartRuntime;
