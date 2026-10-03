/**
 * @typedef {Object} ReportedMetrics Facts received from the current executor; never text estimates.
 * @property {string} source Provider/protocol source.
 * @property {'turn'|'session'} scope The upstream counter's actual scope.
 * @property {string=} turnId
 * @property {number=} observedAt Local receipt timestamp in milliseconds.
 * @property {number=} inputTokens
 * @property {number=} outputTokens
 * @property {number=} cachedInputTokens
 * @property {number=} totalTokens
 * @property {number=} contextTokens Actual occupancy, not cumulative usage.
 * @property {number=} contextWindow Reported window limit.
 * @property {number=} durationMs Provider-reported elapsed time.
 * @property {string=} model
 * @typedef {Object} RuntimeMetadata
 * @property {string=} model
 * @property {string=} permissionMode Read only. No configuration mutation is implied.
 * @property {{name:string, description?:string}[]=} commands Explicitly advertised text commands only.
 */

export function reportedMetrics(value) {
  if (!value || typeof value.source !== 'string' || !['turn', 'session'].includes(value.scope)) return null;
  const result = { source: value.source, scope: value.scope };
  for (const key of ['turnId', 'model']) if (typeof value[key] === 'string') result[key] = value[key];
  for (const key of ['observedAt', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'contextTokens', 'contextWindow', 'durationMs']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

/** UI-local text references do not grant provider file access or retrieve another transcript. */
export function sessionCapabilities(state = {}) {
  const metadata = state.runtimeMetadata || {}, caps = state.capabilities || {};
  return { textReferences: true, fileUpload: false, transcriptImport: false,
    modelSelection: false, permissionSelection: false, send: caps.send !== false,
    interrupt: caps.interrupt === true, steer: caps.steer === true,
    commands: (Array.isArray(metadata.commands) ? metadata.commands : []).filter(command =>
      typeof command?.name === 'string' && /^\/?[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(command.name))
      .map(command => ({ name: '/' + command.name.replace(/^\//, ''), description: typeof command.description === 'string' ? command.description : '' })) };
}

export function contextReference(kind, value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (kind === 'file') {
    const path = value.trim().replace(/\\/g, '/');
    if (/^(?:\/|~|[A-Za-z]:)/.test(path) || path.split('/').some(part => part === '..' || !part)) return null;
    return '[file reference: ' + JSON.stringify(path.replace(/^\.\//, '')) + ']';
  }
  if (kind === 'session') return '[session reference: ' + JSON.stringify(value) + ']';
  return null;
}

/** Search only retained, provider-reported records. Filters combine with AND. */
export function traceMatches(record, filter = {}) {
  if (filter.turnId && String(record.turnId || '') !== filter.turnId) return false;
  if (filter.kind === 'failed' && !(record.kind === 'error' || ['failed', 'error'].includes(record.status) || (record.exitCode != null && record.exitCode !== 0))) return false;
  if (filter.kind === 'tools' && record.kind !== 'tool') return false;
  if (filter.kind === 'files' && record.kind !== 'files') return false;
  const query = String(filter.query || '').trim().toLocaleLowerCase();
  if (!query) return true;
  const haystack = [record.turnId, record.title, record.text, record.command, record.input, record.output,
    ...(record.changes || []).flatMap(change => [change.path, change.diff, change.oldText])].filter(value => value != null).join('\n').toLocaleLowerCase();
  return query.split(/\s+/).every(word => haystack.includes(word));
}

export function sessionToolsHtml(prefix) {
  return `<details class="session-tools" id="${prefix}ContextTools"><summary id="${prefix}ContextLabel">References and capabilities</summary>
    <p id="${prefix}ContextHelp"></p><div class="session-tool-row"><input id="${prefix}FileQuery" type="search" autocomplete="off" aria-label="Project relative file path"><button id="${prefix}FileSearch" type="button">Find files</button></div>
    <div class="session-tool-row"><select id="${prefix}FileResults" aria-label="Project files"></select><button id="${prefix}FileOpen" type="button">Open file</button><button id="${prefix}FileInsert" type="button">Reference file</button></div>
    <div class="session-tool-row"><select id="${prefix}SessionResults" aria-label="Existing sessions"></select><button id="${prefix}SessionInsert" type="button">Reference session</button></div>
    <div class="session-tool-row" id="${prefix}CommandRow" hidden><select id="${prefix}Commands" aria-label="Advertised commands"></select><button id="${prefix}CommandInsert" type="button">Insert command</button></div>
    <p id="${prefix}CapabilitySummary"></p><p id="${prefix}ContextNotice" role="status" aria-live="polite"></p></details>`;
}

export function metricsHtml(prefix) {
  return `<details class="session-metrics"><summary id="${prefix}MetricsLabel">Reported run metrics</summary><dl id="${prefix}Metrics"></dl><p id="${prefix}MetricsSource"></p></details>`;
}

export function traceFilterHtml(prefix) {
  return `<details class="session-trace-tools"><summary id="${prefix}TraceFilterLabel">Find in retained history</summary><div class="session-tool-row">
    <input id="${prefix}TraceQuery" type="search" autocomplete="off" aria-label="Find in retained history">
    <select id="${prefix}TraceKind" aria-label="Event kind"></select><select id="${prefix}TraceTurn" aria-label="Turn"></select>
    <button id="${prefix}TraceClear" type="button">Clear filters</button></div><p id="${prefix}TraceCount" role="status"></p></details>`;
}

export function createSessionTools({ document, window, prefix, bridge, draft, save, state, text, escape }) {
  const node = suffix => document.getElementById(prefix + suffix);
  let scope = '', sequence = 0, paths = [], sessionValues = [], commandValues = [], renderSignature = '';
  const subject = () => JSON.stringify([bridge().projectRoot, bridge().active, state()?.executorId, state()?.generation, state()?.owner]);
  const notice = value => { node('ContextNotice').textContent = value; };
  function insert(value) {
    if (!value) return;
    if (scope !== subject()) { render(); notice(text('Session changed. Choose a reference again.', '会话已切换，请重新选择引用。')); return; }
    const cursor = typeof draft.selectionStart === 'number' ? draft.selectionStart : draft.value.length;
    const end = typeof draft.selectionEnd === 'number' ? draft.selectionEnd : cursor;
    draft.value = draft.value.slice(0, cursor) + (cursor && draft.value[cursor - 1] !== '\n' ? '\n' : '') + value + '\n' + draft.value.slice(end);
    save(); draft.focus(); notice(text('Added to your draft; nothing was sent or read.', '已加入草稿；尚未发送，也未读取引用内容。'));
  }
  function render() {
    const next = subject(), current = state() || {}, metadata = current.runtimeMetadata || {};
    if (scope !== next) { scope = next; sequence++; paths = []; node('FileQuery').value = ''; node('FileResults').innerHTML = ''; node('FileSearch').disabled = false; node('ContextTools').open = false; notice(''); }
    const signature = JSON.stringify([next, metadata, current.capabilities, bridge().sessions, text('en', 'zh')]);
    if (signature === renderSignature) return;
    renderSignature = signature;
    const capabilities = window.hccSessionCapabilities(current);
    node('ContextLabel').textContent = text('References and capabilities', '引用与执行器能力');
    node('ContextHelp').textContent = text('References add plain text only. Files and session history are not read or uploaded.', '引用仅加入明确的文本标记，不会读取或上传文件及会话历史。');
    node('FileQuery').placeholder = text('Project relative path', '项目相对路径');
    node('FileSearch').textContent = text('Find files', '查找文件');
    node('FileInsert').textContent = text('Reference file', '引用文件');
    node('FileOpen').textContent = text('Open file', '打开文件');
    node('SessionInsert').textContent = text('Reference session', '引用会话');
    node('CommandInsert').textContent = text('Insert command', '插入指令');
    node('FileInsert').disabled = !paths.length;
    node('FileOpen').disabled = !paths.length;
    sessionValues = (bridge().sessions || []).map(session => ({ value: [session.kind || session.binding?.provider || 'other', session.peer_id || session.id, session.binding?.provider_session_id || session.binding?.provider_session_name || session.provider_session_label || ''].filter(Boolean).join(':'), label: session.task?.title || session.name || session.peer_id || session.id }));
    const sessionsHtml = sessionValues.map((value, index) => '<option value="' + index + '">' + escape(value.label + ' · ' + value.value) + '</option>').join('');
    if (node('SessionResults').innerHTML !== sessionsHtml) node('SessionResults').innerHTML = sessionsHtml;
    node('SessionInsert').disabled = !sessionValues.length;
    commandValues = capabilities.commands;
    node('CommandRow').hidden = !commandValues.length;
    const commandsHtml = commandValues.map((command, index) => '<option value="' + index + '">' + escape(command.name + (command.description ? ' · ' + command.description : '')) + '</option>').join('');
    if (node('Commands').innerHTML !== commandsHtml) node('Commands').innerHTML = commandsHtml;
    node('CapabilitySummary').textContent = text('Current executor · Model: ', '当前执行器 · 模型：') + (metadata.model || text('not reported', '未报告'))
      + text(' · Permissions: ', ' · 权限：') + (metadata.permissionMode || text('not reported', '未报告'))
      + text(' (read only). Model/permission changes, uploads and history import are not provided here.', '（只读）。此处不提供模型/权限切换、附件上传或历史导入。')
      + (!commandValues.length ? text(' No commands advertised by this executor.', ' 当前执行器未声明可用指令。') : '');
  }
  node('FileSearch').addEventListener('click', async () => {
    const target = subject(), revision = ++sequence; node('FileSearch').disabled = true;
    try {
      const result = await bridge().api('/api/context/files?root=' + encodeURIComponent(bridge().projectRoot) + '&query=' + encodeURIComponent(node('FileQuery').value));
      if (target !== subject() || revision !== sequence) return;
      paths = (Array.isArray(result.paths) ? result.paths : []).filter(path => window.hccContextReference('file', path));
      node('FileResults').innerHTML = paths.map((path, index) => '<option value="' + index + '">' + escape(path) + '</option>').join('');
      node('FileInsert').disabled = !paths.length;
      node('FileOpen').disabled = !paths.length;
      notice(paths.length + text(' matching files', ' 个匹配文件') + (result.truncated ? text(' · Narrow your query for more results.', ' · 结果不完整，可缩小搜索范围。') : ''));
    } catch (error) { if (target === subject() && revision === sequence) notice(error.detail || error.message); }
    finally { if (target === subject() && revision === sequence) node('FileSearch').disabled = false; }
  });
  node('FileInsert').addEventListener('click', () => insert(window.hccContextReference('file', paths[Number(node('FileResults').value)])));
  node('FileOpen').addEventListener('click', () => {
    if (scope !== subject()) { render(); notice(text('Session changed. Choose a file again.', '会话已切换，请重新选择文件。')); return; }
    const path = paths[Number(node('FileResults').value)];
    if (path) window.hccFiles?.open(path);
  });
  node('SessionInsert').addEventListener('click', () => insert(window.hccContextReference('session', sessionValues[Number(node('SessionResults').value)]?.value)));
  node('CommandInsert').addEventListener('click', () => insert(commandValues[Number(node('Commands').value)]?.name));
  return { render };
}

export function renderReportedMetrics({ document, prefix, state, text, escape }) {
  const value = reportedMetrics(state?.metrics), unknown = text('Not reported', '未报告');
  const target = document.getElementById(prefix + 'Metrics'), signature = JSON.stringify([value, unknown]);
  if (target.dataset.metricsSignature === signature) return;
  target.dataset.metricsSignature = signature;
  const labels = [['model', 'Reported model', '报告的模型'], ['inputTokens', 'Input tokens', '输入 token'], ['outputTokens', 'Output tokens', '输出 token'],
    ['cachedInputTokens', 'Cached input tokens', '缓存输入 token'], ['totalTokens', 'Total tokens', '总 token'],
    ['contextTokens', 'Context occupancy', '上下文占用'], ['contextWindow', 'Context window limit', '上下文窗口上限'], ['durationMs', 'Duration (ms)', '耗时（毫秒）']];
  document.getElementById(prefix + 'MetricsLabel').textContent = text('Reported run metrics', '运行指标（上游报告）');
  document.getElementById(prefix + 'Metrics').innerHTML = labels.map(([key, en, zh]) => '<dt>' + escape(text(en, zh)) + '</dt><dd>' + escape(value?.[key] ?? unknown) + '</dd>').join('');
  document.getElementById(prefix + 'MetricsSource').textContent = value ? value.source + ' · ' + text('Scope: ', '统计范围：') + (value.scope === 'turn' ? text('turn', '轮次') : text('session', '会话')) + (value.turnId ? ' · ' + value.turnId : '')
    + (value.observedAt ? ' · ' + text('Received ', '接收于 ') + new Date(value.observedAt).toLocaleString() : '')
    : text('No upstream metrics reported. Unknown is not zero. Account limits are shown separately.', '上游尚未报告运行指标。未知不等于零，账号限额另行展示。');
}

export function createTraceFilter({ document, prefix, text, escape, changed }) {
  const node = suffix => document.getElementById(prefix + suffix);
  let filter = { query: '', kind: 'all', turnId: '' }, subject = '', optionsSignature = '';
  const notify = () => { filter = { query: node('TraceQuery').value, kind: node('TraceKind').value, turnId: node('TraceTurn').value }; changed(filter); };
  for (const [suffix, event] of [['TraceQuery', 'input'], ['TraceKind', 'change'], ['TraceTurn', 'change']]) node(suffix).addEventListener(event, notify);
  node('TraceClear').addEventListener('click', () => { filter = { query: '', kind: 'all', turnId: '' }; changed(filter); });
  return { value: () => filter, clear() { filter = { query: '', kind: 'all', turnId: '' }; }, reset(scope) { if (subject !== scope) { subject = scope; filter = { query: '', kind: 'all', turnId: '' }; } },
    render(turnIds, count, total) {
      node('TraceFilterLabel').textContent = text('Find in retained history', '检索保留的历史');
      node('TraceQuery').placeholder = text('Text, path, command or turn ID', '文本、路径、命令或轮次 ID');
      node('TraceQuery').value = filter.query;
      const signature = JSON.stringify([turnIds, filter.turnId, text('en', 'zh')]);
      if (optionsSignature !== signature) {
        optionsSignature = signature;
        const kinds = [['all', 'All events', '所有事件'], ['failed', 'Failures', '失败'], ['tools', 'Tools', '工具'], ['files', 'File changes', '文件变更']];
        node('TraceKind').innerHTML = kinds.map(([value, en, zh]) => '<option value="' + value + '">' + escape(text(en, zh)) + '</option>').join('');
        const retained = [...new Set(turnIds.filter(Boolean))];
        node('TraceTurn').innerHTML = '<option value="">' + escape(text('All turns', '所有轮次')) + '</option>' + retained.map(id => '<option value="' + escape(id) + '">' + escape(id) + '</option>').join('')
          + (filter.turnId && !retained.includes(filter.turnId) ? '<option value="' + escape(filter.turnId) + '">' + escape(filter.turnId + text(' · Outside retained history', ' · 不在保留窗口')) + '</option>' : '');
      }
      node('TraceKind').value = filter.kind;
      node('TraceTurn').value = filter.turnId;
      node('TraceClear').textContent = text('Clear filters', '清除筛选');
      node('TraceCount').textContent = count + ' / ' + total + text(' retained records · Search does not fetch missing history.', ' 条保留记录 · 检索不会补取缺失历史。');
    } };
}

export function sessionToolsScript() {
  return 'window.hccReportedMetrics = (' + reportedMetrics.toString() + ');'
    + 'window.hccSessionCapabilities = (' + sessionCapabilities.toString() + ');'
    + 'window.hccContextReference = (' + contextReference.toString() + ');'
    + 'window.hccTraceMatches = (' + traceMatches.toString() + ');'
    + 'window.hccCreateSessionTools = (' + createSessionTools.toString() + ');'
    + 'window.hccCreateTraceFilter = (' + createTraceFilter.toString() + ');'
    + 'window.hccRenderReportedMetrics = (' + renderReportedMetrics.toString().replace('reportedMetrics(state?.metrics)', 'window.hccReportedMetrics(state?.metrics)') + ');';
}

export function installSessionTools() {
  window.hccReportedMetrics = reportedMetrics;
  window.hccSessionCapabilities = sessionCapabilities;
  window.hccContextReference = contextReference;
  window.hccTraceMatches = traceMatches;
  window.hccCreateSessionTools = createSessionTools;
  window.hccCreateTraceFilter = createTraceFilter;
  window.hccRenderReportedMetrics = renderReportedMetrics;
}

export const sessionToolsCss = `
  .session-tools,.session-metrics,.session-trace-tools { font-size:var(--small-font); color:var(--muted); margin:8px 0; }
  .session-tools summary,.session-metrics summary,.session-trace-tools summary { cursor:pointer; padding:5px 0; }
  .session-tools p,.session-metrics p,.session-trace-tools p { overflow-wrap:anywhere; margin:6px 0; }
  .session-tool-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:6px; }
  .session-tool-row input,.session-tool-row select { flex:1 1 150px; min-width:0; }
  .session-tool-row button { flex:0 0 auto; }
  .session-metrics dl { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:5px 12px; margin:6px 0; }
  .session-metrics dd { margin:0; color:var(--text); overflow-wrap:anywhere; }
`;
