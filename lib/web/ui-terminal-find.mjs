export const terminalFindCss = `
  .terminal-find { flex:none; padding:8px var(--space); border-bottom:1px solid var(--border); background:var(--panel); }
  .terminal-find-row { display:flex; gap:6px; align-items:center; }
  .terminal-find-row input { flex:1; min-width:60px; }
  .terminal-find-row button { flex:none; min-width:36px; }
  .terminal-find-meta { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:7px; color:var(--muted); font-size:12px; }
  .terminal-find-meta label { display:flex; gap:5px; align-items:center; }
  .terminal-find-meta input { width:auto; margin:0; }
  #terminalFindResult { flex:1; min-width:100px; }
  @media(pointer:coarse) { .terminal-find-row button { min-width:44px; min-height:44px; } }
`;

export function terminalFindHtml() {
  return `<section id="terminalFind" class="terminal-find" role="search" data-i18n-aria="find.title" aria-label="Find in terminal" hidden>
    <div class="terminal-find-row"><input id="terminalFindQuery" type="search" maxlength="256" autocomplete="off" data-i18n-placeholder="find.placeholder" data-i18n-aria="find.title" placeholder="Find in terminal output…" aria-label="Find in terminal"><button id="terminalFindPrev" type="button" data-i18n-title="find.previous" data-i18n-aria="find.previous" title="Previous match" aria-label="Previous match">↑</button><button id="terminalFindNext" type="button" data-i18n-title="find.next" data-i18n-aria="find.next" title="Next match" aria-label="Next match">↓</button><button id="terminalFindClose" type="button" data-i18n-title="close" data-i18n-aria="close" aria-label="Close">×</button></div>
    <div class="terminal-find-meta"><label><input id="terminalFindCase" type="checkbox"><span data-i18n="find.case">Match case</span></label><label><input id="terminalFindWord" type="checkbox"><span data-i18n="find.word">Whole word</span></label><span id="terminalFindResult" role="status" aria-live="polite"></span></div>
  </section>`;
}

export function terminalFindScript() { return '(' + installTerminalFind.toString() + ')();'; }

export function installTerminalFind() {
(() => {
    const host = window.hccTerminalFindHost;
    const bar = document.getElementById('terminalFind');
    const query = document.getElementById('terminalFindQuery');
    const caseOption = document.getElementById('terminalFindCase');
    const wordOption = document.getElementById('terminalFindWord');
    const result = document.getElementById('terminalFindResult');
    const prev = document.getElementById('terminalFindPrev'), next = document.getElementById('terminalFindNext');
    const tr = key => window.hccUi.tr(key);
    let subject = '', timer = 0, composing = false, searched = false;
    let count = 0, index = -1;
    function renderResult() {
      const message = !query.value ? tr('find.hint') : count === 0 ? tr('find.none') : index < 0 ? tr('find.many').replace('{count}', String(count)) : tr('find.count').replace('{index}', String(index + 1)).replace('{count}', String(count));
      if (result.textContent !== message) result.textContent = message;
      prev.disabled = next.disabled = !query.value;
    }
    function close(focus = true) {
      clearTimeout(timer); bar.hidden = true;
      document.getElementById('terminalFindBtn').setAttribute('aria-expanded','false');
      if (searched) host.addon.clearDecorations();
      searched = false;
      if (focus && host.available()) host.term.focus();
    }
    function sync() {
      if (subject !== host.subject() || !host.available()) {
        close(false); subject = host.subject(); query.value = ''; count = 0; index = -1;
      }
      document.getElementById('terminalFindBtn').disabled = !host.available();
      document.getElementById('terminalFindBtn').hidden = !host.available();
      renderResult();
    }
    function options(incremental) {
      const css = getComputedStyle(document.documentElement);
      const color = name => css.getPropertyValue(name).trim();
      return {caseSensitive:caseOption.checked, wholeWord:wordOption.checked, incremental, regex:false,
        decorations:{matchBackground:color('--selection-bg'), matchBorder:color('--border'), matchOverviewRuler:color('--accent'), activeMatchBackground:color('--accent'), activeMatchBorder:color('--accent'), activeMatchColorOverviewRuler:color('--accent')}};
    }
    function search(direction = 1, incremental = true) {
      clearTimeout(timer);
      if (bar.hidden || composing || !host.available() || subject !== host.subject()) return;
      if (!query.value) { if (searched) host.addon.clearDecorations(); searched = false; count = 0; index = -1; renderResult(); return; }
      searched = true;
      try {
        const found = direction < 0 ? host.addon.findPrevious(query.value, options(false)) : host.addon.findNext(query.value, options(incremental));
        if (!found) { count = 0; index = -1; }
        renderResult();
      } catch(error) { host.addon.clearDecorations(); searched = false; count = 0; index = -1; result.textContent = tr('find.failed'); prev.disabled = next.disabled = true; }
    }
    function schedule() { if (!composing) { clearTimeout(timer); timer = setTimeout(() => search(), 120); } }
    function refreshMatches() {
      // The addon caches highlights for the same query; invalidate them when
      // matching options or theme colors change so counts and colors stay fresh.
      if (searched) host.addon.clearDecorations();
      searched = false;
      search();
    }
    function open() {
      sync(); if (!host.available()) return;
      host.showTerminal(); bar.hidden = false; document.getElementById('terminalFindBtn').setAttribute('aria-expanded','true'); query.focus(); query.select(); renderResult();
      if (query.value) search();
    }
    host.addon.onDidChangeResults(value => { if (bar.hidden) return; count = value.resultCount; index = value.resultIndex; renderResult(); });
    query.addEventListener('input', event => { if (!event.isComposing) schedule(); });
    query.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
    query.addEventListener('compositionend', () => { composing = false; schedule(); });
    query.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); search(event.shiftKey ? -1 : 1, false); }
    });
    caseOption.addEventListener('change', refreshMatches); wordOption.addEventListener('change', refreshMatches);
    prev.addEventListener('click', () => search(-1, false)); next.addEventListener('click', () => search(1, false));
    document.getElementById('terminalFindClose').addEventListener('click', () => close());
    document.getElementById('terminalFindBtn').addEventListener('click', open);
    window.addEventListener('hcc:preferences', () => { if (!bar.hidden) { renderResult(); if (query.value) refreshMatches(); } });
    window.hccTerminalFind = {open, close, sync, capturesEscape:event => !bar.hidden && event.key === 'Escape' && (bar.contains(event.target) || host.term.element.contains(event.target))};
    sync();
  })();
}
