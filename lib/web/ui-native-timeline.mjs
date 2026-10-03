import { safeMarkdownScript, installSafeMarkdown } from './ui-safe-markdown.mjs';
import { sessionToolsScript, installSessionTools } from './ui-session-tools.mjs';

// Normalize only facts supplied by the native adapters. In particular receipts
// do not contain prompt text, and a resumed executor does not replay history.
export function nativeTimeline(entries, provider = '') {
  const records = [], keyed = new Map(), streams = new Map(), outputShadows = new Map();
  const string = value => typeof value === 'string' ? value : '';
  const json = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const textParts = content => (Array.isArray(content) ? content : []).map(part =>
    part.type === 'text' ? string(part.text) : part.type === 'content' && part.content?.type === 'text' ? string(part.content.text) : '').filter(Boolean).join('\n');
  function put(key, next) {
    if (keyed.has(key)) { const record = keyed.get(key); const ids = record.eventIds || []; Object.assign(record, next); record.eventIds = [...new Set([...ids, next.eventId])]; }
    else { const record = { key, ...next, eventIds: [next.eventId] }; records.push(record); keyed.set(key, record); }
    return keyed.get(key);
  }
  for (const entry of entries.slice(-100)) {
    const event = entry.payload || entry, source = event.provider || provider;
    const association = event.turnId || event.submissionId || (event.parentToolUseId ? 'parent:' + event.parentToolUseId : 'event:' + entry.id);
    const scope = JSON.stringify([source, event.sessionId, association, event.parentToolUseId || '']);
    const base = { eventId: entry.id, scope, turnId: event.turnId || '', parentToolUseId: event.parentToolUseId || '', status: '' };
    const identity = event.itemId || event.messageId;
    function message(value, { delta = false, role = 'assistant', id = identity } = {}) {
      if (!value) return;
      const streamScope = scope + ':' + role, stream = streams.get(streamScope);
      const namedKey = id ? scope + ':message:' + id : null;
      // Claude assigns the message UUID only on its final message, whereas
      // Codex already supplies the item ID on each delta.
      const canFinishAnonymousStream = !delta && source === 'claude' && stream && !keyed.get(stream)?.explicitIdentity;
      const key = namedKey && !canFinishAnonymousStream ? namedKey : stream || namedKey || scope + ':message:event:' + entry.id;
      const previous = keyed.get(key);
      const record = put(key, { ...base, kind: 'message', role, streamed: delta, explicitIdentity: id || '', text: delta ? (previous?.text || '') + value : value });
      if (namedKey) keyed.set(namedKey, record);
      if (delta) streams.set(streamScope, key); else streams.delete(streamScope);
    }
    function endStreams() { for (const role of ['assistant', 'user', 'output']) streams.delete(scope + ':' + role); }
    if (['delta', 'output', 'message'].includes(event.type)) {
      // These providers' adapters emit assistant text. Unknown providers have
      // no inferred role. Explicit roles always take precedence.
      const role = event.role || (['codex', 'claude', 'dsh'].includes(source) ? 'assistant' : 'output');
      message(string(event.text), { delta: event.type !== 'message', role });
      if (source === 'dsh' && event.type === 'output') outputShadows.set(scope, string(event.text));
    } else if (event.type === 'session.update') {
      const update = event.update || {}, type = update.sessionUpdate;
      if (['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk'].includes(type)) {
        if (update.content?.type === 'text') {
          if (type === 'agent_thought_chunk') put(scope + ':thought:' + entry.id,
            { ...base, kind: 'reasoning', text: string(update.content.text) });
          else {
            const duplicateOutput = type === 'agent_message_chunk' && outputShadows.get(scope) === update.content.text;
            outputShadows.delete(scope);
            if (!duplicateOutput) message(string(update.content.text), { delta: true, role: type === 'user_message_chunk' ? 'user' : 'assistant', id: null });
          }
        }
      } else if (['tool_call', 'tool_call_update'].includes(type)) {
        endStreams();
        const key = scope + ':tool:' + (update.toolCallId || entry.id), previous = keyed.get(key) || {};
        const tool = { ...(previous.tool || {}), ...update };
        put(key, { ...base, kind: tool.kind === 'edit' ? 'files' : 'tool', title: tool.title || tool.kind || '',
          status: tool.status || '', text: textParts(tool.content), input: json(tool.rawInput), output: json(tool.rawOutput),
          changes: (Array.isArray(tool.content) ? tool.content : []).filter(part => part.type === 'diff').map(part => ({ path: part.path, diff: part.newText, oldText: part.oldText })), tool });
      } else if (type === 'plan') put(scope + ':plan', { ...base, kind: 'plan', text: json(update.entries) });
      else put(scope + ':event:' + entry.id, { ...base, kind: 'event', title: type || 'session.update', text: json(update) });
    } else if (event.type === 'item') {
      endStreams();
      const key = scope + ':item:' + (event.item?.id || entry.id);
      const item = { ...(keyed.get(key)?.item || {}), ...(event.item || {}) };
      put(key, { ...base, kind: item.type === 'fileChange' ? 'files' : 'tool',
        title: item.command || item.tool || item.type || '', status: item.status || event.phase || '',
        text: string(item.aggregatedOutput) || json(item.result), input: json(item.arguments),
        changes: Array.isArray(item.changes) ? item.changes : [], exitCode: item.exitCode, command: string(item.command), item });
    } else if (event.type === 'diff' || event.type === 'plan') {
      put(scope + ':' + event.type, { ...base, kind: event.type === 'diff' ? 'files' : 'plan',
        text: string(event.diff) || json(event.plan), explanation: string(event.explanation) });
    } else if (event.type === 'error') {
      put(scope + ':error:' + entry.id, { ...base, kind: 'error', title: event.code || event.error?.code || '',
        text: string(event.text) || string(event.message) || json(event.error) });
    } else if (event.type === 'completed') {
      const output = string(event.text), messages = records.filter(record => record.scope === scope && record.kind === 'message' && record.role === 'assistant');
      // Completion may repeat the final message (Codex/Claude) or the complete
      // concatenation of committed chunks (dsh). Do not print that reply twice.
      const duplicate = messages.some(record => record.text === output) ||
        messages.map(record => record.text).join('') === output || messages.map(record => record.text).join('\n\n') === output;
      if (output && !duplicate) {
        if (event.status === 'failed') put(scope + ':completion-error:' + entry.id, { ...base, kind: 'error', text: output });
        else {
          // dsh completion contains the full accumulated turn text; the event
          // window may have evicted early chunks. Replace surviving fragments
          // instead of showing those fragments again beside the full answer.
          if (source === 'dsh') {
            for (let index = records.length - 1; index >= 0; index--) {
              const record = records[index];
              if (record.scope === scope && record.kind === 'message' && record.role === 'assistant' && record.streamed) records.splice(index, 1);
            }
            endStreams();
          }
          message(output, { id: 'completion:' + entry.id });
        }
      }
      endStreams();
      put(scope + ':completion:' + entry.id, { ...base, kind: 'status', terminal: true, status: event.status || '', text: event.stopReason || '' });
    } else if (event.type === 'status' || event.type === 'opened' || event.type === 'closed') {
      put(scope + ':status:' + entry.id, { ...base, kind: 'status', status: event.status || event.type, text: '' });
    } else if (!['queued', 'account', 'usage', 'metadata', 'approval', 'interaction.pending', 'interaction.resolved', 'interaction.expired', 'permission', 'interrupt.requested'].includes(event.type)) {
      put(scope + ':event:' + entry.id, { ...base, kind: 'event', title: event.type || '', text: json(event) });
    }
  }
  return records;
}

export function nativeTimelineScript() {
  return sessionToolsScript() + safeMarkdownScript() + 'window.hccNativeTimelineModel = (' + nativeTimeline.toString() + ');'
    + 'window.hccNativeTimelineView = (' + createNativeTimelineView.toString() + ');';
}

export function installNativeTimeline() {
  installSafeMarkdown(); installSessionTools();
  window.hccNativeTimelineModel = nativeTimeline;
  window.hccNativeTimelineView = createNativeTimelineView;
}

export function createNativeTimelineView({ document, window, escape, text }) {
  const byId = id => document.getElementById(id), container = byId('nativeEvents'), scroll = byId('nativeScroll');
  const markdown = window.hccSafeMarkdown(escape), views = new Map();
  let scope = '', currentEntries = [], currentState = {}, html = '', copies = [], blocks = [];
  const traceFilter = window.hccCreateTraceFilter({ document, prefix: 'native', text, escape, changed: () => {
    if (!scope) return;
    view().top = 0; view().follow = false; render(currentEntries, currentState, scope); scroll.scrollTop = 0;
  } });
  const view = () => views.get(scope);
  const pinned = () => !Number.isFinite(scroll.scrollHeight) || scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
  function remember() {
    if (!view()) return;
    view().top = scroll.scrollTop || 0;
    for (const node of container.querySelectorAll('details[data-native-detail]')) {
      if (node.dataset.nativeDetail) view().details.set(node.dataset.nativeDetail, node.open);
    }
    for (const node of container.querySelectorAll('pre[data-native-code]')) {
      if (node.dataset.nativeCode) view().codeScroll.set(node.dataset.nativeCode, { top: node.scrollTop, left: node.scrollLeft });
    }
    for (const id of ['nativeIdentityDetails', 'nativeReceiptsDetails']) view().details.set(id, Boolean(byId(id).open));
    for (const map of [view().details, view().pages, view().codeScroll]) while (map.size > 256) map.delete(map.keys().next().value);
  }
  function choose(next) {
    if (scope === next) return;
    remember(); scope = next; html = ''; copies = []; blocks = []; traceFilter.reset(next);
    if (!views.has(scope)) views.set(scope, { mode: 'conversation', top: 0, follow: true, details: new Map(), pages: new Map(), codeScroll: new Map() });
    while (views.size > 20) views.delete(views.keys().next().value);
    for (const id of ['nativeIdentityDetails', 'nativeReceiptsDetails']) byId(id).open = view().details.get(id) || false;
    scroll.scrollTop = view().top;
  }
  function ranges(value) {
    const result = [];
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 12000, value.length), lines = 0;
      for (let i = start; i < end; i++) if (value[i] === '\n' && ++lines === 200) { end = i + 1; break; }
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
      result.push([start, end]); start = end;
    }
    return result.length ? result : [[0, 0]];
  }
  function code(value, identity, label = '') {
    const content = String(value ?? ''), parts = ranges(content), page = Math.min(view().pages.get(identity) || 0, parts.length - 1);
    const index = copies.push(content) - 1;
    blocks[index] = { identity, pages: parts.length, page };
    return '<div class="native-content-actions"><span>' + escape(label || text('Text', '文本')) + '</span>'
      + '<button type="button" data-native-copy="' + index + '">' + escape(text('Copy full text', '复制全文')) + '</button>'
      + (parts.length > 1 ? '<button type="button" data-native-page="' + index + '" data-step="-1"' + (page ? '' : ' disabled') + '>' + escape(text('Previous', '上一段')) + '</button>'
        + '<span>' + (page + 1) + ' / ' + parts.length + '</span><button type="button" data-native-page="' + index + '" data-step="1"' + (page + 1 < parts.length ? '' : ' disabled') + '>' + escape(text('Next', '下一段')) + '</button>' : '')
      + '</div><pre tabindex="0" data-native-code="' + escape(identity) + '"><code>' + escape(content.slice(...parts[page])) + '</code></pre>';
  }
  function prose(value, identity) {
    if (ranges(value).length > 1) return code(value, identity, text('Long message · Plain-text sections', '长消息 · 纯文本分段'));
    const fence = String.fromCharCode(96).repeat(3), parts = value.split('\n');
    let plain = [], source = [], language = '', inCode = false, result = '', block = 0;
    const flush = () => { if (plain.length) result += markdown(plain.join('\n')); plain = []; };
    for (const line of parts) {
      if (line.trimStart().startsWith(fence)) {
        if (inCode) { result += code(source.join('\n'), identity + ':' + block++, language); source = []; }
        else { flush(); language = line.trimStart().slice(3).trim(); }
        inCode = !inCode;
      } else (inCode ? source : plain).push(line);
    }
    if (inCode) result += code(source.join('\n'), identity + ':' + block++, language);
    flush(); return result;
  }
  function details(identity, label, body, status = '') {
    // User disclosure state is restored on the DOM after a content update. It
    // must not alter the cached markup for an otherwise unchanged snapshot.
    return '<details data-native-detail="' + escape(identity) + '"><summary>' + escape(label)
      + (status ? '<small>' + escape(status) + '</small>' : '') + '</summary>' + body + '</details>';
  }
  function card(record) {
    const identity = record.key, labels = { tool: text('Tool / command', '工具 / 命令'), files: text('File changes', '文件变更'), plan: text('Plan', '计划'), reasoning: text('Reasoning', '推理'), error: text('Error', '错误'), event: text('Other event', '其他事件') };
    const locate = '<button type="button" data-native-locate="' + escape(record.eventId) + '">' + escape(text('Locate event #', '定位事件 #') + record.eventId) + '</button>';
    if (record.kind === 'status') return record.terminal ? '<p class="native-meta" data-native-card="' + escape(identity) + '">' + escape(text('Turn status: ', '回合状态：') + (record.status || text('Not reported', '未报告')) + (record.text ? ' · ' + record.text : '')) + ' ' + locate + '</p>' : '';
    const role = record.role === 'user' ? text('You', '你') : record.role === 'assistant'
      ? (record.parentToolUseId ? text('Assistant · Subtask', '助手 · 子任务') : text('Assistant', '助手')) : text('Executor output', '执行器输出');
    let body;
    if (record.kind === 'message') body = '<h4>' + escape(role) + '</h4>' + prose(record.text, identity);
    else {
      const content = (record.explanation ? prose(record.explanation, identity + ':explanation') : '')
        + (record.command ? code(record.command, identity + ':command', text('Command', '命令')) : '')
        + (record.text ? code(record.text, identity + ':text', labels[record.kind]) : '')
        + (record.input ? code(record.input, identity + ':input', text('Input', '输入')) : '')
        + (record.output ? code(record.output, identity + ':output', text('Output', '输出')) : '')
        + (record.exitCode != null ? '<p>' + escape(text('Exit code: ', '退出码：') + record.exitCode) + '</p>' : '')
        + (record.changes || []).map((change, index) => '<h4>' + escape(change.path || text('File', '文件')) + '</h4>'
          + (change.oldText != null ? code(change.oldText, identity + ':old:' + index, text('Before', '修改前')) : '')
          + code(change.diff || '', identity + ':diff:' + index, change.oldText != null ? text('After', '修改后') : text('Reported diff', '报告的差异'))).join('');
      body = record.kind === 'error' ? '<h4>' + escape(labels.error) + '</h4>' + content
        : details(identity, labels[record.kind] + (record.title ? ' · ' + String(record.title).slice(0, 180) : ''), content, record.status);
    }
    return '<article class="native-event native-event-' + escape(record.kind) + (record.role === 'user' ? ' native-event-user' : '') + '" data-native-card="' + escape(identity) + '">' + body + '<div class="native-content-actions">' + locate + '</div></article>';
  }
  function render(entries, state, nextScope) {
    const changedScope = scope !== nextScope;
    if (!changedScope) remember();
    choose(nextScope); currentEntries = entries; currentState = state;
    const reading = view(); copies = []; blocks = [];
    const normalized = window.hccNativeTimelineModel(entries, state.provider);
    const filtered = normalized.filter(record => window.hccTraceMatches(record, traceFilter.value()));
    const matches = new Set(filtered.flatMap(record => record.eventIds || [record.eventId]));
    const trace = entries.filter(entry => matches.has(entry.id) || window.hccTraceMatches({ turnId: (entry.payload || entry).turnId,
      kind: (entry.payload || entry).type === 'error' ? 'error' : 'event', status: (entry.payload || entry).status,
      text: JSON.stringify(entry.payload || entry) }, traceFilter.value()));
    traceFilter.render(entries.map(entry => (entry.payload || entry).turnId), reading.mode === 'trace' ? trace.length : filtered.length, reading.mode === 'trace' ? entries.length : normalized.length);
    const next = (reading.mode === 'trace' ? trace.map(entry => '<article class="native-event" data-native-trace-id="' + escape(entry.id) + '">' + details('trace:' + entry.id,
      '#' + entry.id + ' · ' + (entry.payload?.type || entry.type || text('Event', '事件')), code(JSON.stringify(entry.payload || entry, null, 2), 'trace:' + entry.id))
      + (normalized.some(record => record.eventIds?.includes(entry.id)) ? '<button type="button" data-native-result="' + escape(entry.id) + '">' + escape(text('Locate result', '定位结果')) + '</button>' : '') + '</article>').join('')
      : filtered.map(card).join('')) || '<p class="native-meta">' + escape(entries.length ? text('No matching retained records.', '保留记录中没有匹配项。') : text('No retained output yet.', '暂无保留的输出。')) + '</p>';
    if (html !== next) {
      container.innerHTML = next; html = next;
      for (const node of container.querySelectorAll('details[data-native-detail]')) {
        node.open = reading.details.get(node.dataset.nativeDetail) || false;
      }
      for (const node of container.querySelectorAll('pre[data-native-code]')) {
        const saved = reading.codeScroll.get(node.dataset.nativeCode);
        if (saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
      }
    }
    const bounds = entries.length ? '#' + entries[0].id + '–#' + entries[entries.length - 1].id : '0';
    byId('nativeHistoryRange').textContent = text('Retained events ', '保留事件 ') + bounds + ' · ' + entries.length + '/100 · '
      + text('Recent window, not a full transcript. Submitted prompts may be absent.', '最近事件窗口，非完整会话；可能不含提交的原文。');
    for (const [id, mode] of [['nativeConversation', 'conversation'], ['nativeTrace', 'trace']]) {
      byId(id).textContent = mode === 'conversation' ? text('Conversation', '对话') : text('Event trace', '事件轨迹');
      byId(id).setAttribute?.('aria-pressed', String(reading.mode === mode));
    }
    byId('nativeIdentityLabel').textContent = text('Executor details', '执行器详情');
    byId('nativeReceiptsLabel').textContent = text('Delivery receipts', '投递回执') + ' · ' + (state.deliveries || []).length;
    const count = (state.pendingApprovals || []).length;
    byId('nativeApprovalJump').hidden = !count;
    byId('nativeApprovalJump').textContent = text('Needs your response', '等待你的答复') + ' · ' + count;
    byId('nativeJump').textContent = text('Back to latest', '回到最新');
    byId('nativeJumpBar').hidden = reading.follow;
    scroll.scrollTop = reading.follow ? scroll.scrollHeight : reading.top;
  }
  for (const [id, mode] of [['nativeConversation', 'conversation'], ['nativeTrace', 'trace']]) byId(id).addEventListener('click', () => {
    if (!scope) return;
    remember(); view().mode = mode; view().top = 0; view().follow = false;
    render(currentEntries, currentState, scope); scroll.scrollTop = 0; view().top = 0;
  });
  scroll.addEventListener('scroll', () => {
    if (!view() || !currentEntries.length) return;
    view().follow = pinned(); view().top = scroll.scrollTop; byId('nativeJumpBar').hidden = view().follow;
  });
  byId('nativeJump').addEventListener('click', () => { if (view()) { view().follow = true; scroll.scrollTop = scroll.scrollHeight; byId('nativeJumpBar').hidden = true; } });
  byId('nativeApprovalJump').addEventListener('click', () => {
    scroll.scrollTop = 0;
    byId('nativeApprovals').querySelector?.('input,select,textarea,button')?.focus();
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest?.('button');
    if (!button || !container.contains?.(button)) return;
    if (button.dataset.nativeLocate !== undefined || button.dataset.nativeResult !== undefined) {
      const toTrace = button.dataset.nativeLocate !== undefined, id = Number(toTrace ? button.dataset.nativeLocate : button.dataset.nativeResult);
      remember(); view().follow = false; view().mode = toTrace ? 'trace' : 'conversation';
      traceFilter.clear();
      const record = toTrace ? null : window.hccNativeTimelineModel(currentEntries, currentState.provider).find(item => item.eventIds?.includes(id));
      if (toTrace) view().details.set('trace:' + id, true);
      else if (record) view().details.set(record.key, true);
      render(currentEntries, currentState, scope);
      const target = [...container.querySelectorAll(toTrace ? '[data-native-trace-id]' : '[data-native-card]')].find(node => toTrace ? Number(node.dataset.nativeTraceId) === id : node.dataset.nativeCard === record?.key);
      if (target) { target.scrollIntoView?.({ block: 'center' }); target.setAttribute?.('tabindex', '-1'); target.focus?.({ preventScroll: true }); view().top = scroll.scrollTop; }
    } else if (button.dataset.nativeCopy !== undefined) {
      try { await window.navigator.clipboard.writeText(copies[Number(button.dataset.nativeCopy)]); button.textContent = text('Copied', '已复制'); }
      catch { button.textContent = text('Select text to copy', '请选择文本复制'); }
    } else if (button.dataset.nativePage !== undefined) {
      const block = blocks[Number(button.dataset.nativePage)];
      if (!block) return;
      remember(); view().follow = false;
      view().pages.set(block.identity, Math.max(0, Math.min(block.pages - 1, block.page + Number(button.dataset.step))));
      view().codeScroll.delete(block.identity);
      render(currentEntries, currentState, scope);
      const next = container.querySelector?.('[data-native-page="' + button.dataset.nativePage + '"][data-step="' + button.dataset.step + '"]:not(:disabled)')
        || container.querySelector?.('[data-native-code]');
      next?.focus({ preventScroll: true });
    }
  });
  return { render, reset(nextScope) { render([], {}, nextScope); } };
}

export const nativeTimelineCss = `
  .native-header-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .native-header-top strong { flex:1; min-width:0; }
  .native-navigation { display:flex; gap:6px; align-items:center; margin:10px 0 0; }
  .native-navigation button[aria-pressed=true] { color:var(--accent); border-color:var(--accent); }
  .native-history-range { margin:8px 0 0; color:var(--muted); font-size:var(--small-font); }
  .native-event { max-width:900px; margin:10px auto; padding:14px; border:1px solid var(--border); border-radius:8px; background:var(--panel); }
  .native-event-message { border:0; padding:10px 2px; background:transparent; }
  .native-event-user { padding:14px; background:var(--panel-2); border:1px solid var(--border); }
  .native-event-error { border-color:var(--danger); }
  .native-event h4 { margin:0 0 8px; font-size:var(--small-font); color:var(--muted); }
  .native-event details summary { cursor:pointer; overflow-wrap:anywhere; line-height:1.6; }
  .native-event details summary small { display:block; color:var(--muted); }
  .native-event .codex-prose { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.7; }
  .native-event pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0; padding:10px; max-height:340px; overflow:auto; background:var(--panel-2); border-radius:6px; }
  .native-event blockquote { margin-left:0; padding-left:12px; border-left:3px solid var(--border); color:var(--muted); }
  .native-reading-jump { padding:6px; text-align:center; border-top:1px solid var(--border); }
  .native-meta { color:var(--muted); font-size:var(--small-font); margin:10px 0; }
  .native-meta summary { cursor:pointer; padding:5px 0; }
  .native-meta p { overflow-wrap:anywhere; }
  .native-content-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  .native-content-actions span { color:var(--muted); font-size:var(--small-font); }
  @media(max-width:640px) { .native-header,.native-composer { padding:10px 12px; } .native-scroll { padding:0 12px 10px; } .native-navigation button,.native-content-actions button { min-height:40px; } }
`;
