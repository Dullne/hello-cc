export const workbenchCss = `
  .inspector { grid-template-rows:auto auto auto minmax(0,1fr); }
  .state-tabs { display:flex; gap:4px; padding:8px var(--space); border-bottom:1px solid var(--border); }
  .state-tabs button { flex:1; min-width:0; border:0; background:transparent; color:var(--muted); padding:0 5px; font-size:12px; }
  .state-tabs button[aria-selected="true"] { background:var(--selection-bg); color:var(--text); }
  .state-freshness { display:flex; align-items:center; gap:8px; padding:8px var(--space); color:var(--muted); font-size:var(--small-font); }
  .state-freshness span { flex:1; min-width:0; overflow-wrap:anywhere; }
  .state-freshness[data-stale="true"] { color:var(--warn); background:var(--panel-2); }
  .state-freshness button { height:28px; padding:0 8px; font-size:12px; }
  .state-announcement { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .handoff-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .handoff-chip { display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:11px; background:var(--panel-2); padding:4px 8px; border-radius:5px; }
  .handoff-chip[data-tone="ok"] { color:var(--ok); }
  .handoff-chip[data-tone="warn"] { color:var(--warn); }
  .handoff-chip[data-tone="danger"] { color:var(--danger); }
  .handoff-detail summary { cursor:pointer; width:fit-content; padding:3px 0; }
  .handoff-detail div { padding-top:5px; line-height:1.6; }
  @media (pointer:coarse) { .handoff-bar button, .state-tabs button, .state-freshness button { min-height:40px; } }
`;

export function workbenchControlsHtml() {
  return `<nav class="state-tabs" role="tablist" aria-label="Project views" id="stateTabs">
    <button type="button" id="stateTab-overview" role="tab" data-state-view="overview" aria-controls="state" aria-selected="true">Overview</button>
    <button type="button" id="stateTab-tasks" role="tab" data-state-view="tasks" aria-controls="state" aria-selected="false" tabindex="-1">Tasks</button>
    <button type="button" id="stateTab-messages" role="tab" data-state-view="messages" aria-controls="state" aria-selected="false" tabindex="-1">Messages</button>
    <button type="button" id="stateTab-events" role="tab" data-state-view="events" aria-controls="state" aria-selected="false" tabindex="-1">Events</button>
  </nav>
  <div class="state-freshness" id="stateFreshness" data-stale="false"><span id="stateUpdated"></span><span id="stateAnnouncement" class="state-announcement" role="status" aria-live="polite"></span><button type="button" id="stateRetry" hidden>Retry</button></div>`;
}

// Display state only: the caller owns requests, project scope and retry policy.
export function workbenchScript() {
  return `(() => {
    const tabs = document.getElementById('stateTabs');
    const state = document.getElementById('state');
    const notice = document.getElementById('stateFreshness');
    const updated = document.getElementById('stateUpdated');
    const announcement = document.getElementById('stateAnnouncement');
    const retry = document.getElementById('stateRetry');
    const groups = { overview: ['automation', 'tasks', 'locks'], tasks: ['tasks', 'peers', 'locks'], messages: ['messages'], events: ['timeline'] };
    let view = 'overview', lastUpdated = 0, failure = '', loading = true, announcementKind = '';
    const text = (en, zh) => window.hccUi.language === 'zh' ? zh : en;
    function apply() {
      const labels = { overview: text('Overview', '概览'), tasks: text('Tasks', '任务'), messages: text('Messages', '消息'), events: text('Events', '事件') };
      tabs.setAttribute('aria-label', text('Project views', '项目视图'));
      tabs.querySelectorAll('[data-state-view]').forEach(button => {
        const selected = button.dataset.stateView === view;
        button.textContent = labels[button.dataset.stateView];
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      state.setAttribute('role', 'tabpanel');
      state.setAttribute('aria-labelledby', 'stateTab-' + view);
      state.querySelectorAll('.state-card[data-section]').forEach(card => { card.hidden = !groups[view].includes(card.dataset.section); });
      notice.dataset.stale = String(Boolean(failure));
      const time = lastUpdated ? new Date(lastUpdated).toLocaleTimeString(window.hccUi.language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      updated.textContent = failure
        ? text('Update failed. ', '更新失败。') + (time ? text('Showing data from ', '当前数据更新于 ') + time : text('Data unavailable.', '暂时无法获取数据。'))
        : time ? text('Updated ', '更新于 ') + time : text('Loading project state…', '正在加载项目状态…');
      updated.title = failure;
      const announcements = { loading: text('Loading project state', '正在加载项目状态'), loaded: text('Project state loaded', '项目状态已加载'), failed: lastUpdated ? text('Update failed. Previous data is retained.', '更新失败，保留上次成功的数据。') : text('Update failed. Data unavailable.', '更新失败，暂时无法获取数据。'), recovered: text('Project state updates recovered', '项目状态更新已恢复') };
      const announcementText = announcements[announcementKind] || '';
      if (announcement.textContent !== announcementText) announcement.textContent = announcementText;
      retry.textContent = text('Retry', '重试');
      retry.hidden = !failure;
      retry.disabled = loading;
      state.setAttribute('aria-busy', String(loading));
    }
    function select(next) {
      if (!groups[next]) return;
      view = next; state.scrollTop = 0; apply();
    }
    tabs.querySelectorAll('[data-state-view]').forEach(button => {
      button.addEventListener('click', () => select(button.dataset.stateView));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...tabs.querySelectorAll('[data-state-view]')];
        const index = buttons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        select(buttons[next].dataset.stateView); buttons[next].focus();
      });
    });
    window.hccWorkbench = {
      apply,
      fresh() { if (failure) announcementKind = 'recovered'; else if (!lastUpdated) announcementKind = 'loaded'; lastUpdated = Date.now(); failure = ''; loading = false; apply(); },
      stale(error) { announcementKind = 'failed'; failure = error?.detail || error?.message || text('Request failed', '请求失败'); loading = false; apply(); },
      loading() { loading = true; apply(); },
      reset() { announcementKind = 'loading'; lastUpdated = 0; failure = ''; loading = true; state.textContent = ''; apply(); }
    };
    window.addEventListener('hcc:preferences', apply);
    apply();
  })();`;
}
