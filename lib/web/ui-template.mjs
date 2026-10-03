import { API_VERSION } from './api-version.mjs';
import { uiPreferencesCss, uiPreferencesScript, preferenceControlsHtml, TERMINAL_THEMES } from './ui-preferences.mjs';
import { renderWebLoginPage } from './ui-login.mjs';
import { handoffCss, handoffBarHtml, terminalComposerHtml, uiHandoffScript } from './ui-handoff.mjs';
import { codexPanelHtml, codexPanelScript } from './ui-codex.mjs';
import { workbenchCss, workbenchControlsHtml, workbenchScript } from './ui-workbench.mjs';
import { codexHistoryHtml, codexHistoryScript } from './ui-history.mjs';
import { auxiliaryPanelsCss, reviewPanelHtml, reviewPanelScript } from './ui-review.mjs';
import { nativePanelHtml, nativePanelScript } from './ui-native.mjs';
import { commandPaletteCss, commandPaletteHtml, commandPaletteScript } from './ui-command-palette.mjs';
import { terminalFindCss, terminalFindHtml, terminalFindScript } from './ui-terminal-find.mjs';
import { workspaceCss, workspaceBarHtml, workspaceSecondaryHtml, workspaceScript } from './ui-workspace.mjs';

function nonceAttribute(nonce) {
  const value = String(nonce || '');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) {
    throw new Error('A valid CSP nonce is required');
  }
  return ` nonce="${value}"`;
}

export function webIndexHtml({ nonce, pane = false } = {}) {
  const inlineScriptNonce = nonceAttribute(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hello-cc</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23087b65'/%3E%3Cpath d='m14 20 14 12-14 12m20 0h16' fill='none' stroke='white' stroke-width='5'/%3E%3C/svg%3E">
  <script${inlineScriptNonce}>window.hccDraftScope = ${pane ? '"auxiliary"' : '""'}; document.documentElement.classList.toggle('session-pane', Boolean(window.hccDraftScope)); ${uiPreferencesScript()}</script>
  <link rel="stylesheet" href="/assets/xterm.css">
  <style>
    ${uiPreferencesCss}
    ${handoffCss}
    ${workbenchCss}
    ${auxiliaryPanelsCss}
    ${commandPaletteCss}
    ${terminalFindCss}
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
      height: var(--control-height);
      border-radius: 6px;
      padding: 0 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--primary-bg); border-color: var(--primary-border); }
    button.danger { background: var(--danger-bg); border-color: var(--danger-border); }
    button:disabled { opacity: .55; cursor: default; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    input, select {
      width: 100%;
      height: var(--control-height);
      border: 1px solid var(--border);
      background: var(--input-bg);
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
      height: calc(100dvh - 58px);
      display: grid;
      --left-width: 320px;
      --right-width: 360px;
      grid-template-columns: var(--left-width) minmax(0, 1fr) var(--right-width);
      min-width: 0;
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
    .edge-toggle:hover { color: var(--text); border-color: var(--accent); background: var(--hover-bg); }
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
      grid-template-rows: auto auto auto minmax(0, 1fr);
    }
    .inspector {
      border-right: 0;
      border-left: 1px solid var(--border);
      grid-template-rows: auto auto auto minmax(0, 1fr);
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
      flex: 0 1 72px;
      max-width: 72px;
      text-align: right;
    }
    .brand-actions { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .brand-actions button { width: 26px; height: 26px; padding: 0; font-size: 14px; }
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
      display: grid;
      gap: 8px;
      min-height: 48px;
    }
    .session-header strong {
      font-size: 13px;
      font-weight: 600;
    }
    .project-picker { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; }
    .project-picker button { width: var(--control-height); padding: 0; font-size: 20px; }
    .session-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .session-list-count { color: var(--muted); font-size: 11px; min-height: 15px; }
    .session-title { flex: 1; min-width: 0; }
    .session-subtitle { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--muted); font-size: 11px; }
    .session-subtitle .path { flex: 1; min-width: 0; }
    .session-provider { flex: 0 0 auto; font-family: var(--mono); }
    .session-details { min-width: 0; color: var(--muted); font-size: 11px; cursor: auto; }
    .session-details summary { width: fit-content; max-width: 100%; cursor: pointer; padding: 3px 0; }
    .session-details[open] summary { margin-bottom: 6px; }
    .session-details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 8px; margin: 0; }
    .session-details dt { color: var(--muted); }
    .session-details dd { margin: 0; color: var(--text); font-family: var(--mono); overflow-wrap: anywhere; }
    .session-action { flex: 0 0 auto; width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); background: transparent; }
    .session-action[data-action="restart-detected"] { color: var(--ok); }
    .dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .dialog-heading button { width: 36px; height: 36px; padding: 0; font-size: 20px; }
    .dialog-help { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    .dialog .form { padding: 0; border: 0; gap: 14px; }
    #startForm [hidden], .dialog-help[hidden] { display: none; }
    .dialog-help[role="alert"] { color: var(--danger); }
    .dialog-target { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .session-empty { display: grid; gap: 12px; text-align: center; }
    .session-empty p { margin: 0; }
    @media (pointer: coarse) { .session-action { width: 44px; height: 44px; } .session-details summary { padding: 10px 0; } }
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
      background: var(--card-bg);
      border-radius: 8px;
      padding: 9px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 7px;
      cursor: pointer;
    }
    .session.active { border-color: var(--accent); }
    .session-select { min-width: 0; height: auto; padding: 0; border: 0; background: transparent; color: var(--text); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-select strong { font-size: var(--body-font); }
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
      display: flex;
      flex-direction: column;
      background: var(--terminal-bg);
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
    .menu button:hover { background: var(--hover-bg); }
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
      background: var(--input-bg);
    }
    /* Confirm dialog overlay */
    .dialog-overlay {
      position: fixed; inset: 0; z-index: 2000;
      background: var(--overlay);
      display: flex; align-items: center; justify-content: center;
    }
    .dialog-overlay[hidden] { display: none; }
    .dialog {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 22px;
      width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto;
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
      padding: 0;
    }
    #terminal .xterm {
      cursor: default;
      padding: 8px;
      background: inherit;
    }
    #terminal .xterm-viewport { background: inherit; }
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
      background: var(--card-bg);
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
    .state-card-toggle:hover { background: var(--hover-bg); }
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
      border-bottom: 1px solid var(--border);
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
    body { font-size: var(--body-font); }
    .path, .brand span, .badge, .action-result pre, .sec-label { font-size: var(--small-font); }
    .form, .brand, .sessions, .state, .session { padding: var(--space); }
    .form, .sessions, .state { gap: var(--space); }
    .global-header { height: 58px; padding: 0 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .global-header > strong { margin-right: auto; white-space: nowrap; font-size: 16px; letter-spacing: -.3px; }
    .header-controls { display: flex; align-items: center; gap: 8px; }
    .header-controls button { white-space: nowrap; }
    .global-header #connState { max-width: none; font-size: var(--small-font); color: var(--muted); white-space: nowrap; }
    .global-header #logoutBtn { width: 34px; padding: 0; }
    .mobile-nav { display: none; }
    .settings-fields { display: grid; gap: 16px; }
    .settings-fields label { grid-template-columns: minmax(0, 1fr) minmax(150px, 1fr); align-items: center; gap: 12px; font-size: 13px; }
    .settings-dialog header { display: flex; align-items: center; justify-content: space-between; }
    .settings-dialog header button { width: 32px; padding: 0; }
    .app.focus-mode { grid-template-columns: 0 minmax(0, 1fr) 0; }
    .app.focus-mode .sidebar, .app.focus-mode .inspector { visibility: hidden; border: 0; }
    .app.focus-mode .edge-toggle, .app.focus-mode .edge-resizer { display: none; }
    .global-header button[aria-pressed="true"], .mobile-nav button[aria-current="page"] { background: var(--selection-bg); border-color: var(--accent); }
    input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
    @media (max-width: 1099px) {
      .global-header { padding: 0 12px; gap: 8px; }
      .mobile-nav { height: 46px; display: flex; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
      .mobile-nav button { flex: 1; height: 32px; }
      .app, .app.left-collapsed, .app.right-collapsed, .app.left-collapsed.right-collapsed, .app.focus-mode { height: calc(100dvh - 104px); grid-template-columns: minmax(0, 1fr); }
      .app .sidebar, .app .main, .app .inspector { display: none; border: 0; visibility: visible; }
      .app[data-view="sessions"] .sidebar, .app[data-view="state"] .inspector { display: grid; }
      .app[data-view="terminal"] .main { display:flex; }
      .app .edge-toggle, .app .edge-resizer { display: none; }
      #focusBtn { display: none; }
      .sidebar { grid-template-rows: auto auto auto minmax(0, 1fr); }
    }
    @media (max-width: 480px) {
      .global-header { padding: 0 10px; }
      .global-header > strong { font-size: 15px; }
      .header-controls { gap: 6px; }
      .global-header #connState { max-width: 88px; overflow: hidden; text-overflow: ellipsis; }
      .toolbar { flex-wrap: wrap; padding: 8px 10px; }
      .toolbar .title { flex-basis: 100%; }
      .quick { margin-left: auto; }
      .settings-fields label { grid-template-columns: 1fr; gap: 6px; }
    }
    @media (prefers-reduced-motion: reduce) { .app, .edge-toggle, .edge-resizer { transition: none; } }
    ${workspaceCss}
  </style>
</head>
<body>
  <header class="global-header">
    <strong>hello-cc</strong>
    <div class="header-controls">
      <span id="connState" role="status">offline</span>
      <button id="commandsBtn" type="button" data-i18n="commands.button" data-i18n-title="commands.shortcutHint" aria-haspopup="dialog" aria-controls="commandDialog" aria-keyshortcuts="Control+Shift+P Meta+Shift+P">Commands</button>
      <button id="splitBtn" type="button" data-i18n="workspace.split" aria-pressed="false" disabled>Split</button>
      <button id="focusBtn" type="button" data-i18n="focusMode" aria-pressed="false">Focus</button>
      <button id="settingsBtn" type="button" data-i18n="settings" aria-haspopup="dialog" aria-controls="settingsDialog">Settings</button>
      <button id="logoutBtn" type="button" data-i18n-title="logout" data-i18n-aria="logout" title="Log out" aria-label="Log out">↪</button>
    </div>
  </header>
  <nav class="mobile-nav" data-i18n-aria="navigation" aria-label="Navigation">
    <button type="button" data-view="sessions" data-i18n="sessions">Sessions</button>
    <button type="button" data-view="terminal" data-i18n="terminal" aria-current="page">Terminal</button>
    <button type="button" data-view="state" data-i18n="projectState">Project State</button>
  </nav>
  <div class="app" data-view="terminal">
    <aside class="sidebar">
      <div class="brand">
        <div>
          <strong data-i18n="project">Project</strong>
          <div class="path" id="rootPath"></div>
        </div>
      </div>
      <div class="form" style="padding-top:10px;padding-bottom:10px">
        <div class="project-picker">
          <label><span data-i18n="project">Project</span><select id="projectSelect"></select></label>
          <button id="openProjectDialog" type="button" aria-haspopup="dialog" aria-controls="projectDialog" data-i18n-title="addProject" data-i18n-aria="addProject" title="Add project" aria-label="Add project">+</button>
        </div>
        <button id="openStartDialog" class="primary" type="button" data-i18n="newSession" aria-haspopup="dialog" aria-controls="startDialog">New session</button>
        <button id="openHistoryDialog" type="button" data-i18n="aux.history" aria-haspopup="dialog" aria-controls="historyDialog">Codex history</button>
      </div>
      <div class="session-header">
        <strong data-i18n="sessions">Sessions</strong>
        <input id="sessionSearch" type="search" data-i18n-placeholder="sessionSearchPlaceholder" data-i18n-aria="sessionSearch" aria-label="Search sessions" placeholder="Name, ID, directory or command…" autocomplete="off">
        <div class="session-filters">
          <label><span data-i18n="view">View</span><select id="sessionKindFilter"><option value="all" data-i18n="kind.all">all</option><option value="claude">claude</option><option value="codex">codex</option><option value="dsh">dsh</option><option value="shell" data-i18n="kind.shell">shell</option><option value="other" data-i18n="kind.other">other</option></select></label>
          <label><span data-i18n="sessionStatusFilter">Session availability</span><select id="sessionStatusFilter"><option value="all" data-i18n="sessionFilterAll">All sessions</option><option value="active" data-i18n="sessionFilterActive">Active sessions</option></select></label>
        </div>
        <span class="session-list-count" id="sessionListCount" role="status" aria-live="polite"></span>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>

    <section class="workspace" id="workspace" data-active-pane="primary">
    ${workspaceBarHtml()}
    <div class="workspace-panes" id="workspacePanes">
    <main class="main" id="workspacePrimaryPane">
      <div class="toolbar">
        <div class="title">
          <strong id="activeTitle">No session selected</strong>
          <span class="path" id="activeMeta">Start or select a session from the left panel</span>
          <span id="activeTask" hidden></span>
        </div>
        <div class="quick" id="quickBar">
          <button id="openReviewDialog" type="button" data-i18n="aux.review" aria-haspopup="dialog" aria-controls="reviewDialog" disabled>Review results</button>
          <button id="terminalFindBtn" type="button" data-i18n="find.button" data-i18n-title="find.shortcutHint" aria-controls="terminalFind" aria-expanded="false" aria-keyshortcuts="Control+Shift+F Meta+Shift+F" disabled>Find</button>
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
          <button class="danger" id="stopBtn" type="button" data-i18n="handoff.detach">Pause Web attachment</button>
        </div>
      </div>
      ${handoffBarHtml()}
      ${terminalFindHtml()}
      <div id="terminal" style="min-height:0;flex:1"></div>
      ${codexPanelHtml()}
      ${nativePanelHtml()}
      ${terminalComposerHtml()}
      <div id="detectedPanel" style="display:none;overflow:auto;flex:1"></div>
    </main>
    ${workspaceSecondaryHtml()}
    </div>
    </section>

    <section class="action-result" id="actionResult" hidden aria-live="polite">
      <header>
        <strong id="actionResultTitle"></strong>
        <button id="actionResultClose" type="button" data-i18n-aria="close" aria-label="Close">×</button>
      </header>
      <pre id="actionResultBody"></pre>
    </section>

    <aside class="inspector">
      <div class="brand">
        <strong data-i18n="projectState">Project State</strong>
        <button id="refreshBtn" type="button" data-i18n="refresh">Refresh</button>
      </div>
      ${workbenchControlsHtml()}
      <div class="state" id="state"></div>
    </aside>

    <button class="edge-toggle edge-left" id="toggleLeft" type="button" data-i18n-title="collapseSidebar" data-i18n-aria="toggleLeftSidebar" title="Collapse sidebar" aria-label="Toggle left sidebar">⟨</button>
    <button class="edge-toggle edge-right" id="toggleRight" type="button" data-i18n-title="collapseStatePanel" data-i18n-aria="toggleRightPanel" title="Collapse state panel" aria-label="Toggle right panel">⟩</button>
    <div class="edge-resizer edge-resizer-left" id="resizeLeft" tabindex="0" role="separator" aria-orientation="vertical" data-i18n-aria="resizeLeftSidebar" data-i18n-title="resizeLeftSidebar" aria-label="Resize left sidebar" title="Resize left sidebar"></div>
    <div class="edge-resizer edge-resizer-right" id="resizeRight" tabindex="0" role="separator" aria-orientation="vertical" data-i18n-aria="resizeRightPanel" data-i18n-title="resizeRightPanel" aria-label="Resize right panel" title="Resize right panel"></div>
  </div>

  <div class="dialog-overlay" id="projectDialog" role="dialog" aria-modal="true" aria-labelledby="projectDialogTitle" hidden>
    <div class="dialog">
      <header class="dialog-heading"><h3 id="projectDialogTitle" data-i18n="addProject">Add project</h3><button id="projectDialogClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <p class="dialog-help" data-i18n="projectDialogHelp">Register a local project directory to view its sessions and shared state.</p>
      <p class="dialog-help" id="projectDialogError" role="alert" hidden></p>
      <form id="projectForm" class="form">
        <label><span data-i18n="projectPath">Project path</span><input id="projectPath" data-i18n-placeholder="projectPathPlaceholder" placeholder="/path/to/project" required autocomplete="off"></label>
        <div class="btns"><button id="projectCancelBtn" type="button" data-i18n="dialog.cancel">Cancel</button><button id="addProjectBtn" class="primary" type="submit" data-i18n="registerProject">Register Project</button></div>
      </form>
    </div>
  </div>
  <div class="dialog-overlay" id="startDialog" role="dialog" aria-modal="true" aria-labelledby="startDialogTitle" hidden>
    <div class="dialog">
      <header class="dialog-heading"><h3 id="startDialogTitle" data-i18n="newSession">New session</h3><button id="startDialogClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <p class="dialog-help" data-i18n="startDialogHelp">Choose a CLI and start a new session or resume existing history.</p>
      <p class="dialog-help" id="startDialogError" role="alert" hidden></p>
      <div class="dialog-target"><span data-i18n="startProject">Target project</span>: <span id="startProjectPath"></span></div>
      <form class="form" id="startForm">
        <label><span data-i18n="kind">Kind</span><select id="kind"><option value="codex">codex</option><option value="claude">claude</option><option value="shell" data-i18n="kind.shell">shell</option></select></label>
        <label id="transportField"><span data-i18n="handoff.transport">Codex interface</span><select id="transport"><option value="tmux" data-i18n="handoff.cli">Terminal CLI</option><option value="app-server" data-i18n="handoff.appServer">Structured App Server (opt in)</option></select></label>
        <div class="start-options">
          <label><span data-i18n="mode">Mode</span><select id="startMode"><option value="new" data-i18n="mode.new">new</option><option value="resume" data-i18n="mode.resume">resume</option><option value="last" data-i18n="mode.last">last</option><option value="continue" data-i18n="mode.continue">continue</option></select></label>
          <label data-resume-field><span data-i18n="session">Session</span><select id="resumeSelect"></select></label>
          <label data-resume-field data-resume-custom style="display:none"><span data-i18n="sessionId">Session id</span><input id="resumeArg" data-i18n-placeholder="sessionIdPlaceholder" placeholder="session id or name"></label>
        </div>
        <label id="appServerResumeField" hidden><span style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox" id="appServerResumeConfirm"><span data-i18n="handoff.resumeConfirm">I have stopped the original executor. Resuming history starts a separate executor.</span></span></label>
        <p class="dialog-help" data-i18n="dshLaunchHelp">For DeepSeek Harness, run hcc dsh web in the project. Its agents appear under Detected.</p>
        <div class="btns"><button id="startCancelBtn" type="button" data-i18n="dialog.cancel">Cancel</button><button class="primary" type="submit" data-i18n="start">Start</button></div>
      </form>
    </div>
  </div>
  <div class="dialog-overlay" id="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" hidden>
    <div class="dialog settings-dialog">
      <header><h3 id="settingsTitle" data-i18n="settings">Settings</h3><button id="settingsClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <div class="settings-fields">${preferenceControlsHtml({ terminal: true })}</div>
    </div>
  </div>
  <div class="dialog-overlay" id="stopDialog" role="dialog" aria-modal="true" aria-labelledby="stopDialogTitle" hidden>
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

  ${codexHistoryHtml()}
  ${reviewPanelHtml()}
  ${commandPaletteHtml()}
  <script src="/assets/xterm.js"></script>
  <script src="/assets/addon-fit.js"></script>
  <script src="/assets/addon-search.js"></script>
  <script${inlineScriptNonce}>
    ${uiHandoffScript()}
    ${workbenchScript()}
    const hccUi = window.hccUi;
    const paneMode = ${pane ? 'true' : 'false'};
    const handoffStore = window.hccHandoffStore;
    const initialParams = new URLSearchParams(location.search);
    let loggedOut = false;
    try { sessionStorage.removeItem('hcc_logged_out'); } catch {}
    const token = initialParams.get('token') || '';
    const runtimeApiVersion = ${API_VERSION};
    const headers = {
      'X-HCC-API-Version': String(runtimeApiVersion),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    };
    let currentProject = initialParams.get('project') || initialParams.get('root') || '';
    let projects = [];
    let startPending = false;
    let sessionKindFilter = initialParams.get('kind') || 'all';
    let sessionSearchQuery = '';
    let sessionStatusFilter = 'all';
    let sessions  = [];    // managed (PTY) sessions
    let sessionsLoaded = false;
    let detected  = [];    // coordination-only peers (from hooks/watcher)
    let resumableCache = []; // provider sessions available to resume (from /api/resumable)
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
        document.getElementById('activeTitle').textContent = activeDetected + ' (' + tr('detected') + ')';
        renderDetectedPanel(peer);
        const detMsg = document.getElementById('detMsg');
        if (detMsg && draft) detMsg.value = draft;
      } else if (activeType === 'managed' && active) {
        const meta = sessions.find((s) => s.id === active);
        if (meta) {
          renderActiveSession(meta);
        }
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
      if (!paneMode) params.delete('session');
      if (sessionKindFilter && sessionKindFilter !== 'all') params.set('kind', sessionKindFilter);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
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
      theme: ${JSON.stringify(TERMINAL_THEMES)}[hccUi.preferences.terminalTheme === 'system' ? hccUi.theme : hccUi.preferences.terminalTheme]
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
      const palette = ${JSON.stringify(TERMINAL_THEMES)};
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
      const res = await fetch(path + (path.includes('?') ? '&' : '?') + requestQuery().slice(1), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...headers, ...(options.headers || {}) }
      }).catch((cause) => {
        const error = new Error(tr('networkError'));
        error.detail = cause.message;
        throw error;
      });
      const json = await res.json();
      if (!res.ok) {
        const error = new Error(tr('error.' + json.error?.code, tr('requestFailed')));
        error.code = json.error?.code;
        error.detail = json.error?.message || json.message || error.message;
        throw error;
      }
      return json;
    }

    function controlEpoch() { return Number(sessionControls.get(active)?.epoch || 0); }
    function canControl() {
      return Boolean(active && sessions.find((item) => item.id === active)?.status === 'running' && ws?.readyState === WebSocket.OPEN && sessionActionTokens.get(active) && sessionControls.get(active)?.can_control);
    }

    function renderActiveSession(meta) {
      document.getElementById('activeTitle').textContent = sessionPeerId(meta) || active || '';
      document.getElementById('activeMeta').textContent = sessionMetaText(meta);
      const task = document.getElementById('activeTask');
      task.hidden = !meta?.task?.title;
      task.textContent = meta?.task?.title ? tr('handoff.task') + ' #' + meta.task.id + ': ' + meta.task.title + (meta.task.status ? ' · ' + statusText(meta.task.status) : '') : '';
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
      document.getElementById('handoffHelp').textContent = copy('Attachment details', '连接与离开说明');
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
      document.getElementById('openReviewDialog').disabled = !meta;
    }

    function disconnectWebSocket() {
      clearTimeout(wsReconnectTimer);
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
      get draftScope() { return window.hccDraftScope || ''; },
      get actionToken() { return sessionActionTokens.get(active) || ''; },
      get epoch() { return controlEpoch(); },
      get canControl() { return canControl(); },
      get session() { return sessions.find(item => item.id === active) || null; },
      get sessions() { return sessions; },
      refreshSessions: () => refreshSessions(), openManaged: id => connectManaged(id), openDialog, closeDialog,
      api: (...args) => api(...args), tr, esc
    };
    ${codexPanelScript()}
    ${codexHistoryScript()}
    ${reviewPanelScript()}
    ${nativePanelScript()}
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
        if (!sendTerminalInput(text + '\\r', inputId)) handoffStore.uncertain(currentProject, active);
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

    function handleUiError(error, action = '') {
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

    function syncStartModeOptions() {
      const kind = document.getElementById('kind').value;
      document.getElementById('transportField').hidden = kind !== 'codex';
      const appServer = kind === 'codex' && document.getElementById('transport').value === 'app-server';
      const modeSelect = document.getElementById('startMode');
      const current = modeSelect.value;
      const modes = kind === 'claude'
        ? [['new', 'new'], ['resume', 'resume'], ['continue', 'continue']]
        : kind === 'codex'
          ? (appServer ? [['new', 'new'], ['resume', 'resume']] : [['new', 'new'], ['resume', 'resume'], ['last', 'last']])
          : [['new', 'new']];
      modeSelect.innerHTML = modes.map(([value]) => '<option value="' + value + '">' + tr('mode.' + value, value) + '</option>').join('');
      modeSelect.value = modes.some(([value]) => value === current) ? current : 'new';
      const isResume = modeSelect.value === 'resume';
      document.getElementById('appServerResumeField').hidden = !(appServer && isResume);
      document.getElementById('resumeArg').required = false;
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
      const custom = document.getElementById('startMode').value === 'resume' && sel.value === '__custom__';
      document.querySelector('[data-resume-custom]').style.display = custom ? '' : 'none';
      document.getElementById('resumeArg').required = custom;
    }

    async function loadProjects() {
      const data = await api('/api/projects');
      projects = data.projects || [];
      if (!currentProject) currentProject = data.current?.root || projects[0]?.root || '';
      renderProjects();
      updateLocationProject();
    }

    async function switchProject(root) {
      if (paneMode && root !== currentProject) return;
      window.hccWorkspace?.reset();
      disconnectWebSocket();
      window.hccHistory?.reset();
      window.hccReview?.reset();
      currentProject = root;
      updateLocationProject();
      active = null;
      activeDetected = null;
      activeType = 'managed';
      sessions = [];
      sessionsLoaded = false;
      detected = [];
      renderSections();
      document.getElementById('rootPath').textContent = root;
      lastStateData = null;
      lastStateRoot = '';
      window.hccWorkbench.reset();
      term.reset();
      document.getElementById('codexPanel').hidden = true;
      document.getElementById('nativePanel').hidden = true;
      document.getElementById('terminalComposer').hidden = true;
      document.getElementById('activeTask').hidden = true;
      renderHandoff();
      document.getElementById('activeTitle').textContent = tr('noSessionSelected');
      document.getElementById('activeMeta').textContent = tr('startOrSelect');
      await Promise.all([refreshSessions(), refreshDetected(), refreshState()]);
      if (currentProject !== root) return;
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
      return \`
          <div class="item timeline-item">
            <strong>\${esc(item.title || item.kind || item.source)} <span class="badge">\${esc(item.kind || item.source)}</span></strong>
            <span>\${esc(meta)}</span>
            \${item.text ? '<span>' + esc(item.text) + '</span>' : ''}
          </div>\`;
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
        await api('/api/projects', { method: 'POST', body: JSON.stringify({ root }) });
        if (input.value.trim() === root) input.value = '';
        await loadProjects();
        if (projectDialog.hidden || currentProject !== originalProject) return;
        await switchProject(root);
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
      const words = sessionSearchQuery.trim().toLocaleLowerCase().split(/\\s+/).filter(Boolean);
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
          const title = s.name || s.task?.title || peerId;
          const path = s.cwd || '';
          return \`
          <div class="session \${active === s.id && activeType === 'managed' ? 'active' : ''}" data-id="\${esc(s.id)}" data-type="managed">
            <div class="row"><button class="session-select session-title" type="button" data-focus-key="managed:\${esc(s.id)}" aria-label="\${esc(title)}" aria-pressed="\${active === s.id && activeType === 'managed'}" title="\${esc(title)}"><strong>\${esc(title)}</strong></button><span class="badge \${badgeClass(s.status)}">\${esc(statusText(s.status))}</span></div>
            <div class="session-subtitle"><span class="session-provider">\${esc(sessionProvider(s))}</span><span class="path" title="\${esc(path)}">\${esc(path.split('/').filter(Boolean).slice(-2).join('/'))}</span></div>
            \${sessionDetailsHtml('managed:' + s.id, [[tr('peer'), peerId], [tr('sessionId'), s.id], [tr('runtime'), sessionRuntimeTarget(s)], [tr('providerSession'), sessionProvider(s) + ':' + (sessionProviderSessionValue(s) || tr('unknown'))], [tr('handoff.transport'), s.type || 'pty'], [tr('command'), s.command], [tr('cwd'), path]])}
          </div>\`;
        }).join('')
        : filtered ? '' : startEmpty;

      const renderDetectedPeer = (p) => {
          const state = peerStateView(p);
          const canStop = detectedPeerCanStop(p);
          return \`
          <div class="session \${activeDetected === p.id && activeType === 'detected' ? 'active' : ''}" data-id="\${esc(p.id)}" data-type="detected">
            <div class="row">
              <button class="session-select session-title" type="button" data-focus-key="detected:\${esc(p.id)}" aria-label="\${esc(p.name || p.id)}" aria-pressed="\${activeDetected === p.id && activeType === 'detected'}" title="\${esc(p.name || p.id)}"><strong>\${esc(p.name || p.id)}</strong></button>
              <div style="display:flex;gap:6px;align-items:center">
                <span class="badge \${badgeClass(state.label)}" title="\${esc(state.detail)}">\${esc(statusText(state.label))}</span>
                \${dshCoordinationPeer(p) ? '' : canStop ? \`
                <button class="session-action stop-detected-btn" data-action="stop-detected" data-id="\${esc(p.id)}" data-focus-key="stop:\${esc(p.id)}" title="\${esc(tr('action.stopPeer'))}" aria-label="\${esc(tr('action.stopPeer')) + ' ' + esc(p.id)}" type="button">✕</button>
                \` : \`
                <button class="session-action" data-action="restart-detected" data-id="\${esc(p.id)}" data-focus-key="restart:\${esc(p.id)}" title="\${esc(tr('action.restartPeer'))}" aria-label="\${esc(tr('action.restartPeer')) + ' ' + esc(p.id)}" type="button">↻</button>
                \`}
              </div>
            </div>
            <div class="session-subtitle"><span class="session-provider">\${esc(p.provider || p.kind || 'other')}</span><span class="path" title="\${esc(p.worktree || p.cwd || '')}">\${esc((p.worktree || p.cwd || '').split('/').filter(Boolean).slice(-2).join('/'))}</span></div>
            \${sessionDetailsHtml('detected:' + p.id, [[tr('peer'), p.id], [tr('kind'), p.kind], [tr('status'), state.detail], [tr('cwd'), p.worktree || p.cwd], [tr('command'), p.command], [tr('branch'), p.branch], [tr('pid'), p.pid]])}
          </div>\`;
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
      box.innerHTML = filtered && !visibleSessions.length && !visibleDetected.length ? noMatches : \`
        <div class="sec-label">\${esc(tr('managed'))} <span class="badge">\${visibleSessions.filter(s=>s.status==='running').length} \${esc(tr('running'))}</span></div>
        \${manHtml}
        <div class="sec-label" style="margin-top:10px">\${esc(tr('activeDetected'))} <span class="badge" style="color:var(--warn)">\${activeDetectedPeers.length}</span></div>
        \${activeDetectedHtml}
        <div class="sec-label" style="margin-top:10px">\${esc(tr('staleDetected'))} <span class="badge">\${staleDetectedPeers.length}</span><span class="sec-spacer"></span><button id="toggleStaleDetected" type="button" \${searching ? 'hidden' : ''}>\${esc(staleToggleLabel)}</button></div>
        \${staleDetectedHtml}
      \`;
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
        if (meta) {
          renderActiveSession(meta);
          activeLocalClients = meta.local_clients ?? activeLocalClients;
        }
      }
      connText(ws?.readyState === WebSocket.OPEN ? 'attached' : activeDetected ? 'coordinationOnly' : active ? (activeConnectionState === 'connecting' ? 'reconnecting' : 'offline') : 'online');
      renderHandoff();
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
      sessionActionTokens.delete(id);
      sessionControls.delete(id);
      activeConnectionState = 'connecting';
      renderHandoff();
      const socket = new WebSocket(proto + '://' + location.host + '/ws/terminal/' + encodeURIComponent(id) + requestQuery({ api_version: runtimeApiVersion }));
      ws = socket;
      socket.onopen = () => {
        if (ws !== socket || active !== id) return;
        activeConnectionState = 'connected';
        renderHandoff();
        wsReconnectFailures = 0;
        connText('attached');
      };
      socket.onmessage = (event) => {
        if (ws !== socket || active !== id) return;
        const msg = JSON.parse(event.data);
        const pinned = terminalPinned();
        // The server streams the tmux pane's raw output, so xterm renders
        // incrementally (no reset/redraw → no flicker) and the program's own
        // escape sequences carry the cursor.
        if (msg.type === 'snapshot') {
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
        if (msg.type === 'exit') { refreshSessions().catch(console.error); }
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
        if (event.code === 4001 || loggedOut) {
          connText('signed out');
          return;
        }
        wsReconnectFailures += 1;
        if (wsReconnectFailures > 5) {
          connText('offline');
          return;
        }
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
      document.getElementById('activeTitle').textContent = id + ' (' + tr('detected') + ')';
      document.getElementById('activeMeta').textContent = peer ? peer.kind + ' · ' + (peer.worktree || '') : '';
      document.getElementById('terminal').style.display = 'none';
      document.getElementById('codexPanel').hidden = true;
      document.getElementById('nativePanel').hidden = true;
      document.getElementById('codexPanel').style.display = 'none';
      document.getElementById('terminalComposer').hidden = true;
      document.getElementById('activeTask').hidden = true;
      document.getElementById('detectedPanel').style.display = '';
      document.getElementById('quickBar').style.display = 'none';
      setMobileView('terminal');
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
              \${dshCoordinationPeer(peer) ? \`
              <div class="item"><strong>\${esc(tr('providerSession'))}</strong><span class="mono" style="overflow-wrap:anywhere">\${esc(peer.provider_session_id || tr('unknown'))}</span></div>
              <p style="font-size:12px;color:var(--muted)">\${esc(tr('dshCoordinationHelp'))}</p>
              \` : ''}
              <div class="item"><strong>\${esc(tr('status'))}</strong><span>\${esc(statusText(peer.status))}</span></div>
              <div class="item"><strong>\${esc(tr('cwd'))}</strong><span class="mono" style="font-size:11px">\${esc(peer.worktree || '')}</span></div>
              <div class="item"><strong>\${esc(tr('pid'))}</strong><span>\${esc(peer.pid || tr('unknown'))}</span></div>
              <div class="item"><strong>\${esc(tr('lastSeen'))}</strong><span>\${peer.age_sec != null ? esc(peer.age_sec + tr('secondsAgo')) : ''}</span></div>
            </div>
          </div>
          <div class="card">
            <h2>\${esc(tr('sendMessage'))}</h2>
            <div class="body" style="gap:8px">
              <div style="font-size:12px;color:var(--muted)">\${tr(dshCoordinationPeer(peer) && peer.transport === 'cordis' ? 'dshCordisMessageHelp' : 'messageHelp')}</div>
              <textarea id="detMsg" rows="3" style="width:100%;background:var(--input-bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font:inherit;resize:vertical" placeholder="\${esc(tr('messageBodyPlaceholder'))}"></textarea>
              <button class="primary" id="sendDetMsg">\${esc(tr('send'))}</button>
            </div>
          </div>
        </div>
      \`;
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
      sendTerminalInput(text + '\\r');
    }

    // ── Start session form ────────────────────────────────────────────────
    document.getElementById('kind').addEventListener('change', syncStartModeOptions);
    document.getElementById('transport').addEventListener('change', syncStartModeOptions);
    document.getElementById('startMode').addEventListener('change', syncStartModeOptions);
    document.getElementById('resumeSelect').addEventListener('change', toggleResumeCustom);
    syncStartModeOptions();

    document.getElementById('startForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (startPending) return;
      startPending = true;
      document.getElementById('openStartDialog').disabled = true;
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      const errorElement = document.getElementById('startDialogError');
      const projectRoot = currentProject;
      errorElement.hidden = true;
      try {
        const kind = document.getElementById('kind').value;
        const mode = document.getElementById('startMode').value;
        const sel = document.getElementById('resumeSelect');
        const resume = (sel.value && sel.value !== '__custom__')
          ? sel.value
          : document.getElementById('resumeArg').value.trim();
        if (mode === 'resume' && !resume) {
          document.getElementById('resumeArg').focus();
          return;
        }
        const payload = { kind, mode };
        if (kind === 'codex' && document.getElementById('transport').value === 'app-server') {
          payload.transport = 'app-server';
          if (mode === 'resume') {
            if (!document.getElementById('appServerResumeConfirm').checked) throw new Error(tr('handoff.resumeConfirm'));
            payload.handoffConfirmed = true;
          }
        }
        if (mode === 'resume') payload.resume = resume;
        const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
        if (currentProject !== projectRoot) return;
        await refreshSessions();
        if (currentProject !== projectRoot || startDialog.hidden) return;
        closeDialog(startDialog);
        connectManaged(data.session.id);
      } catch (error) {
        errorElement.textContent = tr('error.' + error.code, error.detail || error.message);
        errorElement.hidden = false;
      }
      finally { startPending = false; submitButton.disabled = false; document.getElementById('openStartDialog').disabled = false; }
    });

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
      const error = result.error || data.error;
      if (error) {
        const code = String(result.errorCode || '').toLowerCase();
        return [
          tr('error.' + code, tr('requestFailed')),
          result.errorCode ? '[' + result.errorCode + ']' : '',
          tr('details') + ': ' + error
        ].join('\\n');
      }
      if (result.action === 'status') {
        const tasks = (data.tasks || []).map((row) => statusText(row.status) + ': ' + row.n).join(', ') || tr('none');
        return [
          data.root ? tr('root') + ': ' + data.root : '',
          tr('peers') + ' · ' + tr('active') + ': ' + (data.active_peers ?? 0) + ' · ' + tr('stale') + ': ' + (data.stale_peers ?? 0),
          tr('tasks') + ': ' + tasks,
          tr('locks') + ' · ' + tr('active') + ': ' + (data.active_locks ?? 0),
          tr('unread') + ': ' + (data.unread ?? 0)
        ].filter(Boolean).join('\\n');
      }
      if (result.action === 'state') {
        const automation = data.automation || {};
        const next = automation.next_action || {};
        return [
          tr('phase') + ': ' + statusText(automation.phase || 'idle'),
          tr('next') + ': ' + (next.command || (next.kind && next.kind !== 'none' ? tr('action.' + next.kind, next.kind) : tr('none'))),
          tr('why') + ': ' + (next.reason || tr('noImmediateAction')),
          ...(automation.warnings || []).map((w) => tr('warnings') + ': ' + w)
        ].join('\\n');
      }
      if (result.action === 'inbox') {
        const messages = data.messages || [];
        return messages.length
          ? messages.map((m) => '#' + m.id + ' ' + m.sender + ' -> ' + (m.recipient || tr('all')) + ': ' + m.body).join('\\n')
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
        ].filter(Boolean).join('\\n');
      }
      if (result.action === 'register') {
        const peer = data.peer || {};
        return [
          tr('registered') + ': ' + (peer.id || result.peer || tr('unknown')),
          tr('kind') + ': ' + (peer.kind || tr('unknown')),
          tr('status') + ': ' + statusText(peer.status),
          peer.worktree ? tr('cwd') + ': ' + peer.worktree : ''
        ].filter(Boolean).join('\\n');
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
    function closeDialog(dialog) {
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
    function openStartDialog() {
      if (startPending) return;
      document.getElementById('startProjectPath').textContent = currentProject;
      document.getElementById('startDialogError').hidden = true;
      document.getElementById('appServerResumeConfirm').checked = false;
      syncStartModeOptions();
      openDialog(startDialog, document.getElementById('kind'));
    }
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
    document.getElementById('settingsBtn').addEventListener('click', () => openDialog(settingsDialog, document.getElementById('langSelect')));
    document.getElementById('settingsClose').addEventListener('click', () => closeDialog(settingsDialog));
    [settingsDialog, stopDialog, projectDialog, startDialog, document.getElementById('historyDialog'), document.getElementById('reviewDialog'), document.getElementById('commandDialog')].forEach((dialog) => {
      dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog); });
      dialog.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); closeDialog(dialog); return; }
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button, select, input, textarea, [tabindex="0"]')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
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
    ${terminalFindScript()}
    window.hccCommandHost = {
      openDialog, closeDialog, error: handleUiError,
      modalOpen: () => Boolean(document.querySelector('.dialog-overlay:not([hidden])')),
      terminalAvailable: terminalFindAvailable, focusSessions: focusSessionsSearch,
      commands() {
        const page = tr('commands.pages');
        const commands = [
          { id:'new', label:tr('newSession'), group:page, enabled:!startPending, run:openStartDialog },
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
        if (paneMode) return commands.filter(command => ['new','sessions','find','settings','history','review','refresh'].includes(command.id) || command.id.startsWith('session:'));
        commands.splice(3,0,{id:'workspace',label:tr(window.hccWorkspace?.isOpen ? 'workspace.close' : 'workspace.split'),group:page,enabled:!document.getElementById('splitBtn').disabled,run:() => document.getElementById('splitBtn').click()});
        return commands;
      }
    };
    ${commandPaletteScript()}
    window.hccWorkspaceHost = {
      embedded:paneMode, app:appEl, primary:document.getElementById('workspacePrimaryPane'),
      project:() => currentProject, active:() => active, sessions:() => sessions, ready:() => sessionsLoaded,
      esc, showTerminal:() => setMobileView('terminal'), layoutChanged:() => { syncPanelAccess(); requestAnimationFrame(resizeTerm); }
    };
    ${workspaceScript()}
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
    loadProjects().then(() => Promise.all([refreshSessions(), refreshDetected(), refreshState()])).then(() => {
      if (!active && !activeDetected) restoreSelection();
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
  </script>
</body>
</html>`;
}

// Minimal fallback page shown when a browser visits the bare URL with no valid
// session cookie (e.g. a bookmarked URL after the runtime restarted). The main
// flow is the token-in-URL exchange performed by the server; this form lets the
// user re-enter the token once to get a fresh cookie.
export function webLoginPage({ nonce } = {}) {
  return renderWebLoginPage({ inlineScriptNonce: nonceAttribute(nonce) });
}
