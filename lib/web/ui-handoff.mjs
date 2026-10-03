// Browser handoff state is scoped to the runtime project and session. Storage
// failures fall back to memory; delivery records never trigger an automatic send.
export function createHandoffStore(storage, { scope = '' } = {}) {
  const memory = new Map();
  const suffix = scope ? ':pane:' + JSON.stringify(String(scope)) : '';
  const key = (kind, project, session = '') => 'hcc.handoff.v1.' + kind + ':' + JSON.stringify([project, session]) + suffix;
  function read(name) {
    if (memory.has(name)) return memory.get(name);
    try {
      const raw = storage?.getItem(name);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function write(name, value) {
    memory.set(name, value);
    try { storage?.setItem(name, JSON.stringify(value)); } catch {}
  }
  function draft(project, session) {
    const value = read(key('draft', project, session));
    if (!value || typeof value.text !== 'string') return { text: '', pending: null };
    const pending = value.pending && typeof value.pending === 'object' && typeof value.pending.inputId === 'string' && typeof value.pending.text === 'string'
      ? { inputId: value.pending.inputId, text: value.pending.text, status: value.pending.status === 'pending' ? 'pending' : 'uncertain' } : null;
    return { text: value.text, pending };
  }
  return {
    selected(project) {
      const value = read(key('selected', project));
      return value && ['managed', 'detected'].includes(value.type) && typeof value.id === 'string' ? value : null;
    },
    select(project, type, id) { write(key('selected', project), { type, id }); },
    draft,
    saveDraft(project, session, text) {
      const value = draft(project, session);
      value.text = String(text || '');
      write(key('draft', project, session), value);
      return value;
    },
    submit(project, session, inputId, text) {
      const value = draft(project, session);
      if (value.pending) return false;
      value.pending = { inputId, text, status: 'pending' };
      write(key('draft', project, session), value);
      return true;
    },
    acknowledge(project, session, inputId) {
      const value = draft(project, session);
      if (!value.pending || value.pending.inputId !== inputId) return false;
      if (value.text === value.pending.text) value.text = '';
      value.pending = null;
      write(key('draft', project, session), value);
      return true;
    },
    uncertain(project, session) {
      const value = draft(project, session);
      if (!value.pending) return false;
      value.pending.status = 'uncertain';
      write(key('draft', project, session), value);
      return true;
    },
    review(project, session) {
      const value = draft(project, session);
      value.pending = null;
      write(key('draft', project, session), value);
    }
  };
}

export function uiHandoffScript() {
  return 'window.hccHandoffStore = (' + createHandoffStore.toString() + ')((() => { try { return window.localStorage; } catch { return null; } })(), { scope: window.hccUi?.draftScope || window.hccDraftScope || "" });';
}

export const handoffCss = `
  .main > .toolbar, .main > .handoff-bar, .main > .terminal-composer { flex-shrink:0; }
  .main > #codexPanel { flex:1; min-height:0; height:auto !important; }
  .handoff-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--panel); }
  .handoff-status { flex:1 1 220px; font-size:12px; color:var(--muted); }
  .handoff-detail { width:100%; font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
  .handoff-bar button { height:30px; font-size:12px; }
  .terminal-composer { display:grid; gap:6px; padding:10px 12px; border-top:1px solid var(--border); background:var(--panel); }
  .terminal-composer textarea { width:100%; min-height:64px; max-height:160px; resize:vertical; font:inherit; border:1px solid var(--border); border-radius:6px; padding:8px; background:var(--input-bg); color:var(--text); }
  .terminal-composer .composer-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .terminal-composer .composer-note { flex:1 1 220px; font-size:11px; color:var(--muted); }
  #activeTask { overflow-wrap:anywhere; color:var(--text); white-space:normal; font-size:12px; }
  [hidden] { display:none !important; }
`;

export function handoffBarHtml() {
  return `<div class="handoff-bar" id="handoffBar" hidden>
    <div class="handoff-status handoff-chips" id="handoffStatus" role="status" aria-live="polite"><span class="handoff-chip" id="handoffConnection"></span><span class="handoff-chip" id="handoffProcess"></span><span class="handoff-chip" id="handoffAccess"></span></div>
    <button id="claimControlBtn" type="button" data-i18n="handoff.claim">Take control</button>
    <button id="releaseControlBtn" type="button" data-i18n="handoff.release" hidden>Release control</button>
    <button id="reconnectBtn" type="button" data-i18n="handoff.reconnect">Reconnect</button>
    <details class="handoff-detail"><summary id="handoffHelp">Attachment details</summary><div id="handoffDetail"></div></details>
  </div>`;
}

export function terminalComposerHtml() {
  return `<form class="terminal-composer" id="terminalComposer" hidden>
    <label><span data-i18n="handoff.draft">Terminal input draft</span><textarea id="terminalDraft" rows="2" data-i18n-placeholder="handoff.draftPlaceholder" placeholder="Write terminal input here; Ctrl+Enter sends it"></textarea></label>
    <div class="composer-actions"><span class="composer-note" id="draftStatus" role="status" aria-live="polite"></span><button id="reviewDraftBtn" type="button" data-i18n="handoff.review" hidden>Reviewed; keep draft</button><button class="primary" id="sendDraftBtn" type="submit" data-i18n="handoff.send">Send + Enter</button></div>
  </form>`;
}
