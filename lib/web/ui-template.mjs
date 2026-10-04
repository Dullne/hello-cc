import { agentStartHtml } from './ui-agent-start.mjs';
import { agentDefaultsCss, agentDefaultsHtml } from './ui-agent-defaults.mjs';
import { filesCss, filesHtml } from './ui-files.mjs';
import { uiPreferencesCss, uiPreferencesScript, preferenceControlsHtml } from './ui-preferences.mjs';
import { renderWebLoginPage } from './ui-login.mjs';
import { handoffCss, handoffBarHtml, terminalComposerHtml } from './ui-handoff.mjs';
import { codexPanelHtml } from './ui-codex.mjs';
import { workbenchCss, workbenchControlsHtml } from './ui-workbench.mjs';
import { codexHistoryHtml } from './ui-history.mjs';
import { auxiliaryPanelsCss, reviewPanelHtml } from './ui-review.mjs';
import { nativePanelHtml } from './ui-native.mjs';
import { commandPaletteCss, commandPaletteHtml } from './ui-command-palette.mjs';
import { terminalFindCss, terminalFindHtml } from './ui-terminal-find.mjs';
import { workspaceCss, workspaceBarHtml, workspaceSecondaryHtml } from './ui-workspace.mjs';

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
    #agentLaunchFields { display:grid; gap:14px; }
    #agentLaunchFields[hidden] { display:none; }
    #historyDialog [hidden] { display:none; }
    #startForm [hidden], .dialog-help[hidden] { display: none; }
    #agentAdvanced summary { cursor: pointer; padding: 8px 0; }
    #agentAdvanced > :not(summary) { margin-top: 10px; }
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
      .header-controls { gap: 6px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
      .header-controls > * { flex-shrink: 0; }
      .global-header #connState { max-width: 88px; overflow: hidden; text-overflow: ellipsis; }
      .toolbar { flex-wrap: wrap; padding: 8px 10px; }
      .toolbar .title { flex-basis: 100%; }
      .quick { margin-left: auto; max-width:100%; flex-wrap:wrap; justify-content:flex-end; }
      .settings-fields label { grid-template-columns: 1fr; gap: 6px; }
    }
    @media (prefers-reduced-motion: reduce) { .app, .edge-toggle, .edge-resizer { transition: none; } }
    ${workspaceCss}
    ${filesCss}
    ${agentDefaultsCss}
  </style>
</head>
<body>
  <header class="global-header">
    <strong>hello-cc</strong>
    <div class="header-controls">
      <span id="connState" role="status">offline</span>
      <button id="filesBtn" type="button" data-i18n="files.button" aria-haspopup="dialog" aria-controls="filesDialog">Files</button>
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
        <button id="openStartDialog" class="primary" type="button" data-i18n="newSession" aria-haspopup="dialog" aria-controls="startDialog">New Agent</button>
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
  ${agentStartHtml()}
  ${filesHtml()}
  <div class="dialog-overlay" id="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" hidden>
    <div class="dialog settings-dialog">
      <header><h3 id="settingsTitle" data-i18n="settings">Settings</h3><button id="settingsClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
      <div class="settings-fields">${preferenceControlsHtml({ terminal: true })}</div>
      ${agentDefaultsHtml()}
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
  <script type="module" src="/assets/web/browser/core.mjs"></script>
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
