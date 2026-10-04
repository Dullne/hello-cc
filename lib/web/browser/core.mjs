import { createSessionSync } from './session-sync.mjs';
import { createProjectRequests, sharedProjectBroker, scheduleVisiblePoll } from './project-data.mjs';
import { installHandoff } from '../ui-handoff.mjs';
import { installWorkbench } from '../ui-workbench.mjs';
import { installCodexPanel } from '../ui-codex.mjs';
import { installHistory } from '../ui-history.mjs';
import { installReview } from '../ui-review.mjs';
import { installNativePanel } from '../ui-native.mjs';
import { installAgentStart } from '../ui-agent-start.mjs';
import { installAgentDefaults } from '../ui-agent-defaults.mjs';
import { installFiles } from '../ui-files.mjs';
import { installTerminalFind } from '../ui-terminal-find.mjs';
import { installCommandPalette } from '../ui-command-palette.mjs';
import { installWorkspace } from '../ui-workspace.mjs';
import { API_VERSION } from '../api-version.mjs';
import { TERMINAL_THEMES } from '../ui-preferences.mjs';

    const auxiliaryPage = window.hccDraftScope === 'auxiliary';
    const sameOriginFrame = (() => {
      try { return window.parent !== window && window.parent.location.origin === location.origin; }
      catch { return false; }
    })();
    // /pane is cookie-gated, but may still be visited as a top-level URL.
    // Only an actual same-origin embed gets pane behavior and its draft scope.
    if (auxiliaryPage && !sameOriginFrame) {
      window.hccDraftScope = '';
      document.documentElement.classList.remove('session-pane');
    }
    installHandoff();
    installWorkbench();
    const hccUi = window.hccUi;
    const paneMode = auxiliaryPage && sameOriginFrame;
    const handoffStore = window.hccHandoffStore;
    const initialParams = new URLSearchParams(location.search);
    let loggedOut = false;
    try { sessionStorage.removeItem('hcc_logged_out'); } catch {}
    const token = initialParams.get('token') || '';
    const runtimeApiVersion = API_VERSION;
    const headers = {
      'X-HCC-API-Version': String(runtimeApiVersion),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    };
    const requestedInitialProject = initialParams.get('project') || initialParams.get('root') || '';
    const initialProjectIdentity = initialParams.get('root_identity') || '';
    // A navigation URL is not a project selection. In particular, following a
    // link from another site must not make our same-origin browser code register
    // the directory named in that link using the visitor's session cookie.
    // root_identity is only an inode comparison, not an authenticated intent.
    // A previous selection in this tab may be restored without a new click;
    // workspace panes inherit only the active identity of their same-origin parent.
    const trustedPaneProject = paneMode && (() => {
      try {
        return window.parent !== window && window.parent.location.origin === location.origin &&
          window.parent.hccWorkspaceHost?.project() === requestedInitialProject &&
          window.parent.hccWorkspaceHost?.projectIdentity() === initialProjectIdentity;
      } catch { return false; }
    })();
    const trustedInitialProject = Boolean(requestedInitialProject && initialProjectIdentity && (trustedPaneProject || !paneMode && (() => {
      try {
        const selected = JSON.parse(sessionStorage.getItem('hcc.selectedProject') || 'null');
        return selected?.root === requestedInitialProject && selected?.identity === initialProjectIdentity;
      } catch { return false; }
    })()));
    let pendingInitialProject = !paneMode && !trustedInitialProject ? requestedInitialProject : '';
    let currentProject = trustedInitialProject ? requestedInitialProject : '';
    const projectRequests = createProjectRequests({ broker: sharedProjectBroker(), root: currentProject,
      rootIdentity: trustedInitialProject ? initialProjectIdentity : '', headers, requireIdentity: true });
    let projectSelectionVisit = 0;
    let projects = [];
    let sessionKindFilter = initialParams.get('kind') || 'all';
    let sessionSearchQuery = '';
    let sessionStatusFilter = 'all';
    let sessions  = [];    // managed (PTY) sessions
    let sessionsLoaded = false;
    let detected  = [];    // coordination-only peers (from hooks/watcher)
    // The current token belongs to one terminal WebSocket connection and is
    // replaced on every reconnect.
    const sessionActionTokens = new Map();
    const sessionControls = new Map();
    let activeConnectionState = 'offline';
    let activeLocalClients = null;
    let draftReceipt = false;
    let lastControlNotice = 0;
    let active    = null;  // active managed session id
    let activeDetected = null; // active detected peer id
    let activeType = 'managed'; // 'managed' | 'detected'
    let showStaleDetected = hccUi.safeGet('hcc.showStaleDetected') === '1';
    let activePeerTtl = 600;
    let lastStateNow = 0;
    let lastStateRoot = '';
    let lastStateData = null;
    let lastActionResult = null;
    let ws        = null;
    let wsReconnectTimer = null;
    let wsReconnectTarget = null;
    let lastSentTerminalSize = null;
    // ui-4: after logout (or repeated failed reconnects) the WS must not loop
    // forever every 2s against a server that now rejects the upgrade.
    let wsReconnectFailures = 0;
    let terminalHasContent = false;
    let terminalLastDataAt = 0;
    let terminalLastResizeAt = 0;
    let terminalLastReplaceAt = 0;
    let autoPollInFlight = false;
    let projectPollInFlight = false;
    let lang = hccUi.language;

    function tr(key, fallback = '') {
      return hccUi.tr(key, fallback);
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
      lang = hccUi.language;
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      hccUi.translate();
      if (!active && !activeDetected) {
        setText('activeTitle', 'noSessionSelected');
        setText('activeMeta', 'startOrSelect');
      }
      const stateKey = document.getElementById('connState')?.dataset.stateKey || 'offline';
      connText(stateKey);
      syncStartModeOptions();
      renderSections();
      renderHandoff();
      if (activeType === 'detected' && activeDetected) {
        const draft = document.getElementById('detMsg')?.value || '';
        const peer = detected.find((p) => p.id === activeDetected) || { id: activeDetected };
        renderDetectedHeader(peer);
        renderDetectedPanel(peer);
        const detMsg = document.getElementById('detMsg');
        if (detMsg && draft) detMsg.value = draft;
      } else if (activeType === 'managed' && active) {
        const meta = sessions.find((s) => s.id === active);
        renderActiveSession(meta || { id: active });
      }
      if (lastStateData) renderState(lastStateData);
      if (lastActionResult && !document.getElementById('actionResult').hidden) showActionResult(lastActionResult);
      if (!stopDialog.hidden) updateStopDialogTitle();
      syncFocusButton();
      syncToggleIcons();
    }

    function requestQuery(extra = {}) {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (currentProject) params.set('root', currentProject);
      params.set('browser', '1');
      if (projectRequests.rootIdentity()) params.set('root_identity', projectRequests.rootIdentity());
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
      params.delete('root');
      if (projectRequests.rootIdentity()) params.set('root_identity', projectRequests.rootIdentity());
      else params.delete('root_identity');
      if (!paneMode) params.delete('session');
      if (sessionKindFilter && sessionKindFilter !== 'all') params.set('kind', sessionKindFilter);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
      if (!paneMode && currentProject && projectRequests.rootIdentity()) {
        try { sessionStorage.setItem('hcc.selectedProject', JSON.stringify({ root: currentProject, identity: projectRequests.rootIdentity() })); } catch {}
      }
    }

    const term = new Terminal({
      // Search match decorations use xterm's proposed decoration API.
      allowProposedApi: true,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: hccUi.preferences.fontSize,
      lineHeight: 1.15,
      theme: TERMINAL_THEMES[hccUi.preferences.terminalTheme === 'system' ? hccUi.theme : hccUi.preferences.terminalTheme]
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon.SearchAddon({ highlightLimit: 1000 });
    term.loadAddon(searchAddon);
    term.open(document.getElementById('terminal'));

    function resizeTerm() {
      const el = document.getElementById('terminal');
      if (!el.getClientRects().length || el.clientWidth <= 16 || el.clientHeight <= 16) return;
      const size = fitAddon.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      const { cols, rows } = size;
      term.resize(cols, rows);
      const actionToken = sessionActionTokens.get(active) || '';
      if (ws && ws.readyState === WebSocket.OPEN && actionToken && canControl() &&
          (!lastSentTerminalSize || lastSentTerminalSize.socket !== ws || lastSentTerminalSize.cols !== cols || lastSentTerminalSize.rows !== rows)) {
        lastSentTerminalSize = { socket: ws, cols, rows };
        terminalLastResizeAt = Date.now();
        ws.send(JSON.stringify({ type: 'resize', cols, rows, action_token: actionToken, epoch: controlEpoch() }));
      }
    }
    window.addEventListener('resize', resizeTerm);
    new ResizeObserver(() => resizeTerm()).observe(document.getElementById('terminal'));
    document.fonts?.ready.then(() => resizeTerm());
    setTimeout(resizeTerm, 80);

    function applyTerminalPreferences() {
      const palette = TERMINAL_THEMES;
      const theme = hccUi.preferences.terminalTheme === 'system' ? hccUi.theme : hccUi.preferences.terminalTheme;
      term.options.theme = palette[theme];
      term.options.fontSize = hccUi.preferences.fontSize;
      document.getElementById('terminal').style.backgroundColor = palette[theme].background;
      requestAnimationFrame(() => resizeTerm());
    }

    term.onData((data) => {
      sendTerminalInput(data);
    });

    function sendTerminalInput(data, inputId = '') {
      if (sessions.find(item => item.id === active)?.type === 'native' || sessions.find(item => item.id === active)?.type === 'app-server') return false;
      if (!active || !ws || ws.readyState !== WebSocket.OPEN || !canControl()) {
        if (Date.now() - lastControlNotice > 3000) {
          lastControlNotice = Date.now();
          document.getElementById('handoffStatus').textContent = tr('handoff.controlRequired');
        }
        return false;
      }
      const actionToken = sessionActionTokens.get(active) || '';
      if (!actionToken) return false;
      ws.send(JSON.stringify({ type: 'input', data, action_token: actionToken, epoch: controlEpoch(), ...(inputId ? { input_id: inputId } : {}) }));
      return true;
    }

    async function api(path, options = {}) {
      projectRequests.setRoot(currentProject);
      try { return await projectRequests.request(path, options); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        const translated = tr('error.' + error.code, '');
        if (translated && translated !== 'error.' + error.code) error.message = translated;
        throw error;
      }
    }

    function controlEpoch() { return Number(sessionControls.get(active)?.epoch || 0); }
    function canControl() {
      return Boolean(active && sessions.find((item) => item.id === active)?.status === 'running' && ws?.readyState === WebSocket.OPEN && sessionActionTokens.get(active) && sessionControls.get(active)?.can_control);
    }

    function renderActiveSession(meta) {
      document.getElementById('activeTitle').textContent = sessionDisplayTitle(meta) || active || '';
      document.getElementById('activeMeta').textContent = [sessionProvider(meta), meta?.task?.id != null ? '#' + meta.task.id : '', meta?.task?.status ? statusText(meta.task.status) : ''].filter(Boolean).join(' · ');
      const details = document.getElementById('activeDetails');
      const subject = JSON.stringify([currentProject, 'managed', meta?.id || active]);
      if (details.dataset.subject !== subject) details.open = false;
      details.dataset.subject = subject;
      const rows = [[tr('peer'), sessionPeerId(meta)], [tr('sessionId'), meta?.id], [tr('runtime'), sessionRuntimeTarget(meta)],
        [tr('providerSession'), sessionProvider(meta) + ':' + (sessionProviderSessionValue(meta) || tr('unknown'))],
        [tr('handoff.transport'), meta?.type || 'pty'], [tr('command'), meta?.command], [tr('cwd'), meta?.cwd]];
      document.getElementById('activeIdentity').innerHTML = rows.map(([label, value]) => '<dt>' + esc(label) + '</dt><dd>' + esc(value || tr('unknown')) + '</dd>').join('');
      const task = document.getElementById('activeTask');
      task.hidden = !meta?.task?.title;
      task.textContent = meta?.task?.title ? tr('handoff.task') + (meta.task.id != null ? ' #' + meta.task.id : '') + ': ' + meta.task.title + (meta.task.status ? ' · ' + statusText(meta.task.status) : '') : '';
    }

    function clearSessionIdentity() {
      const details = document.getElementById('activeDetails');
      details.open = false;
      delete details.dataset.subject;
      document.getElementById('activeIdentity').textContent = '';
      document.getElementById('handoffDetail').textContent = '';
      document.getElementById('activeTask').textContent = '';
      document.getElementById('activeTask').hidden = true;
    }

    function renderDetectedHeader(peer) {
      clearSessionIdentity();
      document.getElementById('activeTitle').textContent = peer?.name || peer?.id || activeDetected || '';
      document.getElementById('activeMeta').textContent = [peer?.provider || peer?.kind || tr('unknown'), tr('detected'), peer?.worktree || peer?.cwd || ''].filter(Boolean).join(' · ');
    }

    function renderDraftState() {
      const value = active ? handoffStore.draft(currentProject, active) : { text: '', pending: null };
      const note = document.getElementById('draftStatus');
      note.textContent = tr(value.pending ? value.pending.status === 'uncertain' ? 'handoff.uncertain' : 'handoff.pending' : draftReceipt ? 'handoff.received' : 'handoff.saved');
      note.title = tr('handoff.storageHint');
      document.getElementById('reviewDraftBtn').hidden = value.pending?.status !== 'uncertain';
      document.getElementById('sendDraftBtn').disabled = !canControl() || !value.text || Boolean(value.pending);
    }

    function renderHandoff() {
      document.getElementById('handoffBar').hidden = !active;
      const control = sessionControls.get(active) || {};
      const writable = canControl();
      term.options.disableStdin = !writable;
      const copy = (en, zh) => lang === 'zh' ? zh : en;
      const connection = document.getElementById('handoffConnection');
      connection.textContent = copy('Web: ', '连接：') + (activeConnectionState === 'connected' ? copy('Connected', '已连接') : activeConnectionState === 'connecting' ? copy('Connecting…', '连接中…') : copy('Disconnected', '已断开'));
      connection.dataset.tone = activeConnectionState === 'connected' ? 'ok' : 'warn';
      const meta = sessions.find((item) => item.id === active);
      const processState = document.getElementById('handoffProcess');
      processState.textContent = copy('Process: ', '进程：') + statusText(meta?.status || 'unknown');
      processState.dataset.tone = meta?.status === 'running' ? 'ok' : meta?.status === 'exited' ? 'danger' : '';
      const access = document.getElementById('handoffAccess');
      access.textContent = writable ? copy('You control', '你正在控制') : control.has_controller ? control.controller_connected === false ? copy('Control retained · Read only', '控制权暂时保留 · 只读') : copy('Other window controls · Read only', '其他窗口控制 · 只读') : copy('Read only', '只读');
      access.dataset.tone = writable ? 'ok' : control.has_controller ? 'warn' : '';
      document.getElementById('handoffHelp').textContent = tr('sessionDetails');
      const claim = document.getElementById('claimControlBtn');
      claim.hidden = writable;
      claim.disabled = activeConnectionState !== 'connected' || !sessionActionTokens.get(active);
      claim.textContent = tr(control.has_controller ? 'handoff.takeover' : 'handoff.claim');
      document.getElementById('releaseControlBtn').hidden = !writable;
      const reconnect = document.getElementById('reconnectBtn');
      reconnect.disabled = !active || activeConnectionState === 'connecting';
      reconnect.hidden = activeConnectionState === 'connected';
      const clients = activeLocalClients ?? meta?.local_clients;
      const count = typeof clients === 'number' ? clients : Array.isArray(clients) ? clients.length : Number(clients?.count || 0);
      document.getElementById('handoffDetail').textContent = (meta?.type === 'tmux' ? (clients?.state === 'unknown' ? tr('handoff.localUnknown') : count ? tr('handoff.localClients') + ': ' + count : tr('handoff.noLocalClients')) + ' · ' + tr('handoff.localBoundary') + ' ' : '') + tr('handoff.leaveHelp');
      const stop = document.getElementById('stopBtn');
      stop.hidden = meta?.type === 'native';
      stop.disabled = !writable;
      stop.dataset.i18n = meta?.type === 'tmux' ? 'handoff.detach' : 'handoff.terminate';
      stop.textContent = tr(stop.dataset.i18n);
      document.querySelectorAll('[data-terminal-action]').forEach((button) => { button.disabled = !writable || meta?.type === 'app-server' || meta?.type === 'native'; });
      document.querySelectorAll('[data-action]').forEach((button) => {
        if (!['status', 'state', 'inbox'].includes(button.dataset.action)) button.disabled = !writable;
      });
      renderDraftState();
      window.hccCodex?.sync();
      window.hccNative?.sync();
      window.hccHistory?.sync();
      window.hccReview?.sync();
      window.hccTerminalFind?.sync();
      window.hccWorkspace?.sync();
      window.hccAgentDefaults?.sync();
      document.getElementById('openReviewDialog').disabled = !meta;
    }

    function disconnectWebSocket() {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
      wsReconnectTarget = null;
      const previous = ws;
      ws = null;
      if (active) {
        handoffStore.uncertain(currentProject, active);
        sessionActionTokens.delete(active);
        sessionControls.delete(active);
      }
      activeConnectionState = 'offline';
      lastSentTerminalSize = null;
      previous?.close();
    }

    function restoreSelection() {
      const explicit = initialParams.get('session');
      initialParams.delete('session');
      const selected = explicit ? { type: 'managed', id: explicit } : handoffStore.selected(currentProject);
      if (selected) {
        if (selected.type === 'managed' && sessions.some((item) => item.id === selected.id && item.status === 'running')) return connectManaged(selected.id);
        if (selected.type === 'detected' && detected.some((item) => item.id === selected.id)) return connectDetected(selected.id);
        document.getElementById('activeMeta').textContent = tr('handoff.missingSelection');
        return;
      }
      const first = sessions.find((item) => item.status === 'running');
      if (first) connectManaged(first.id);
    }

    window.hccHandoff = {
      get active() { return active; },
      get projectRoot() { return currentProject; },
      get projectIdentity() { return projectRequests.rootIdentity(); },
      get draftScope() { return window.hccDraftScope || ''; },
      get actionToken() { return sessionActionTokens.get(active) || ''; },
      get epoch() { return controlEpoch(); },
      get canControl() { return canControl(); },
      get session() { return sessions.find(item => item.id === active) || null; },
      get sessions() { return sessions; },
      refreshSessions: () => refreshSessions(), openManaged: id => connectManaged(id), openDialog, closeDialog,
      api: (...args) => api(...args), tr, esc
    };
    installCodexPanel();
    installHistory();
    installReview();
    installNativePanel();
    installAgentDefaults();
    installFiles();
    document.getElementById('claimControlBtn').addEventListener('click', () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const target = active, socket = ws, epoch = controlEpoch();
      const takeover = Boolean(sessionControls.get(active)?.has_controller);
      if (takeover && !confirm(lang === 'zh' ? '接管后，其他浏览器窗口将转为只读。当前任务继续运行。是否接管？' : 'Taking control makes the other browser window read only. The current task keeps running. Continue?')) return;
      if (active !== target || ws !== socket) return;
      socket.send(JSON.stringify({ type: 'control', action: 'claim', action_token: sessionActionTokens.get(target) || '', epoch, force: takeover }));
    });
    document.getElementById('releaseControlBtn').addEventListener('click', () => {
      if (!canControl()) return;
      ws.send(JSON.stringify({ type: 'control', action: 'release', action_token: sessionActionTokens.get(active) || '', epoch: controlEpoch() }));
    });
    document.getElementById('reconnectBtn').addEventListener('click', () => {
      if (!active) return;
      const id = active;
      disconnectWebSocket();
      wsReconnectFailures = 0;
      openWs(id);
    });
    document.getElementById('terminalDraft').addEventListener('input', (event) => {
      if (!active) return;
      draftReceipt = false;
      handoffStore.saveDraft(currentProject, active, event.target.value);
      renderDraftState();
    });
    function submitTerminalDraft(event) {
      event.preventDefault();
      if (!active || !canControl()) return;
      const textarea = document.getElementById('terminalDraft');
      const text = textarea.value;
      if (!text || handoffStore.draft(currentProject, active).pending) return;
      const inputId = window.crypto?.randomUUID?.() || 'input-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      handoffStore.saveDraft(currentProject, active, text);
      handoffStore.submit(currentProject, active, inputId, text);
      try {
        if (!sendTerminalInput(text + '\r', inputId)) handoffStore.uncertain(currentProject, active);
      } catch {
        handoffStore.uncertain(currentProject, active);
      }
      renderDraftState();
    }
    document.getElementById('terminalComposer').addEventListener('submit', submitTerminalDraft);
    document.getElementById('terminalDraft').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitTerminalDraft(event);
    });
    document.getElementById('reviewDraftBtn').addEventListener('click', () => {
      if (!active) return;
      handoffStore.review(currentProject, active);
      draftReceipt = false;
      renderDraftState();
    });
    window.addEventListener('pagehide', () => disconnectWebSocket());

    function reportPollError(error) { if (error.name !== 'AbortError') console.error(error); }

    function handleUiError(error, action = '') {
      if (error.name === 'AbortError') return;
      showActionResult({ action, peer: activePeerInfo()?.peerId || '', error: error.detail || error.message, errorCode: error.code });
    }

    function renderProjects() {
      const select = document.getElementById('projectSelect');
      select.innerHTML = projects.map((p) =>
        '<option value="' + esc(p.root) + '">' + esc((p.name || p.root) + ' · ' + p.root) + '</option>'
      ).join('');
      if (currentProject) select.value = currentProject;
      document.getElementById('sessionKindFilter').value = sessionKindFilter;
      window.hccCommandPalette?.refresh();
    }

    function kindMatches(item) {
      const kind = ['claude', 'codex', 'dsh', 'shell'].includes(item.kind) ? item.kind : 'other';
      return sessionKindFilter === 'all' || kind === sessionKindFilter;
    }

    function syncStartModeOptions() { window.hccAgentStart?.sync(); }

    async function loadProjects() {
      const data = projectRequests.rootIdentity()
        ? await api('/api/projects')
        : await api('/api/projects/select',
          { method: 'POST', explicitSelection: true });
      if (!data.project_identity) throw Object.assign(new Error('Project selection has no directory identity'), { code: 'PROJECT_IDENTITY_REQUIRED' });
      projects = data.projects || [];
      // State-sync identities use the server's canonical project path, even
      // when navigation supplied an alias or a path with a trailing slash.
      currentProject = data.current?.root || currentProject || projects[0]?.root || '';
      projectRequests.setRoot(currentProject, data.project_identity);
      renderProjects();
      updateLocationProject();
    }

    async function switchProject(root, selection = null) {
      if (paneMode && root !== currentProject) return;
      const visit = ++projectSelectionVisit;
      const selected = selection || await api('/api/projects/select?root=' + encodeURIComponent(root),
        { method: 'POST', explicitSelection: true });
      if (visit !== projectSelectionVisit) return;
      const selectedRoot = selected.current?.root || selected.project?.root;
      if (!selectedRoot || !selected.project_identity) {
        throw Object.assign(new Error('Project selection has no directory identity'), { code: 'PROJECT_IDENTITY_REQUIRED' });
      }
      window.hccAgentStart?.reset();
      window.hccAgentDefaults?.reset();
      window.hccFiles?.reset();
      window.hccWorkspace?.reset();
      disconnectWebSocket();
      window.hccHistory?.reset();
      window.hccReview?.reset();
      currentProject = selectedRoot;
      projectRequests.setRoot(selectedRoot, selected.project_identity);
      projects = selected.projects || projects;
      renderProjects();
      updateLocationProject();
      active = null;
      activeDetected = null;
      activeType = 'managed';
      sessions = [];
      sessionsLoaded = false;
      detected = [];
      renderSections();
      document.getElementById('rootPath').textContent = selectedRoot;
      lastStateData = null;
      lastStateRoot = '';
      window.hccWorkbench.reset();
      term.reset();
      document.getElementById('codexPanel').hidden = true;
      document.getElementById('nativePanel').hidden = true;
      document.getElementById('terminalComposer').hidden = true;
      renderHandoff();
      clearSessionIdentity();
      document.getElementById('activeTitle').textContent = tr('noSessionSelected');
      document.getElementById('activeMeta').textContent = tr('startOrSelect');
      await Promise.all([refreshSessions(), refreshDetected(), refreshState()]);
      if (currentProject !== selectedRoot) return;
      restoreSelection();
    }

    function esc(text) {
      return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function fmtTime(ts) {
      if (!ts) return '';
      return new Date(ts * 1000).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en');
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

    function sessionDisplayTitle(session) {
      return session?.task?.title || session?.name || sessionPeerId(session);
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
        session?.capabilities?.structured_turns ? 'App Server' : '',
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

    function dshCoordinationPeer(peer) {
      return (peer?.provider || peer?.kind) === 'dsh' && ['hook', 'cordis'].includes(peer?.transport);
    }

    function detectedPeerCanStop(peer) {
      if (dshCoordinationPeer(peer)) return false;
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
        if (task.takeover_ready) return tr('ownerStaleNoLock');
        const locks = Number(task.related_lock_count || 0);
        return locks ? tr('ownerStaleLocks') + ': ' + locks : tr('ownerStale');
      }
      if (task.owner_active) return tr('ownerActive');
      return '';
    }

    function bodyPinned(el) {
      if (!el) return false;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    }

    function stateCardCollapsed(section) {
      return hccUi.safeGet('hcc.stateCard.' + section + '.collapsed') === '1';
    }

    function stateCardHtml(section, title, count, bodyHtml) {
      const collapsed = stateCardCollapsed(section);
      return `
          <div class="card state-card ${collapsed ? 'state-card-collapsed' : ''}" data-section="${esc(section)}">
            <button class="state-card-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
              <span class="state-card-toggle-title"><strong>${esc(title)}</strong> <span class="badge">${esc(count)}</span></span>
              <span class="state-card-chevron">⌄</span>
            </button>
            <div class="body">${bodyHtml}</div>
          </div>`;
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
          hccUi.safeSet('hcc.stateCard.' + section + '.collapsed', collapsed ? '1' : '0');
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
      return `
          <div class="item timeline-item">
            <strong>${esc(item.title || item.kind || item.source)} <span class="badge">${esc(item.kind || item.source)}</span></strong>
            <span>${esc(meta)}</span>
            ${item.text ? '<span>' + esc(item.text) + '</span>' : ''}
          </div>`;
    }

    document.getElementById('projectSelect').addEventListener('change', (event) => {
      switchProject(event.target.value).catch(handleUiError);
    });
    document.getElementById('sessionKindFilter').addEventListener('change', (event) => {
      sessionKindFilter = event.target.value || 'all';
      updateLocationProject();
      renderSections();
    });
    document.getElementById('sessionSearch').addEventListener('input', (event) => {
      sessionSearchQuery = event.target.value;
      renderSections();
    });
    document.getElementById('sessionStatusFilter').addEventListener('change', (event) => {
      sessionStatusFilter = event.target.value || 'all';
      renderSections();
    });
    document.getElementById('projectForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('addProjectBtn');
      if (button.disabled) return;
      button.disabled = true;
      document.getElementById('openProjectDialog').disabled = true;
      const errorElement = document.getElementById('projectDialogError');
      const originalProject = currentProject;
      errorElement.hidden = true;
      try {
        const input = document.getElementById('projectPath');
        const root = input.value.trim();
        if (!root) return;
        const added = await api('/api/projects?root=' + encodeURIComponent(root),
          { method: 'POST', explicitSelection: true, body: JSON.stringify({ root }) });
        if (input.value.trim() === root) input.value = '';
        if (projectDialog.hidden || currentProject !== originalProject) return;
        await switchProject(added.project.root, added);
        if (!projectDialog.hidden) closeDialog(projectDialog);
      } catch (error) {
        errorElement.textContent = tr('error.' + error.code, error.detail || error.message);
        errorElement.hidden = false;
      } finally { button.disabled = false; document.getElementById('openProjectDialog').disabled = false; }
    });

    function clearSessionFilters() {
      sessionSearchQuery = '';
      sessionStatusFilter = 'all';
      sessionKindFilter = 'all';
      document.getElementById('sessionSearch').value = '';
      document.getElementById('sessionStatusFilter').value = 'all';
      document.getElementById('sessionKindFilter').value = 'all';
      updateLocationProject();
      renderSections();
      document.getElementById('sessionSearch').focus();
    }

    function sessionMatchesSearch(item) {
      const words = sessionSearchQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return true;
      const searchable = [item.name, item.task?.title, item.id, item.peer_id, item.kind, item.provider, item.cwd, item.worktree, item.command,
        item.type, item.transport, item.branch, item.provider_session_label, item.binding?.runtime_target,
        item.binding?.provider, item.binding?.provider_session_id, item.binding?.provider_session_name]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return words.every((word) => searchable.includes(word));
    }

    function sessionDetailsHtml(key, rows) {
      return '<details class="session-details" data-detail-key="' + esc(key) + '"><summary data-focus-key="detail:' + esc(key) + '">' + esc(tr('sessionDetails')) + '</summary><dl>' +
        rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) =>
          '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>').join('') + '</dl></details>';
    }

    // ── Sessions rendering (managed + detected) ──────────────────────────
    function renderSections() {
      const box = document.getElementById('sessions');
      const filtered = Boolean(sessionSearchQuery.trim() || sessionStatusFilter !== 'all' || sessionKindFilter !== 'all');
      const searching = Boolean(sessionSearchQuery.trim());
      const visibleSessions = sessions.filter((s) => kindMatches(s) && sessionMatchesSearch(s) &&
        (sessionStatusFilter === 'all' || s.status === 'running'))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') ||
          String(a.name || sessionPeerId(a)).localeCompare(String(b.name || sessionPeerId(b))));
      const visibleDetected = detected.filter((p) => kindMatches(p) && sessionMatchesSearch(p) &&
        (sessionStatusFilter === 'all' || peerIsActive(p)))
        .sort((a, b) => Number(b.last_seen_at || 0) - Number(a.last_seen_at || 0) || String(a.id).localeCompare(String(b.id)));
      const activeDetectedPeers = visibleDetected.filter((p) => peerIsActive(p));
      const staleDetectedPeers = visibleDetected.filter((p) => !peerIsActive(p));
      const noMatches = '<div class="empty session-empty"><p>' + esc(tr('noMatchingSessions')) + '</p><button type="button" data-navigation="clear-session-filters">' + esc(tr('clearSessionFilters')) + '</button></div>';
      const startEmpty = '<div class="empty session-empty"><p>' + esc(tr('noActiveSessions')) + '</p><button class="primary" type="button" data-navigation="open-start">' + esc(tr('createFirstSession')) + '</button></div>';
      const manHtml = visibleSessions.length
        ? visibleSessions.map((s) => {
          const peerId = sessionPeerId(s);
          const title = sessionDisplayTitle(s);
          const path = s.cwd || '';
          return `
          <div class="session ${active === s.id && activeType === 'managed' ? 'active' : ''}" data-id="${esc(s.id)}" data-type="managed">
            <div class="row"><button class="session-select session-title" type="button" data-focus-key="managed:${esc(s.id)}" aria-label="${esc(title)}" aria-pressed="${active === s.id && activeType === 'managed'}" title="${esc(title)}"><strong>${esc(title)}</strong></button><span class="badge ${badgeClass(s.status)}">${esc(statusText(s.status))}</span></div>
            <div class="session-subtitle"><span class="session-provider">${esc(sessionProvider(s))}</span><span class="path" title="${esc(path)}">${esc(path.split('/').filter(Boolean).slice(-2).join('/'))}</span></div>
            ${sessionDetailsHtml('managed:' + s.id, [[tr('peer'), peerId], [tr('sessionId'), s.id], [tr('runtime'), sessionRuntimeTarget(s)], [tr('providerSession'), sessionProvider(s) + ':' + (sessionProviderSessionValue(s) || tr('unknown'))], [tr('handoff.transport'), s.type || 'pty'], [tr('command'), s.command], [tr('cwd'), path]])}
          </div>`;
        }).join('')
        : filtered ? '' : startEmpty;

      const renderDetectedPeer = (p) => {
          const state = peerStateView(p);
          const canStop = detectedPeerCanStop(p);
          return `
          <div class="session ${activeDetected === p.id && activeType === 'detected' ? 'active' : ''}" data-id="${esc(p.id)}" data-type="detected">
            <div class="row">
              <button class="session-select session-title" type="button" data-focus-key="detected:${esc(p.id)}" aria-label="${esc(p.name || p.id)}" aria-pressed="${activeDetected === p.id && activeType === 'detected'}" title="${esc(p.name || p.id)}"><strong>${esc(p.name || p.id)}</strong></button>
              <div style="display:flex;gap:6px;align-items:center">
                <span class="badge ${badgeClass(state.label)}" title="${esc(state.detail)}">${esc(statusText(state.label))}</span>
                ${dshCoordinationPeer(p) ? '' : canStop ? `
                <button class="session-action stop-detected-btn" data-action="stop-detected" data-id="${esc(p.id)}" data-focus-key="stop:${esc(p.id)}" title="${esc(tr('action.stopPeer'))}" aria-label="${esc(tr('action.stopPeer')) + ' ' + esc(p.id)}" type="button">✕</button>
                ` : `
                <button class="session-action" data-action="restart-detected" data-id="${esc(p.id)}" data-focus-key="restart:${esc(p.id)}" title="${esc(tr('action.restartPeer'))}" aria-label="${esc(tr('action.restartPeer')) + ' ' + esc(p.id)}" type="button">↻</button>
                `}
              </div>
            </div>
            <div class="session-subtitle"><span class="session-provider">${esc(p.provider || p.kind || 'other')}</span><span class="path" title="${esc(p.worktree || p.cwd || '')}">${esc((p.worktree || p.cwd || '').split('/').filter(Boolean).slice(-2).join('/'))}</span></div>
            ${sessionDetailsHtml('detected:' + p.id, [[tr('peer'), p.id], [tr('kind'), p.kind], [tr('status'), state.detail], [tr('cwd'), p.worktree || p.cwd], [tr('command'), p.command], [tr('branch'), p.branch], [tr('pid'), p.pid]])}
          </div>`;
      };
      const activeDetectedHtml = activeDetectedPeers.length
        ? activeDetectedPeers.map(renderDetectedPeer).join('')
        : filtered ? '' : '<div class="empty">' + esc(tr('noActiveDetectedPeers')) + '</div>';
      const staleToggleLabel = showStaleDetected ? tr('hideStale') : tr('showStale');
      const staleDetectedHtml = (showStaleDetected || searching)
        ? (staleDetectedPeers.length ? staleDetectedPeers.map(renderDetectedPeer).join('') : '<div class="empty">' + esc(tr('noDetectedPeers')) + '</div>')
        : '';

      const savedScroll = box.scrollTop;
      const restoreFocus = preserveFocus(box);
      const summaryFocus = document.activeElement?.tagName === 'SUMMARY' && box.contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
      const openDetails = new Set([...box.querySelectorAll('details[open]')].map((el) => el.dataset.detailKey));
      document.getElementById('sessionListCount').textContent = tr('sessionListSummary').replace('{count}', visibleSessions.length + activeDetectedPeers.length + ((showStaleDetected || searching) ? staleDetectedPeers.length : 0));
      box.innerHTML = filtered && !visibleSessions.length && !visibleDetected.length ? noMatches : `
        <div class="sec-label">${esc(tr('managed'))} <span class="badge">${visibleSessions.filter(s=>s.status==='running').length} ${esc(tr('running'))}</span></div>
        ${manHtml}
        <div class="sec-label" style="margin-top:10px">${esc(tr('activeDetected'))} <span class="badge" style="color:var(--warn)">${activeDetectedPeers.length}</span></div>
        ${activeDetectedHtml}
        <div class="sec-label" style="margin-top:10px">${esc(tr('staleDetected'))} <span class="badge">${staleDetectedPeers.length}</span><span class="sec-spacer"></span><button id="toggleStaleDetected" type="button" ${searching ? 'hidden' : ''}>${esc(staleToggleLabel)}</button></div>
        ${staleDetectedHtml}
      `;
      box.querySelectorAll('details').forEach((el) => { el.open = openDetails.has(el.dataset.detailKey); });
      box.scrollTop = savedScroll;
      restoreFocus();
      if (summaryFocus) [...box.querySelectorAll('summary')].find((el) => el.dataset.focusKey === summaryFocus)?.focus({ preventScroll: true });
      box.querySelectorAll('[data-navigation="clear-session-filters"]').forEach((button) => button.addEventListener('click', clearSessionFilters));
      window.hccCommandPalette?.refresh();
      box.querySelectorAll('[data-navigation="open-start"]').forEach((button) => button.addEventListener('click', openStartDialog));
      const staleToggle = document.getElementById('toggleStaleDetected');
      if (staleToggle) {
        staleToggle.addEventListener('click', () => {
          showStaleDetected = !showStaleDetected;
          hccUi.safeSet('hcc.showStaleDetected', showStaleDetected ? '1' : '0');
          renderSections();
        });
      }
      box.querySelectorAll('.session[data-type="managed"]').forEach((el) => {
        el.addEventListener('click', (event) => {
          if (event.target.closest('details, [data-action]')) return;
          connectManaged(el.dataset.id);
        });
      });
      box.querySelectorAll('.session[data-type="detected"]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('details, [data-action]')) return;
          connectDetected(el.dataset.id);
        });
      });
      box.querySelectorAll('[data-action="stop-detected"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const peerId = btn.dataset.id;
          document.getElementById('stopDialogTitle').textContent = tr('stop') + ' ' + peerId + '?';
          stopKillCb.checked = false;
          stopKillCb.parentElement.parentElement.hidden = false;
          stopConfirmBtn.textContent = tr('stop');
          document.getElementById('stopDialogMeta').textContent = tr('detectedPeer');
          stopDialog._action = 'detected';
          stopDialog._peerId = peerId;
          openDialog(stopDialog, stopCancelBtn);
        });
      });
      box.querySelectorAll('[data-action="restart-detected"]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          try {
            e.stopPropagation();
            const peerId = btn.dataset.id;
            await api('/api/detected/' + encodeURIComponent(peerId) + '/restart', { method: 'POST', body: '{}' });
            await Promise.all([refreshSessions(), refreshDetected()]);
          } catch (error) { handleUiError(error); }
        });
      });
    }

    async function refreshSessions() {
      const root = currentProject;
      const data = await api('/api/sessions');
      if (currentProject !== root) return;
      sessions = data.sessions || [];
      sessionsLoaded = true;
      renderSections();
      if (active && activeType === 'managed') {
        const meta = sessions.find((s) => s.id === active);
        renderActiveSession(meta || { id: active });
        if (meta) {
          activeLocalClients = meta.local_clients ?? activeLocalClients;
        }
      }
      connText(ws?.readyState === WebSocket.OPEN ? 'attached' : activeDetected ? 'coordinationOnly' : active ? (activeConnectionState === 'connecting' || wsReconnectTimer !== null ? 'reconnecting' : 'offline') : 'online');
      renderHandoff();
      scheduleWsReconnect();
    }

    async function refreshDetected() {
      const root = currentProject;
      try {
        const data = await api('/api/detected');
        if (currentProject !== root) return;
        activePeerTtl = Number(data.active_peer_ttl || activePeerTtl);
        lastStateNow = Number(data.now || lastStateNow);
        detected = data.detected || [];
        renderSections();
        if (activeType === 'detected' && activeDetected) renderDetectedHeader(detected.find((peer) => peer.id === activeDetected) || { id: activeDetected });
      } catch {}
    }

    // ── Project state panel ───────────────────────────────────────────────
    function renderState(data) {
      lastStateData = data;
      const stateRoot = data.root || '';
      document.getElementById('rootPath').textContent = stateRoot;
      activePeerTtl = Number(data.active_peer_ttl || activePeerTtl);
      lastStateNow = Number(data.now || lastStateNow);
      const state = document.getElementById('state');
      const restoreFocus = preserveFocus(state);
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
      const tasks = tasksData.map((t) => `
          <div class="item"><strong>#${t.id} ${esc(t.title)}</strong><span>${esc(statusText(t.status))} ${esc(tr('owner'))}=${esc(t.owner || '')} ${esc(tr('assignee'))}=${esc(t.assignee || '')}${taskOwnerStateText(t) ? ' · ' + esc(taskOwnerStateText(t)) : ''}</span></div>
        `).join('') || '<div class="empty">' + esc(tr('noTasks')) + '</div>';
      const peers = peersData.map((a) => {
        const peerRuntime = runtimeById.get(a.id);
        const peerState = peerStateView(a, peerRuntime, data.now);
        return `
        <div class="item"><strong>${esc(a.id)} <span class="badge">${esc(a.kind)}</span> <span class="badge ${badgeClass(peerState.label)}">${esc(statusText(peerState.label))}</span></strong><span>${esc(peerState.detail)}</span></div>
      `;
      }).join('') || '<div class="empty">' + esc(tr('noPeers')) + '</div>';
      const locks = locksData.map((l) => `
          <div class="item"><strong>${esc(lockLabel(l))}</strong><span>${esc(tr('owner'))}=${esc(l.owner)} ${esc(tr('task'))}=${l.task_id ? '#' + l.task_id : ''}</span></div>
        `).join('') || '<div class="empty">' + esc(tr('noActiveLocks')) + '</div>';
      const messages = messagesData.map((m) => `
          <div class="item"><strong>#${m.id} ${esc(m.sender)} → ${esc(m.recipient || tr('all'))}${m.reply_to ? ' ' + esc(tr('reply')) + ' #' + m.reply_to : ''}</strong><span>${esc(m.body)}</span></div>
        `).join('') || '<div class="empty">' + esc(tr('noMessages')) + '</div>';
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
      window.hccWorkbench.apply();
      restoreFocus();
      lastStateRoot = stateRoot;
    }

    async function refreshState() {
      const root = currentProject;
      const selected = active;
      const selectionType = activeType;
      const peer = active ? managedPeerId(active) : null;
      const p = peer ? '/api/state?peer=' + encodeURIComponent(peer) : '/api/state';
      try {
        const data = await api(p);
        if (currentProject !== root || active !== selected || activeType !== selectionType) return;
        renderState(data);
        window.hccWorkbench.fresh();
      } catch (error) {
        if (currentProject === root && active === selected && activeType === selectionType) window.hccWorkbench.stale(error);
        throw error;
      }
    }

    async function refreshDetectedState() {
      if (!activeDetected) return;
      const root = currentProject, selected = activeDetected;
      try {
        const data = await api('/api/state?peer=' + encodeURIComponent(selected));
        if (currentProject !== root || activeDetected !== selected || activeType !== 'detected') return;
        renderState(data);
        window.hccWorkbench.fresh();
      } catch (error) {
        if (currentProject === root && activeDetected === selected && activeType === 'detected') window.hccWorkbench.stale(error);
        throw error;
      }
    }

    async function refreshCurrentState() {
      if (activeType === 'detected') return refreshDetectedState();
      return refreshState();
    }

    async function refreshVisibleData() {
      if (autoPollInFlight) return;
      autoPollInFlight = true;
      window.hccWorkbench.loading();
      try {
        await Promise.all([
          refreshSessions(),
          refreshDetected(),
          refreshCurrentState()
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
      if (!paneMode) window.hccWorkspace?.primary();
      const meta = sessions.find((s) => s.id === id);
      window.hccReview?.reset();
      disconnectWebSocket();
      active = id;
      activeDetected = null;
      activeType = 'managed';
      if (paneMode) { const url = new URL(location.href); url.searchParams.set('session', id); history.replaceState(null, '', url); }
      handoffStore.select(currentProject, 'managed', id);
      activeLocalClients = meta?.local_clients ?? null;
      renderSections();
      renderActiveSession(meta || { id });
      const isCodex = meta?.type === 'app-server';
      const isNative = meta?.type === 'native';
      document.getElementById('terminal').style.display = isCodex || isNative ? 'none' : '';
      document.getElementById('codexPanel').hidden = !isCodex;
      document.getElementById('codexPanel').style.display = isCodex ? '' : 'none';
      document.getElementById('nativePanel').hidden = !isNative;
      document.getElementById('terminalComposer').hidden = isCodex || isNative;
      document.getElementById('detectedPanel').style.display = 'none';
      document.getElementById('quickBar').style.display = '';
      setMobileView('terminal');
      draftReceipt = false;
      handoffStore.uncertain(currentProject, id);
      document.getElementById('terminalDraft').value = handoffStore.draft(currentProject, id).text;
      window.hccTerminalFind?.sync();
      term.reset();
      terminalHasContent = false;
      terminalLastDataAt = 0;
      terminalLastReplaceAt = 0;
      terminalLastResizeAt = Date.now();
      openWs(id);
      refreshState().catch(reportPollError);
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
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
      wsReconnectTarget = null;
      if (!projectRequests.rootIdentity()) { connText('error'); return; }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      sessionActionTokens.delete(id);
      sessionControls.delete(id);
      activeConnectionState = 'connecting';
      renderHandoff();
      const socket = new WebSocket(proto + '://' + location.host + '/ws/terminal/' + encodeURIComponent(id) + requestQuery({ api_version: runtimeApiVersion, state_sync: 1 }));
      ws = socket;
      const connectionRoot = currentProject;
      const receiver = createSessionSync({
        root: connectionRoot, sessionId: id,
        onState(state, channel) {
          if (ws !== socket || active !== id || currentProject !== connectionRoot) return;
          if (channel === 'native') window.hccNative?.render(state);
          if (channel === 'codex') window.hccCodex?.render(state);
        },
        requestSnapshot(frame) { if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); }
      });
      socket.onopen = () => {
        if (ws !== socket || active !== id) return;
        activeConnectionState = 'connected';
        renderHandoff();
        connText('attached');
      };
      socket.onmessage = (event) => {
        if (ws !== socket || active !== id) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'state_sync') { receiver.receive(msg); return; }
        const pinned = terminalPinned();
        // The server streams the tmux pane's raw output, so xterm renders
        // incrementally (no reset/redraw → no flicker) and the program's own
        // escape sequences carry the cursor.
        if (msg.type === 'snapshot') {
          wsReconnectFailures = 0;
          if (msg.action_token) sessionActionTokens.set(id, msg.action_token);
          if (msg.control) sessionControls.set(id, msg.control);
          if (msg.local_clients != null) activeLocalClients = msg.local_clients;
          const selected = sessions.find(item => item.id === id);
          if (selected?.type === 'native' && msg.native_state) window.hccNative?.render(msg.native_state);
          else if (selected?.type === 'app-server' && msg.state) window.hccCodex?.render(msg.state);
          renderHandoff();
          writeTerminalSnapshot(msg.data || '', true);
          resizeTerm();
          // Connection recovery never replays terminal input or a draft.
        }
        if (msg.type === 'data') {
          terminalHasContent = true;
          terminalLastDataAt = Date.now();
          term.write(msg.data || '', pinned ? () => { term.scrollToBottom(); } : undefined);
        }
        if (msg.type === 'replace' && shouldApplyTerminalReplace()) {
          writeTerminalSnapshot(msg.data || '', pinned);
        }
        if (msg.type === 'control') {
          sessionControls.set(id, msg.control || {});
          lastSentTerminalSize = null;
          renderHandoff();
          resizeTerm();
          window.hccCodex?.sync();
        }
        if (msg.type === 'codex_state') window.hccCodex?.render(msg.state);
        if (msg.type === 'native_state') window.hccNative?.render(msg.state);
        if (msg.type === 'input_ack' && handoffStore.acknowledge(currentProject, id, msg.input_id)) {
          draftReceipt = true;
          document.getElementById('terminalDraft').value = handoffStore.draft(currentProject, id).text;
          renderDraftState();
        }
        if (msg.type === 'error') {
          if (msg.control) sessionControls.set(id, msg.control);
          renderHandoff();
          handoffStore.uncertain(currentProject, id);
          renderDraftState();
          handleUiError({ code: msg.error?.code, message: msg.error?.message || tr('requestFailed') });
        }
        if (msg.type === 'exit') { refreshSessions().catch(reportPollError); }
      };
      socket.onclose = (event) => {
        if (ws !== socket) return;
        sessionActionTokens.delete(id);
        sessionControls.delete(id);
        activeConnectionState = 'disconnected';
        handoffStore.uncertain(currentProject, id);
        renderHandoff();
        window.hccCodex?.sync();
        // ui-4: no reconnect after logout, and stop after repeated failures
        // (e.g. the session cookie was revoked in another tab) instead of
        // looping every 2s forever.
        receiver.reset();
        if (event.code === 4001 || loggedOut) {
          connText('signed out');
          return;
        }
        if (navigator.onLine === false) { connText('offline'); return; }
        wsReconnectFailures += 1;
        if (wsReconnectFailures > 5) {
          connText('offline');
          return;
        }
        connText('reconnecting');
        wsReconnectTarget = { id, root: connectionRoot, socket };
        scheduleWsReconnect();
      };
    }

    function canReconnectWs(target) {
      return Boolean(target && target === wsReconnectTarget && !loggedOut && navigator.onLine !== false &&
        wsReconnectFailures > 0 && wsReconnectFailures <= 5 && currentProject === target.root &&
        activeType === 'managed' && active === target.id && ws === target.socket && ws.readyState === WebSocket.CLOSED);
    }

    function scheduleWsReconnect() {
      const target = wsReconnectTarget;
      if (wsReconnectTimer !== null || !canReconnectWs(target) ||
          sessions.find(session => session.id === target.id)?.status !== 'running') return;
      connText('reconnecting');
      wsReconnectTimer = setTimeout(() => {
        // A cancelled callback must not clear a newer connection's timer.
        if (target !== wsReconnectTarget) return;
        wsReconnectTimer = null;
        if (!canReconnectWs(target)) return;
        // Keep this target when the list is temporarily disconnected. A later
        // successful poll resumes the same bounded backoff without replaying work.
        if (sessions.find(session => session.id === target.id)?.status === 'running') openWs(target.id);
        else connText('offline');
      }, Math.min(12000, 750 * 2 ** (wsReconnectFailures - 1)) * (0.8 + Math.random() * 0.4));
    }

    // ── Connect to detected (coordination-only) peer ──────────────────────
    function connectDetected(id) {
      if (!paneMode) window.hccWorkspace?.primary();
      const peer = detected.find((p) => p.id === id);
      window.hccReview?.reset();
      disconnectWebSocket();
      active = null;
      activeDetected = id;
      activeType = 'detected';
      handoffStore.select(currentProject, 'detected', id);
      renderHandoff();
      renderSections();
      renderDetectedHeader(peer || { id });
      document.getElementById('terminal').style.display = 'none';
      document.getElementById('codexPanel').hidden = true;
      document.getElementById('nativePanel').hidden = true;
      document.getElementById('codexPanel').style.display = 'none';
      document.getElementById('terminalComposer').hidden = true;
      document.getElementById('detectedPanel').style.display = '';
      document.getElementById('quickBar').style.display = 'none';
      setMobileView('terminal');
      connText('coordinationOnly');
      renderDetectedPanel(peer || { id });
      refreshDetectedState().catch(reportPollError);
    }

    function renderDetectedPanel(peer) {
      const dp = document.getElementById('detectedPanel');
      dp.innerHTML = `
        <div style="padding:16px;display:grid;gap:12px">
          <div class="card">
            <h2>${esc(tr('detectedSession'))}</h2>
            <div class="body">
              <div class="item"><strong>${esc(tr('peer'))}</strong><span class="mono">${esc(peer.id)}</span></div>
              <div class="item"><strong>${esc(tr('kind'))}</strong><span>${esc(peer.kind || '')}</span></div>
              ${dshCoordinationPeer(peer) ? `
              <div class="item"><strong>${esc(tr('providerSession'))}</strong><span class="mono" style="overflow-wrap:anywhere">${esc(peer.provider_session_id || tr('unknown'))}</span></div>
              <p style="font-size:12px;color:var(--muted)">${esc(tr('dshCoordinationHelp'))}</p>
              ` : ''}
              <div class="item"><strong>${esc(tr('status'))}</strong><span>${esc(statusText(peer.status))}</span></div>
              <div class="item"><strong>${esc(tr('cwd'))}</strong><span class="mono" style="font-size:11px">${esc(peer.worktree || '')}</span></div>
              <div class="item"><strong>${esc(tr('pid'))}</strong><span>${esc(peer.pid || tr('unknown'))}</span></div>
              <div class="item"><strong>${esc(tr('lastSeen'))}</strong><span>${peer.age_sec != null ? esc(peer.age_sec + tr('secondsAgo')) : ''}</span></div>
            </div>
          </div>
          <div class="card">
            <h2>${esc(tr('sendMessage'))}</h2>
            <div class="body" style="gap:8px">
              <div style="font-size:12px;color:var(--muted)">${tr(dshCoordinationPeer(peer) && peer.transport === 'cordis' ? 'dshCordisMessageHelp' : 'messageHelp')}</div>
              <textarea id="detMsg" rows="3" style="width:100%;background:var(--input-bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font:inherit;resize:vertical" placeholder="${esc(tr('messageBodyPlaceholder'))}"></textarea>
              <button class="primary" id="sendDetMsg">${esc(tr('send'))}</button>
            </div>
          </div>
        </div>
      `;
      const draftProject = currentProject;
      const draftKey = 'detected:' + peer.id;
      document.getElementById('detMsg').value = handoffStore.draft(draftProject, draftKey).text;
      document.getElementById('detMsg').addEventListener('input', (event) => handoffStore.saveDraft(draftProject, draftKey, event.target.value));
      document.getElementById('sendDetMsg').addEventListener('click', async () => {
        try {
          const body = document.getElementById('detMsg').value.trim();
          if (!body) return;
          await api('/api/detected/' + encodeURIComponent(peer.id) + '/msg', {
            method: 'POST',
            body: JSON.stringify({ body })
          });
          const textarea = document.getElementById('detMsg');
          if (currentProject === draftProject && activeDetected === peer.id && textarea?.value.trim() === body) {
            textarea.value = '';
            handoffStore.saveDraft(draftProject, draftKey, '');
          }
          await refreshDetectedState();
        } catch (error) { handleUiError(error); }
      });
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function sendLine(text) {
      sendTerminalInput(text + '\r');
    }

    function activePeerInfo() {
      if (!active) return null;
      const session = sessions.find((s) => s.id === active) || { id: active, kind: 'other', role: 'peer' };
      return {
        session,
        peerId: sessionPeerId(session) || active,
        // The action token is delivered via the terminal WS snapshot frame, not
        // the session list (net-05); read it from the per-session store.
        actionToken: sessionActionTokens.get(active) || ''
      };
    }

    function terminalShellQuote(value) {
      return "'" + String(value).split("'").join("'\"'\"'") + "'";
    }

    function terminalCommandForAction(action, info) {
      const session = info.session || {};
      const peerId = terminalShellQuote(info.peerId);
      const lines = {
        register: `hcc register --peer ${peerId} --kind ${terminalShellQuote(session.kind || 'other')} --role ${terminalShellQuote(session.role || 'peer')}`,
        inbox:    `hcc msg inbox --peer ${peerId}`,
        'task-next': `hcc task next --peer ${peerId}`,
        state:    `hcc state --peer ${peerId}`,
        status:   `hcc status --peer ${peerId}`,
        heartbeat:`hcc heartbeat --peer ${peerId} --renew-locks`
      };
      return lines[action] || lines.status;
    }

    function formatActionResult(result) {
      if (!result) return '';
      const data = result.data || {};
      const error = result.error || data.error;
      if (error) {
        const code = String(result.errorCode || '').toLowerCase();
        return [
          tr('error.' + code, tr('requestFailed')),
          result.errorCode ? '[' + result.errorCode + ']' : '',
          tr('details') + ': ' + error
        ].join('\n');
      }
      if (result.action === 'status') {
        const tasks = (data.tasks || []).map((row) => statusText(row.status) + ': ' + row.n).join(', ') || tr('none');
        return [
          data.root ? tr('root') + ': ' + data.root : '',
          tr('peers') + ' · ' + tr('active') + ': ' + (data.active_peers ?? 0) + ' · ' + tr('stale') + ': ' + (data.stale_peers ?? 0),
          tr('tasks') + ': ' + tasks,
          tr('locks') + ' · ' + tr('active') + ': ' + (data.active_locks ?? 0),
          tr('unread') + ': ' + (data.unread ?? 0)
        ].filter(Boolean).join('\n');
      }
      if (result.action === 'state') {
        const automation = data.automation || {};
        const next = automation.next_action || {};
        return [
          tr('phase') + ': ' + statusText(automation.phase || 'idle'),
          tr('next') + ': ' + (next.command || (next.kind && next.kind !== 'none' ? tr('action.' + next.kind, next.kind) : tr('none'))),
          tr('why') + ': ' + (next.reason || tr('noImmediateAction')),
          ...(automation.warnings || []).map((w) => tr('warnings') + ': ' + w)
        ].join('\n');
      }
      if (result.action === 'inbox') {
        const messages = data.messages || [];
        return messages.length
          ? messages.map((m) => '#' + m.id + ' ' + m.sender + ' -> ' + (m.recipient || tr('all')) + ': ' + m.body).join('\n')
          : tr('noMessages');
      }
      if (result.action === 'task-next') {
        return data.task
          ? tr(data.current ? 'current' : 'claimed') + ': #' + data.task.id + ' ' + data.task.title + ' (' + statusText(data.task.status) + ')'
          : tr('noPendingTasks');
      }
      if (result.action === 'task-takeover') {
        return data.task ? '#' + data.task.id + ' ' + data.task.title + ' · ' + tr('owner') + ': ' + data.task.owner : tr('noTasks');
      }
      if (result.action === 'lock-acquire') {
        return data.lock ? tr('locked') + ': ' + lockLabel(data.lock) + ' · ' + tr('by') + ': ' + data.lock.owner : tr('noActiveLocks');
      }
      if (result.action === 'lock-release') {
        return data.result ? tr(data.result.released ? 'lockReleased' : 'noLock') + ': ' + lockLabel(data.result) : tr('noActiveLocks');
      }
      if (result.action === 'heartbeat') {
        return [
          tr('peer') + ': ' + (data.peer || result.peer || tr('unknown')),
          data.status ? tr('status') + ': ' + statusText(data.status) : '',
          tr('renewedLocks') + ': ' + (data.renewed ?? 0)
        ].filter(Boolean).join('\n');
      }
      if (result.action === 'register') {
        const peer = data.peer || {};
        return [
          tr('registered') + ': ' + (peer.id || result.peer || tr('unknown')),
          tr('kind') + ': ' + (peer.kind || tr('unknown')),
          tr('status') + ': ' + statusText(peer.status),
          peer.worktree ? tr('cwd') + ': ' + peer.worktree : ''
        ].filter(Boolean).join('\n');
      }
      return result.summary || JSON.stringify(result, null, 2);
    }

    function showActionResult(result) {
      lastActionResult = result;
      const panel = document.getElementById('actionResult');
      const action = String(result.action || '');
      const label = action ? tr('action.' + action, tr(action, action)) : tr('actionResult');
      document.getElementById('actionResultTitle').textContent = label + (result.peer ? ' · ' + result.peer : '');
      document.getElementById('actionResultBody').textContent = formatActionResult(result);
      panel.hidden = false;
    }

    async function runPeerAction(action) {
      const info = activePeerInfo();
      if (!info) return;
      const readOnly = ['status', 'state', 'inbox'].includes(action);
      const payload = action === 'register'
        ? { kind: info.session.kind || 'other', role: info.session.role || 'peer', worktree: info.session.cwd || currentProject }
        : action === 'heartbeat'
          ? { renew_locks: true }
          : {};
      if (!readOnly) { payload.action_token = info.actionToken; payload.epoch = controlEpoch(); }
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
          handleUiError(err, button.dataset.action);
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
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      closeActionsMenu();
      try {
        const res = await fetch('/logout', { method: 'POST', headers });
        if (!res.ok) throw new Error(tr('requestFailed'));
        // Stop reconnect only after the server confirms revocation.
        loggedOut = true;
        window.hccWorkspace?.destroy();
        try { sessionStorage.setItem('hcc_logged_out', '1'); } catch {}
        location.replace('/');
      } catch (error) { handleUiError(error, 'logout'); }
    });
    document.getElementById('actionResultClose').addEventListener('click', () => {
      document.getElementById('actionResult').hidden = true;
    });

    // ── Stop confirmation dialog ───────────────────────────────────────
    const stopDialog = document.getElementById('stopDialog');
    const stopConfirmBtn = document.getElementById('stopConfirmBtn');
    const stopCancelBtn = document.getElementById('stopCancelBtn');
    const stopKillCb = document.getElementById('stopKillCb');
    const settingsDialog = document.getElementById('settingsDialog');
    const projectDialog = document.getElementById('projectDialog');
    const startDialog = document.getElementById('startDialog');
    let dialogReturnFocus = null;
    function openDialog(dialog, initialFocus) {
      closeActionsMenu();
      dialogReturnFocus = document.activeElement;
      dialog.hidden = false;
      document.querySelector('.app').inert = true;
      document.querySelector('.global-header').inert = true;
      document.querySelector('.mobile-nav').inert = true;
      initialFocus?.focus();
    }
    function offerInitialProject() {
      const requested = pendingInitialProject;
      pendingInitialProject = '';
      if (!requested || requested === currentProject ||
          requested.replace(/[\\/]+$/, '') === currentProject.replace(/[\\/]+$/, '')) return;
      const input = document.getElementById('projectPath');
      input.value = requested;
      document.getElementById('projectDialogError').hidden = true;
      openDialog(projectDialog, input);
    }
    function closeDialog(dialog) {
      if (dialog.id === 'startDialog') window.hccAgentStart?.closed();
      if (dialog.id === 'filesDialog') window.hccFiles?.closed();
      if (dialog.id === 'historyDialog') window.hccHistory?.closed();
      if (dialog.id === 'settingsDialog') window.hccAgentDefaults?.closed();
      dialog.hidden = true;
      document.querySelector('.app').inert = false;
      document.querySelector('.global-header').inert = false;
      document.querySelector('.mobile-nav').inert = false;
      if (dialogReturnFocus?.isConnected && !dialogReturnFocus.disabled && dialogReturnFocus.getClientRects().length) dialogReturnFocus.focus();
      else document.getElementById('settingsBtn').focus();
      dialogReturnFocus = null;
    }
    function updateStopDialogTitle() {
      const peerId = stopDialog._action === 'detected' ? stopDialog._peerId : (sessionPeerId(sessions.find((s) => s.id === active)) || active);
      document.getElementById('stopDialogTitle').textContent = tr('stop') + ' ' + (peerId || '') + '?';
      if (stopDialog._action === 'detected') {
        document.getElementById('stopDialogMeta').textContent = tr('detectedPeer');
        stopConfirmBtn.textContent = tr('stop');
      } else {
        const session = sessions.find((item) => item.id === active) || {};
        document.getElementById('stopDialogTitle').textContent = tr(session.type === 'tmux' ? 'handoff.detach' : 'handoff.terminate') + ' ' + (peerId || '') + '?';
        stopConfirmBtn.textContent = tr(session.type === 'tmux' ? 'handoff.detach' : 'handoff.terminate');
      }
    }
    installAgentStart();
    function openStartDialog() { window.hccAgentStart.open(); }
    document.getElementById('openStartDialog').addEventListener('click', openStartDialog);
    document.getElementById('openHistoryDialog').addEventListener('click', () => window.hccHistory.open());
    document.getElementById('openReviewDialog').addEventListener('click', () => window.hccReview.open());
    document.getElementById('startDialogClose').addEventListener('click', () => closeDialog(startDialog));
    document.getElementById('startCancelBtn').addEventListener('click', () => closeDialog(startDialog));
    document.getElementById('openProjectDialog').addEventListener('click', () => {
      document.getElementById('projectDialogError').hidden = true;
      openDialog(projectDialog, document.getElementById('projectPath'));
    });
    document.getElementById('projectDialogClose').addEventListener('click', () => closeDialog(projectDialog));
    document.getElementById('projectCancelBtn').addEventListener('click', () => closeDialog(projectDialog));
    document.getElementById('settingsBtn').addEventListener('click', () => { openDialog(settingsDialog, document.getElementById('langSelect')); window.hccAgentDefaults.open(); });
    document.getElementById('settingsClose').addEventListener('click', () => closeDialog(settingsDialog));
    [settingsDialog, stopDialog, projectDialog, startDialog, document.getElementById('historyDialog'), document.getElementById('reviewDialog'), document.getElementById('commandDialog'), document.getElementById('filesDialog')].forEach((dialog) => {
      dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog); });
      dialog.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); closeDialog(dialog); return; }
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button, select, input, textarea, a[href], [tabindex="0"]')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
    });
    function preserveFocus(root) {
      const focused = document.activeElement;
      if (!root.contains(focused)) return () => {};
      const key = focused.dataset.focusKey;
      const id = focused.id;
      const section = focused.closest('[data-section]')?.dataset.section;
      const action = focused.dataset.action;
      const peerId = focused.dataset.id;
      return () => {
        const target = [...root.querySelectorAll('button, select, input')].find((el) =>
          key ? el.dataset.focusKey === key : id ? el.id === id : section ? el.closest('[data-section]')?.dataset.section === section : action && el.dataset.action === action && el.dataset.id === peerId);
        target?.focus({ preventScroll: true });
      };
    }

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
    const narrowViewport = window.matchMedia('(max-width: 1099px)');
    const focusBtn = document.getElementById('focusBtn');
    function syncFocusButton() {
      const enabled = appEl.classList.contains('focus-mode');
      focusBtn.textContent = tr(enabled ? 'exitFocus' : 'focusMode');
      focusBtn.setAttribute('aria-pressed', String(enabled));
    }
    function syncPanelAccess() {
      const focus = appEl.classList.contains('focus-mode') && !narrowViewport.matches;
      for (const [selector, view, side] of [['.sidebar', 'sessions', 'left'], ['.main', 'terminal', null], ['.inspector', 'state', 'right']]) {
        appEl.querySelector(selector).inert = paneMode ? view !== 'terminal' : narrowViewport.matches
          ? appEl.dataset.view !== view || view === 'terminal' && appEl.classList.contains('workspace-open') && document.getElementById('workspace').dataset.activePane === 'secondary'
          : Boolean(side && (focus || sideIsCollapsed(side) || side === 'right' && appEl.classList.contains('workspace-open')));
      }
      document.getElementById('workspaceSecondPane').inert = narrowViewport.matches && (appEl.dataset.view !== 'terminal' || document.getElementById('workspace').dataset.activePane !== 'secondary');
    }
    function setMobileView(view) {
      if (paneMode) view = 'terminal';
      if (!['sessions', 'terminal', 'state'].includes(view)) return;
      appEl.dataset.view = view;
      document.querySelectorAll('.mobile-nav [data-view]').forEach((button) => {
        if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      syncPanelAccess();
      closeActionsMenu();
      requestAnimationFrame(() => resizeTerm());
    }
    document.querySelectorAll('.mobile-nav [data-view]').forEach((button) => button.addEventListener('click', () => setMobileView(button.dataset.view)));
    focusBtn.addEventListener('click', () => {
      appEl.classList.toggle('focus-mode');
      syncFocusButton();
      syncPanelAccess();
      setTimeout(resizeTerm, 200);
    });
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
      return appEl.classList.contains(side + '-collapsed') || hccUi.safeGet('hcc.collapse.' + side) === '1';
    }
    function storedSideWidth(side) {
      const raw = Number(hccUi.safeGet(sideWidthKey[side]));
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
      if (persist) hccUi.safeSet(sideWidthKey[side], String(value));
      const handle = document.getElementById(side === 'left' ? 'resizeLeft' : 'resizeRight');
      handle.setAttribute('aria-valuemin', String(sideMin[side]));
      handle.setAttribute('aria-valuemax', String(clampSideWidth(side, sideMax[side])));
      handle.setAttribute('aria-valuenow', String(value));
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
      appEl.classList.toggle('left-collapsed', hccUi.safeGet('hcc.collapse.left') === '1');
      appEl.classList.toggle('right-collapsed', hccUi.safeGet('hcc.collapse.right') === '1');
      applySideWidths();
      syncToggleIcons();
      syncPanelAccess();
    }
    function toggleSide(side) {
      const cls = side + '-collapsed';
      const on = appEl.classList.toggle(cls);
      hccUi.safeSet('hcc.collapse.' + side, on ? '1' : '0');
      applySideWidths();
      syncToggleIcons();
      syncPanelAccess();
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
        hccUi.safeSet('hcc.collapse.left', '0');
      } else {
        appEl.classList.remove('right-collapsed');
        hccUi.safeSet('hcc.collapse.right', '0');
      }
      syncToggleIcons();
      syncPanelAccess();
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
      if (handle.getAttribute('role') === 'separator') handle.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 40 : 16;
        const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * step;
        const width = event.key === 'Home' ? sideMin[side] : event.key === 'End' ? sideMax[side] : readSideWidth(side) + delta;
        appEl.classList.remove(side + '-collapsed');
        hccUi.safeSet('hcc.collapse.' + side, '0');
        setSideWidth(side, width);
        syncToggleIcons();
        syncPanelAccess();
        setTimeout(resizeTerm, 200);
      });
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
      syncPanelAccess();
      closeActionsMenu();
      setTimeout(() => { try { resizeTerm(); } catch {} }, 50);
    });
    applyCollapseState();

    document.getElementById('stopBtn').addEventListener('click', () => {
      if (!active || !canControl()) return;
      const session = sessions.find((s) => s.id === active) || {};
      if (session.type === 'native') return;
      document.getElementById('stopDialogTitle').textContent = tr(session.type === 'tmux' ? 'handoff.detach' : 'handoff.terminate') + ' ' + (sessionPeerId(session) || active) + '?';
      stopConfirmBtn.textContent = tr(session.type === 'tmux' ? 'handoff.detach' : 'handoff.terminate');
      stopKillCb.checked = false;
      const meta = sessionMetaText(session);
      document.getElementById('stopDialogMeta').textContent = [meta, tr(session.type === 'tmux' ? 'handoff.detachHelp' : 'handoff.terminateHelp')].filter(Boolean).join(' · ');
      stopKillCb.parentElement.parentElement.hidden = session.type !== 'tmux';
      stopDialog._action = null; stopDialog._peerId = null;
      stopDialog._sessionId = active;
      stopDialog._projectRoot = currentProject;
      openDialog(stopDialog, stopCancelBtn);
    });
    document.getElementById('refreshBtn').addEventListener('click', () => {
      refreshVisibleData().catch(handleUiError);
    });
    document.getElementById('stateRetry').addEventListener('click', () => {
      refreshVisibleData().catch(handleUiError);
    });

    function terminalFindAvailable() {
      const session = sessions.find(item => item.id === active);
      return Boolean(active && activeType === 'managed' && session && session.type !== 'app-server' && session.type !== 'native');
    }
    function focusSessionsSearch() {
      if (paneMode) { window.hccCommandPalette?.open(); return; }
      if (narrowViewport.matches) setMobileView('sessions');
      else {
        appEl.classList.remove('focus-mode');
        hccUi.safeSet('hcc.collapse.left', '0');
        applyCollapseState(); syncFocusButton();
      }
      document.getElementById('sessionSearch').focus();
    }
    const shortcutPrefix = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ ⇧ ' : 'Ctrl Shift ';
    window.hccTerminalFindHost = {
      term, addon: searchAddon, available: terminalFindAvailable,
      subject: () => currentProject + ':' + (active || ''),
      showTerminal: () => { if (!paneMode) window.hccWorkspace?.primary(); setMobileView('terminal'); }
    };
    installTerminalFind();
    window.hccCommandHost = {
      openDialog, closeDialog, error: handleUiError,
      modalOpen: () => Boolean(document.querySelector('.dialog-overlay:not([hidden])')),
      terminalAvailable: terminalFindAvailable, focusSessions: focusSessionsSearch,
      commands() {
        const page = tr('commands.pages');
        const commands = [
          { id:'new', label:tr('newSession'), group:page, enabled:!window.hccAgentStart.pending, run:openStartDialog },
          { id:'files', label:tr('files.title'), group:page, run:() => window.hccFiles.open() },
          { id:'sessions', label:tr('sessionSearch'), group:page, shortcut:shortcutPrefix+'L', run:focusSessionsSearch },
          { id:'find', label:tr('find.title'), group:page, shortcut:shortcutPrefix+'F', enabled:terminalFindAvailable(), run:() => window.hccTerminalFind.open() },
          { id:'settings', label:tr('settings'), group:page, run:() => document.getElementById('settingsBtn').click() },
          { id:'project-add', label:tr('addProject'), group:page, enabled:!document.getElementById('openProjectDialog').disabled, run:() => document.getElementById('openProjectDialog').click() },
          { id:'refresh', label:tr('commands.refresh'), group:page, run:refreshVisibleData },
          { id:'focus', label:tr(appEl.classList.contains('focus-mode') ? 'exitFocus' : 'focusMode'), group:page, enabled:!narrowViewport.matches, run:() => focusBtn.click() },
          { id:'history', label:tr('aux.history'), group:page, run:() => document.getElementById('openHistoryDialog').click() },
          { id:'review', label:tr('aux.review'), group:page, enabled:!document.getElementById('openReviewDialog').disabled, run:() => document.getElementById('openReviewDialog').click() }
        ];
        for (const view of ['overview','tasks','messages','events']) {
          commands.push({ id:'view:'+view, label:tr('commands.view.'+view), group:page, run:() => {
            if (narrowViewport.matches) setMobileView('state');
            else { if (window.hccWorkspace?.isOpen) window.hccWorkspace.close(); appEl.classList.remove('focus-mode'); hccUi.safeSet('hcc.collapse.right','0'); applyCollapseState(); syncFocusButton(); }
            document.getElementById('stateTab-'+view).click(); document.getElementById('stateTab-'+view).focus();
          }});
        }
        for (const project of projects) {
          commands.push({ id:'project:'+project.root, label:project.name || project.root, detail:project.root, group:tr('commands.projects'), enabled:project.root!==currentProject, run:() => {
            document.getElementById('projectSelect').value = project.root;
            return switchProject(project.root);
          }});
        }
        const root = currentProject;
        for (const session of sessions) {
          commands.push({ id:'session:'+root+':'+session.id, label:session.name || session.task?.title || sessionPeerId(session), detail:sessionProvider(session)+' · '+statusText(session.status)+' · '+(session.cwd || ''), keywords:[session.id,sessionPeerId(session),session.task?.title,sessionRuntimeTarget(session),sessionProviderSessionValue(session),session.command].join(' '), group:tr('sessions'), enabled:session.status==='running', run:() => { if (currentProject===root) connectManaged(session.id); }});
        }
        for (const peer of detected) {
          commands.push({ id:'detected:'+root+':'+peer.id, label:peer.name || peer.id, detail:(peer.provider || peer.kind || '')+' · '+(peer.worktree || peer.cwd || ''), group:tr('detected'), run:() => { if (currentProject===root) connectDetected(peer.id); }});
        }
        if (paneMode) return commands.filter(command => ['new','files','sessions','find','settings','history','review','refresh'].includes(command.id) || command.id.startsWith('session:'));
        commands.splice(3,0,{id:'workspace',label:tr(window.hccWorkspace?.isOpen ? 'workspace.close' : 'workspace.split'),group:page,enabled:!document.getElementById('splitBtn').disabled,run:() => document.getElementById('splitBtn').click()});
        return commands;
      }
    };
    installCommandPalette();
    window.hccWorkspaceHost = {
      embedded:paneMode, app:appEl, primary:document.getElementById('workspacePrimaryPane'),
      project:() => currentProject, projectIdentity:() => projectRequests.rootIdentity(),
      active:() => active, sessions:() => sessions, ready:() => sessionsLoaded,
      esc, showTerminal:() => setMobileView('terminal'), layoutChanged:() => { syncPanelAccess(); requestAnimationFrame(resizeTerm); }
    };
    installWorkspace();
    term.attachCustomKeyEventHandler(event => !event.defaultPrevented && !window.hccCommandPalette.captures(event));
    hccUi.bindControls();
    window.addEventListener('hcc:preferences', (event) => {
      if (event.detail.changed.some((key) => key === 'language' || key === 'resolvedLanguage')) applyLanguage();
      syncFocusButton();
      syncToggleIcons();
      applyTerminalPreferences();
    });
    applyTerminalPreferences();
    applyLanguage();
    loadProjects().then(() => {
      offerInitialProject();
      return Promise.all([refreshSessions(), refreshDetected(), refreshState()]);
    }).then(() => {
      if (!active && !activeDetected) restoreSelection();
    }).catch((err) => {
      if (err.name === 'AbortError') return;
      connText('error');
      console.error(err);
    });
    const stopDataPoll = scheduleVisiblePoll(refreshVisibleData, { intervalMs: 3000 });
    const stopProjectPoll = scheduleVisiblePoll(refreshProjectsQuietly, { intervalMs: 8000 });
    window.addEventListener('online', () => {
      if (!loggedOut && active && (!ws || ws.readyState === WebSocket.CLOSED)) {
        clearTimeout(wsReconnectTimer); wsReconnectFailures = 0; openWs(active);
      }
    });
    window.addEventListener('pagehide', () => { stopDataPoll(); stopProjectPoll(); projectRequests.dispose(); });
    window.addEventListener('pageshow', (event) => {
      // pagehide disposes sockets, polling and embedded panes. A bfcache restore
      // skips module initialization, so reload the complete lifecycle. Saved
      // drafts and selection survive; initialization never replays submissions.
      if (event.persisted) location.reload();
    });

    stopCancelBtn.addEventListener('click', () => closeDialog(stopDialog));

    stopConfirmBtn.addEventListener('click', async () => {
      closeDialog(stopDialog);
      try {
        const killTmux = stopKillCb.checked;
        if (stopDialog._action === 'detected') {
          const peerId = stopDialog._peerId;
          stopDialog._action = null; stopDialog._peerId = null;
          if (!peerId) return;
          await api('/api/detected/' + encodeURIComponent(peerId) + '/stop', { method: 'POST', body: JSON.stringify({ kill_tmux: killTmux }) });
          await Promise.all([refreshSessions(), refreshDetected()]);
        } else {
          if (!active || !canControl()) return;
          if (stopDialog._sessionId !== active || stopDialog._projectRoot !== currentProject) throw new Error(tr('error.subject_changed'));
          await api('/api/sessions/' + encodeURIComponent(active) + '/stop', { method: 'POST', body: JSON.stringify({ kill_tmux: killTmux, action_token: sessionActionTokens.get(active) || '', epoch: controlEpoch() }) });
          await refreshSessions();
        }
      } catch (error) { handleUiError(error); }
    });
