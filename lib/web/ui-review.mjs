export const auxiliaryPanelsCss = `
  .dialog.auxiliary-dialog { width:min(1040px,calc(100vw - 28px)); max-width:none; height:min(84dvh,900px); display:flex; flex-direction:column; overflow:hidden; gap:10px; }
  .auxiliary-dialog > .dialog-heading { flex:none; }
  .auxiliary-dialog pre { white-space:pre-wrap; overflow-wrap:anywhere; font:var(--small-font)/1.6 var(--mono); }
  .auxiliary-dialog .btns { flex-wrap:wrap; }
  .auxiliary-dialog .confirmation-row { display:flex; align-items:flex-start; gap:8px; margin:12px 0; line-height:1.5; }
  .confirmation-row input { flex:none; }
  .history-layout { display:grid; grid-template-columns:minmax(180px,260px) minmax(0,1fr); gap:16px; min-height:0; flex:1; }
  .history-list,.history-preview,.review-scroll { min-width:0; min-height:0; overflow:auto; }
  .history-thread { height:auto; display:grid; gap:5px; width:100%; text-align:left; padding:10px; margin:8px 0; }
  .history-thread span { color:var(--muted); font-size:var(--small-font); overflow-wrap:anywhere; }
  .history-thread[aria-pressed=true] { border-color:var(--accent); background:var(--selection-bg); }
  .history-turn,.review-record { border:1px solid var(--border); border-radius:8px; padding:12px; margin:10px 0; background:var(--card-bg); }
  .history-turn article { border-top:1px solid var(--border); padding-top:10px; margin-top:10px; }
  .review-scroll { flex:1; }
  .review-record-head { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .review-record-head strong { flex:1; min-width:150px; }
  .review-record small { color:var(--muted); }
  .review-stage-list { display:flex; flex-wrap:wrap; gap:8px; }
  .review-evidence { display:grid; gap:6px; font-size:var(--small-font); overflow-wrap:anywhere; }
  .review-form { display:grid; gap:10px; padding:12px 0; border-top:1px solid var(--border); }
  .review-form-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .review-form textarea { width:100%; min-height:70px; padding:8px; resize:vertical; font:inherit; color:var(--text); background:var(--input-bg); border:1px solid var(--border); border-radius:6px; }
  @media(max-width:700px) { .history-layout { grid-template-columns:1fr; grid-template-rows:minmax(100px,30%) minmax(0,1fr); } .review-form-row { grid-template-columns:1fr; } .dialog.auxiliary-dialog { height:90dvh; } }
`;

export function reviewPanelHtml() {
  return `<div class="dialog-overlay" id="reviewDialog" role="dialog" aria-modal="true" aria-labelledby="reviewTitle" hidden><div class="dialog auxiliary-dialog">
    <header class="dialog-heading"><h3 id="reviewTitle" data-i18n="review.title">Review results</h3><button id="reviewClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
    <p class="dialog-help" id="reviewScope"></p><p class="dialog-help" id="reviewNotice" role="status" aria-live="polite"></p>
    <div class="review-scroll"><div class="review-stage-list" id="reviewSummary"></div><div id="reviewRecords"></div>
      <form class="review-form" id="verificationForm">
        <h4 data-i18n="review.record">Record verification evidence</h4><p class="dialog-help" data-i18n="review.manualHelp">Record what you verified and its evidence. Task completion remains a separate action.</p>
        <div class="review-form-row"><label><span data-i18n="review.stage">Stage</span><select id="verificationStage"><option value="local" data-i18n="review.local">Local validation</option><option value="publication" data-i18n="review.publication">Publication</option><option value="business" data-i18n="review.business">Business acceptance</option></select></label>
          <label><span data-i18n="review.status">Result</span><select id="verificationStatus"><option value="pending" data-i18n="review.pending">Pending</option><option value="passed" data-i18n="review.passed">Passed</option><option value="failed" data-i18n="review.failed">Failed</option></select></label></div>
        <label><span data-i18n="review.recordTitle">Verification title or command already run</span><input id="verificationTitle" required maxlength="300" autocomplete="off"></label>
        <label><span data-i18n="review.details">Conclusion and remaining gaps</span><textarea id="verificationDetails" rows="3" required></textarea></label>
        <label><span data-i18n="review.evidence">Evidence references, one per line</span><textarea id="verificationEvidence" rows="2"></textarea></label>
        <div class="btns"><button id="reviewRefresh" type="button" data-i18n="refresh">Refresh</button><button id="verificationSave" class="primary" type="submit" data-i18n="review.save" disabled>Save record</button></div>
      </form>
    </div>
  </div></div>`;
}

export function reviewPanelScript() {
  return String.raw`(() => {
    const dialog = document.getElementById('reviewDialog'), form = document.getElementById('verificationForm');
    const bridge = () => window.hccHandoff, tr = (key, fallback = '') => bridge().tr(key, fallback), esc = value => bridge().esc(String(value ?? ''));
    let target = null, data = null, generation = 0, busy = false;
    const same = subject => subject && subject.root === bridge().projectRoot && subject.id === bridge().active;
    const route = subject => '/api/sessions/' + encodeURIComponent(subject.id) + '/results?root=' + encodeURIComponent(subject.root);
    const draftKey = subject => 'hcc.reviewDraft:' + JSON.stringify([subject.root,subject.id,subject.taskId]);
    const fields = ['verificationStage','verificationStatus','verificationTitle','verificationDetails','verificationEvidence'];
    function notice(message) { document.getElementById('reviewNotice').textContent = message || ''; }
    function values() { return Object.fromEntries(fields.map(id => [id,document.getElementById(id).value])); }
    function saveDraft() { if (target) window.hccUi.safeSet(draftKey(target), JSON.stringify(values())); }
    function restoreDraft() {
      let saved = {}; try { saved = JSON.parse(window.hccUi.safeGet(draftKey(target)) || '{}'); } catch (_) {}
      for (const id of fields) document.getElementById(id).value = saved[id] || (id === 'verificationStage' ? 'local' : id === 'verificationStatus' ? 'pending' : '');
    }
    function sync() {
      const task = data?.current_task;
      const owner = task?.owner;
      const writable = same(target) && bridge().canControl && task && task.id === target.taskId && bridge().session?.task?.id === target.taskId && owner === target.peer;
      document.getElementById('verificationSave').disabled = busy || !writable;
      document.getElementById('reviewRefresh').disabled = busy || !target;
      if (!busy && data && !writable) notice(task ? tr('review.controlRequired') : tr('review.noTask'));
    }
    function recordHtml(record) {
      const source = record.source === 'executor' ? tr('review.executorSource') : record.source === 'user' ? tr('review.userSource') : tr('review.recordedSource');
      const evidence = Array.isArray(record.evidence) ? record.evidence : record.evidence ? [record.evidence] : [];
      const command = record.command || record.commands;
      return '<article class="review-record"><div class="review-record-head"><strong>' + esc(record.title || record.command || tr('review.record')) + '</strong><span class="badge">' + esc(tr('review.' + (record.stage || 'local'))) + '</span><span class="badge">' + esc(tr('review.' + (record.status || 'pending'))) + '</span></div><small>' + esc(source) + (record.created_at || record.createdAt ? ' · ' + esc(new Date(Number(record.created_at || record.createdAt) * (Number(record.created_at || record.createdAt) < 1e12 ? 1000 : 1)).toLocaleString()) : '') + '</small>'
        + (record.details || record.conclusion ? '<pre>' + esc(record.details || record.conclusion) + '</pre>' : '')
        + (command ? '<details><summary>' + esc(tr('review.commands')) + '</summary><pre>' + esc(typeof command === 'string' ? command : JSON.stringify(command,null,2)) + '</pre></details>' : '')
        + (record.diff ? '<details><summary>' + esc(tr('review.diff')) + '</summary><pre>' + esc(record.diff) + '</pre></details>' : '')
        + (record.changedFiles?.length ? '<pre>' + esc(record.changedFiles.map(file => typeof file === 'string' ? file : file.path || JSON.stringify(file)).join('\n')) + '</pre>' : '')
        + (evidence.length ? '<div class="review-evidence">' + evidence.map(reference => '<span>' + esc(typeof reference === 'string' ? reference : JSON.stringify(reference)) + '</span>').join('') + '</div>' : '') + '</article>';
    }
    function render() {
      document.getElementById('reviewScope').textContent = [target?.root, target?.peer, data?.current_task ? '#' + data.current_task.id + ' ' + data.current_task.title : ''].filter(Boolean).join(' · ');
      document.getElementById('reviewSummary').innerHTML = ['local','publication','business'].map(stage => {
        const latest = data?.summary?.[stage];
        const status = typeof latest === 'string' ? latest : latest?.status || 'pending';
        const source = latest?.source === 'executor' ? tr('review.executorSource') : latest?.source === 'user' ? tr('review.userSource') : '';
        return '<span class="badge">' + esc(tr('review.' + stage)) + ': ' + esc(tr('review.' + status, status)) + (source ? ' · ' + esc(source) : '') + '</span>';
      }).join('');
      document.getElementById('reviewRecords').innerHTML = (data?.results || []).map(recordHtml).join('') || '<p class="dialog-help">' + esc(tr('review.empty')) + '</p>';
      sync();
    }
    async function refresh() {
      if (!target || busy) return;
      const subject = { ...target }, version = ++generation;
      busy = true; sync(); notice(tr('review.loading'));
      try {
        const result = await bridge().api(route(subject));
        if (!same(subject) || version !== generation || dialog.hidden) return;
        const previousTask = target.taskId;
        data = result; target.taskId = result.current_task?.id || null;
        if (previousTask !== target.taskId) restoreDraft();
        notice(''); render();
      } catch (error) { if (same(subject) && version === generation && !dialog.hidden) notice(error.detail || error.message); }
      finally { if (version === generation) { busy = false; sync(); } }
    }
    function open() {
      const b = bridge(), session = b.session;
      if (!session?.id) return;
      target = { root:b.projectRoot,id:session.id,peer:session.peer_id || session.id,taskId:session.task?.id || null };
      data = null; generation++; busy = false; restoreDraft(); render();
      b.openDialog(dialog, document.getElementById('reviewRefresh')); void refresh();
    }
    form.addEventListener('input', saveDraft); form.addEventListener('change', saveDraft);
    form.addEventListener('submit', async event => {
      event.preventDefault(); sync();
      if (busy || document.getElementById('verificationSave').disabled) return;
      const subject = { ...target }, version = generation, submitted = values(), storageKey = draftKey(subject);
      busy = true; sync(); notice(tr('review.saving'));
      try {
        await bridge().api(route(subject), { method:'POST',body:JSON.stringify({ actionToken:bridge().actionToken,epoch:bridge().epoch,taskId:subject.taskId,stage:submitted.verificationStage,status:submitted.verificationStatus,title:submitted.verificationTitle,details:submitted.verificationDetails,evidence:submitted.verificationEvidence.split('\n').map(line=>line.trim()).filter(Boolean) }) });
        let current = {}; try { current = JSON.parse(window.hccUi.safeGet(storageKey) || '{}'); } catch (_) {}
        if (JSON.stringify(current) === JSON.stringify(submitted)) window.hccUi.safeSet(storageKey,'{}');
        if (!same(subject) || version !== generation || dialog.hidden) return;
        restoreDraft(); notice(tr('review.saved')); busy = false; await refresh();
      } catch (error) { if (same(subject) && version === generation && !dialog.hidden) notice((error.detail || error.message) + (error.code ? ' [' + error.code + ']' : '')); }
      finally { if (version === generation) { busy = false; sync(); } }
    });
    document.getElementById('reviewRefresh').addEventListener('click', refresh);
    document.getElementById('reviewClose').addEventListener('click', () => bridge().closeDialog(dialog));
    window.addEventListener('hcc:preferences', () => { if (!dialog.hidden) render(); });
    window.hccReview = { open,sync,reset() { generation++; busy = false; target = null; if (!dialog.hidden) bridge().closeDialog(dialog); } };
  })();`;
}
