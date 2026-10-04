import { nativeTimeline } from './ui-native-timeline.mjs';

export function codexHistoryHtml() {
  return `<div class="dialog-overlay" id="historyDialog" role="dialog" aria-modal="true" aria-labelledby="historyTitle" hidden>
    <div class="dialog auxiliary-dialog">
      <header class="dialog-heading"><h3 id="historyTitle" data-i18n="history.title">History</h3><button id="historyClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <div class="session-tool-row"><label><span data-i18n="history.source">Source</span> <select id="historySource"><option value="native" data-i18n="history.native">HCC retained history</option><option value="codex" data-i18n="history.codex">Codex saved threads</option></select></label>
        <label id="historyProviderField"><span data-i18n="agent.provider">Agent</span> <select id="historyProvider"><option value="all" data-i18n="history.allProviders">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="dsh">DeepSeek Harness</option></select></label></div>
      <p class="dialog-help" id="historyHelp"></p><p id="historyNotice" class="dialog-help" role="status" aria-live="polite"></p>
      <p id="historyUnverified" class="dialog-help" role="status" aria-live="polite"></p>
      <div class="history-layout"><div class="history-list"><button id="historyRefresh" type="button" data-i18n="refresh">Refresh</button><div id="historyThreads"></div><button id="historyMore" type="button" data-i18n="history.more" hidden>Load more</button></div>
        <div class="history-preview"><h4 id="historySelected"></h4><p id="historyIdentity" class="dialog-help"></p><p id="historyRetention" class="dialog-help"></p>
          <p id="historyResumeReason" class="dialog-help"></p>
          <label class="confirmation-row"><input id="historyConfirmed" type="checkbox"><span id="historyConfirmLabel"></span></label>
          <div class="btns"><button id="historyResume" type="button" data-i18n="history.resume" disabled>Resume in a new executor</button><button id="historyFork" type="button" data-i18n="history.fork" disabled>Fork into a new executor</button></div>
          <div class="session-tool-row" id="historyEventControls" hidden><button id="historyEventsPrevious" type="button" data-i18n="history.previousEvents">Previous events</button><span id="historyEventPage"></span><button id="historyEventsNext" type="button" data-i18n="history.nextEvents">Next events</button><button id="historyEventsReload" type="button" data-i18n="refresh">Refresh</button><label><span data-i18n="history.view">View</span> <select id="historyNativeView"><option value="conversation" data-i18n="history.output">Recorded output</option><option value="trace" data-i18n="history.trace">Event trace</option></select></label></div>
          <div id="historyContent"></div><details id="historyReceipts" hidden><summary data-i18n="history.receipts">Recent delivery receipts</summary><pre id="historyReceiptContent"></pre></details>
        </div></div>
    </div>
  </div>`;
}

export function codexHistoryScript() { return '(' + installHistory.toString() + ')(globalThis,(' + nativeTimeline.toString() + '));'; }

export function installHistory(browser = globalThis, timeline = nativeTimeline) {
  const { window, document } = browser, byId = id => document.getElementById(id);
  const dialog = byId('historyDialog'), bridge = () => window.hccHandoff;
  const tr = (key, fallback = '') => bridge().tr(key, fallback), esc = value => bridge().esc(String(value ?? ''));
  let root = '', source = 'native', entries = [], cursor = null, selected = null, ready = false, busy = false, generation = 0;
  let unverifiedCount = 0;
  let events = [], deliveries = [], nextAfter = null, pageStarts = [0], page = 0, runtimeAvailable = true;
  const isNative = () => source === 'native';
  const same = (project, version) => project === root && project === bridge().projectRoot && version === generation && !dialog.hidden;
  const route = (path, project = root) => path + (path.includes('?') ? '&' : '?') + 'root=' + encodeURIComponent(project);
  const entryId = entry => isNative() ? entry.peer : entry.id;
  function notice(value) { byId('historyNotice').textContent = value || ''; }
  function liveSources() {
    return (bridge().sessions || []).filter(session => session.status === 'running' && (isNative()
      ? session.type === 'native' && [session.id,session.peer_id].includes(selected?.peer)
      : session.binding?.provider === 'codex' && session.binding.provider_session_id === selected?.id));
  }
  function controlsSource(sources) { return sources.every(session => session.id === bridge().active && bridge().canControl); }
  function nativeEligible() { return ready && selected?.resumable === true && selected.status === 'closed' && selected.owned === false && Boolean(selected.owner && selected.sessionId); }
  function updatedLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
  }
  function sync() {
    if (!dialog.hidden && !root && bridge().projectRoot) { root = bridge().projectRoot; void load(); return; }
    const confirmed = byId('historyConfirmed').checked, sources = liveSources();
    const unavailable = busy || !ready || !selected || !confirmed || root !== bridge().projectRoot || Boolean(window.hccAgentStart?.pending);
    byId('historyProviderField').hidden = !isNative();
    byId('historyHelp').textContent = tr(isNative() ? 'history.nativeHelp' : 'history.help');
    byId('historyUnverified').textContent = !isNative() && unverifiedCount > 0
      ? tr('history.unverified').replace('{count}', String(unverifiedCount)) : '';
    byId('historyConfirmLabel').textContent = tr(isNative() ? 'history.nativeConfirm' : 'history.confirm');
    byId('historyResume').disabled = unavailable || sources.length > 0 || (isNative() && !nativeEligible());
    byId('historyFork').hidden = isNative(); byId('historyFork').disabled = isNative() || unavailable || !controlsSource(sources);
    byId('historyResumeReason').textContent = isNative() && selected && !nativeEligible()
      ? tr('history.resumeReason.' + (selected.resumeReason || 'unavailable'), selected.resumeDetail || tr('history.resumeUnavailable')) : '';
    if (!busy && sources.length) notice(tr(isNative() ? 'history.nativeActive' : controlsSource(sources) ? 'history.stopOriginal' : 'history.sourceControlRequired'));
    byId('historyRefresh').disabled = busy; byId('historyMore').hidden = isNative() || !cursor; byId('historyMore').disabled = busy;
    byId('historyEventControls').hidden = !isNative() || !ready;
    byId('historyEventsPrevious').disabled = busy || page === 0; byId('historyEventsNext').disabled = busy || nextAfter == null;
    byId('historyEventsReload').disabled = busy; byId('historyReceipts').hidden = !isNative() || !ready;
  }
  function clearSelected() {
    selected = null; ready = false; events = []; deliveries = []; nextAfter = null; pageStarts = [0]; page = 0;
    byId('historyConfirmed').checked = false; byId('historyReceipts').open = false;
    for (const id of ['historySelected','historyContent','historyIdentity','historyRetention','historyReceiptContent']) byId(id).textContent = '';
  }
  function renderList() {
    const provider = byId('historyProvider').value || 'all';
    const filtered = isNative() && provider !== 'all' ? entries.filter(entry => entry.provider === provider) : entries;
    const container = byId('historyThreads');
    container.innerHTML = filtered.map(entry => '<button type="button" class="history-thread" data-thread="' + esc(entryId(entry)) + '" aria-pressed="' + (entryId(entry) === (selected && entryId(selected))) + '"><strong>'
      + esc(isNative() ? entry.peer : entry.name || entry.preview || entry.id) + '</strong><span>'
      + esc(isNative() ? [entry.provider,entry.status,updatedLabel(entry.updatedAt)].filter(Boolean).join(' · ') : entry.id) + '</span><span>' + esc(entry.cwd || '') + '</span></button>').join('')
      || '<p class="dialog-help">' + esc(tr(isNative() ? 'history.nativeEmpty' : 'history.empty')) + '</p>';
    container.querySelectorAll('[data-thread]').forEach(button => button.addEventListener('click', () => select(button.dataset.thread))); sync();
  }
  async function load(more = false) {
    if (busy) return;
    if (!root) { notice(tr('history.projectLoading')); return; }
    const project = root, version = ++generation, native = isNative();
    if (!more) { clearSelected(); unverifiedCount = 0; }
    busy = true; notice(tr('history.loading')); sync();
    try {
      const result = await bridge().api(route(native ? '/api/native/history' : '/api/codex/threads' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), project));
      if (!same(project,version)) return;
      const incoming = (native ? result.workers : result.threads) || [];
      entries = [...new Map((more ? entries.concat(incoming) : incoming).map(entry => [entryId(entry),entry])).values()];
      cursor = native ? null : result.nextCursor || null; runtimeAvailable = result.runtimeAvailable !== false;
      const hidden = Number(result.unverifiedCount);
      if (!native && Number.isSafeInteger(hidden) && hidden > 0) unverifiedCount += hidden;
      notice(native ? [runtimeAvailable ? '' : tr('history.runtimeOffline'),result.truncated ? tr('history.listTruncated') : ''].filter(Boolean).join(' ') : ''); renderList();
    } catch (error) { if (same(project,version)) notice(error.detail || error.message); }
    finally { if (project === root && version === generation) { busy = false; sync(); } }
  }
  async function select(id, targetPage = 0) {
    if (busy) return;
    const project = root, version = ++generation, native = isNative();
    if (!selected || entryId(selected) !== id) { clearSelected(); selected = entries.find(entry => entryId(entry) === id) || (native ? {peer:id} : {id}); }
    ready = false; byId('historyConfirmed').checked = false;
    byId('historySelected').textContent = selected.name || selected.preview || id; byId('historyContent').textContent = ''; byId('historyReceiptContent').textContent = '';
    busy = true; renderList(); notice(tr('history.loading'));
    try {
      const result = await bridge().api(route(native ? '/api/native/history/' + encodeURIComponent(id) + '?after=' + (pageStarts[targetPage] || 0) : '/api/codex/threads/' + encodeURIComponent(id),project));
      if (!same(project,version)) return;
      selected = (native ? result.worker : result.thread) || selected; ready = true;
      if (native) {
        runtimeAvailable = result.runtimeAvailable !== false;
        events = Array.isArray(result.events) ? result.events : []; deliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
        nextAfter = result.truncated === true && Number.isSafeInteger(result.nextAfter) && result.nextAfter > (pageStarts[targetPage] || 0) ? result.nextAfter : null;
        page = targetPage; if (nextAfter != null) pageStarts[page + 1] = nextAfter; pageStarts.length = page + (nextAfter == null ? 1 : 2);
      }
      renderPreview(); notice(native && !runtimeAvailable ? tr('history.runtimeOffline') : '');
    } catch (error) { if (same(project,version)) notice(error.detail || error.message); }
    finally { if (project === root && version === generation) { busy = false; sync(); } }
  }
  function renderPreview() {
    if (!ready) return;
    if (isNative()) {
      byId('historyIdentity').textContent = [selected.provider,selected.peer,selected.status,selected.sessionId,selected.cwd].filter(Boolean).join(' · ');
      byId('historyRetention').textContent = tr('history.retention');
      byId('historyEventPage').textContent = tr('history.eventPage').replace('{page}',String(page + 1)).replace('{count}',String(events.length))
        + (events.length ? ' · #' + events[0].id + '–#' + events.at(-1).id : '');
      byId('historyReceiptContent').textContent = JSON.stringify(deliveries,null,2);
      const trace = byId('historyNativeView').value === 'trace';
      byId('historyContent').innerHTML = (trace ? events.map(entry => '<details class="history-turn"><summary>#' + esc(entry.id) + ' · ' + esc((entry.payload || entry).type || '') + '</summary><pre>' + esc(JSON.stringify(entry.payload || entry,null,2)) + '</pre></details>')
        : timeline(events,selected.provider).map(record => '<section class="history-turn"><strong>' + esc(record.role === 'user' ? tr('history.user') : record.role === 'assistant' ? tr('history.assistant') : record.title || record.kind)
          + '</strong><small> · #' + esc(record.eventId) + (record.status ? ' · ' + esc(record.status) : '') + '</small><pre>'
          + esc([record.text,record.command,record.input,record.output,record.changes?.length ? JSON.stringify(record.changes,null,2) : ''].filter(Boolean).join('\n\n')) + '</pre></section>')).join('')
          || '<p class="dialog-help">' + esc(tr('history.noEvents')) + '</p>'; return;
    }
    byId('historyContent').innerHTML = (selected?.turns || []).map(turn => '<section class="history-turn"><strong>' + esc(turn.status || '') + '</strong>' + (turn.items || []).map(item => {
      const content = Array.isArray(item.content) ? item.content.map(part => part.text || '').join('\n') : item.text || item.command || item.aggregatedOutput || '';
      const label = item.type === 'userMessage' ? tr('history.user') : item.type === 'agentMessage' ? tr('history.assistant') : item.type === 'commandExecution' ? tr('history.command') : item.type === 'fileChange' ? tr('history.files') : tr('history.event');
      return '<article><strong>' + esc(label) + '</strong><pre>' + esc(content || (item.changes ? JSON.stringify(item.changes,null,2) : '')) + '</pre></article>';
    }).join('') + '</section>').join('') || '<p class="dialog-help">' + esc(tr('history.noTurns')) + '</p>';
  }
  async function reopen(fork) {
    if (busy || !ready || !selected || !byId('historyConfirmed').checked || root !== bridge().projectRoot) return;
    const sources = liveSources();
    if (isNative()) {
      if (fork || !nativeEligible() || sources.length || window.hccAgentStart?.pending) { sync(); return; }
      const worker = { ...selected }; bridge().closeDialog(dialog); return window.hccAgentStart.resumeNative(worker);
    }
    if (sources.length && (!fork || !controlsSource(sources))) { sync(); return; }
    const project = root, threadId = selected.id, version = ++generation;
    const input = fork ? { confirmed:true, ...(sources.length ? {actionToken:bridge().actionToken,epoch:bridge().epoch} : {}) }
      : {kind:'codex',transport:'app-server',mode:'resume',resume:threadId,handoffConfirmed:true};
    busy = true; sync(); notice(tr('history.opening'));
    try {
      const result = await bridge().api(fork ? route('/api/codex/threads/' + encodeURIComponent(threadId) + '/fork',project) : route('/api/sessions',project),{method:'POST',body:JSON.stringify(input)});
      if (project !== bridge().projectRoot) return;
      await bridge().refreshSessions(); if (!same(project,version)) return;
      bridge().closeDialog(dialog); if (result.session?.id) bridge().openManaged(result.session.id);
    } catch (error) { if (same(project,version)) notice((error.detail || error.message) + (error.code ? ' [' + error.code + ']' : '') + ' ' + tr('history.checkSessions')); }
    finally { if (project === root && version === generation) { busy = false; sync(); } }
  }
  function closed() { generation++; busy = false; ready = false; byId('historyConfirmed').checked = false; }
  function open(nextSource = 'native') {
    root = bridge().projectRoot; generation++; source = nextSource === 'codex' ? 'codex' : 'native'; entries = []; cursor = null; unverifiedCount = 0; busy = false; clearSelected();
    byId('historySource').value = source; byId('historyProvider').value = 'all'; byId('historyNativeView').value = 'conversation';
    bridge().openDialog(dialog,byId('historySource')); renderList(); void load();
  }
  byId('historySource').addEventListener('change',() => {
    generation++; busy = false; source = byId('historySource').value === 'codex' ? 'codex' : 'native'; entries = []; cursor = null; unverifiedCount = 0; clearSelected(); renderList(); void load();
  });
  byId('historyProvider').addEventListener('change',() => {
    // Keep an in-flight list read: its response uses the current filter. A
    // detail read is fenced when its selected provider is left behind.
    if (selected) { generation++; busy = false; clearSelected(); notice(''); }
    renderList();
  });
  byId('historyNativeView').addEventListener('change',renderPreview);
  byId('historyEventsPrevious').addEventListener('click',() => { if (page > 0 && selected) return select(selected.peer,page - 1); });
  byId('historyEventsNext').addEventListener('click',() => { if (nextAfter != null && selected) return select(selected.peer,page + 1); });
  byId('historyEventsReload').addEventListener('click',() => selected && select(selected.peer,page));
  byId('historyClose').addEventListener('click',() => { closed(); bridge().closeDialog(dialog); });
  byId('historyRefresh').addEventListener('click',() => load()); byId('historyMore').addEventListener('click',() => load(true));
  byId('historyConfirmed').addEventListener('change',sync); byId('historyResume').addEventListener('click',() => reopen(false));
  byId('historyFork').addEventListener('click',() => reopen(true));
  window.addEventListener('hcc:preferences',() => { if (!dialog.hidden) { renderList(); renderPreview(); } });
  window.hccHistory = {open,sync,closed,reset() { closed(); if (!dialog.hidden) bridge().closeDialog(dialog); }};
}
