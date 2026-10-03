export function filterCommands(commands, query) {
  const words = String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const text = [command.id, command.label, command.detail, command.group, command.keywords].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).slice(0, 80);
}

// Modified shortcuts only. Plain Ctrl+F/K/P remain available to terminal apps.
export function shortcutAction(event, { modalOpen = false, paletteOpen = false, terminalAvailable = false } = {}) {
  if (event.isComposing || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return null;
  const key = String(event.key || '').toLowerCase();
  if (key === 'p' && (!modalOpen || paletteOpen)) return 'palette';
  if (modalOpen) return null;
  if (key === 'l') return 'sessions';
  if (key === 'f' && terminalAvailable) return 'terminal-find';
  return null;
}

export const commandPaletteCss = `
  .dialog.command-dialog { width:min(640px,calc(100vw - 24px)); padding:0; gap:0; overflow:hidden; }
  .command-dialog .dialog-heading { padding:14px 16px 0; }
  .command-query { margin:12px 16px; width:calc(100% - 32px); }
  .command-list { max-height:min(50vh,420px); overflow:auto; border-top:1px solid var(--border); }
  .command-option { display:flex; align-items:center; width:100%; min-height:58px; height:auto; padding:10px 16px; gap:12px; text-align:left; border:0; border-radius:0; background:transparent; }
  .command-option[aria-selected="true"] { background:var(--selection-bg); }
  .command-option:disabled { opacity:.55; }
  .command-copy { flex:1; min-width:0; }
  .command-copy strong,.command-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .command-copy small { margin-top:4px; color:var(--muted); font-size:12px; }
  .command-option kbd,.command-hint kbd { font:11px var(--mono); color:var(--muted); white-space:nowrap; }
  .command-hint { display:flex; gap:12px; flex-wrap:wrap; padding:10px 16px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
  .command-empty { padding:20px 16px; color:var(--muted); }
  .command-help { flex:1; }
  @media(max-width:1099px) { #commandsBtn kbd { display:none; } }
  @media(max-width:500px) { .command-option kbd { display:none; } .command-list { max-height:48dvh; } }
`;

export function commandPaletteHtml() {
  return `<div class="dialog-overlay" id="commandDialog" role="dialog" aria-modal="true" aria-labelledby="commandTitle" hidden>
    <div class="dialog command-dialog">
      <header class="dialog-heading"><h3 id="commandTitle" data-i18n="commands.title">Command palette</h3><button id="commandClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <input class="command-query" id="commandQuery" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="commandList" data-i18n-placeholder="commands.placeholder" data-i18n-aria="commands.search" placeholder="Search actions, projects or sessions…" aria-label="Search commands" autocomplete="off">
      <div id="commandList" class="command-list" role="listbox" data-i18n-aria="commands.results" aria-label="Commands"></div>
      <div class="command-hint"><span class="command-help" id="commandHint" role="status" aria-live="polite"></span><span><kbd>↑ ↓</kbd> <span data-i18n="commands.navigate">Navigate</span></span><span><kbd>Enter</kbd> <span data-i18n="commands.open">Open</span></span><span><kbd>Esc</kbd> <span data-i18n="close">Close</span></span></div>
    </div>
  </div>`;
}

export function commandPaletteScript() { return '(' + installCommandPalette.toString() + ')();'; }

export function installCommandPalette() {
(() => {
    const filter = function filterCommands(commands, query) {
  const words = String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter(command => {
    const text = [command.id, command.label, command.detail, command.group, command.keywords].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).slice(0, 80);
};
    const shortcut = function shortcutAction(event, { modalOpen = false, paletteOpen = false, terminalAvailable = false } = {}) {
  if (event.isComposing || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return null;
  const key = String(event.key || '').toLowerCase();
  if (key === 'p' && (!modalOpen || paletteOpen)) return 'palette';
  if (modalOpen) return null;
  if (key === 'l') return 'sessions';
  if (key === 'f' && terminalAvailable) return 'terminal-find';
  return null;
};
    const host = window.hccCommandHost;
    const dialog = document.getElementById('commandDialog');
    const query = document.getElementById('commandQuery');
    const list = document.getElementById('commandList');
    const hint = document.getElementById('commandHint');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const tr = key => window.hccUi.tr(key);
    let visible = [], selected = 0;
    function refresh() {
      if (dialog.hidden) return;
      const previous = visible[selected]?.id;
      visible = filter(host.commands(), query.value);
      selected = Math.max(0, visible.findIndex(command => command.id === previous));
      const scroll = list.scrollTop;
      list.innerHTML = visible.length ? visible.map((command, index) => '<button type="button" tabindex="-1" role="option" class="command-option" id="commandOption-' + index + '" data-command-index="' + index + '" aria-selected="' + (index === selected) + '" aria-disabled="' + (command.enabled === false) + '" ' + (command.enabled === false ? 'disabled' : '') + '><span class="command-copy"><strong>' + esc(command.label) + '</strong><small>' + esc(command.group) + (command.detail ? ' · ' + esc(command.detail) : '') + '</small></span>' + (command.shortcut ? '<kbd>' + esc(command.shortcut) + '</kbd>' : '') + '</button>').join('') : '<div class="command-empty">' + esc(tr('commands.empty')) + '</div>';
      list.scrollTop = scroll;
      query.setAttribute('aria-expanded', 'true');
      if (visible.length) query.setAttribute('aria-activedescendant', 'commandOption-' + selected);
      else query.removeAttribute('aria-activedescendant');
      hint.textContent = tr('commands.count').replace('{count}', String(visible.length)) + (visible.length === 80 ? ' · ' + tr('commands.refine') : '');
      list.querySelectorAll('[data-command-index]').forEach(button => button.addEventListener('click', () => run(Number(button.dataset.commandIndex))));
    }
    function open() {
      if (!dialog.hidden) return;
      if (host.modalOpen()) return;
      query.value = ''; visible = []; selected = 0;
      host.openDialog(dialog, query); refresh();
    }
    function run(index) {
      // Re-resolve from current project data, not a stale row captured before polling.
      const command = host.commands().find(item => item.id === visible[index]?.id);
      if (!command || command.enabled === false) { refresh(); hint.textContent = tr('commands.unavailable'); return; }
      host.closeDialog(dialog);
      try { Promise.resolve(command.run()).catch(host.error); } catch(error) { host.error(error); }
    }
    query.addEventListener('input', refresh);
    query.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); if (visible.length) run(selected); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !visible.length) return;
      event.preventDefault();
      selected = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (selected + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      list.querySelectorAll('[data-command-index]').forEach((button, index) => button.setAttribute('aria-selected', String(index === selected)));
      query.setAttribute('aria-activedescendant', 'commandOption-' + selected);
      document.getElementById('commandOption-' + selected)?.scrollIntoView({block:'nearest'});
    });
    const context = () => ({modalOpen:host.modalOpen(), paletteOpen:!dialog.hidden, terminalAvailable:host.terminalAvailable()});
    const captures = event => Boolean(shortcut(event, context()) || window.hccTerminalFind?.capturesEscape(event));
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (window.hccTerminalFind?.capturesEscape(event) && !host.modalOpen()) {
        event.preventDefault(); window.hccTerminalFind.close(); return;
      }
      const action = shortcut(event, context());
      if (!action) return;
      event.preventDefault();
      if (action === 'palette') { if (dialog.hidden) open(); else host.closeDialog(dialog); }
      if (action === 'sessions') host.focusSessions();
      if (action === 'terminal-find') window.hccTerminalFind.open();
    }, true);
    document.getElementById('commandsBtn').addEventListener('click', open);
    document.getElementById('commandClose').addEventListener('click', () => host.closeDialog(dialog));
    window.addEventListener('hcc:preferences', refresh);
    window.hccCommandPalette = {open, refresh, captures};
  })();
}
