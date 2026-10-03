import { nativeTimelineCss, nativeTimelineScript, installNativeTimeline } from './ui-native-timeline.mjs';
import { interactionPanelScript, installInteractionPanel } from './ui-interactions.mjs';
import { codexAccountPanelHtml, codexAccountPanelCss, codexAccountPanelScript, installCodexAccountPanel } from './ui-codex-account.mjs';
import { sessionToolsCss, sessionToolsHtml, sessionToolsScript, metricsHtml, traceFilterHtml, installSessionTools } from './ui-session-tools.mjs';

export function nativePanelHtml() {
  return `<style>
    #nativePanel { flex:1; min-width:0; min-height:0; overflow:hidden; flex-direction:column; }
    #nativePanel[hidden] { display:none; }
    #nativePanel:not([hidden]) { display:flex; }
    .native-header,.native-composer { flex:none; padding:12px 16px; background:var(--panel); }
    .native-header { border-bottom:1px solid var(--border); }
    .native-header p { margin:6px 0 0; color:var(--muted); font-size:var(--small-font); overflow-wrap:anywhere; }
    .native-scroll { flex:1; min-height:0; overflow:auto; padding:0 16px 12px; }
    .native-event { padding:10px 0; border-bottom:1px solid var(--border); }
    .native-event pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:6px 0; line-height:1.6; }
    .native-receipts { display:grid; gap:8px; margin:10px 0; }
    .native-receipt { border:1px solid var(--border); border-radius:7px; padding:9px; font-size:var(--small-font); overflow-wrap:anywhere; }
    .native-composer { border-top:1px solid var(--border); max-height:45%; overflow:auto; }
    #nativeDraft { width:100%; min-height:70px; max-height:170px; resize:vertical; padding:10px; font:inherit; background:var(--input-bg); color:var(--text); border:1px solid var(--border); border-radius:7px; }
    .hcc-interaction-content,.hcc-interaction-details pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; margin:6px 0; }
    .hcc-interaction-details { margin:8px 0; }
    .hcc-interaction-details summary { cursor:pointer; color:var(--muted); }
    .native-controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px; }
    .native-controls label { display:flex; gap:6px; align-items:center; font-size:var(--small-font); }
    #nativeNotice { color:var(--muted); font-size:var(--small-font); overflow-wrap:anywhere; }
    ${codexAccountPanelCss()}
    ${nativeTimelineCss}
    ${sessionToolsCss}
  </style><section id="nativePanel" hidden aria-label="Native worker">
    <header class="native-header"><div class="native-header-top"><strong id="nativeStatus" role="status"></strong><button id="nativeApprovalJump" type="button" hidden>Needs your response</button></div>
      <nav class="native-navigation" aria-label="Native session views"><button id="nativeConversation" type="button" aria-pressed="true">Conversation</button><button id="nativeTrace" type="button" aria-pressed="false">Event trace</button></nav><p id="nativeHistoryRange" class="native-history-range"></p></header>
    <div id="nativeScroll" class="native-scroll" tabindex="0" aria-label="Native conversation"><div id="nativeApprovals"></div>${codexAccountPanelHtml('native')}${traceFilterHtml('native')}${metricsHtml('native')}<div id="nativeEvents"></div>
      <details id="nativeReceiptsDetails" class="native-meta"><summary id="nativeReceiptsLabel">Delivery receipts</summary><div id="nativeReceipts" class="native-receipts"></div></details>
      <details id="nativeIdentityDetails" class="native-meta"><summary id="nativeIdentityLabel">Executor details</summary><p id="nativeIdentity"></p><p data-i18n="native.approvalPolicy">The current controller can answer interactive requests here.</p></details></div>
    <div id="nativeJumpBar" class="native-reading-jump" hidden><button id="nativeJump" type="button">Back to latest</button></div>
    <footer class="native-composer"><label for="nativeDraft" data-i18n="native.draft">Message draft saved in this browser</label><textarea id="nativeDraft" rows="3"></textarea>${sessionToolsHtml('native')}
      <div class="native-controls"><button id="nativeSend" class="primary" type="button" data-i18n="native.send" disabled>Queue message</button><button id="nativeInterrupt" type="button" data-i18n="native.interrupt" disabled>Interrupt current turn</button><button id="nativeRead" type="button" data-i18n="native.read">Refresh receipts</button><button id="nativeReviewPending" type="button" data-i18n="native.reviewPending" hidden>Reviewed; keep draft</button></div>
      <div class="native-controls"><label><input id="nativeCloseConfirmed" type="checkbox"><span data-i18n="native.closeConfirm">Stop this executor</span></label><button id="nativeClose" class="danger" type="button" data-i18n="native.close" disabled>Close executor</button></div>
      <p id="nativeNotice" role="status" aria-live="polite"></p>
    </footer>
  </section>`;
}

export function nativePanelScript() {
  return nativeTimelineScript() + codexAccountPanelScript() + interactionPanelScript() + "(" + installNativePanel.toString() + ")(false);";
}

export function installNativePanel(installDependencies = true) {
  if (installDependencies) { installNativeTimeline(); installCodexAccountPanel(); installInteractionPanel(); }
    const bridge = () => window.hccHandoff, panel = document.getElementById('nativePanel'), draft = document.getElementById('nativeDraft');
    const tr = (key, fallback = '') => bridge().tr(key, fallback), esc = value => bridge().esc(String(value ?? ''));
    const events = new Map(), inflight = new Set(), responding = new Set();
    const accountPending = new Set(), accountReads = new Set();
    const text = (en, zh) => ['zh','zh-CN'].includes(window.hccUi.language) ? zh : en;
    const timeline = window.hccNativeTimelineView({ document, window, escape: esc, text });
    let key = '', state = null, pending = null, observed = 0, approvalSignature = '';
    const contextTools = window.hccCreateSessionTools({ document, window, prefix: 'native', bridge, draft, save: () => { save(); sync(); }, state: () => state, text, escape: esc });
    const storageKey = () => 'hcc.nativeDraft:' + JSON.stringify([bridge().projectRoot,bridge().active]) + (bridge().draftScope ? ':pane:' + JSON.stringify(bridge().draftScope) : '');
    function save() { if (key) window.hccUi.safeSet(key,JSON.stringify({text:draft.value,pending})); }
    function subject() { const b = bridge(); return {root:b.projectRoot,id:b.active,key:storageKey(),token:b.actionToken,epoch:b.epoch,generation:state?.generation,owner:state?.owner}; }
    const matches = target => target.root === bridge().projectRoot && target.id === bridge().active && (!target.generation || target.generation === state?.generation) && (!target.owner || target.owner === state?.owner);
    const accountScope = target => JSON.stringify([target.key,target.generation,target.owner,target.sessionId]);
    const route = (target,name) => '/api/sessions/' + encodeURIComponent(target.id) + '/native/' + name + '?root=' + encodeURIComponent(target.root);
    function notice(message) { document.getElementById('nativeNotice').textContent = message || ''; }
    function sync() {
      const next = storageKey();
      if (next !== key) {
        key = next; state = null; pending = null; events.clear(); observed++; draft.value = '';
        approvalSignature = ''; timeline.reset(key);
        for (const id of ['nativeStatus','nativeIdentity','nativeReceipts','nativeNotice','nativeApprovals']) document.getElementById(id).textContent = '';
        document.getElementById('nativeCloseConfirmed').checked = false;
        document.getElementById('nativeAccount').open = false;
        try { const saved = JSON.parse(window.hccUi.safeGet(key) || '{}'); draft.value = saved.text || ''; pending = saved.pending || null; } catch (_) {}
      }
      window.hccCodexAccount.render('native', state?.account, { supported: Boolean(state?.capabilities?.accountRead),
        connected: Boolean(state?.connected), pending: accountPending.has(accountScope({ ...subject(), sessionId: state?.sessionId })) });
      const writable = bridge().session?.type === 'native' && bridge().canControl && state?.connected && !state.closing;
      const sending = inflight.has(key);
      document.getElementById('nativeSend').disabled = !writable || sending || !!pending || !draft.value.trim() || state?.quarantined || state?.capabilities?.send === false;
      document.getElementById('nativeInterrupt').disabled = !writable || sending || !state?.turnId || state?.capabilities?.interrupt === false;
      document.getElementById('nativeClose').disabled = !writable || sending || !document.getElementById('nativeCloseConfirmed').checked;
      document.getElementById('nativeReviewPending').hidden = !pending;
      document.getElementById('nativeReviewPending').disabled = sending;
      document.getElementById('nativeRead').disabled = bridge().session?.type !== 'native';
      document.getElementById('nativeApprovals').querySelectorAll('button[data-response]').forEach(button => {
        button.disabled = !writable || responding.has(button.dataset.requestKey) || (button.dataset.decision === 'accept' && button.dataset.truncated === 'true');
      });
      if (pending) notice(tr('native.uncertain'));
      contextTools.render();
      window.hccRenderReportedMetrics({ document, prefix: 'native', state, text, escape: esc });
    }
    function acknowledge(target, submissionId) {
      let stored = {}; try { stored = JSON.parse(window.hccUi.safeGet(target.key) || '{}'); } catch (_) {}
      if (stored.pending?.id !== submissionId) return false;
      if (stored.text === stored.pending.text) stored.text = '';
      stored.pending = null; window.hccUi.safeSet(target.key,JSON.stringify(stored));
      // A-B-A navigation can return before its fresh executor snapshot arrives.
      // Reconcile the matching local submission even while state is still null.
      if (key === target.key && pending?.id === submissionId) {
        draft.value = stored.text || ''; pending = null;
        notice(matches(target) ? tr('native.queued') : '');
      }
      return true;
    }
    function render(value) {
      sync();
      if (!value || bridge().session?.type !== 'native' || (value.peer !== bridge().session?.peer_id && value.peer !== bridge().active) || (value.root && value.root !== bridge().projectRoot)) return;
      if (Number.isSafeInteger(state?.generation) && Number.isSafeInteger(value.generation) && value.generation < state.generation) return;
      const replaced = state && (state.generation !== value.generation || state.owner !== value.owner);
      if (replaced) { events.clear(); approvalSignature = ''; document.getElementById('nativeCloseConfirmed').checked = false; }
      if (state !== value) observed++;
      state = value;
      const accountKey = accountScope({ ...subject(), sessionId: state.sessionId });
      if (state.connected && state.capabilities?.accountRead && !accountReads.has(accountKey)) {
        accountReads.add(accountKey);
        if (accountReads.size > 100) accountReads.delete(accountReads.values().next().value);
        void readAccount();
      }
      for (const entry of value.events || []) events.set(entry.id,entry);
      while (events.size > 100) events.delete(events.keys().next().value);
      const recent = [...events.values()].sort((a,b)=>a.id-b.id).map(entry => entry.payload || entry);
      const metricEvent = recent.findLast(event => event.metrics), metadataEvent = recent.findLast(event => event.runtimeMetadata);
      state = { ...state, metrics: state.metrics || metricEvent?.metrics, runtimeMetadata: state.runtimeMetadata || metadataEvent?.runtimeMetadata };
      document.getElementById('nativeStatus').textContent = tr('native.sameExecutor') + ' · ' + (state.provider || '') + ' · ' + tr('native.state.' + state.status, state.status || '');
      document.getElementById('nativeIdentity').textContent = [state.peer,state.sessionId,state.turnId].filter(Boolean).join(' · ');
      const receiptsHtml = (state.deliveries || []).map(delivery => '<article class="native-receipt"><strong>#' + esc(delivery.message_id) + ' · ' + esc(tr('native.delivery.' + delivery.state,delivery.state)) + '</strong><div>' + esc(delivery.submission_id) + (delivery.turn_id ? ' · ' + esc(delivery.turn_id) : '') + '</div>' + (delivery.detail ? '<details><summary>' + esc(tr('details')) + '</summary><pre>' + esc(typeof delivery.detail === 'string' ? delivery.detail : JSON.stringify(delivery.detail,null,2)) + '</pre></details>' : '') + '</article>').join('') || '<p>' + esc(tr('native.noReceipts')) + '</p>';
      if (document.getElementById('nativeReceipts').innerHTML !== receiptsHtml) document.getElementById('nativeReceipts').innerHTML = receiptsHtml;
      const approvals = state.pendingApprovals || [], target = subject(), container = document.getElementById('nativeApprovals');
      const requestKey = request => JSON.stringify([target.root, target.id, state.executorId, request.requestId]);
      const nextApprovalSignature = JSON.stringify([target.root, target.id, state.executorId, state.generation, state.owner, approvals, window.hccUi.language]);
      if (approvalSignature !== nextApprovalSignature) {
        window.hccInteractions.remember(container);
        container.innerHTML = approvals.map((request, index) => '<article class="codex-card codex-approval"><h3>'
          + esc(window.hccInteractions.requiresInput(request) ? text('Your input is required', '等待您的答复') : text('Approval required', '等待人工审批'))
          + '</h3>' + window.hccInteractions.preview(request, requestKey(request), esc, text)
          + (request.truncated ? '<p>' + esc(text('Truncated; cancel or decline only.', '参数已截断，只能取消或拒绝。')) + '</p>' : '')
          + '<div class="hcc-interaction-form">' + window.hccInteractions.form(request, requestKey(request), esc, text) + '</div><div class="native-controls">'
          + '<button data-response="' + index + '" data-decision="accept" data-truncated="' + window.hccInteractions.approvalBlocked(request) + '" data-request-key="' + esc(requestKey(request)) + '">' + esc(window.hccInteractions.acceptLabel(request, text)) + '</button>'
          + '<button data-response="' + index + '" data-decision="' + (request.kind === 'userInput' ? 'cancel' : 'decline') + '" data-request-key="' + esc(requestKey(request)) + '">' + esc(request.kind === 'mcp' ? text('Decline', '拒绝') : text('Decline / cancel', '拒绝 / 取消')) + '</button>'
          + (request.kind === 'mcp' ? '<button data-response="' + index + '" data-decision="cancel" data-request-key="' + esc(requestKey(request)) + '">' + esc(text('Cancel request', '取消请求')) + '</button>' : '') + '</div></article>').join('');
        window.hccInteractions.restore(container);
        container.querySelectorAll('button[data-response]').forEach(button => button.addEventListener('click', async () => {
          if (!matches(target) || !bridge().canControl || responding.has(button.dataset.requestKey)) return;
          const request = approvals[Number(button.dataset.response)], key = button.dataset.requestKey;
          const version = observed;
          notice(''); responding.add(key); sync();
          let authorization;
          try {
            const payload = window.hccInteractions.payload(request, ['permissions','userInput','mcp'].includes(request.kind) ? button.closest('article') : null, button.dataset.decision);
            authorization = window.hccInteractions.prepareUrl(request, button.dataset.decision, text);
            const result = await bridge().api(route(target, 'respond'), {method:'POST', body:JSON.stringify({
              executorId:request.executorId, sessionId:request.sessionId, turnId:request.turnId, requestId:request.requestId,
              ...payload, action_token:bridge().actionToken, epoch:bridge().epoch })});
            window.hccInteractions.forget(key);
            const opened = authorization?.complete();
            if (opened && matches(target)) notice(opened);
            if (matches(target) && version === observed) { if (result.state) render(result.state); else void read(); }
          } catch(error) {
            authorization?.cancel();
            if (matches(target) && (state?.pendingApprovals || []).some(current => current.requestId === request.requestId && current.executorId === request.executorId)) notice(error.detail || error.message);
          }
          finally { responding.delete(key); sync(); }
        }));
        approvalSignature = nextApprovalSignature;
      }
      timeline.render([...events.values()].sort((a,b)=>a.id-b.id), state, JSON.stringify([key,state.generation,state.owner]));
      if (pending && (state.deliveries || []).some(delivery => delivery.submission_id === pending.id && delivery.message_id)) acknowledge(subject(),pending.id);
      sync();
    }
    async function read() {
      if (bridge().session?.type !== 'native') return;
      const target = subject(), version = observed;
      try {
        const result = await bridge().api(route(target,'state'));
        if (matches(target) && version === observed) render(result.state || result);
      } catch (error) { if (matches(target)) notice(error.detail || error.message); }
    }
    async function readAccount() {
      if (!state?.connected || !state.sessionId || !state.capabilities?.accountRead || accountPending.has(accountScope({ ...subject(), sessionId: state.sessionId }))) return;
      const target = { ...subject(), sessionId: state.sessionId }, version = observed;
      const scope = accountScope(target); accountPending.add(scope); sync();
      try {
        const query = new URLSearchParams({ generation: target.generation, owner: target.owner, sessionId: target.sessionId });
        const result = await bridge().api(route(target,'account') + '&' + query);
        if (matches(target) && version === observed) render(result.state || result);
      } catch (error) { if (matches(target) && version === observed) notice(error.detail || error.message); }
      finally { accountPending.delete(scope); if (target.root === bridge().projectRoot && target.id === bridge().active) sync(); }
    }
    document.getElementById('nativeAccountRead').addEventListener('click', readAccount);
    draft.addEventListener('input',()=>{ save(); sync(); });
    document.getElementById('nativeSend').addEventListener('click',async()=>{
      sync(); if (document.getElementById('nativeSend').disabled) return;
      const target = subject(), text = draft.value, id = 's_' + crypto.randomUUID(), version = observed;
      pending = {id,text,generation:target.generation}; save(); inflight.add(target.key); sync(); notice(tr('native.sending'));
      try {
        const result = await bridge().api(route(target,'send'),{method:'POST',body:JSON.stringify({text,submissionId:id,action_token:target.token,epoch:target.epoch})});
        const receipt = result.receipt || result;
        if (receipt.submission_id !== id || !Number.isSafeInteger(receipt.message_id)) throw new Error(tr('native.invalidReceipt'));
        acknowledge(target,id);
        if (matches(target) && version === observed) { if (result.state) render(result.state); else void read(); }
      } catch(error) { if (matches(target) && pending?.id === id) notice((error.detail || error.message) + ' ' + tr('native.uncertain')); }
      finally { inflight.delete(target.key); sync(); }
    });
    document.getElementById('nativeInterrupt').addEventListener('click',async()=>{
      sync(); if (document.getElementById('nativeInterrupt').disabled) return;
      const target = subject(); inflight.add(target.key); sync();
      try { await bridge().api(route(target,'interrupt'),{method:'POST',body:JSON.stringify({turnId:state.turnId || state.activeDelivery?.turn_id,action_token:target.token,epoch:target.epoch})}); if(matches(target)){notice(tr('native.interruptRequested'));void read();} }
      catch(error){if(matches(target))notice(error.detail || error.message);}
      finally{inflight.delete(target.key);sync();}
    });
    document.getElementById('nativeCloseConfirmed').addEventListener('change',sync);
    document.getElementById('nativeClose').addEventListener('click',async()=>{
      sync(); if(document.getElementById('nativeClose').disabled)return;
      const target=subject();inflight.add(target.key);sync();
      try{await bridge().api(route(target,'close'),{method:'POST',body:JSON.stringify({action_token:target.token,epoch:target.epoch})});if(matches(target)){notice(tr('native.closed'));await bridge().refreshSessions();}}
      catch(error){if(matches(target))notice(error.detail || error.message);}
      finally{inflight.delete(target.key);sync();}
    });
    document.getElementById('nativeRead').addEventListener('click',read);
    document.getElementById('nativeReviewPending').addEventListener('click',()=>{
      if (!pending || inflight.has(key) || !confirm(tr('native.reviewConfirm'))) return;
      pending=null;save();notice(tr('native.retained'));sync();
    });
    window.addEventListener('hcc:preferences',()=>{if(state&&!panel.hidden)render(state);});
    window.hccNative={render,sync,read};
}
