export function webIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hello-cc</title>
  <link rel="stylesheet" href="/assets/xterm.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #181b1f;
      --panel-2: #20242a;
      --border: #303640;
      --text: #eef2f6;
      --muted: #a3adba;
      --accent: #40c4aa;
      --warn: #f2bb4f;
      --danger: #ff6b6b;
      --ok: #75d17c;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      overflow: hidden;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      height: 32px;
      border-radius: 6px;
      padding: 0 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #1b5f54; border-color: #267f71; }
    button.danger { background: #5d252a; border-color: #8c333d; }
    input, select {
      width: 100%;
      height: 32px;
      border: 1px solid var(--border);
      background: #0d0f12;
      color: var(--text);
      border-radius: 6px;
      padding: 0 9px;
      min-width: 0;
    }
    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .app {
      position: relative;
      height: 100vh;
      display: grid;
      --left-width: 320px;
      --right-width: 360px;
      grid-template-columns: var(--left-width) minmax(0, 1fr) var(--right-width);
      min-width: 640px;
      transition: grid-template-columns .18s ease;
    }
    .app.resizing { transition: none; }
    .app.left-collapsed  { grid-template-columns: 0 minmax(0, 1fr) var(--right-width); }
    .app.right-collapsed { grid-template-columns: var(--left-width) minmax(0, 1fr) 0; }
    .app.left-collapsed.right-collapsed { grid-template-columns: 0 minmax(0, 1fr) 0; }
    /* Hide sidebar borders when collapsed so no 1px seam remains. */
    .app.left-collapsed .sidebar { border-right-width: 0; }
    .app.right-collapsed .inspector { border-left-width: 0; }
    .edge-resizer {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 55;
      width: 12px;
      cursor: col-resize;
      touch-action: none;
      user-select: none;
      background: transparent;
      transition: left .18s ease, right .18s ease, background .12s;
    }
    .edge-resizer:hover,
    .app.resizing .edge-resizer {
      background: rgba(126, 231, 215, .08);
    }
    .app.resizing .edge-resizer { transition: none; }
    .edge-resizer-left  { left: var(--left-width); transform: translateX(-50%); }
    .edge-resizer-right { right: var(--right-width); transform: translateX(50%); }
    .app.left-collapsed  .edge-resizer-left  { left: 0; }
    .app.right-collapsed .edge-resizer-right { right: 0; }
    /* Small collapse handles centered vertically on each divider border.
       They are children of .app (no overflow clip) and track the column edge. */
    .edge-toggle {
      position: absolute;
      top: 50%;
      z-index: 60;
      width: 16px;
      height: 44px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      line-height: 1;
      color: var(--muted);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: col-resize;
      touch-action: none;
      user-select: none;
      transition: left .18s ease, right .18s ease, color .12s, border-color .12s, background .12s;
    }
    .app.resizing .edge-toggle { transition: none; }
    .edge-toggle:hover { color: var(--text); border-color: var(--accent); background: #1b1f26; }
    .edge-left  { left: var(--left-width); transform: translate(-50%, -50%); }
    .edge-right { right: var(--right-width); transform: translate(50%, -50%); }
    .app.left-collapsed  .edge-left  { left: 0;  transform: translate(0, -50%); }
    .app.right-collapsed .edge-right { right: 0; transform: translate(0, -50%); }
    .sidebar, .inspector {
      min-height: 0;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      background: var(--panel);
      border-right: 1px solid var(--border);
      display: grid;
      grid-template-rows: auto auto auto auto 1fr;
    }
    .inspector {
      border-right: 0;
      border-left: 1px solid var(--border);
      grid-template-rows: auto 1fr;
    }
    .sidebar > *, .inspector > * {
      min-width: 0;
      max-width: 100%;
    }
    .brand {
      padding: 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand > div {
      min-width: 0;
    }
    .brand strong { font-size: 15px; }
    .brand span, .path {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #connState {
      flex: 0 0 92px;
      max-width: 92px;
      text-align: right;
    }
    .form {
      padding: 12px;
      display: grid;
      gap: 9px;
      border-bottom: 1px solid var(--border);
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .start-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .start-options {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .start-options label[data-resume-field] {
      grid-column: 1 / -1;
    }
    .session-header {
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 48px;
    }
    .session-header strong {
      font-size: 13px;
      font-weight: 600;
    }
    .session-header label {
      width: 118px;
    }
    .sessions, .state {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-content: start;
      gap: 8px;
      scrollbar-width: thin;
      scrollbar-color: #3a3f4a transparent;
    }
    .sessions::-webkit-scrollbar, .state::-webkit-scrollbar { width: 8px; }
    .sessions::-webkit-scrollbar-track, .state::-webkit-scrollbar-track { background: transparent; }
    .sessions::-webkit-scrollbar-thumb, .state::-webkit-scrollbar-thumb { background: #3a3f4a; border-radius: 4px; }
    .session {
      border: 1px solid var(--border);
      background: #111418;
      border-radius: 8px;
      padding: 9px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 7px;
      cursor: pointer;
    }
    .session.active { border-color: var(--accent); }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .row strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 2px 6px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .badge.running { color: var(--ok); border-color: #3b7b44; }
    .badge.working, .badge.busy { color: var(--warn); border-color: #6b5a20; }
    .badge.stale, .badge.detached, .badge.idle { color: var(--muted); border-color: var(--border); }
    .badge.exited { color: var(--danger); border-color: #87434a; }
    .main {
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto 1fr;
      background: #0b0d10;
    }
    .toolbar {
      min-height: 48px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      overflow: hidden;
    }
    .toolbar .title {
      flex: 1 1 auto;
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .toolbar .title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .quick {
      display: flex;
      gap: 8px;
      flex-wrap: nowrap;
      align-items: center;
      flex: 0 0 auto;
    }
    /* Toolbar edge toggles for collapsing the side panels. */
    .icon-btn {
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      line-height: 1;
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 7px;
      cursor: pointer;
    }
    .icon-btn:hover { color: var(--text); border-color: var(--accent); }
    /* Compact actions dropdown so the top bar stays a single tidy row. */
    .menu-wrap { position: relative; display: inline-flex; }
    .menu-btn { white-space: nowrap; }
    .menu {
      position: fixed;
      z-index: 1000;
      min-width: 150px;
      padding: 5px;
      display: grid;
      gap: 2px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
    }
    .menu[hidden] { display: none; }
    .menu button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      padding: 7px 9px;
      border-radius: 6px;
      color: var(--text);
    }
    .menu button:hover { background: #1b1f26; }
    .menu .divider {
      height: 1px;
      margin: 4px 2px;
      background: var(--border);
    }
    .action-result {
      position: fixed;
      right: 16px;
      top: 64px;
      z-index: 1200;
      width: min(520px, calc(100vw - 32px));
      max-height: min(68vh, 640px);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0,0,0,.5);
      overflow: hidden;
    }
    .action-result[hidden] { display: none; }
    .action-result header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--border);
    }
    .action-result header strong { font-size: 13px; }
    .action-result pre {
      margin: 0;
      padding: 10px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text);
      background: #0d0f12;
    }
    /* Confirm dialog overlay */
    .dialog-overlay {
      position: fixed; inset: 0; z-index: 2000;
      background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
    }
    .dialog-overlay[hidden] { display: none; }
    .dialog {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 22px;
      min-width: 320px; max-width: 420px;
      display: grid; gap: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .dialog h3 { margin: 0; font-size: 15px; }
    .dialog .row { display: flex; gap: 12px; align-items: center; }
    .dialog .row label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
    .dialog .btns { display: flex; gap: 8px; justify-content: flex-end; }
    #terminal {
      min-height: 0;
      overflow: hidden;
      padding: 8px;
    }
    #terminal .xterm {
      cursor: default;
    }
    /* The terminal mirrors a tmux pane; keep xterm's own hidden helper textarea
       off-screen, but DO show the rendered block cursor (positioned from tmux). */
    #terminal .xterm-helper-textarea {
      caret-color: transparent !important;
      color: transparent !important;
      background: transparent !important;
      left: -10000px !important;
      top: 0 !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #111418;
      overflow: hidden;
    }
    .card.state-card {
      min-height: 0;
      max-height: min(34vh, 280px);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .card.state-card.state-card-collapsed {
      grid-template-rows: auto 0;
    }
    .card h2 {
      margin: 0;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .state-card-toggle {
      width: 100%;
      min-width: 0;
      border: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
      background: transparent;
      color: inherit;
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      text-align: left;
    }
    .state-card-toggle:hover { background: #151922; }
    .state-card-toggle-title {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }
    .state-card-toggle-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state-card-chevron {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }
    .state-card.state-card-collapsed .state-card-chevron {
      transform: rotate(-90deg);
    }
    .card .body {
      padding: 8px 10px;
      display: grid;
      gap: 6px;
    }
    .state-card .body {
      min-height: 0;
      max-height: min(28vh, 228px);
      overflow-y: auto;
      overflow-x: hidden;
      align-content: start;
      scrollbar-width: thin;
      scrollbar-color: #3a3f4a transparent;
    }
    .state-card.state-card-collapsed .body {
      display: none;
    }
    .state-card .body::-webkit-scrollbar { width: 8px; }
    .state-card .body::-webkit-scrollbar-track { background: transparent; }
    .state-card .body::-webkit-scrollbar-thumb { background: #3a3f4a; border-radius: 4px; }
    .item {
      display: grid;
      gap: 2px;
      font-size: 12px;
      color: var(--muted);
      border-bottom: 1px solid #242932;
      padding-bottom: 6px;
    }
    .item:last-child { border-bottom: 0; padding-bottom: 0; }
    .item strong { color: var(--text); font-size: 12px; }
    .item span { overflow-wrap: anywhere; }
    .mono { font-family: var(--mono); }
    .empty { color: var(--muted); font-size: 12px; }
    .sec-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: var(--muted); padding: 6px 10px 2px; display: flex; align-items: center; gap: 6px; }
    .sec-spacer { flex: 1 1 auto; }
    .sec-label button { height: 22px; padding: 0 7px; font-size: 10px; text-transform: none; letter-spacing: 0; }
    #terminal { display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div>
          <strong>hello-cc</strong>
          <div class="path" id="rootPath"></div>
        </div>
        <span id="connState" data-i18n="conn.offline">offline</span>
      </div>
      <div class="form" style="padding-top:10px;padding-bottom:10px">
        <div class="grid2">
          <label><span data-i18n="project">Project</span><select id="projectSelect"></select></label>
          <label><span data-i18n="language">Language</span><select id="langSelect"><option value="en">English</option><option value="zh">中文</option></select></label>
        </div>
        <label><span data-i18n="projectPath">Project path</span><input id="projectPath" data-i18n-placeholder="projectPathPlaceholder" placeholder="/path/to/project"></label>
        <button id="addProjectBtn" type="button" data-i18n="registerProject">Register Project</button>
      </div>
      <form class="form" id="startForm">
        <div class="start-row">
          <label><span data-i18n="newSession">New session</span><select id="kind"><option value="codex">codex</option><option value="claude">claude</option><option value="shell" data-i18n="kind.shell">shell</option></select></label>
          <button class="primary" type="submit" data-i18n="start">Start</button>
        </div>
        <div class="start-options">
          <label><span data-i18n="mode">Mode</span><select id="startMode"><option value="new" data-i18n="mode.new">new</option><option value="resume" data-i18n="mode.resume">resume</option><option value="last" data-i18n="mode.last">last</option><option value="continue" data-i18n="mode.continue">continue</option></select></label>
          <label data-resume-field><span data-i18n="session">Session</span><select id="resumeSelect"></select></label>
          <label data-resume-field data-resume-custom style="display:none"><span data-i18n="sessionId">Session id</span><input id="resumeArg" data-i18n-placeholder="sessionIdPlaceholder" placeholder="session id or name"></label>
        </div>
      </form>
      <div class="session-header">
        <strong data-i18n="sessions">Sessions</strong>
        <label><span data-i18n="view">View</span><select id="sessionKindFilter"><option value="all" data-i18n="kind.all">all</option><option value="claude">claude</option><option value="codex">codex</option><option value="shell" data-i18n="kind.shell">shell</option><option value="other" data-i18n="kind.other">other</option></select></label>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>

    <main class="main">
      <div class="toolbar">
        <div class="title">
          <strong id="activeTitle" data-i18n="noSessionSelected">No session selected</strong>
          <span class="path" id="activeMeta" data-i18n="startOrSelect">Start or select a session from the left panel</span>
        </div>
        <div class="quick" id="quickBar">
          <div class="menu-wrap">
            <button class="menu-btn" id="actionsBtn" type="button" aria-haspopup="true" aria-expanded="false"><span data-i18n="actions">Actions</span> ▾</button>
            <div class="menu" id="actionsMenu" hidden>
              <button data-action="state" data-i18n="action.state">state</button>
              <button data-action="status" data-i18n="action.status">status</button>
              <button data-action="inbox" data-i18n="action.inbox">inbox</button>
              <button data-action="task-next" data-i18n="action.claimNextTask">claim next task</button>
              <button data-action="heartbeat" data-i18n="action.renewHeartbeat">renew heartbeat</button>
              <div class="divider" role="separator"></div>
              <button data-action="register" data-i18n="action.reregister">re-register peer</button>
              <button data-terminal-action="status" data-i18n="action.runStatusTerminal">run status in terminal</button>
            </div>
          </div>
          <button class="danger" id="stopBtn" type="button" data-i18n="stop">stop</button>
        </div>
      </div>
      <div id="terminal" style="min-height:0;flex:1"></div>
      <div id="detectedPanel" style="display:none;overflow:auto;flex:1"></div>
    </main>

    <section class="action-result" id="actionResult" hidden aria-live="polite">
      <header>
        <strong id="actionResultTitle"></strong>
        <button id="actionResultClose" type="button" aria-label="Close">×</button>
      </header>
      <pre id="actionResultBody"></pre>
    </section>

    <aside class="inspector">
      <div class="brand">
        <strong data-i18n="projectState">Project State</strong>
        <button id="refreshBtn" type="button" data-i18n="refresh">Refresh</button>
      </div>
      <div class="state" id="state"></div>
    </aside>

    <button class="edge-toggle edge-left" id="toggleLeft" type="button" data-i18n-title="collapseSidebar" data-i18n-aria="toggleLeftSidebar" title="Collapse sidebar" aria-label="Toggle left sidebar">⟨</button>
    <button class="edge-toggle edge-right" id="toggleRight" type="button" data-i18n-title="collapseStatePanel" data-i18n-aria="toggleRightPanel" title="Collapse state panel" aria-label="Toggle right panel">⟩</button>
    <div class="edge-resizer edge-resizer-left" id="resizeLeft" role="separator" aria-orientation="vertical" data-i18n-aria="resizeLeftSidebar" data-i18n-title="resizeLeftSidebar" aria-label="Resize left sidebar" title="Resize left sidebar"></div>
    <div class="edge-resizer edge-resizer-right" id="resizeRight" role="separator" aria-orientation="vertical" data-i18n-aria="resizeRightPanel" data-i18n-title="resizeRightPanel" aria-label="Resize right panel" title="Resize right panel"></div>
  </div>

  <div class="dialog-overlay" id="stopDialog" hidden>
    <div class="dialog">
      <h3 id="stopDialogTitle">Stop session?</h3>
      <div class="path" id="stopDialogMeta" style="font-size:12px"></div>
      <div class="row"><label><input type="checkbox" id="stopKillCb"> <span id="stopKillLabel" data-i18n="dialog.killTmux">Also kill tmux session</span></label></div>
      <div class="btns">
        <button id="stopCancelBtn" type="button" data-i18n="dialog.cancel">Cancel</button>
        <button class="danger" id="stopConfirmBtn" type="button" data-i18n="stop">Stop</button>
      </div>
    </div>
  </div>

  <script src="/assets/xterm.js"></script>
  <script>
    const initialParams = new URLSearchParams(location.search);
    const token = initialParams.get('token') || '';
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    let currentProject = initialParams.get('project') || initialParams.get('root') || '';
    let projects = [];
    let sessionKindFilter = initialParams.get('kind') || 'all';
    let sessions  = [];    // managed (PTY) sessions
    let detected  = [];    // coordination-only peers (from hooks/watcher)
    let resumableCache = []; // provider sessions available to resume (from /api/resumable)
    let active    = null;  // active managed session id
    let activeDetected = null; // active detected peer id
    let activeType = 'managed'; // 'managed' | 'detected'
    let showStaleDetected = localStorage.getItem('hcc.showStaleDetected') === '1';
    let activePeerTtl = 600;
    let lastStateNow = 0;
    let lastStateRoot = '';
    let ws        = null;
    let wsReconnectTimer = null;
    let terminalHasContent = false;
    let terminalLastDataAt = 0;
    let terminalLastResizeAt = 0;
    let terminalLastReplaceAt = 0;
    let autoPollInFlight = false;
    let projectPollInFlight = false;
    const i18n = {
      en: {
        language: 'Language',
        project: 'Project',
        projectPath: 'Project path',
        projectPathPlaceholder: '/path/to/project',
        registerProject: 'Register Project',
        newSession: 'New session',
        start: 'Start',
        mode: 'Mode',
        'mode.new': 'new',
        'mode.resume': 'resume',
        'mode.last': 'last',
        'mode.continue': 'continue',
        session: 'Session',
        sessionId: 'Session id',
        sessionIdPlaceholder: 'session id or name',
        sessions: 'Sessions',
        view: 'View',
        'kind.all': 'all',
        'kind.shell': 'shell',
        'kind.other': 'other',
        noSessionSelected: 'No session selected',
        startOrSelect: 'Start or select a session from the left panel',
        actions: 'Actions',
        'action.state': 'state',
        'action.inbox': 'inbox',
        'action.claimNextTask': 'claim next task',
        'action.status': 'status',
        'action.renewHeartbeat': 'renew heartbeat',
        'action.reregister': 're-register peer',
        'action.runStatusTerminal': 'run status in terminal',
        actionResult: 'Action Result',
        stop: 'stop',
        projectState: 'Project State',
        refresh: 'Refresh',
        managed: 'Managed',
        detected: 'Detected',
        running: 'running',
        noActiveSessions: 'No active sessions.',
        startOneAbove: 'Start one above',
        orRunTerminal: 'or run in any terminal:',
        noDetectedPeers: 'No detected peers.',
        viewFilter: 'View filter',
        noTasks: 'No tasks.',
        noPeers: 'No peers.',
        noActiveLocks: 'No active locks.',
        noMessages: 'No messages.',
        noTimelineItems: 'No timeline items.',
        nextAction: 'Next Action',
        timeline: 'Timeline',
        messages: 'Messages',
        peers: 'Peers',
        tasks: 'Tasks',
        locks: 'Locks',
        owner: 'owner',
        assignee: 'assignee',
        task: 'task',
        all: 'all',
        next: 'next',
        finish: 'finish',
        warnings: 'warnings',
        noImmediateAction: 'No immediate coordination action',
        detectedSession: 'Detected Session',
        sendMessage: 'Send Message',
        messageHelp: "Message will appear in the peer's <code>hcc msg inbox</code> and be injected on next hook fire.",
        messageBodyPlaceholder: 'Message body...',
        send: 'Send',
        peer: 'peer',
        kind: 'kind',
        status: 'status',
        cwd: 'cwd',
        pid: 'pid',
        unknown: 'unknown',
        lastSeen: 'last seen',
        secondsAgo: 's ago',
        age: 'age',
        branch: 'branch',
        runtime: 'runtime',
        command: 'command',
        providerSession: 'provider session',
        activeDetected: 'Active detected',
        staleDetected: 'Stale detected',
        noActiveDetectedPeers: 'No active detected peers.',
        showStale: 'show stale',
        hideStale: 'hide stale',
        thread: 'thread',
        reply: 'reply',
        'status.active': 'active',
        'status.stale': 'stale',
        'status.unknown': 'unknown',
        'status.running': 'running',
        'status.idle': 'idle',
        'status.exited': 'exited',
        'status.claimed': 'claimed',
        'status.review': 'review',
        'status.blocked': 'blocked',
        'status.done': 'done',
        'status.abandoned': 'abandoned',
        'status.pending': 'pending',
        'conn.offline': 'offline',
        'conn.online': 'online',
        'conn.attached': 'attached',
        'conn.reconnecting': 'reconnecting...',
        'conn.coordinationOnly': 'coordination only',
        'conn.error': 'error',
        show: 'Show',
        collapse: 'Collapse',
        sidebar: 'sidebar',
        statePanel: 'state panel',
        dragToResize: 'drag to resize',
        collapseSidebar: 'Collapse sidebar',
        collapseStatePanel: 'Collapse state panel',
        toggleLeftSidebar: 'Toggle left sidebar',
        toggleRightPanel: 'Toggle right panel',
        resizeLeftSidebar: 'Resize left sidebar',
        resizeRightPanel: 'Resize right panel',
        customSession: 'custom session id...',
        'dialog.cancel': 'Cancel',
        'dialog.killTmux': 'Also kill tmux session',
        'action.stopPeer': 'Stop peer',
        'action.restartPeer': 'Restart peer',
        detectedPeer: 'detected peer'
      },
      zh: {
        language: '语言',
        project: '项目',
        projectPath: '项目路径',
        projectPathPlaceholder: '/项目/路径',
        registerProject: '注册项目',
        newSession: '新会话',
        start: '启动',
        mode: '模式',
        'mode.new': '新建',
        'mode.resume': '恢复',
        'mode.last': '最近',
        'mode.continue': '继续',
        session: '会话',
        sessionId: '会话 ID',
        sessionIdPlaceholder: '会话 ID 或名称',
        sessions: '会话',
        view: '视图',
        'kind.all': '全部',
        'kind.shell': 'shell',
        'kind.other': '其他',
        noSessionSelected: '未选择会话',
        startOrSelect: '从左侧面板启动或选择一个会话',
        actions: '操作',
        'action.state': '状态详情',
        'action.inbox': '收件箱',
        'action.claimNextTask': '认领下个任务',
        'action.status': '状态',
        'action.renewHeartbeat': '续期心跳',
        'action.reregister': '重新注册协作方',
        'action.runStatusTerminal': '在终端运行状态命令',
        actionResult: '操作结果',
        stop: '停止',
        projectState: '项目状态',
        refresh: '刷新',
        managed: '托管',
        detected: '检测到',
        running: '运行中',
        noActiveSessions: '没有活动会话。',
        startOneAbove: '在上方启动一个会话',
        orRunTerminal: '或在任意终端运行：',
        noDetectedPeers: '没有检测到的协作方。',
        viewFilter: '视图过滤',
        noTasks: '没有任务。',
        noPeers: '没有协作方。',
        noActiveLocks: '没有活动锁。',
        noMessages: '没有消息。',
        noTimelineItems: '没有时间线条目。',
        nextAction: '下一步',
        timeline: '时间线',
        messages: '消息',
        peers: '协作方',
        tasks: '任务',
        locks: '锁',
        owner: '负责人',
        assignee: '执行者',
        task: '任务',
        all: '全部',
        next: '下一步',
        finish: '收尾',
        warnings: '警告',
        noImmediateAction: '当前没有需要立即处理的协作动作',
        detectedSession: '检测到的会话',
        sendMessage: '发送消息',
        messageHelp: '消息会出现在该 peer 的 <code>hcc msg inbox</code> 中，并在下一次 hook 触发时注入。',
        messageBodyPlaceholder: '消息内容...',
        send: '发送',
        peer: '协作方',
        kind: '类型',
        status: '状态',
        cwd: '工作目录',
        pid: 'PID',
        unknown: '未知',
        lastSeen: '最后出现',
        secondsAgo: ' 秒前',
        age: '时长',
        branch: '分支',
        runtime: '运行时',
        command: '命令',
        providerSession: '提供方会话',
        activeDetected: '活跃检测',
        staleDetected: '过期检测',
        noActiveDetectedPeers: '没有活跃的检测协作方。',
        showStale: '显示过期',
        hideStale: '隐藏过期',
        thread: '线程',
        reply: '回复',
        'status.active': '活跃',
        'status.stale': '过期',
        'status.unknown': '未知',
        'status.running': '运行中',
        'status.idle': '空闲',
        'status.exited': '已退出',
        'status.claimed': '已认领',
        'status.review': '审查中',
        'status.blocked': '阻塞',
        'status.done': '完成',
        'status.abandoned': '已放弃',
        'status.pending': '待处理',
        'conn.offline': '离线',
        'conn.online': '在线',
        'conn.attached': '已连接',
        'conn.reconnecting': '重连中...',
        'conn.coordinationOnly': '仅协作',
        'conn.error': '错误',
        show: '显示',
        collapse: '折叠',
        sidebar: '侧栏',
        statePanel: '状态面板',
        dragToResize: '拖动调整大小',
        collapseSidebar: '折叠侧栏',
        collapseStatePanel: '折叠状态面板',
        toggleLeftSidebar: '切换左侧栏',
        toggleRightPanel: '切换右侧面板',
        resizeLeftSidebar: '调整左侧栏宽度',
        resizeRightPanel: '调整右侧面板宽度',
        customSession: '自定义会话 ID...',
        'dialog.cancel': '取消',
        'dialog.killTmux': '同时终止 tmux 会话',
        'action.stopPeer': '停止协作方',
        'action.restartPeer': '恢复协作方',
        detectedPeer: '检测到的协作方'
      }
    };
    let lang = localStorage.getItem('hcc.lang') || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    if (!i18n[lang]) lang = 'en';

    function tr(key, fallback = '') {
      return i18n[lang]?.[key] || i18n.en[key] || fallback || key;
    }

    function setText(id, key) {
      const el = document.getElementById(id);
      if (el) el.textContent = tr(key);
    }

    function connText(key) {
      const el = document.getElementById('connState');
      if (el) {
        el.dataset.stateKey = key;
        el.textContent = tr('conn.' + key);
      }
    }

    function applyLanguage() {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      localStorage.setItem('hcc.lang', lang);
      const sel = document.getElementById('langSelect');
      if (sel) sel.value = lang;
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
      document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
      document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', tr(el.dataset.i18nAria)); });
      if (!active && !activeDetected) {
        setText('activeTitle', 'noSessionSelected');
        setText('activeMeta', 'startOrSelect');
      }
      const stateKey = document.getElementById('connState')?.dataset.stateKey || 'offline';
      connText(stateKey);
      syncStartModeOptions();
      renderSections();
      if (activeType === 'detected' && activeDetected) {
        const draft = document.getElementById('detMsg')?.value || '';
        const peer = detected.find((p) => p.id === activeDetected) || { id: activeDetected };
        document.getElementById('activeTitle').textContent = activeDetected + ' (' + tr('detected') + ')';
        renderDetectedPanel(peer);
        const detMsg = document.getElementById('detMsg');
        if (detMsg && draft) detMsg.value = draft;
      } else if (activeType === 'managed' && active) {
        const meta = sessions.find((s) => s.id === active);
        if (meta) {
          document.getElementById('activeTitle').textContent = sessionPeerId(meta) || active;
          document.getElementById('activeMeta').textContent = sessionMetaText(meta);
        }
      }
      if (lastStateRoot) refreshCurrentState().catch(console.error);
      syncToggleIcons();
    }

    function requestQuery(extra = {}) {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (currentProject) params.set('root', currentProject);
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, value);
      }
      const text = params.toString();
      return text ? '?' + text : '';
    }

    function updateLocationProject() {
      const params = new URLSearchParams(location.search);
      if (token) params.set('token', token);
      if (currentProject) params.set('project', currentProject);
      if (sessionKindFilter && sessionKindFilter !== 'all') params.set('kind', sessionKindFilter);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0d10', foreground: '#eef2f6', cursor: '#7dd3fc', cursorAccent: '#0b0d10' }
    });
    term.open(document.getElementById('terminal'));

    // Accurate terminal sizing via character measurement
    function measureCharSize() {
      const el = document.getElementById('terminal');
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d');
      ctx2d.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      const m = ctx2d.measureText('M');
      return { w: m.width || 8, h: 17 };
    }

    function resizeTerm() {
      const el = document.getElementById('terminal');
      const { w, h } = measureCharSize();
      const cols = Math.max(60, Math.floor((el.clientWidth  - 16) / w));
      const rows = Math.max(10, Math.floor((el.clientHeight - 16) / h));
      term.resize(cols, rows);
      if (ws && ws.readyState === WebSocket.OPEN) {
        terminalLastResizeAt = Date.now();
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }
    window.addEventListener('resize', resizeTerm);
    setTimeout(resizeTerm, 80);

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    async function api(path, options = {}) {
      const res = await fetch(path + (path.includes('?') ? '&' : '?') + requestQuery().slice(1), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...headers, ...(options.headers || {}) }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'request failed');
      return json;
    }

    function renderProjects() {
      const select = document.getElementById('projectSelect');
      select.innerHTML = projects.map((p) =>
        '<option value="' + esc(p.root) + '">' + esc((p.name || p.root) + ' · ' + p.root) + '</option>'
      ).join('');
      if (currentProject) select.value = currentProject;
      document.getElementById('sessionKindFilter').value = sessionKindFilter;
    }

    function kindMatches(item) {
      const kind = ['claude', 'codex', 'shell'].includes(item.kind) ? item.kind : 'other';
      return sessionKindFilter === 'all' || kind === sessionKindFilter;
    }

    function syncStartModeOptions() {
      const kind = document.getElementById('kind').value;
      const modeSelect = document.getElementById('startMode');
      const current = modeSelect.value;
      const modes = kind === 'claude'
        ? [['new', 'new'], ['resume', 'resume'], ['continue', 'continue']]
        : kind === 'codex'
          ? [['new', 'new'], ['resume', 'resume'], ['last', 'last']]
          : [['new', 'new']];
      modeSelect.innerHTML = modes.map(([value]) => '<option value="' + value + '">' + tr('mode.' + value, value) + '</option>').join('');
      modeSelect.value = modes.some(([value]) => value === current) ? current : 'new';
      const isResume = modeSelect.value === 'resume';
      document.querySelector('[data-resume-field]:not([data-resume-custom])').style.display = isResume ? '' : 'none';
      if (isResume) loadResumable();
      else document.querySelector('[data-resume-custom]').style.display = 'none';
    }

    // Fetch provider sessions hcc knows about and fill the resume dropdown.
    async function loadResumable() {
      try { const d = await api('/api/resumable'); resumableCache = d.resumable || []; }
      catch { resumableCache = []; }
      populateResumeSelect();
    }
    function populateResumeSelect() {
      const kind = document.getElementById('kind').value;
      const sel = document.getElementById('resumeSelect');
      const prev = sel.value;
      const items = resumableCache.filter((r) => r.provider === kind);
      const opts = items.map((r) => {
        const resume = r.resume || r.session_id || r.session_name || '';
        const shortResume = resume.length > 14 ? resume.slice(0, 10) + '…' : resume;
        const label = (r.name && r.name !== resume ? r.name + ' · ' : '') + shortResume + ' (' + r.peer + ')';
        return '<option value="' + esc(resume) + '">' + esc(label) + '</option>';
      });
      opts.push('<option value="__custom__">' + esc(tr('customSession')) + '</option>');
      sel.innerHTML = opts.join('');
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      toggleResumeCustom();
    }
    function toggleResumeCustom() {
      const sel = document.getElementById('resumeSelect');
      document.querySelector('[data-resume-custom]').style.display = sel.value === '__custom__' ? '' : 'none';
    }

    async function loadProjects() {
      const data = await api('/api/projects');
      projects = data.projects || [];
      if (!currentProject) currentProject = data.current?.root || projects[0]?.root || '';
      renderProjects();
      updateLocationProject();
    }

    async function switchProject(root) {
      currentProject = root;
      updateLocationProject();
      active = null;
      activeDetected = null;
      activeType = 'managed';
      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); ws = null; }
      term.reset();
      document.getElementById('activeTitle').textContent = tr('noSessionSelected');
      document.getElementById('activeMeta').textContent = tr('startOrSelect');
      await Promise.all([refreshSessions(), refreshDetected(), refreshState()]);
      const first = sessions.find(s => s.status === 'running');
      if (first) connectManaged(first.id);
    }

    function esc(text) {
      return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function fmtTime(ts) {
      if (!ts) return '';
      return new Date(ts * 1000).toLocaleTimeString();
    }

    function badgeClass(status) {
      return String(status || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }

    function fmtAge(age) {
      const n = Number(age);
      if (!Number.isFinite(n)) return '?';
      return Math.max(0, Math.round(n)) + (lang === 'zh' ? '秒' : 's');
    }

    function sessionPeerId(session) {
      return session?.peer_id || session?.id || '';
    }

    function sessionRuntimeNote(session) {
      const target = sessionRuntimeTarget(session);
      return target ? tr('runtime') + '=' + target : '';
    }

    function sessionBinding(session) {
      return session?.binding || {};
    }

    function sessionRuntimeTarget(session) {
      const binding = sessionBinding(session);
      return binding.runtime_target || session?.pane || session?.id || '';
    }

    function runtimeTargetText(session) {
      return tr('runtime') + '=' + (sessionRuntimeTarget(session) || tr('unknown'));
    }

    function sessionProvider(session) {
      const binding = sessionBinding(session);
      return binding.provider || session?.kind || 'other';
    }

    function sessionProviderSessionValue(session) {
      const binding = sessionBinding(session);
      return session?.provider_session_label || binding.provider_session_id || binding.provider_session_name || '';
    }

    function providerSessionKnown(session) {
      return session?.provider_session_known === true || Boolean(sessionProviderSessionValue(session));
    }

    function sessionProviderSessionText(session) {
      const value = sessionProviderSessionValue(session);
      return tr('providerSession') + '=' + sessionProvider(session) + ':' + (value || tr('unknown'));
    }

    function sessionCardDetailText(session) {
      return [
        runtimeTargetText(session),
        sessionProviderSessionText(session),
        session?.cwd || ''
      ].filter(Boolean).join(' · ');
    }

    function sessionMetaText(session) {
      return [
        runtimeTargetText(session),
        sessionProviderSessionText(session),
        session?.command ? tr('command') + '=' + session.command : '',
        session?.cwd || ''
      ].filter(Boolean).join(' · ');
    }

    function statusText(status) {
      const value = String(status || 'unknown');
      return tr('status.' + value.toLowerCase(), value);
    }

    function lockLabel(lock) {
      const base = lock.base_resource || lock.resource || '';
      const scope = lock.scope || '*';
      return scope === '*' ? base : base + ' [' + scope + ']';
    }

    function managedPeerId(id) {
      return sessionPeerId(sessions.find((s) => s.id === id)) || id;
    }

    function peerIsActive(peer, basisNow = lastStateNow) {
      const age = Number(peer?.age_sec);
      if (Number.isFinite(age)) return age <= activePeerTtl;
      const seen = Number(peer?.last_seen_at || 0);
      const t = Number(basisNow || 0) || Math.floor(Date.now() / 1000);
      return seen > 0 && (t - seen) <= activePeerTtl;
    }

    function detectedPeerCanStop(peer) {
      const status = String(peer?.status || '').toLowerCase();
      if (['exited', 'detached'].includes(status)) return false;
      return peerIsActive(peer);
    }

    function peerStateView(peer, runtime = null, basisNow = lastStateNow) {
      const activity = peer?.status || 'unknown';
      const liveness = peerIsActive(peer, basisNow) ? 'active' : 'stale';
      const age = fmtAge(peer?.age_sec);
      const branch = peer?.branch ? ' ' + tr('branch') + '=' + peer.branch : '';
      if (runtime) {
        return {
          label: runtime.status || 'running',
          detail: tr('peer') + '=' + statusText(activity) + ' ' + statusText(liveness) + ' ' + tr('age') + '=' + age + branch
        };
      }
      if (liveness === 'stale') {
        return {
          label: 'stale',
          detail: tr('lastSeen') + '=' + statusText(activity) + ' ' + tr('age') + '=' + age + branch
        };
      }
      return {
        label: activity,
        detail: statusText(liveness) + ' ' + tr('age') + '=' + age + branch
      };
    }

    function taskOwnerStateText(task) {
      if (!task?.owner) return '';
      if (task.owner_stale) {
        if (task.takeover_ready) return 'owner_state=stale/no-lock';
        const locks = Number(task.related_lock_count || 0);
        return locks ? 'owner_state=stale/locks=' + locks : 'owner_state=stale';
      }
      if (task.owner_active) return 'owner_state=active';
      return '';
    }

    function bodyPinned(el) {
      if (!el) return false;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    }

    function stateCardCollapsed(section) {
      return localStorage.getItem('hcc.stateCard.' + section + '.collapsed') === '1';
    }

    function stateCardHtml(section, title, count, bodyHtml) {
      const collapsed = stateCardCollapsed(section);
      return \`
          <div class="card state-card \${collapsed ? 'state-card-collapsed' : ''}" data-section="\${esc(section)}">
            <button class="state-card-toggle" type="button" aria-expanded="\${collapsed ? 'false' : 'true'}">
              <span class="state-card-toggle-title"><strong>\${esc(title)}</strong> <span class="badge">\${esc(count)}</span></span>
              <span class="state-card-chevron">⌄</span>
            </button>
            <div class="body">\${bodyHtml}</div>
          </div>\`;
    }

    function bindStateCardToggles() {
      document.querySelectorAll('.state-card[data-section] .state-card-toggle').forEach((button) => {
        button.addEventListener('click', () => {
          const card = button.closest('.state-card[data-section]');
          if (!card) return;
          const section = card.dataset.section || '';
          const collapsed = !card.classList.contains('state-card-collapsed');
          card.classList.toggle('state-card-collapsed', collapsed);
          button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          localStorage.setItem('hcc.stateCard.' + section + '.collapsed', collapsed ? '1' : '0');
        });
      });
    }

    function renderTimelineItem(item) {
      const meta = [
        item.source + ':' + item.source_id,
        item.task_id ? tr('task') + ' #' + item.task_id : '',
        item.thread_id ? tr('thread') + ' #' + item.thread_id : '',
        item.direction || '',
        fmtTime(item.ts)
      ].filter(Boolean).join(' · ');
      return \`
          <div class="item timeline-item">
            <strong>\${esc(item.title || item.kind || item.source)} <span class="badge">\${esc(item.kind || item.source)}</span></strong>
            <span>\${esc(meta)}</span>
            \${item.text ? '<span>' + esc(item.text) + '</span>' : ''}
          </div>\`;
    }

    document.getElementById('projectSelect').addEventListener('change', (event) => {
      switchProject(event.target.value).catch(console.error);
    });
    document.getElementById('langSelect').addEventListener('change', (event) => {
      lang = event.target.value === 'zh' ? 'zh' : 'en';
      applyLanguage();
    });
    document.getElementById('sessionKindFilter').addEventListener('change', (event) => {
      sessionKindFilter = event.target.value || 'all';
      updateLocationProject();
      renderSections();
    });
    document.getElementById('addProjectBtn').addEventListener('click', async () => {
      const input = document.getElementById('projectPath');
      const root = input.value.trim();
      if (!root) return;
      await api('/api/projects', { method: 'POST', body: JSON.stringify({ root }) });
      input.value = '';
      await loadProjects();
      await switchProject(root);
    });

    // ── Sessions rendering (managed + detected) ──────────────────────────
    function renderSections() {
      const box = document.getElementById('sessions');
      const visibleSessions = sessions.filter(kindMatches);
      const visibleDetected = detected.filter(kindMatches);
      const activeDetectedPeers = visibleDetected.filter((p) => peerIsActive(p));
      const staleDetectedPeers = visibleDetected.filter((p) => !peerIsActive(p));
      const filterNote = sessionKindFilter === 'all' ? '' : '<br><br>' + esc(tr('viewFilter')) + ': ' + esc(sessionKindFilter);
      const shortSessionValue = (value) => {
        const text = String(value || '');
        return text.length > 14 ? text.slice(0, 10) + '...' : text;
      };
      const manHtml = visibleSessions.length
        ? visibleSessions.map((s) => {
          const peerId = sessionPeerId(s);
          const providerText = sessionProvider(s) + ':' + (providerSessionKnown(s) ? shortSessionValue(sessionProviderSessionValue(s)) : tr('unknown'));
          return \`
          <div class="session \${active === s.id && activeType === 'managed' ? 'active' : ''}" data-id="\${esc(s.id)}" data-type="managed">
            <div class="row"><strong>\${esc(peerId)}</strong><span class="badge \${badgeClass(s.status)}">\${esc(statusText(s.status))}</span></div>
            <div class="row"><span class="badge">\${esc(s.kind)}</span><span class="badge \${s.type === 'external' || s.type === 'tmux' ? 'warn' : ''}">\${s.type === 'external' ? 'external' : s.type === 'tmux' ? 'tmux' : 'pty'}</span><span class="badge \${providerSessionKnown(s) ? '' : 'stale'}" title="\${esc(sessionProviderSessionText(s))}">\${esc(providerText)}</span></div>
            <div class="path" title="\${esc(sessionMetaText(s))}">\${esc(sessionCardDetailText(s))}</div>
          </div>\`;
        }).join('')
        : '<div class="empty">' + esc(tr('noActiveSessions')) + filterNote + '<br><br>' + esc(tr('startOneAbove')) + '<br>' + esc(tr('orRunTerminal')) + '<br><code>hcc peer start X -- claude</code></div>';

      const renderDetectedPeer = (p) => {
          const state = peerStateView(p);
          const canStop = detectedPeerCanStop(p);
          return \`
          <div class="session \${activeDetected === p.id && activeType === 'detected' ? 'active' : ''}" data-id="\${esc(p.id)}" data-type="detected">
            <div class="row">
              <strong>\${esc(p.id)}</strong>
              <div style="display:flex;gap:6px;align-items:center">
                <span class="badge" style="color:var(--warn);border-color:#6b5a20">\${esc(tr('detected'))}</span>
                \${canStop ? \`
                <button class="stop-detected-btn" data-action="stop-detected" data-id="\${esc(p.id)}" title="\${esc(tr('action.stopPeer'))}" aria-label="\${esc(tr('action.stopPeer')) + ' ' + esc(p.id)}" type="button" style="flex:0 0 auto;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:5px;cursor:pointer">✕</button>
                \` : \`
                <button data-action="restart-detected" data-id="\${esc(p.id)}" title="\${esc(tr('action.restartPeer'))}" aria-label="\${esc(tr('action.restartPeer')) + ' ' + esc(p.id)}" type="button" style="flex:0 0 auto;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:var(--ok);background:transparent;border:1px solid var(--ok);border-radius:5px;cursor:pointer">↻</button>
                \`}
              </div>
            </div>
            <div class="row"><span class="badge">\${esc(p.kind)}</span><span class="badge \${badgeClass(state.label)}" title="\${esc(state.detail)}">\${esc(statusText(state.label))}</span></div>
            <div class="path" title="\${esc(p.worktree || '')}">\${esc((p.worktree || '').split('/').slice(-2).join('/'))}</div>
          </div>\`;
      };
      const activeDetectedHtml = activeDetectedPeers.length
        ? activeDetectedPeers.map(renderDetectedPeer).join('')
        : '<div class="empty">' + esc(tr('noActiveDetectedPeers')) + filterNote + '</div>';
      const staleToggleLabel = showStaleDetected ? tr('hideStale') : tr('showStale');
      const staleDetectedHtml = showStaleDetected
        ? (staleDetectedPeers.length ? staleDetectedPeers.map(renderDetectedPeer).join('') : '<div class="empty">' + esc(tr('noDetectedPeers')) + '</div>')
        : '';

      const savedScroll = box.scrollTop;
      box.innerHTML = \`
        <div class="sec-label">\${esc(tr('managed'))} <span class="badge">\${visibleSessions.filter(s=>s.status==='running').length} \${esc(tr('running'))}</span></div>
        \${manHtml}
        <div class="sec-label" style="margin-top:10px">\${esc(tr('activeDetected'))} <span class="badge" style="color:var(--warn)">\${activeDetectedPeers.length}</span></div>
        \${activeDetectedHtml}
        <div class="sec-label" style="margin-top:10px">\${esc(tr('staleDetected'))} <span class="badge">\${staleDetectedPeers.length}</span><span class="sec-spacer"></span><button id="toggleStaleDetected" type="button">\${esc(staleToggleLabel)}</button></div>
        \${staleDetectedHtml}
      \`;
      box.scrollTop = savedScroll;
      const staleToggle = document.getElementById('toggleStaleDetected');
      if (staleToggle) {
        staleToggle.addEventListener('click', () => {
          showStaleDetected = !showStaleDetected;
          localStorage.setItem('hcc.showStaleDetected', showStaleDetected ? '1' : '0');
          renderSections();
        });
      }
      box.querySelectorAll('.session[data-type="managed"]').forEach((el) => {
        el.addEventListener('click', () => connectManaged(el.dataset.id));
      });
      box.querySelectorAll('.session[data-type="detected"]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-action]')) return;
          connectDetected(el.dataset.id);
        });
      });
      box.querySelectorAll('[data-action="stop-detected"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const peerId = btn.dataset.id;
          document.getElementById('stopDialogTitle').textContent = tr('stop') + ' ' + peerId + '?';
          stopKillCb.checked = false;
          document.getElementById('stopDialogMeta').textContent = tr('detectedPeer');
          stopDialog._action = 'detected';
          stopDialog._peerId = peerId;
          stopDialog.hidden = false;
        });
      });
      box.querySelectorAll('[data-action="restart-detected"]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const peerId = btn.dataset.id;
          await api('/api/detected/' + encodeURIComponent(peerId) + '/restart', { method: 'POST', body: '{}' });
          await Promise.all([refreshSessions(), refreshDetected()]);
        });
      });
    }

    async function refreshSessions() {
      const data = await api('/api/sessions');
      sessions = data.sessions || [];
      renderSections();
      if (active && activeType === 'managed') {
        const meta = sessions.find((s) => s.id === active);
        if (meta) {
          document.getElementById('activeTitle').textContent = sessionPeerId(meta) || active;
          document.getElementById('activeMeta').textContent = sessionMetaText(meta);
        }
      }
      connText('online');
    }

    async function refreshDetected() {
      try {
        const data = await api('/api/detected');
        activePeerTtl = Number(data.active_peer_ttl || activePeerTtl);
        lastStateNow = Number(data.now || lastStateNow);
        detected = data.detected || [];
        renderSections();
      } catch {}
    }

    // ── Project state panel ───────────────────────────────────────────────
    function renderState(data) {
      const stateRoot = data.root || '';
      document.getElementById('rootPath').textContent = stateRoot;
      activePeerTtl = Number(data.active_peer_ttl || activePeerTtl);
      lastStateNow = Number(data.now || lastStateNow);
      const state = document.getElementById('state');
      const preserveScroll = lastStateRoot === stateRoot;
      const savedStateScroll = preserveScroll ? state.scrollTop : 0;
      const savedCardScroll = preserveScroll
        ? new Map(
          [...state.querySelectorAll('.state-card[data-section]')].map((card) => [
            card.dataset.section,
            {
              top: card.querySelector('.body')?.scrollTop || 0,
              pinned: bodyPinned(card.querySelector('.body'))
            }
          ])
        )
        : new Map();
      const runtimeById = new Map();
      for (const session of sessions || []) {
        runtimeById.set(session.id, session);
        const peerId = sessionPeerId(session);
        if (peerId) runtimeById.set(peerId, session);
      }
      const tasksData = data.tasks || [];
      const peersData = data.peers || [];
      const locksData = data.locks || [];
      const messagesData = data.messages || [];
      const timelineData = data.timeline || [];
      const automation = data.automation || {};
      const nextAction = automation.next_action || {};
      const tasks = tasksData.map((t) => \`
          <div class="item"><strong>#\${t.id} \${esc(t.title)}</strong><span>\${esc(statusText(t.status))} \${esc(tr('owner'))}=\${esc(t.owner || '')} \${esc(tr('assignee'))}=\${esc(t.assignee || '')}\${taskOwnerStateText(t) ? ' · ' + esc(taskOwnerStateText(t)) : ''}</span></div>
        \`).join('') || '<div class="empty">' + esc(tr('noTasks')) + '</div>';
      const peers = peersData.map((a) => {
        const peerRuntime = runtimeById.get(a.id);
        const peerState = peerStateView(a, peerRuntime, data.now);
        return \`
        <div class="item"><strong>\${esc(a.id)} <span class="badge">\${esc(a.kind)}</span> <span class="badge \${badgeClass(peerState.label)}">\${esc(statusText(peerState.label))}</span></strong><span>\${esc(peerState.detail)}</span></div>
      \`;
      }).join('') || '<div class="empty">' + esc(tr('noPeers')) + '</div>';
      const locks = locksData.map((l) => \`
          <div class="item"><strong>\${esc(lockLabel(l))}</strong><span>\${esc(tr('owner'))}=\${esc(l.owner)} \${esc(tr('task'))}=\${l.task_id ? '#' + l.task_id : ''}</span></div>
        \`).join('') || '<div class="empty">' + esc(tr('noActiveLocks')) + '</div>';
      const messages = messagesData.map((m) => \`
          <div class="item"><strong>#\${m.id} \${esc(m.sender)} → \${esc(m.recipient || tr('all'))}\${m.reply_to ? ' ' + esc(tr('reply')) + ' #' + m.reply_to : ''}</strong><span>\${esc(m.body)}</span></div>
        \`).join('') || '<div class="empty">' + esc(tr('noMessages')) + '</div>';
      const timeline = timelineData.map(renderTimelineItem).join('') || '<div class="empty">' + esc(tr('noTimelineItems')) + '</div>';
      const actionLines = [
        '<div class="item"><strong>' + esc(statusText(automation.phase || 'idle')) + '</strong><span>' + esc(nextAction.reason || tr('noImmediateAction')) + '</span></div>',
        nextAction.command ? '<div class="item"><strong>' + esc(tr('next')) + '</strong><span class="mono">' + esc(nextAction.command) + '</span></div>' : '',
        (automation.finish_actions || []).length ? '<div class="item"><strong>' + esc(tr('finish')) + '</strong><span>' + esc(automation.finish_actions.map((a) => a.command).join(' | ')) + '</span></div>' : '',
        (automation.warnings || []).length ? '<div class="item"><strong>' + esc(tr('warnings')) + '</strong><span>' + esc(automation.warnings.join(' | ')) + '</span></div>' : ''
      ].filter(Boolean).join('');
      state.innerHTML = [
        stateCardHtml('automation', tr('nextAction'), statusText(automation.phase || 'idle'), actionLines),
        stateCardHtml('timeline', tr('timeline'), timelineData.length, timeline),
        stateCardHtml('messages', tr('messages'), messagesData.length, messages),
        stateCardHtml('peers', tr('peers'), peersData.length, peers),
        stateCardHtml('tasks', tr('tasks'), tasksData.length, tasks),
        stateCardHtml('locks', tr('locks'), locksData.length, locks)
      ].join('');
      state.scrollTop = savedStateScroll;
      for (const [section, saved] of savedCardScroll) {
        const body = state.querySelector('.state-card[data-section="' + section + '"] .body');
        if (!body) continue;
        if (section === 'timeline' && saved.pinned) body.scrollTop = body.scrollHeight;
        else body.scrollTop = saved.top;
      }
      bindStateCardToggles();
      lastStateRoot = stateRoot;
    }

    async function refreshState() {
      const peer = active ? managedPeerId(active) : null;
      const p = peer ? '/api/state?peer=' + encodeURIComponent(peer) : '/api/state';
      const data = await api(p);
      renderState(data);
    }

    async function refreshDetectedState() {
      if (!activeDetected) return;
      const data = await api('/api/state?peer=' + encodeURIComponent(activeDetected));
      renderState(data);
    }

    async function refreshCurrentState() {
      if (activeType === 'detected') return refreshDetectedState();
      return refreshState();
    }

    async function refreshVisibleData() {
      if (autoPollInFlight) return;
      autoPollInFlight = true;
      try {
        await Promise.all([
          refreshSessions(),
          refreshDetected(),
          activeType === 'detected' ? refreshDetectedState() : (active ? refreshState() : Promise.resolve())
        ]);
      } finally {
        autoPollInFlight = false;
      }
    }

    async function refreshProjectsQuietly() {
      if (projectPollInFlight) return;
      projectPollInFlight = true;
      try {
        await loadProjects();
      } finally {
        projectPollInFlight = false;
      }
    }

    // ── Connect to managed (PTY) session ─────────────────────────────────
    function connectManaged(id) {
      const meta = sessions.find((s) => s.id === id);
      const peerId = sessionPeerId(meta) || id;
      active = id;
      activeDetected = null;
      activeType = 'managed';
      renderSections();
      document.getElementById('activeTitle').textContent = peerId;
      document.getElementById('activeMeta').textContent = meta ? sessionMetaText(meta) : '';
      document.getElementById('terminal').style.display = '';
      document.getElementById('detectedPanel').style.display = 'none';
      document.getElementById('quickBar').style.display = '';

      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); }
      term.reset();
      terminalHasContent = false;
      terminalLastDataAt = 0;
      terminalLastReplaceAt = 0;
      terminalLastResizeAt = Date.now();
      openWs(id);
      refreshState().catch(console.error);
    }

    function terminalPinned() {
      try {
        const b = term.buffer.active;
        return b.viewportY >= b.baseY;
      } catch {
        return true;
      }
    }

    function writeTerminalSnapshot(data, pinned = true) {
      term.reset();
      terminalHasContent = Boolean(data);
      terminalLastReplaceAt = Date.now();
      term.write(data || '', pinned ? () => { term.scrollToBottom(); } : undefined);
    }

    function shouldApplyTerminalReplace() {
      const t = Date.now();
      if (!terminalHasContent) return true;
      if (t - terminalLastResizeAt <= 1500) return true;
      // Server fallback replace frames are useful for recovery, but applying
      // them during normal idle chat causes visible rollback/flicker.
      return document.visibilityState !== 'visible' &&
        t - terminalLastDataAt > 30000 &&
        t - terminalLastReplaceAt > 15000;
    }

    function openWs(id) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws/terminal/' + encodeURIComponent(id) + requestQuery());
      ws.onopen = () => {
        resizeTerm();
        connText('attached');
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const pinned = terminalPinned();
        // The server streams the tmux pane's raw output, so xterm renders
        // incrementally (no reset/redraw → no flicker) and the program's own
        // escape sequences carry the cursor.
        if (msg.type === 'snapshot') { writeTerminalSnapshot(msg.data || '', true); }
        if (msg.type === 'data') {
          terminalHasContent = true;
          terminalLastDataAt = Date.now();
          term.write(msg.data || '', pinned ? () => { term.scrollToBottom(); } : undefined);
        }
        if (msg.type === 'replace' && shouldApplyTerminalReplace()) {
          writeTerminalSnapshot(msg.data || '', pinned);
        }
        if (msg.type === 'exit') { refreshSessions().catch(console.error); }
      };
      ws.onclose = () => {
        connText('reconnecting');
        // Auto-reconnect if session is still in the list and running
        wsReconnectTimer = setTimeout(() => {
          const s = sessions.find((s) => s.id === id);
          if (s && s.status === 'running' && active === id) openWs(id);
          else connText('online');
        }, 2000);
      };
    }

    // ── Connect to detected (coordination-only) peer ──────────────────────
    function connectDetected(id) {
      const peer = detected.find((p) => p.id === id);
      active = null;
      activeDetected = id;
      activeType = 'detected';
      if (ws) { clearTimeout(wsReconnectTimer); ws.close(); ws = null; }
      renderSections();
      document.getElementById('activeTitle').textContent = id + ' (' + tr('detected') + ')';
      document.getElementById('activeMeta').textContent = peer ? peer.kind + ' · ' + (peer.worktree || '') : '';
      document.getElementById('terminal').style.display = 'none';
      document.getElementById('detectedPanel').style.display = '';
      document.getElementById('quickBar').style.display = 'none';
      connText('coordinationOnly');
      renderDetectedPanel(peer || { id });
      refreshDetectedState().catch(console.error);
    }

    function renderDetectedPanel(peer) {
      const dp = document.getElementById('detectedPanel');
      dp.innerHTML = \`
        <div style="padding:16px;display:grid;gap:12px">
          <div class="card">
            <h2>\${esc(tr('detectedSession'))}</h2>
            <div class="body">
              <div class="item"><strong>\${esc(tr('peer'))}</strong><span class="mono">\${esc(peer.id)}</span></div>
              <div class="item"><strong>\${esc(tr('kind'))}</strong><span>\${esc(peer.kind || '')}</span></div>
              <div class="item"><strong>\${esc(tr('status'))}</strong><span>\${esc(peer.status || '')}</span></div>
              <div class="item"><strong>\${esc(tr('cwd'))}</strong><span class="mono" style="font-size:11px">\${esc(peer.worktree || '')}</span></div>
              <div class="item"><strong>\${esc(tr('pid'))}</strong><span>\${esc(peer.pid || tr('unknown'))}</span></div>
              <div class="item"><strong>\${esc(tr('lastSeen'))}</strong><span>\${peer.age_sec != null ? esc(peer.age_sec + tr('secondsAgo')) : ''}</span></div>
            </div>
          </div>
          <div class="card">
            <h2>\${esc(tr('sendMessage'))}</h2>
            <div class="body" style="gap:8px">
              <div style="font-size:12px;color:var(--muted)">\${tr('messageHelp')}</div>
              <textarea id="detMsg" rows="3" style="width:100%;background:#0d0f12;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font:inherit;resize:vertical" placeholder="\${esc(tr('messageBodyPlaceholder'))}"></textarea>
              <button class="primary" id="sendDetMsg">\${esc(tr('send'))}</button>
            </div>
          </div>
        </div>
      \`;
      document.getElementById('sendDetMsg').addEventListener('click', async () => {
        const body = document.getElementById('detMsg').value.trim();
        if (!body) return;
        await api('/api/detected/' + encodeURIComponent(peer.id) + '/msg', {
          method: 'POST',
          body: JSON.stringify({ body, from: 'web' })
          });
          document.getElementById('detMsg').value = '';
          await refreshDetectedState();
        });
      }

    // ── Helpers ───────────────────────────────────────────────────────────
    function sendLine(text) {
      if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data: text + '\\r' }));
    }

    // ── Start session form ────────────────────────────────────────────────
    document.getElementById('kind').addEventListener('change', syncStartModeOptions);
    document.getElementById('startMode').addEventListener('change', syncStartModeOptions);
    document.getElementById('resumeSelect').addEventListener('change', toggleResumeCustom);
    syncStartModeOptions();

    document.getElementById('startForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const kind = document.getElementById('kind').value;
      const mode = document.getElementById('startMode').value;
      const sel = document.getElementById('resumeSelect');
      const resume = (sel.value && sel.value !== '__custom__')
        ? sel.value
        : document.getElementById('resumeArg').value.trim();
      if (mode === 'resume' && !resume) return;
      const payload = { kind, mode };
      if (mode === 'resume') payload.resume = resume;
      const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
      await refreshSessions();
      connectManaged(data.session.id);
    });

    function activePeerInfo() {
      if (!active) return null;
      const session = sessions.find((s) => s.id === active) || { id: active, kind: 'other', role: 'peer' };
      return {
        session,
        peerId: sessionPeerId(session) || active
      };
    }

    function terminalCommandForAction(action, info) {
      const session = info.session || {};
      const peerId = info.peerId;
      const lines = {
        register: \`hcc register --peer \${peerId} --kind \${session.kind || 'other'} --role \${session.role || 'peer'}\`,
        inbox:    \`hcc msg inbox --peer \${peerId}\`,
        'task-next': \`hcc task next --peer \${peerId}\`,
        state:    \`hcc state --peer \${peerId}\`,
        status:   \`hcc status --peer \${peerId}\`,
        heartbeat:\`hcc heartbeat --peer \${peerId} --renew-locks\`
      };
      return lines[action] || lines.status;
    }

    function formatActionResult(result) {
      if (!result) return '';
      const data = result.data || {};
      if (result.action === 'status') {
        const tasks = (data.tasks || []).map((row) => row.status + ':' + row.n).join(', ') || 'none';
        return [
          data.root,
          'peers active=' + data.active_peers + ' stale=' + data.stale_peers,
          'tasks ' + tasks,
          'locks active=' + data.active_locks,
          'unread ' + (data.unread ?? 0)
        ].filter(Boolean).join('\\n');
      }
      if (result.action === 'state') {
        const automation = data.automation || {};
        const next = automation.next_action || {};
        return [
          'phase: ' + (automation.phase || 'idle'),
          'next: ' + (next.command || next.kind || 'none'),
          'why: ' + (next.reason || tr('noImmediateAction')),
          ...(automation.warnings || []).map((w) => 'warning: ' + w)
        ].join('\\n');
      }
      if (result.action === 'inbox') {
        const messages = data.messages || [];
        return messages.length
          ? messages.map((m) => '#' + m.id + ' ' + m.sender + ' -> ' + (m.recipient || 'all') + ': ' + m.body).join('\\n')
          : tr('noMessages');
      }
      if (result.action === 'task-next') {
        return data.task
          ? (data.current ? 'current ' : 'claimed ') + '#' + data.task.id + ' ' + data.task.title + ' (' + data.task.status + ')'
          : result.summary;
      }
      if (result.action === 'task-takeover') {
        return data.task ? '#' + data.task.id + ' ' + data.task.title + ' -> ' + data.task.owner : result.summary;
      }
      if (result.action === 'lock-acquire') {
        return data.lock ? 'locked ' + lockLabel(data.lock) + ' by ' + data.lock.owner : result.summary;
      }
      if (result.action === 'lock-release') {
        return result.summary || JSON.stringify(data.result || data, null, 2);
      }
      return result.summary || JSON.stringify(result, null, 2);
    }

    function showActionResult(result) {
      const panel = document.getElementById('actionResult');
      document.getElementById('actionResultTitle').textContent = (result.action || tr('actionResult')) + ' · ' + (result.peer || '');
      document.getElementById('actionResultBody').textContent = formatActionResult(result);
      panel.hidden = false;
    }

    async function runPeerAction(action) {
      const info = activePeerInfo();
      if (!info) return;
      const payload = action === 'register'
        ? { kind: info.session.kind || 'other', role: info.session.role || 'peer', worktree: info.session.cwd || currentProject }
        : action === 'heartbeat'
          ? { renew_locks: true }
          : {};
      const readOnly = ['status', 'state', 'inbox'].includes(action);
      const result = await api('/api/peers/' + encodeURIComponent(info.peerId) + '/actions/' + encodeURIComponent(action), readOnly
        ? {}
        : { method: 'POST', body: JSON.stringify(payload) });
      showActionResult(result);
      await Promise.all([refreshSessions(), refreshDetected(), refreshCurrentState()]);
    }

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        closeActionsMenu();
        runPeerAction(button.dataset.action).catch((err) => {
          showActionResult({ action: button.dataset.action, peer: activePeerInfo()?.peerId || '', summary: err.message, data: { error: err.message } });
        });
      });
    });
    document.querySelectorAll('[data-terminal-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const info = activePeerInfo();
        if (!info) return;
        sendLine(terminalCommandForAction(button.dataset.terminalAction, info));
        closeActionsMenu();
      });
    });
    document.getElementById('actionResultClose').addEventListener('click', () => {
      document.getElementById('actionResult').hidden = true;
    });

    // ── Stop confirmation dialog ───────────────────────────────────────
    const stopDialog = document.getElementById('stopDialog');
    const stopConfirmBtn = document.getElementById('stopConfirmBtn');
    const stopCancelBtn = document.getElementById('stopCancelBtn');
    const stopKillCb = document.getElementById('stopKillCb');

    // ── Actions dropdown (declutters the toolbar) ─────────────────────────
    const actionsBtn = document.getElementById('actionsBtn');
    const actionsMenu = document.getElementById('actionsMenu');
    function closeActionsMenu() {
      actionsMenu.hidden = true;
      actionsBtn.setAttribute('aria-expanded', 'false');
    }
    actionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = actionsMenu.hidden;
      actionsMenu.hidden = !open;
      actionsBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        // Position as a fixed layer so it escapes the toolbar/main overflow clip.
        const r = actionsBtn.getBoundingClientRect();
        actionsMenu.style.top = (r.bottom + 6) + 'px';
        actionsMenu.style.left = Math.max(8, r.right - actionsMenu.offsetWidth) + 'px';
      }
    });
    document.addEventListener('click', (e) => {
      if (!actionsMenu.hidden && !e.target.closest('.menu-wrap')) closeActionsMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionsMenu(); });

    // ── Collapsible side panels ───────────────────────────────────────────
    const appEl = document.querySelector('.app');
    const toggleLeftBtn = document.getElementById('toggleLeft');
    const toggleRightBtn = document.getElementById('toggleRight');
    const resizeLeftHandle = document.getElementById('resizeLeft');
    const resizeRightHandle = document.getElementById('resizeRight');
    const sideDefaults = { left: 320, right: 360 };
    const sideMin = { left: 220, right: 240 };
    const sideMax = { left: 560, right: 640 };
    const sideWidthKey = { left: 'hcc.sidebar.left.width', right: 'hcc.sidebar.right.width' };
    const dragState = { side: null, startX: 0, startWidth: 0, moved: false, suppressClick: false };
    function sideIsCollapsed(side) {
      return appEl.classList.contains(side + '-collapsed') || localStorage.getItem('hcc.collapse.' + side) === '1';
    }
    function storedSideWidth(side) {
      const raw = Number(localStorage.getItem(sideWidthKey[side]));
      return Number.isFinite(raw) && raw > 0 ? raw : sideDefaults[side];
    }
    function effectiveOppositeWidth(side) {
      const opposite = side === 'left' ? 'right' : 'left';
      return sideIsCollapsed(opposite) ? 0 : storedSideWidth(opposite);
    }
    function clampSideWidth(side, width) {
      const viewport = Math.max(640, window.innerWidth || appEl.clientWidth || 0);
      const opposite = effectiveOppositeWidth(side);
      const maxByViewport = Math.max(sideMin[side], viewport - opposite - 280);
      return Math.max(sideMin[side], Math.min(sideMax[side], maxByViewport, Math.round(width)));
    }
    function readSideWidth(side) {
      return clampSideWidth(side, storedSideWidth(side));
    }
    function setSideWidth(side, width, persist = true) {
      const value = clampSideWidth(side, width);
      appEl.style.setProperty('--' + side + '-width', value + 'px');
      if (persist) localStorage.setItem(sideWidthKey[side], String(value));
      return value;
    }
    function applySideWidths() {
      setSideWidth('left', readSideWidth('left'), false);
      setSideWidth('right', readSideWidth('right'), false);
    }
    function syncToggleIcons() {
      const l = appEl.classList.contains('left-collapsed');
      const r = appEl.classList.contains('right-collapsed');
      toggleLeftBtn.textContent = l ? '⟩' : '⟨';
      toggleLeftBtn.title = (l ? tr('show') : tr('collapse')) + ' ' + tr('sidebar') + '; ' + tr('dragToResize');
      toggleRightBtn.textContent = r ? '⟨' : '⟩';
      toggleRightBtn.title = (r ? tr('show') : tr('collapse')) + ' ' + tr('statePanel') + '; ' + tr('dragToResize');
    }
    function applyCollapseState() {
      appEl.classList.toggle('left-collapsed', localStorage.getItem('hcc.collapse.left') === '1');
      appEl.classList.toggle('right-collapsed', localStorage.getItem('hcc.collapse.right') === '1');
      applySideWidths();
      syncToggleIcons();
    }
    function toggleSide(side) {
      const cls = side + '-collapsed';
      const on = appEl.classList.toggle(cls);
      localStorage.setItem('hcc.collapse.' + side, on ? '1' : '0');
      applySideWidths();
      syncToggleIcons();
      // Refit the terminal after the grid transition so xterm uses the new width.
      setTimeout(() => { try { resizeTerm(); } catch {} }, 200);
    }
    function beginSideDrag(side, event) {
      if (event.button !== undefined && event.button !== 0) return;
      dragState.side = side;
      dragState.startX = event.clientX;
      dragState.startWidth = readSideWidth(side);
      dragState.moved = false;
      dragState.suppressClick = false;
      appEl.classList.add('resizing');
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }
    function moveSideDrag(event) {
      if (!dragState.side) return;
      const delta = event.clientX - dragState.startX;
      if (!dragState.moved && Math.abs(delta) <= 3) return;
      dragState.moved = true;
      const width = dragState.side === 'left'
        ? dragState.startWidth + delta
        : dragState.startWidth - delta;
      setSideWidth(dragState.side, width);
      if (dragState.side === 'left') {
        appEl.classList.remove('left-collapsed');
        localStorage.setItem('hcc.collapse.left', '0');
      } else {
        appEl.classList.remove('right-collapsed');
        localStorage.setItem('hcc.collapse.right', '0');
      }
      syncToggleIcons();
      try { resizeTerm(); } catch {}
      event.preventDefault();
    }
    function endSideDrag(event) {
      if (!dragState.side) return;
      dragState.suppressClick = dragState.moved;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      dragState.side = null;
      appEl.classList.remove('resizing');
      setTimeout(() => { dragState.suppressClick = false; }, 0);
      try { resizeTerm(); } catch {}
    }
    function bindSideHandle(handle, side, clickAction = null) {
      handle.addEventListener('pointerdown', (event) => beginSideDrag(side, event));
      handle.addEventListener('pointermove', moveSideDrag);
      handle.addEventListener('pointerup', endSideDrag);
      handle.addEventListener('pointercancel', endSideDrag);
      handle.addEventListener('click', (event) => {
        if (dragState.suppressClick) {
          event.preventDefault();
          return;
        }
        if (clickAction) clickAction(side);
      });
    }
    bindSideHandle(resizeLeftHandle, 'left');
    bindSideHandle(resizeRightHandle, 'right');
    bindSideHandle(toggleLeftBtn, 'left', toggleSide);
    bindSideHandle(toggleRightBtn, 'right', toggleSide);
    window.addEventListener('resize', () => {
      applySideWidths();
      setTimeout(() => { try { resizeTerm(); } catch {} }, 50);
    });
    applyCollapseState();

    document.getElementById('stopBtn').addEventListener('click', () => {
      if (!active) return;
      const session = sessions.find((s) => s.id === active) || {};
      document.getElementById('stopDialogTitle').textContent = tr('stop') + ' ' + (sessionPeerId(session) || active) + '?';
      stopKillCb.checked = false;
      const meta = sessionMetaText(session);
      document.getElementById('stopDialogMeta').textContent = meta || '';
      stopDialog._action = null; stopDialog._peerId = null;
      stopDialog.hidden = false;
    });
    document.getElementById('refreshBtn').addEventListener('click', () => {
      refreshVisibleData().catch(console.error);
    });

    applyLanguage();
    loadProjects().then(() => Promise.all([refreshSessions(), refreshDetected(), refreshState()])).then(() => {
      // Auto-connect to first running managed session on load
      if (!active && !activeDetected) {
        const first = sessions.find(s => s.status === 'running');
        if (first) connectManaged(first.id);
      }
    }).catch((err) => {
      connText('error');
      console.error(err);
    });
    // ── Auto-poll state ──────────────────────────────────────────────────
    setInterval(() => {
      refreshVisibleData().catch(console.error);
    }, 3000);
    setInterval(() => {
      refreshProjectsQuietly().catch(console.error);
    }, 8000);

    stopCancelBtn.addEventListener('click', () => { stopDialog.hidden = true; });
    stopDialog.addEventListener('click', (e) => { if (e.target === stopDialog) stopDialog.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !stopDialog.hidden) stopDialog.hidden = true; });

    stopConfirmBtn.addEventListener('click', async () => {
      stopDialog.hidden = true;
      const killTmux = stopKillCb.checked;
      if (stopDialog._action === 'detected') {
        const peerId = stopDialog._peerId;
        stopDialog._action = null; stopDialog._peerId = null;
        if (!peerId) return;
        await api('/api/detected/' + encodeURIComponent(peerId) + '/stop', { method: 'POST', body: JSON.stringify({ kill_tmux: killTmux }) });
        await Promise.all([refreshSessions(), refreshDetected()]);
      } else {
        if (!active) return;
        await api('/api/sessions/' + encodeURIComponent(active) + '/stop', { method: 'POST', body: JSON.stringify({ kill_tmux: killTmux }) });
        await refreshSessions();
      }
    });
  </script>
</body>
</html>`;
}
