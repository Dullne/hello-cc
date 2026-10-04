export function normalizeWorkspaceLayout(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const ratio = Number(source.ratio);
  return { version: 1, open: source.open === true, direction: source.direction === 'rows' ? 'rows' : 'columns',
    ratio: Number.isFinite(ratio) ? Math.max(.25, Math.min(.75, ratio)) : .5,
    session: typeof source.session === 'string' && source.session.length <= 512 ? source.session : '' };
}

export function workspaceMessageValid(event, source, origin, project) {
  const data = event.data;
  return Boolean(source && event.source === source && event.origin === origin && data && typeof data === 'object'
    && data.type === 'hcc-workspace' && data.version === 1 && data.project === project
    && ['ready', 'selection', 'preferences', 'close'].includes(data.action)
    && (data.session === undefined || typeof data.session === 'string' && data.session.length <= 512)
    && (data.preferences === undefined || data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences)));
}

export const workspaceCss = `
  .workspace { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  .workspace-panes { flex:1; min-height:0; min-width:0; display:grid; grid-template-columns:minmax(0,1fr); }
  .workspace-bar { flex:none; display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:8px 10px; background:var(--panel); border-bottom:1px solid var(--border); }
  .workspace-bar[hidden], .workspace-secondary[hidden], .workspace-divider[hidden] { display:none; }
  .workspace-bar label { display:flex; flex:1; align-items:center; gap:8px; min-width:160px; }
  .workspace-bar select { min-width:0; flex:1; max-width:350px; }
  .workspace-pane-tabs { display:none; gap:6px; }
  .workspace-bar button[aria-pressed="true"] { background:var(--selection-bg); border-color:var(--accent); }
  .workspace-secondary { display:flex; position:relative; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:var(--bg); }
  .workspace-secondary iframe { width:100%; flex:1; min-height:0; border:0; background:var(--bg); }
  .workspace-status { padding:12px; color:var(--muted); font-size:var(--small-font); }
  .workspace-status[hidden] { display:none; }
  .workspace-divider { width:8px; height:100%; border:0; padding:0; cursor:col-resize; border-radius:0; background:var(--border); touch-action:none; }
  .workspace-divider:focus-visible { outline-offset:-2px; }
  .workspace-panes[data-direction="columns"] { grid-template-columns:minmax(0,var(--workspace-ratio,1fr)) 8px minmax(0,var(--workspace-rest,1fr)); }
  .workspace-panes[data-direction="rows"] { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(420px,var(--workspace-ratio,1fr)) 8px minmax(420px,var(--workspace-rest,1fr)); overflow:auto; }
  .workspace-panes[data-direction="rows"] .workspace-divider { width:100%; height:8px; cursor:row-resize; }
  .workspace-panes.resizing iframe { pointer-events:none; }
  .app.workspace-open { grid-template-columns:var(--left-width) minmax(0,1fr) 0; }
  .app.workspace-open.left-collapsed, .app.workspace-open.focus-mode { grid-template-columns:0 minmax(0,1fr) 0; }
  .app.workspace-open .inspector { display:none; }
  .app.workspace-open .edge-right, .app.workspace-open .edge-resizer-right { display:none; }
  .workspace-open .main > .toolbar { flex-wrap:wrap; }
  .workspace-open .main > .toolbar .title { flex-basis:100%; }
  .workspace-open .quick, .session-pane .quick { flex:1 1 auto; flex-wrap:wrap; min-width:0; }
  @media(max-width:1099px) {
    .app .workspace { display:none; }
    .app[data-view="terminal"] .workspace { display:flex; }
    .app.workspace-open, .app.workspace-open.left-collapsed, .app.workspace-open.focus-mode { grid-template-columns:minmax(0,1fr); }
    .app.workspace-open[data-view="state"] .inspector { display:grid; visibility:visible; }
    .workspace-pane-tabs { display:flex; }
    .workspace-panes[data-direction] { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); }
    .workspace-panes .workspace-divider, #workspaceDirection { display:none; }
    .app[data-view="terminal"] .workspace[data-active-pane="secondary"] .main { display:none; }
    .workspace[data-active-pane="primary"] .workspace-secondary { display:none; }
    .workspace-bar { gap:6px; }
    .workspace-bar label span { display:none; }
    .workspace-bar label { min-width:100px; }
  }
  .session-pane .global-header, .session-pane .mobile-nav, .session-pane .sidebar,
  .session-pane .inspector, .session-pane .edge-toggle, .session-pane .edge-resizer,
  .session-pane #workspaceBar { display:none !important; }
  .session-pane .app { display:flex; height:100dvh; }
  .session-pane .app .workspace, .session-pane .app .main { display:flex; flex:1; visibility:visible; }
  .session-pane .toolbar { flex-wrap:wrap; }
  .session-pane .toolbar .title { flex-basis:100%; }
  @media(pointer:coarse) { .workspace-bar button, .workspace-bar select { min-height:44px; } }
`;

export function workspaceBarHtml() {
  return `<header class="workspace-bar" id="workspaceBar" hidden>
    <div class="workspace-pane-tabs" role="group" data-i18n-aria="workspace.panes" aria-label="Session panes">
      <button id="workspacePrimary" type="button" data-i18n="workspace.primary" aria-pressed="true">Main</button>
      <button id="workspaceSecondary" type="button" data-i18n="workspace.secondary" aria-pressed="false">Second</button>
    </div>
    <label><span data-i18n="workspace.secondSession">Second session</span><select id="workspaceSession" data-i18n-aria="workspace.secondSession" aria-label="Second session"></select></label>
    <button id="workspaceDirection" type="button">Stack vertically</button>
    <button id="workspaceClose" type="button" data-i18n="workspace.close" data-i18n-title="workspace.closeHelp" title="Close this pane; the session keeps running">Close split</button>
  </header>`;
}

export function workspaceSecondaryHtml() {
  return `<div class="workspace-divider" id="workspaceDivider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="50" data-i18n-aria="workspace.resize" aria-label="Resize session panes" hidden></div>
    <section class="workspace-secondary" id="workspaceSecondPane" data-i18n-aria="workspace.secondary" aria-label="Second pane" hidden>
      <div class="workspace-status" id="workspaceStatus" role="status"></div>
      <button id="workspaceRetry" type="button" data-i18n="workspace.retry" hidden>Reconnect pane</button>
    </section>`;
}

function workspaceRuntime(normalize, validMessage) {
  const host = window.hccWorkspaceHost, ui = window.hccUi;
  const tr = key => ui.tr(key);
  const byId = id => document.getElementById(id);
  const workspace = byId('workspace'), panes = byId('workspacePanes'), bar = byId('workspaceBar');
  const secondary = byId('workspaceSecondPane'), status = byId('workspaceStatus'), select = byId('workspaceSession');
  const divider = byId('workspaceDivider'), split = byId('splitBtn');
  const mobile = window.matchMedia('(max-width:1099px)');
  let root = '', layout = normalize(null), frame = null, mounted = '', timer = 0, selectedPane = 'primary', resizing = false, applyingParentPreferences = false;
  const key = () => 'hcc.workspace:' + root;
  const save = () => { if (root) ui.safeSet(key(), JSON.stringify(layout)); };
  const post = action => {
    const data = {type:'hcc-workspace', version:1, action, project:host.project(), session:host.active() || '', preferences:ui.preferences};
    if (host.embedded) { if (window.parent !== window) window.parent.postMessage(data, location.origin); }
    else frame?.contentWindow?.postMessage({...data, session:layout.session}, location.origin);
  };
  function destroy() {
    clearTimeout(timer); mounted = ''; frame?.remove(); frame = null;
    status.hidden = true; byId('workspaceRetry').hidden = true;
  }
  function appearance() {
    bar.hidden = !layout.open; secondary.hidden = divider.hidden = !layout.open;
    host.app.classList.toggle('workspace-open', layout.open);
    split.setAttribute('aria-pressed', String(layout.open));
    if (layout.open) panes.dataset.direction = layout.direction; else delete panes.dataset.direction;
    panes.style.setProperty('--workspace-ratio', layout.ratio + 'fr');
    panes.style.setProperty('--workspace-rest', (1-layout.ratio) + 'fr');
    divider.setAttribute('aria-orientation', layout.direction === 'columns' ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-valuenow', String(Math.round(layout.ratio*100)));
    byId('workspaceDirection').textContent = tr(layout.direction === 'columns' ? 'workspace.rows' : 'workspace.columns');
    workspace.dataset.activePane = selectedPane;
    byId('workspacePrimary').setAttribute('aria-pressed', String(selectedPane === 'primary'));
    byId('workspaceSecondary').setAttribute('aria-pressed', String(selectedPane === 'secondary'));
    secondary.inert = mobile.matches && (selectedPane !== 'secondary' || host.app.dataset.view !== 'terminal');
    host.primary.inert = mobile.matches && (layout.open && selectedPane !== 'primary' || host.app.dataset.view !== 'terminal');
    host.layoutChanged();
  }
  function mount() {
    if (!layout.open || !host.ready()) return;
    const session = host.sessions().find(item => item.id === layout.session && item.status === 'running');
    if (!session) {
      destroy(); status.hidden = false; status.textContent = tr('workspace.missing'); return;
    }
    const identity = JSON.stringify([root,session.id]);
    if (frame && mounted === identity) return;
    destroy(); mounted = identity; status.hidden = false; status.textContent = tr('workspace.connecting');
    frame = document.createElement('iframe'); frame.id = 'workspaceFrame'; frame.title = tr('workspace.secondary');
    const url = new URL('/pane', location.origin); url.searchParams.set('project',root); url.searchParams.set('session',session.id);
    if (host.projectIdentity?.()) url.searchParams.set('root_identity', host.projectIdentity());
    frame.src = url.href; secondary.appendChild(frame);
    timer = setTimeout(() => { status.hidden = false; status.textContent = tr('workspace.failed'); byId('workspaceRetry').hidden = false; }, 12000);
  }
  function sync() {
    if (host.embedded) { post('selection'); return; }
    const nextRoot = host.project();
    if (nextRoot !== root) {
      destroy(); root = nextRoot;
      try { layout = normalize(JSON.parse(ui.safeGet(key()) || 'null')); } catch (_) { layout = normalize(null); }
      selectedPane = 'primary';
    }
    split.disabled = !host.ready() || !host.sessions().some(item => item.status === 'running');
    const options = host.sessions().filter(item => item.status === 'running');
    const esc = host.esc;
    const html = options.map(item => '<option value="'+esc(item.id)+'">'+esc(item.name || item.task?.title || item.peer_id || item.id)+'</option>').join('');
    const missing = layout.session && !options.some(item => item.id === layout.session);
    const nextHtml = (missing ? '<option value="'+esc(layout.session)+'" disabled>'+esc(layout.session)+' · '+esc(tr('workspace.missingShort'))+'</option>' : '') + html;
    if (select.innerHTML !== nextHtml) select.innerHTML = nextHtml;
    select.value = layout.session;
    appearance(); if (layout.open) mount();
  }
  function open() {
    if (host.embedded || split.disabled) return;
    if (!layout.session) layout.session = (host.sessions().find(item => item.status === 'running' && item.id !== host.active()) || host.sessions().find(item => item.status === 'running'))?.id || '';
    layout.open = true; selectedPane = mobile.matches ? 'secondary' : 'primary'; save(); host.showTerminal(); sync();
  }
  function close() { layout.open = false; destroy(); selectedPane = 'primary'; save(); appearance(); split.focus(); }
  function reset() { destroy(); root = ''; layout = normalize(null); appearance(); }
  function pickPane(value) { selectedPane = value; host.showTerminal(); appearance(); }
  function resize(event) {
    if (!resizing) return;
    const rect = panes.getBoundingClientRect();
    const fraction = layout.direction === 'columns' ? (event.clientX-rect.left)/rect.width : (event.clientY-rect.top)/rect.height;
    layout.ratio = Math.max(.25,Math.min(.75,fraction)); appearance();
  }
  if (!host.embedded) {
    split.addEventListener('click', () => layout.open ? close() : open());
    byId('workspaceClose').addEventListener('click', close);
    select.addEventListener('change', () => {
      if (!host.sessions().some(item => item.id === select.value && item.status === 'running')) return;
      layout.session = select.value; selectedPane = 'secondary'; save(); mount(); appearance();
    });
    byId('workspaceDirection').addEventListener('click', () => { layout.direction = layout.direction === 'columns' ? 'rows' : 'columns'; save(); appearance(); });
    byId('workspacePrimary').addEventListener('click', () => pickPane('primary'));
    byId('workspaceSecondary').addEventListener('click', () => pickPane('secondary'));
    byId('workspaceRetry').addEventListener('click', () => { destroy(); mount(); });
    divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); resizing = true; panes.classList.add('resizing'); divider.setPointerCapture(event.pointerId); });
    divider.addEventListener('pointermove', resize);
    for (const name of ['pointerup','pointercancel','lostpointercapture']) divider.addEventListener(name, () => { resizing = false; panes.classList.remove('resizing'); save(); });
    divider.addEventListener('keydown', event => {
      const decrease = layout.direction === 'columns' ? 'ArrowLeft' : 'ArrowUp', increase = layout.direction === 'columns' ? 'ArrowRight' : 'ArrowDown';
      if (![decrease,increase,'Home','End'].includes(event.key)) return;
      event.preventDefault(); layout.ratio = event.key === 'Home' ? .25 : event.key === 'End' ? .75 : Math.max(.25,Math.min(.75,layout.ratio+(event.key === increase ? .05 : -.05)));
      save(); appearance();
    });
    mobile.addEventListener('change', appearance);
  }
  window.addEventListener('message', event => {
    const source = host.embedded ? window.parent : frame?.contentWindow;
    if (!validMessage(event, source, location.origin, host.project())) return;
    const data = event.data;
    if (host.embedded) {
      if (data.action === 'preferences') {
        applyingParentPreferences = true;
        try { ui.update(data.preferences); } finally { applyingParentPreferences = false; }
      }
      return;
    }
    if (!layout.open) return;
    if (data.action === 'ready') post('preferences');
    if (data.action === 'selection') {
      if (data.session && host.sessions().some(item => item.id === data.session && item.status === 'running')) {
        clearTimeout(timer); status.hidden = true; byId('workspaceRetry').hidden = true;
        layout.session = data.session; mounted = JSON.stringify([root,data.session]); select.value = data.session; save();
      }
    }
    if (data.action === 'preferences') ui.update(data.preferences);
  });
  window.addEventListener('hcc:preferences', () => { if (!host.embedded) { sync(); if (frame) frame.title = tr('workspace.secondary'); } if (!applyingParentPreferences) post('preferences'); });
  window.addEventListener('pagehide', destroy);
  window.hccWorkspace = {open, close, sync, reset, access:appearance, destroy, primary:() => pickPane('primary'), get isOpen() { return layout.open; }};
  if (host.embedded) { post('ready'); } else sync();
}

export function workspaceScript() {
  return '(' + workspaceRuntime.toString() + ')(' + normalizeWorkspaceLayout.toString() + ',' + workspaceMessageValid.toString() + ');';
}

export function installWorkspace() { workspaceRuntime(normalizeWorkspaceLayout, workspaceMessageValid); }
