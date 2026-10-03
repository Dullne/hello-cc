import { uiPreferencesCss, uiPreferencesScript, preferenceControlsHtml } from './ui-preferences.mjs';

// Authentication stays server-side. Only appearance preferences are shared with
// the console; the access token is sent once and never added to browser storage.
export function renderWebLoginPage({ inlineScriptNonce }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hello-cc — sign in</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23087b65'/%3E%3Cpath d='m14 20 14 12-14 12m20 0h16' fill='none' stroke='white' stroke-width='5'/%3E%3C/svg%3E">
  <script${inlineScriptNonce}>${uiPreferencesScript()}</script>
  <style>
    ${uiPreferencesCss}
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100dvh; padding: 24px; display: grid; place-items: center; background: var(--bg); color: var(--text); font-family: var(--sans); }
    .login-card { width: min(100%, 460px); padding: 32px; border: 1px solid var(--border); border-radius: 16px; background: var(--panel); box-shadow: 0 20px 60px var(--shadow, rgba(0, 0, 0, .15)); }
    .login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; font-weight: 700; font-size: 18px; letter-spacing: -.03em; }
    .login-mark { color: var(--accent); font-family: var(--mono); }
    h1 { margin: 0; font-size: 24px; line-height: 1.4; letter-spacing: -.025em; }
    .login-help { color: var(--muted); font-size: 14px; line-height: 1.65; margin: 10px 0 24px; }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; }
    input, select, button { font: inherit; }
    input, select { width: 100%; min-width: 0; min-height: 40px; padding: 9px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--input-bg, var(--bg)); color: var(--text); }
    input::placeholder { color: var(--muted); opacity: .8; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .login-submit { width: 100%; min-height: 42px; margin-top: 16px; border-radius: 7px; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent, #06211b); font-weight: 600; cursor: pointer; }
    .login-submit:hover { filter: brightness(1.08); }
    .login-submit:disabled { cursor: wait; opacity: .65; }
    .login-error { color: var(--danger); font-size: 13px; line-height: 1.5; margin-top: 12px; min-height: 20px; }
    .login-preferences { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; border-top: 1px solid var(--border); padding-top: 20px; margin-top: 20px; }
    .login-preferences select { font-size: 12px; padding-left: 7px; }
    @media (max-width: 480px) { body { padding: 16px; } .login-card { padding: 24px; } h1 { font-size: 22px; } .login-preferences { grid-template-columns: 1fr; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <main class="login-card">
    <div class="login-brand"><span class="login-mark" aria-hidden="true">&gt;_</span><span>hello-cc</span></div>
    <h1 data-i18n="loginTitle">Sign in to hello-cc</h1>
    <p class="login-help" data-i18n="loginHelp">Enter the access token shown when you start the web console.</p>
    <form id="loginForm">
      <label for="tok"><span data-i18n="accessToken">Access token</span>
        <input id="tok" name="token" type="password" autocomplete="off" data-i18n-placeholder="tokenPlaceholder" placeholder="Paste your access token" required autofocus aria-describedby="err">
      </label>
      <button class="login-submit" id="go" type="submit" data-i18n="signIn">Sign in</button>
      <div class="login-error" id="err" role="alert" aria-live="polite"></div>
    </form>
    <div class="login-preferences" aria-label="Settings" data-i18n-aria="settings">${preferenceControlsHtml({ terminal: false })}</div>
  </main>
  <script${inlineScriptNonce}>
    const ui = window.hccUi;
    const input = document.getElementById('tok');
    const err = document.getElementById('err');
    const button = document.getElementById('go');
    const form = document.getElementById('loginForm');
    let pending = false;
    let errorKey = '';
    function renderLoginText() {
      ui.translate();
      document.title = 'hello-cc — ' + ui.tr('signIn');
      button.textContent = ui.tr(pending ? 'signingIn' : 'signIn');
      err.textContent = errorKey ? ui.tr(errorKey) : '';
    }
    ui.bindControls();
    window.addEventListener('hcc:preferences', renderLoginText);
    renderLoginText();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pending) return;
      const token = input.value.trim();
      if (!token) { errorKey = 'tokenRequired'; renderLoginText(); input.focus(); return; }
      pending = true;
      errorKey = '';
      button.disabled = true;
      input.setAttribute('aria-invalid', 'false');
      form.setAttribute('aria-busy', 'true');
      renderLoginText();
      try {
        const res = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) { location.href = '/'; return; }
        errorKey = res.status === 401 || res.status === 403 ? 'invalidToken' : 'networkError';
        input.setAttribute('aria-invalid', errorKey === 'invalidToken' ? 'true' : 'false');
      } catch {
        errorKey = 'networkError';
      } finally {
        pending = false;
        button.disabled = false;
        form.setAttribute('aria-busy', 'false');
        renderLoginText();
      }
    });
  </script>
</body>
</html>`;
}
