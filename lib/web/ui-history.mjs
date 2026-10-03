export function codexHistoryHtml() {
  return `<div class="dialog-overlay" id="historyDialog" role="dialog" aria-modal="true" aria-labelledby="historyTitle" hidden>
    <div class="dialog auxiliary-dialog">
      <header class="dialog-heading"><h3 id="historyTitle" data-i18n="history.title">Codex history</h3><button id="historyClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <p class="dialog-help" data-i18n="history.help">Browse saved history, then explicitly resume or fork it in a separate executor.</p>
      <p id="historyNotice" class="dialog-help" role="status" aria-live="polite"></p>
      <div class="history-layout"><div class="history-list"><button id="historyRefresh" type="button" data-i18n="refresh">Refresh</button><div id="historyThreads"></div><button id="historyMore" type="button" data-i18n="history.more" hidden>Load more</button></div>
        <div class="history-preview"><h4 id="historySelected"></h4><div id="historyContent"></div>
          <label class="confirmation-row"><input id="historyConfirmed" type="checkbox"><span data-i18n="history.confirm">I checked the original executor. Opening starts a separate executor; resuming the same thread requires stopping the original.</span></label>
          <div class="btns"><button id="historyResume" type="button" data-i18n="history.resume" disabled>Resume in a new executor</button><button id="historyFork" type="button" data-i18n="history.fork" disabled>Fork into a new executor</button></div>
        </div></div>
    </div>
  </div>`;
}

export function codexHistoryScript() {
  return String.raw`(() => {
    const dialog = document.getElementById('historyDialog');
    const bridge = () => window.hccHandoff;
    const tr = (key, fallback = '') => bridge().tr(key, fallback);
    const esc = value => bridge().esc(String(value ?? ''));
    let root = '', entries = [], cursor = null, selected = null, busy = false, generation = 0;
    const same = (project, version) => project === root && project === bridge().projectRoot && version === generation && !dialog.hidden;
    const route = (path, project = root) => path + (path.includes('?') ? '&' : '?') + 'root=' + encodeURIComponent(project);
    function notice(value) { document.getElementById('historyNotice').textContent = value || ''; }
    function liveSources() {
      return (bridge().sessions || []).filter(session => session.status === 'running' && session.binding?.provider === 'codex' && session.binding.provider_session_id === selected?.id);
    }
    function controlsSource(sources) { return sources.every(session => session.id === bridge().active && bridge().canControl); }
    function sync() {
      const confirmed = document.getElementById('historyConfirmed').checked;
      const sources = liveSources(), unavailable = busy || !selected || !confirmed || root !== bridge().projectRoot;
      document.getElementById('historyResume').disabled = unavailable || sources.length > 0;
      document.getElementById('historyFork').disabled = unavailable || !controlsSource(sources);
      if (!busy && sources.length) notice(tr(controlsSource(sources) ? 'history.stopOriginal' : 'history.sourceControlRequired'));
      document.getElementById('historyRefresh').disabled = busy;
      document.getElementById('historyMore').hidden = !cursor;
      document.getElementById('historyMore').disabled = busy;
    }
    function renderList() {
      const container = document.getElementById('historyThreads');
      container.innerHTML = entries.map(entry => '<button type="button" class="history-thread" data-thread="' + esc(entry.id) + '" aria-pressed="' + (entry.id === selected?.id) + '"><strong>' + esc(entry.name || entry.preview || entry.id) + '</strong><span>' + esc(entry.id) + '</span><span>' + esc(entry.cwd || '') + '</span></button>').join('') || '<p class="dialog-help">' + esc(tr('history.empty')) + '</p>';
      container.querySelectorAll('[data-thread]').forEach(button => button.addEventListener('click', () => select(button.dataset.thread)));
      sync();
    }
    async function load(more = false) {
      if (busy || !root) return;
      const project = root, version = ++generation;
      busy = true; notice(tr('history.loading')); sync();
      try {
        const result = await bridge().api(route('/api/codex/threads' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), project));
        if (!same(project, version)) return;
        const incoming = Array.isArray(result.threads) ? result.threads : [];
        entries = [...new Map((more ? entries.concat(incoming) : incoming).map(entry => [entry.id, entry])).values()];
        cursor = result.nextCursor || null;
        notice(''); renderList();
      } catch (error) { if (same(project, version)) notice(error.detail || error.message); }
      finally { if (project === root && version === generation) { busy = false; sync(); } }
    }
    async function select(id) {
      if (busy) return;
      const project = root, version = ++generation;
      selected = entries.find(entry => entry.id === id) || { id };
      document.getElementById('historyConfirmed').checked = false;
      document.getElementById('historySelected').textContent = selected.name || selected.preview || id;
      document.getElementById('historyContent').textContent = '';
      busy = true; renderList(); notice(tr('history.loading'));
      try {
        const result = await bridge().api(route('/api/codex/threads/' + encodeURIComponent(id), project));
        if (!same(project, version)) return;
        selected = result.thread || selected;
        renderPreview();
        notice('');
      } catch (error) { if (same(project, version)) notice(error.detail || error.message); }
      finally { if (project === root && version === generation) { busy = false; sync(); } }
    }
    function renderPreview() {
        document.getElementById('historyContent').innerHTML = (selected?.turns || []).map(turn => '<section class="history-turn"><strong>' + esc(turn.status || '') + '</strong>' + (turn.items || []).map(item => {
          const content = Array.isArray(item.content) ? item.content.map(part => part.text || '').join('\n') : item.text || item.command || item.aggregatedOutput || '';
          const label = item.type === 'userMessage' ? tr('history.user') : item.type === 'agentMessage' ? tr('history.assistant') : item.type === 'commandExecution' ? tr('history.command') : item.type === 'fileChange' ? tr('history.files') : tr('history.event');
          return '<article><strong>' + esc(label) + '</strong><pre>' + esc(content || (item.changes ? JSON.stringify(item.changes, null, 2) : '')) + '</pre></article>';
        }).join('') + '</section>').join('') || '<p class="dialog-help">' + esc(tr('history.noTurns')) + '</p>';
    }
    async function reopen(fork) {
      if (busy || !selected || !document.getElementById('historyConfirmed').checked || root !== bridge().projectRoot) return;
      const sources = liveSources();
      if (sources.length && (!fork || !controlsSource(sources))) { sync(); return; }
      const project = root, threadId = selected.id, version = ++generation;
      const input = fork ? { confirmed: true, ...(sources.length ? { actionToken: bridge().actionToken, epoch: bridge().epoch } : {}) } : { kind: 'codex', transport: 'app-server', mode: 'resume', resume: threadId, handoffConfirmed: true };
      busy = true; sync(); notice(tr('history.opening'));
      try {
        const result = await bridge().api(fork ? route('/api/codex/threads/' + encodeURIComponent(threadId) + '/fork', project) : route('/api/sessions', project), {
          method: 'POST', body: JSON.stringify(input)
        });
        if (project !== bridge().projectRoot) return;
        await bridge().refreshSessions();
        if (!same(project, version)) return;
        bridge().closeDialog(dialog);
        if (result.session?.id) bridge().openManaged(result.session.id);
      } catch (error) { if (same(project, version)) notice((error.detail || error.message) + (error.code ? ' [' + error.code + ']' : '') + ' ' + tr('history.checkSessions')); }
      finally { if (project === root && version === generation) { busy = false; sync(); } }
    }
    function open() {
      root = bridge().projectRoot; generation++; entries = []; selected = null; cursor = null; busy = false;
      document.getElementById('historyContent').textContent = ''; document.getElementById('historySelected').textContent = '';
      document.getElementById('historyConfirmed').checked = false;
      bridge().openDialog(dialog, document.getElementById('historyRefresh')); renderList(); void load();
    }
    document.getElementById('historyClose').addEventListener('click', () => bridge().closeDialog(dialog));
    document.getElementById('historyRefresh').addEventListener('click', () => load());
    document.getElementById('historyMore').addEventListener('click', () => load(true));
    document.getElementById('historyConfirmed').addEventListener('change', sync);
    document.getElementById('historyResume').addEventListener('click', () => reopen(false));
    document.getElementById('historyFork').addEventListener('click', () => reopen(true));
    window.addEventListener('hcc:preferences', () => { if (!dialog.hidden) { renderList(); renderPreview(); } });
    window.hccHistory = { open, sync, reset() { generation++; busy = false; if (!dialog.hidden) bridge().closeDialog(dialog); } };
  })();`;
}
