export function codexAccountPanelHtml(prefix) {
  return '<details id="' + prefix + 'Account" class="hcc-codex-account" hidden><summary id="' + prefix + 'AccountLabel">Account and limits</summary>'
    + '<p id="' + prefix + 'AccountSummary" role="status"></p><div id="' + prefix + 'AccountLimits"></div>'
    + '<p id="' + prefix + 'AccountChecked" class="hcc-account-muted"></p><button id="' + prefix + 'AccountRead" type="button">Refresh account and limits</button>'
    + '<p id="' + prefix + 'AccountNote" class="hcc-account-muted"></p></details>';
}
export function codexAccountPanelCss() {
  return '.hcc-codex-account{max-width:900px;margin:12px auto;padding:12px;border:1px solid var(--border);border-radius:8px;overflow-wrap:anywhere}'
    + '.hcc-codex-account summary{cursor:pointer;font-weight:600}.hcc-codex-account p{margin:8px 0;font-size:var(--small-font)}'
    + '.hcc-account-muted{color:var(--muted)}.hcc-account-window{display:grid;gap:4px;margin:10px 0}.hcc-account-window progress{width:100%;height:8px;accent-color:var(--accent)}'
    + '.hcc-codex-account[data-warning="true"]{border-color:var(--warn)}.hcc-codex-account button{min-height:36px}'
    + '@media(max-width:640px){.hcc-codex-account{padding:10px}.hcc-codex-account button{min-height:44px;width:100%}}';
}
export function codexAccountPanelScript() { return '(' + installCodexAccountPanel.toString() + ')();'; }

export function installCodexAccountPanel() {
(() => {
    if (window.hccCodexAccount) return;
    const text = (en,zh) => window.hccUi.language === 'zh' ? zh : en;
    const esc = value => window.hccHandoff.esc(String(value ?? ''));
    const rendered = new Map();
    function label(account) {
      if (!account || account.status === 'unknown') return text('Not read yet','暂未读取');
      if (account.status !== 'ready') return account.reason === 'disconnected' ? text('Executor disconnected','执行器已断开') : text('Temporarily unavailable','暂不可用');
      if (account.authentication === 'providerManaged') return text('Provider-managed authentication','供应商自行管理认证');
      if (account.authentication === 'required') return text('Local Codex sign-in required','需要在本地 Codex 登录');
      if (account.authentication !== 'authenticated') return text('Authentication unknown','认证状态未知');
      return (account.type === 'chatgpt' ? 'ChatGPT' + (account.planType ? ' · ' + account.planType : '')
        : account.type === 'apiKey' ? 'API key' : 'Amazon Bedrock') + text(' · Signed in',' · 已登录');
    }
    function date(value) {
      if (!Number.isFinite(value)) return '';
      try { return new Date(value).toLocaleString(window.hccUi.language === 'zh' ? 'zh-CN' : 'en-US'); } catch (_) { return ''; }
    }
    function windowHtml(value, fallback) {
      if (!value) return '';
      const duration = value.windowDurationMins;
      const name = duration ? (duration % 1440 === 0 ? duration / 1440 + text(' day window',' 天窗口')
        : duration % 60 === 0 ? duration / 60 + text(' hour window',' 小时窗口') : duration + text(' minute window',' 分钟窗口')) : fallback;
      const reset = value.resetsAt == null ? '' : text(' · Resets ',' · 重置时间 ') + date(value.resetsAt * 1000);
      return '<div class="hcc-account-window"><span>' + esc(name + text(' · Used ',' · 已用 ') + value.usedPercent + '%' + reset)
        + '</span><progress max="100" value="' + Math.min(100,Math.max(0,value.usedPercent)) + '" aria-label="' + esc(name + text(' usage',' 用量')) + '"></progress></div>';
    }
    function render(prefix, account, { supported = true, connected = true, pending = false } = {}) {
      const panel = document.getElementById(prefix + 'Account');
      if (!panel) return;
      const signature = JSON.stringify([account, supported, connected, pending, window.hccUi.language]);
      if (rendered.get(prefix) === signature) return;
      rendered.set(prefix, signature);
      panel.hidden = !supported;
      if (!supported) return;
      const limits = account?.rateLimits;
      panel.dataset.warning = String(account?.authentication === 'required' || limits?.buckets?.some(bucket => bucket.reached || (bucket.credits?.hasCredits === false && !bucket.credits.unlimited) || [bucket.primary,bucket.secondary].some(value => value?.usedPercent >= 100)) || false);
      document.getElementById(prefix + 'AccountLabel').textContent = text('Account and limits','账号与限额') + ' · ' + label(account);
      document.getElementById(prefix + 'AccountSummary').textContent = label(account)
        + (account?.stale ? text(' · Prior data, needs refresh',' · 历史状态，待刷新') : '');
      let html = '';
      if (limits?.status === 'ready' || limits?.stale) html = (limits.buckets || []).map(bucket => '<div><strong>' + esc(bucket.id || 'Codex') + '</strong>'
        + windowHtml(bucket.primary,text('Primary window','主要窗口')) + windowHtml(bucket.secondary,text('Secondary window','次要窗口'))
        + (bucket.credits ? '<p>' + esc(bucket.credits.unlimited ? text('Credits: unlimited','额度：不限量') : bucket.credits.hasCredits ? text('Credits available','有可用额度') : text('No available credits','无可用额度')) + '</p>' : '')
        + (bucket.reached ? '<p>' + esc(text('A usage or credit limit has been reached. Check the local Codex account.','已达到用量或额度限制，请检查本地 Codex 账号。')) + '</p>' : '') + '</div>').join('');
      if (limits?.stale) html = '<p>' + esc(text('Prior usage data; the current read is unavailable.','以下是历史用量，本次读取暂不可用。')) + '</p>' + html;
      if (limits?.status !== 'ready') html += '<p>' + esc(account?.authentication === 'required'
        ? text('Sign in locally to read subscription limits.','请先在本地登录，再读取订阅限额。') : limits?.status === 'notApplicable'
        ? text('Codex subscription limits do not apply to this provider. Its quota is unknown here.','当前供应商不适用 Codex 订阅限额；这里无法确认它的配额。')
        : limits?.reason === 'unsupported' ? text('This Codex version does not provide subscription limits.','此 Codex 版本未提供订阅限额。')
        : text('Limits are unavailable; missing data does not mean zero usage.','限额暂不可用；缺失数据不代表用量为零。')) + '</p>';
      document.getElementById(prefix + 'AccountLimits').innerHTML = html;
      const checked = [account?.checkedAt ? text('Account checked: ','账号读取时间：') + date(account.checkedAt) : '',
        limits?.checkedAt ? text('Limits checked: ','限额读取时间：') + date(limits.checkedAt) : ''].filter(Boolean).join(' · ');
      document.getElementById(prefix + 'AccountChecked').textContent = checked;
      const button = document.getElementById(prefix + 'AccountRead');
      button.disabled = !connected || pending;
      button.textContent = pending ? text('Reading…','读取中…') : text('Refresh account and limits','刷新账号与限额');
      document.getElementById(prefix + 'AccountNote').textContent = account?.authentication === 'providerManaged'
        ? text('This provider does not require OpenAI sign-in. A real task is needed to verify its authentication.','当前供应商无需 OpenAI 登录，认证是否有效需通过实际任务确认。')
        : text('Read-only data from this executor. Login changes stay in local Codex; no proactive token refresh is requested.','只读查看此执行器的状态。登录变更仍由本地 Codex 管理，此操作不请求主动刷新 token。');
    }
    window.hccCodexAccount = { render };
  })();
}
