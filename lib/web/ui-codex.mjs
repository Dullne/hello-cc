import { interactionPanelScript } from './ui-interactions.mjs';

export function codexPanelHtml() {
  return `<style>
    #codexPanel { flex:1; min-height:0; min-width:0; overflow:hidden; }
    #codexPanel:not([hidden]) { display:flex; flex-direction:column; }
    #codexPanel[hidden] { display:none; }
    .codex-header { flex:none; display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--border); }
    #codexStatus { color:var(--muted); font-size:var(--small-font); overflow-wrap:anywhere; }
    #codexApprovalJump { flex:none; margin-left:auto; color:var(--warn); border-color:var(--warn); }
    .codex-history { flex:none; display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--border); }
    .codex-history[hidden] { display:none; }
    .codex-history span { color:var(--muted); font-size:var(--small-font); }
    .codex-history button { min-height:36px; }
    .codex-scroll { flex:1; min-height:0; overflow:auto; padding:0 16px 16px; overflow-anchor:none; scrollbar-gutter:stable; }
    .codex-turn { max-width:900px; margin:20px auto 0; }
    .codex-turn-heading { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:var(--small-font); margin-bottom:10px; }
    .codex-turn-heading span:last-child { margin-left:auto; }
    .codex-card { padding:12px 14px; margin:8px 0; border:1px solid var(--border); border-radius:10px; background:var(--card-bg); min-width:0; }
    .codex-card-user { background:var(--panel-2); border-left:3px solid var(--accent); }
    .codex-card-agent { border-color:transparent; background:transparent; padding-left:2px; padding-right:2px; }
    .codex-card-error { border-color:var(--danger); }
    .codex-card-heading { font-size:var(--small-font); color:var(--muted); display:flex; gap:10px; align-items:center; margin-bottom:8px; }
    .codex-card-heading strong { color:var(--text); font-weight:600; }
    .codex-status { margin-left:auto; flex:none; color:var(--muted); }
    .codex-status-failed { color:var(--danger); }
    .codex-prose { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; margin:8px 0; }
    .codex-markdown { line-height:1.65; overflow-wrap:anywhere; }
    .codex-markdown h1, .codex-markdown h2, .codex-markdown h3, .codex-markdown h4, .codex-markdown h5, .codex-markdown h6 { line-height:1.4; margin:16px 0 8px; font-weight:600; }
    .codex-markdown h1 { font-size:22px; } .codex-markdown h2 { font-size:19px; } .codex-markdown h3 { font-size:17px; }
    .codex-markdown h4, .codex-markdown h5, .codex-markdown h6 { font-size:var(--body-font); }
    .codex-markdown ul, .codex-markdown ol { margin:8px 0; padding-left:24px; }
    .codex-markdown li { padding-left:2px; margin:4px 0; }
    .codex-markdown blockquote { margin:10px 0; padding:4px 12px; border-left:3px solid var(--border); color:var(--muted); }
    .codex-markdown :not(pre) > code { font-family:var(--mono); font-size:.92em; padding:2px 5px; border-radius:4px; background:var(--panel-2); }
    .codex-tool > summary, .codex-review > summary { cursor:pointer; display:flex; align-items:center; gap:8px; overflow-wrap:anywhere; }
    .codex-tool > summary::before, .codex-review > summary::before { content:"›"; color:var(--muted); }
    .codex-tool[open] > summary::before, .codex-review[open] > summary::before { content:"⌄"; }
    .codex-tool > summary strong { flex:none; font-size:var(--small-font); }
    .codex-tool-preview { color:var(--muted); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; min-width:0; flex:1; font-family:var(--mono); font-size:var(--small-font); }
    .codex-code { border:1px solid var(--border); border-radius:8px; overflow:hidden; margin:10px 0; background:var(--input-bg); }
    .codex-code-header { display:flex; align-items:center; justify-content:space-between; padding:4px 8px; color:var(--muted); font-size:var(--small-font); border-bottom:1px solid var(--border); }
    .codex-code-header button { font-size:var(--small-font); min-height:28px; padding:3px 8px; }
    .codex-code pre { margin:0; padding:10px 12px; overflow:auto; white-space:pre; font-family:var(--mono); font-size:var(--small-font); line-height:1.6; }
    .codex-segment-nav { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--border); }
    .codex-segment-nav button { min-height:32px; font-size:var(--small-font); padding:4px 8px; }
    .codex-segment-nav span { color:var(--muted); font-size:var(--small-font); margin-right:auto; }
    .codex-code [data-segment-content] pre { max-height:360px; }
    .codex-code-prose pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:inherit; font-size:var(--body-font); }
    .codex-diff-add { color:var(--ok); } .codex-diff-remove { color:var(--danger); } .codex-diff-header { color:var(--accent); }
    .codex-review { max-width:900px; margin:16px auto 0; border-top:1px solid var(--border); padding-top:12px; }
    .codex-review h3 { font-size:var(--small-font); margin:14px 0 6px; }
    .codex-plan { list-style:none; padding:0; margin:8px 0; display:grid; gap:8px; }
    .codex-plan li { display:flex; gap:10px; align-items:baseline; overflow-wrap:anywhere; }
    .codex-plan li span:first-child { min-width:72px; color:var(--muted); font-size:var(--small-font); }
    .codex-plan li[data-status="completed"] span:first-child { color:var(--ok); }
    .codex-plan li[data-status="inProgress"] span:first-child { color:var(--accent); }
    .codex-approval { max-width:900px; margin:16px auto; border-color:var(--warn); }
    .codex-approval h3 { margin:0 0 10px; font-size:var(--body-font); color:var(--warn); }
    .codex-approval dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 12px; margin:10px 0; }
    .codex-approval dt { color:var(--muted); font-size:var(--small-font); } .codex-approval dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
    .hcc-interaction-form { display:grid; gap:10px; margin:12px 0; }
    .hcc-interaction-form label { display:grid; gap:5px; overflow-wrap:anywhere; }
    .hcc-interaction-form label:has(input[type=checkbox]) { display:flex; align-items:flex-start; }
    .hcc-interaction-form input:not([type=checkbox]), .hcc-interaction-form select { width:100%; min-height:36px; min-width:0; background:var(--input-bg); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px; }
    .hcc-mcp-field { min-width:0; border:1px solid var(--border); border-radius:6px; padding:10px; }
    .hcc-mcp-field legend,.hcc-mcp-field p { overflow-wrap:anywhere; }
    .hcc-mcp-field small { color:var(--muted); }
    .hcc-mcp-field .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    .codex-approval-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .codex-jump { flex:none; text-align:center; padding:6px; border-top:1px solid var(--border); }
    .codex-composer { flex:none; padding:12px 16px; border-top:1px solid var(--border); background:var(--panel); max-height:40%; overflow:auto; }
    .codex-composer-inner { max-width:900px; margin:auto; }
    .codex-composer label { display:block; color:var(--muted); font-size:var(--small-font); margin-bottom:6px; }
    #codexDraft { display:block; width:100%; box-sizing:border-box; font:inherit; color:var(--text); background:var(--input-bg); border:1px solid var(--border); border-radius:8px; padding:10px; resize:vertical; min-height:64px; max-height:180px; }
    .codex-composer-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    #codexSubmission { font-size:var(--small-font); color:var(--muted); margin:8px 0 0; overflow-wrap:anywhere; }
    #codexSubmission:empty { display:none; }
    @media (max-width:640px) {
      .codex-header, .codex-scroll, .codex-composer { padding-left:12px; padding-right:12px; }
      .codex-card { padding:10px; } .codex-card-agent { padding:2px; }
      .codex-composer-actions button { min-height:36px; }
      .codex-segment-nav span { flex-basis:100%; }
      .codex-segment-nav button { min-height:44px; flex:1; }
      .codex-approval dl { grid-template-columns:1fr; gap:3px; } .codex-approval dd { margin-bottom:6px; }
    }
  </style>
  <section id="codexPanel" hidden aria-label="Codex">
    <header class="codex-header"><div id="codexStatus" role="status"></div><button id="codexApprovalJump" type="button" hidden>Approval required</button></header>
    <nav id="codexHistory" class="codex-history" hidden aria-label="Conversation history"><button id="codexEarlier" type="button" aria-controls="codexTimeline">Earlier</button><span id="codexHistoryRange" role="status"></span><button id="codexLater" type="button" aria-controls="codexTimeline">Newer</button></nav>
    <div id="codexScroll" class="codex-scroll" tabindex="0" aria-label="Conversation">
      <div id="codexApprovals" aria-live="polite"></div>
      <div id="codexTimeline"></div>
      <details id="codexReview" class="codex-review" hidden data-details-key="review"><summary id="codexReviewLabel">Latest turn changes and plan</summary><div id="codexPlan"></div><div id="codexDiff"></div></details>
    </div>
    <div id="codexJumpBar" class="codex-jump" hidden><button id="codexJump" type="button">Back to latest</button></div>
    <footer class="codex-composer"><div class="codex-composer-inner">
      <label for="codexDraft" id="codexDraftLabel">Message saved in this browser</label>
      <textarea id="codexDraft" rows="3"></textarea>
      <div class="codex-composer-actions">
        <button id="codexSend" class="primary" type="button">Send</button><button id="codexInterrupt" type="button">Interrupt turn</button>
        <button id="codexRecover" type="button">Read current state</button><button id="codexClear" type="button">Clear draft</button>
      </div><p id="codexSubmission" role="status"></p>
    </div></footer>
  </section>`;
}

export function codexPanelScript() {
  return interactionPanelScript() + String.raw`(() => {
    const panel = document.getElementById('codexPanel');
    const draft = document.getElementById('codexDraft');
    const scroller = document.getElementById('codexScroll');
    const views = new Map();
    const approving = new Set();
    const PAGE_SIZE = 80;
    const SEGMENT_CHARS = 12000, SEGMENT_LINES = 200;
    let copies = [], timelineHtml = '', timelineSignature = '', timelineCopies = [], entries = [];
    let blocks = [], timelineBlocks = [], blockScope = '', blockOrder = 0;
    let state = null, key = '', pending = null, submitting = false;
    let stateRevision = 0, subjectRevision = 0, readSequence = 0;
    const text = (en, zh) => window.hccUi.language === 'zh' ? zh : en;
    const bridge = () => window.hccHandoff;
    const escape = (value) => bridge().esc(String(value ?? ''));
    function draftKey() { return 'hcc.codexDraft:' + bridge().projectRoot + ':' + bridge().active + (bridge().draftScope ? ':' + bridge().draftScope : ''); }
    function subject() { const b = bridge(); return { root: b.projectRoot, id: b.active, key: draftKey(), token: b.actionToken, epoch: b.epoch }; }
    function matches(target) { return target.root === bridge().projectRoot && target.id === bridge().active; }
    function route(target, name) { return '/api/sessions/' + encodeURIComponent(target.id) + '/codex/' + name + '?root=' + encodeURIComponent(target.root); }
    function approvalKey(target, executorId, requestId) { return JSON.stringify([target.root, target.id, executorId, requestId]); }
    function save() { window.hccUi.safeSet(key, JSON.stringify({ text: draft.value, pending })); }
    function message(value) { document.getElementById('codexSubmission').textContent = value; }
    function activeThread() { return state?.threads?.find(t => t.id === (state.currentThreadId || state.threadId)) || state?.threads?.[0]; }
    function turnId() { return state?.turnId || activeThread()?.activeTurnId || ''; }
    function view() {
      if (!views.has(key)) {
        views.set(key, { top: 0, follow: true, unread: false, signature: '', details: new Map(), textPages: new Map(), codeScroll: new Map(), startKey: '', start: 0, end: 0, total: 0 });
        if (views.size > 20) views.delete(views.keys().next().value);
      }
      return views.get(key);
    }
    function pinned() { return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 48; }
    function updateJump() {
      document.getElementById('codexJumpBar').hidden = view().follow;
      document.getElementById('codexJump').textContent = view().unread
        ? text('New updates · Back to latest', '有新内容 · 回到最新')
        : text('Back to latest', '回到最新');
    }
    function statusLabel(value) {
      const status = typeof value === 'object' ? value?.type : value;
      const labels = {
        completed: text('Completed', '已完成'), failed: text('Failed', '失败'),
        interrupted: text('Interrupted', '已中断'), inProgress: text('Running', '进行中'),
        pending: text('Pending', '待处理'), ready: text('Ready', '就绪'),
        idle: text('Idle', '空闲'), active: text('Active', '活跃'),
        starting: text('Starting', '启动中'), stopped: text('Stopped', '已停止'),
        exited: text('Exited', '已退出'), disconnected: text('Disconnected', '已断开'),
        new: text('Not started', '未启动'), connecting: text('Connecting', '连接中'), closed: text('Closed', '已关闭'),
        notLoaded: text('Not loaded', '未加载'), systemError: text('System error', '系统错误'),
        declined: text('Declined', '已拒绝'), error: text('Error', '错误')
      };
      return labels[status] || String(status || '');
    }
    function segmentRanges(content) {
      const ranges = [];
      let start = 0;
      while (start < content.length) {
        let end = Math.min(content.length, start + SEGMENT_CHARS), cursor = start;
        for (let lines = 0; lines < SEGMENT_LINES; lines += 1) {
          const newline = content.indexOf('\n', cursor);
          if (newline === -1 || newline >= end) break;
          cursor = newline + 1;
          if (lines === SEGMENT_LINES - 1) end = cursor;
        }
        // A page boundary must not split an emoji or another surrogate pair.
        if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end -= 1;
        ranges.push([start, end]); start = end;
      }
      return ranges;
    }
    function codeBody(content, diff) {
      return diff ? content.split('\n').map(line => {
        const cls = line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')
          ? 'codex-diff-header' : line.startsWith('+') ? 'codex-diff-add' : line.startsWith('-') ? 'codex-diff-remove' : '';
        return '<span class="' + cls + '">' + escape(line) + '</span>';
      }).join('\n') : escape(content);
    }
    function segmentBody(block, index) {
      const [start, end] = block.ranges[block.page];
      const button = (action, label, disabled) => '<button type="button" data-segment="' + index + '" data-segment-action="' + action + '"'
        + (disabled ? ' disabled' : '') + '>' + escape(label) + '</button>';
      return '<nav class="codex-segment-nav" aria-label="' + escape(text('Text sections', '内容分段')) + '"><span role="status" tabindex="-1">'
        + escape(text('Section ', '第 ') + (block.page + 1) + text(' of ', ' / ') + block.ranges.length + text(' · Full text available', ' 段 · 可查阅全文'))
        + '</span>' + button('first', text('First', '首段'), block.page === 0)
        + button('previous', text('Previous', '上一段'), block.page === 0)
        + button('next', text('Next', '下一段'), block.page === block.ranges.length - 1)
        + button('last', text('Last', '末段'), block.page === block.ranges.length - 1)
        + '</nav><pre tabindex="0" data-code-page="' + block.page + '"><code>' + codeBody(block.content.slice(start, end), block.diff) + '</code></pre>';
    }
    function codeBlock(value, language = '', diff = false, plain = false, identityScope = '') {
      const content = String(value ?? ''), index = copies.push(content) - 1;
      const ranges = segmentRanges(content), identity = identityScope || blockScope + ':' + blockOrder++;
      let body, blockIndex = -1;
      if (ranges.length > 1) {
        blockIndex = blocks.length;
        const page = Math.min(view().textPages.get(identity) || 0, ranges.length - 1);
        const block = { content, ranges, diff, page, identity };
        blocks.push(block);
        body = '<div data-segment-content>' + segmentBody(block, blockIndex) + '</div>';
      } else body = '<pre data-code-page="0"><code>' + codeBody(content, diff) + '</code></pre>';
      return '<div class="codex-code' + (plain ? ' codex-code-prose' : '') + '" data-code-key="' + escape(identity) + '"' + (blockIndex < 0 ? '' : ' data-segment-block="' + blockIndex + '"')
        + '><div class="codex-code-header"><span>' + escape(language || text('Text', '文本'))
        + '</span><button type="button" data-copy="' + index + '">' + escape(ranges.length > 1 ? text('Copy full text', '复制全文') : text('Copy', '复制'))
        + '</button></div>' + body + '</div>';
    }
    function inline(value, allowBold = true) {
      const tick = String.fromCharCode(96), source = String(value), fragments = [];
      let index = 0, plain = '';
      const flush = () => { if (plain) fragments.push(escape(plain)); plain = ''; };
      const codeEnd = start => {
        const end = source.indexOf(tick, start + 1), newline = source.indexOf('\n', start + 1);
        return end > start + 1 && (newline === -1 || end < newline) ? end : -1;
      };
      while (index < source.length) {
        if (source[index] === tick && codeEnd(index) !== -1) {
          const end = codeEnd(index);
          flush(); fragments.push('<code>' + escape(source.slice(index + 1, end)) + '</code>'); index = end + 1;
          continue;
        }
        const marker = source.slice(index, index + 2);
        if (allowBold && (marker === '**' || marker === '__')) {
          let end = index + 2;
          while (end < source.length && source[end] !== '\n') {
            // Code spans are opaque: bold markers inside them are literal text.
            if (source[end] === tick && codeEnd(end) !== -1) { end = codeEnd(end) + 1; continue; }
            if (source.startsWith(marker, end)) break;
            end += 1;
          }
          if (end > index + 2 && source.startsWith(marker, end)) {
            flush(); fragments.push('<strong>' + inline(source.slice(index + 2, end), false) + '</strong>'); index = end + 2;
            continue;
          }
        }
        plain += source[index]; index += 1;
      }
      flush(); return fragments.join('');
    }
    function markdown(value) {
      const lines = String(value).split('\n'), parts = [];
      let paragraph = [], list = [], listType = '', listStart = '', quote = [];
      const flushParagraph = () => { if (paragraph.length) parts.push('<p class="codex-prose">' + inline(paragraph.join('\n')) + '</p>'); paragraph = []; };
      const flushList = () => {
        if (list.length) parts.push('<' + listType + (listType === 'ol' && listStart !== '1' ? ' start="' + listStart + '"' : '') + '>'
          + list.map(line => '<li>' + inline(line) + '</li>').join('') + '</' + listType + '>');
        list = []; listType = ''; listStart = '';
      };
      const flushQuote = () => { if (quote.length) parts.push('<blockquote>' + quote.map(line => inline(line)).join('<br>') + '</blockquote>'); quote = []; };
      for (const line of lines) {
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(line);
        const ordered = /^\s{0,3}(\d{1,9})[.)]\s+(.+)$/.exec(line);
        const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (heading) {
          flushParagraph(); flushList(); flushQuote();
          const tag = 'h' + heading[1].length;
          parts.push('<' + tag + '>' + inline(heading[2].replace(/\s+#+\s*$/, '')) + '</' + tag + '>');
        } else if (unordered || ordered) {
          flushParagraph(); flushQuote();
          const nextType = unordered ? 'ul' : 'ol';
          if (listType && listType !== nextType) flushList();
          if (!listType) { listType = nextType; listStart = ordered ? String(Number(ordered[1])) : ''; }
          list.push(unordered ? unordered[1] : ordered[2]);
        } else if (quoted) {
          flushParagraph(); flushList(); quote.push(quoted[1]);
        } else {
          flushList(); flushQuote();
          if (!line.trim()) flushParagraph();
          else paragraph.push(line);
        }
      }
      flushParagraph(); flushList(); flushQuote();
      return '<div class="codex-markdown">' + parts.join('') + '</div>';
    }
    function prose(value) {
      const content = String(value ?? '');
      if (segmentRanges(content).length > 1) return codeBlock(content, text('Long message · Plain-text sections', '长消息 · 纯文本分段'), false, true);
      const fence = String.fromCharCode(96).repeat(3), lines = content.split('\n');
      let html = '', plain = [], code = [], language = '', inCode = false;
      const flush = () => { if (plain.length) html += markdown(plain.join('\n')); plain = []; };
      for (const line of lines) {
        if (line.trimStart().startsWith(fence)) {
          if (inCode) { html += codeBlock(code.join('\n'), language); code = []; }
          else { flush(); language = line.trimStart().slice(3).trim(); }
          inCode = !inCode;
        } else if (inCode) code.push(line);
        else plain.push(line);
      }
      if (inCode) html += codeBlock(code.join('\n'), language);
      flush(); return html;
    }
    function details(id, summary, content, defaultOpen = false, cls = 'codex-tool') {
      const open = view().details.has(id) ? view().details.get(id) : defaultOpen;
      return '<details class="' + cls + '" data-details-key="' + escape(id) + '"' + (open ? ' open' : '')
        + '><summary>' + summary + '</summary>' + content + '</details>';
    }
    function itemText(item) {
      if (Array.isArray(item.content)) return item.content.map(part => part.text || part.type || '').join('\n');
      return item.text || (typeof item.content === 'string' ? item.content : '') || '';
    }
    function itemCard(item, turn, index) {
      const type = item.type || '', id = turn.id + ':' + (item.id || index), content = itemText(item);
      blockScope = 'item:' + id; blockOrder = 0;
      const error = item.status === 'failed' || item.error || (item.exitCode != null && item.exitCode !== 0);
      const status = '<span class="codex-status' + (error ? ' codex-status-failed' : '') + '">' + escape(error ? text('Failed', '失败') : statusLabel(item.status)) + '</span>';
      if (type === 'userMessage' || type === 'agentMessage') {
        return '<article class="codex-card codex-card-' + (type === 'userMessage' ? 'user' : 'agent') + '" data-card-key="' + escape(id)
          + '"><div class="codex-card-heading"><strong>' + escape(type === 'userMessage' ? text('You', '你') : text('Assistant', '助手'))
          + '</strong></div>' + prose(content) + '</article>';
      }
      const titles = {
        commandExecution: text('Command', '命令'), fileChange: text('File changes', '文件修改'),
        mcpToolCall: text('Tool call', '工具调用'), dynamicToolCall: text('Tool call', '工具调用'),
        webSearch: text('Web search', '网页搜索'), reasoning: text('Reasoning', '推理'),
        imageView: text('Image', '图片'), enteredReviewMode: text('Review started', '开始审阅'),
        exitedReviewMode: text('Review completed', '完成审阅'), contextCompaction: text('Context compacted', '上下文压缩')
      };
      let body = '', preview = item.command || item.tool || item.query || content.split('\n')[0] || '';
      if (type === 'commandExecution') {
        if (item.command) body += codeBlock(item.command, text('Command', '命令'));
        if (item.cwd) body += '<div class="codex-prose">' + escape(text('Directory: ', '目录：') + item.cwd) + '</div>';
        if (item.aggregatedOutput) body += codeBlock(item.aggregatedOutput, text('Output', '输出'));
        if (item.exitCode != null) body += '<div class="codex-card-heading">' + escape(text('Exit code: ', '退出码：') + item.exitCode) + '</div>';
      } else if (type === 'fileChange' && Array.isArray(item.changes)) {
        preview = item.changes.map(change => change.path || '').filter(Boolean).join(', ');
        body = item.changes.map((change, fileIndex) => {
          const kind = typeof change.kind === 'object' ? change.kind?.type : change.kind || '';
          const label = { add: text('Added', '新增'), delete: text('Deleted', '删除'), update: text('Modified', '修改') }[kind] || kind;
          return details(id + ':file:' + fileIndex,
            '<strong>' + escape(change.path || text('File', '文件')) + '</strong><span class="codex-status">' + escape(label) + '</span>',
            codeBlock(change.diff || JSON.stringify(change, null, 2), text('Executor-reported diff', '执行器报告的差异'), true), false);
        }).join('');
      } else {
        if (content) body += prose(content);
        const output = item.aggregatedOutput || item.result;
        if (output) body += codeBlock(typeof output === 'string' ? output : JSON.stringify(output, null, 2), text('Result', '结果'));
        if (!body) body = codeBlock(JSON.stringify(item, null, 2));
      }
      if (item.error) body += prose(typeof item.error === 'string' ? item.error : JSON.stringify(item.error, null, 2));
      const summary = '<strong>' + escape(titles[type] || type || text('Event', '事件')) + '</strong><span class="codex-tool-preview">'
        + escape(String(preview).slice(0, 180)) + '</span>' + status;
      return '<article class="codex-card' + (error ? ' codex-card-error' : '') + '" data-card-key="' + escape(id) + '">'
        + details(id, summary, body, Boolean(error) || !['completed', 'declined'].includes(item.status)) + '</article>';
    }
    function bindReadActions(container) {
      const currentKey = key;
      container.querySelectorAll('details[data-details-key]').forEach(node => {
        node.addEventListener('toggle', () => { if (key === currentKey && node.isConnected !== false) view().details.set(node.dataset.detailsKey, node.open); });
      });
      container.querySelectorAll('button[data-copy]').forEach(button => {
        button.addEventListener('click', async () => {
          if (key !== currentKey || button.isConnected === false) return;
          // A hidden section may change while the visible HTML stays identical.
          const content = copies[Number(button.dataset.copy)];
          try {
            await navigator.clipboard.writeText(content);
            button.textContent = text('Copied', '已复制');
          } catch (_) { button.textContent = text('Select text to copy', '请选择文本复制'); }
        });
      });
      bindSegmentActions(container);
      bindCodeScroll(container);
    }
    function bindCodeScroll(container) {
      const currentKey = key;
      container.querySelectorAll('pre[data-code-page]').forEach(pre => {
        const identity = pre.closest('[data-code-key]')?.dataset.codeKey;
        if (!identity) return;
        const page = Number(pre.dataset.codePage), saved = view().codeScroll.get(identity);
        if (saved?.page === page) { pre.scrollTop = saved.top; pre.scrollLeft = saved.left; }
        // Scroll events from restoration are asynchronous. Ignore unchanged
        // coordinates so restoring a block never opts out of follow mode.
        let top = pre.scrollTop, left = pre.scrollLeft;
        pre.addEventListener('scroll', () => {
          if (key !== currentKey || pre.isConnected === false || (top === pre.scrollTop && left === pre.scrollLeft)) return;
          top = pre.scrollTop; left = pre.scrollLeft;
          const reading = view();
          reading.codeScroll.set(identity, { page, top, left });
          if (reading.codeScroll.size > 256) reading.codeScroll.delete(reading.codeScroll.keys().next().value);
          if (top || left) { reading.follow = false; reading.top = scroller.scrollTop; updateJump(); }
        });
      });
    }
    function bindSegmentActions(container) {
      const currentKey = key;
      container.querySelectorAll('button[data-segment]').forEach(button => {
        const index = Number(button.dataset.segment);
        button.addEventListener('click', () => {
          const block = blocks[index];
          if (key !== currentKey || button.isConnected === false || !block) return;
          const action = button.dataset.segmentAction;
          block.page = Math.max(0, Math.min(block.ranges.length - 1,
            action === 'first' ? 0 : action === 'last' ? block.ranges.length - 1 : block.page + (action === 'next' ? 1 : -1)));
          view().textPages.set(block.identity, block.page);
          view().codeScroll.delete(block.identity);
          if (view().textPages.size > 256) view().textPages.delete(view().textPages.keys().next().value);
          const wrapper = button.closest('[data-segment-block]'), body = wrapper.querySelector('[data-segment-content]');
          const top = wrapper.getBoundingClientRect().top, oldTop = scroller.scrollTop;
          view().follow = false;
          body.innerHTML = segmentBody(block, index);
          bindSegmentActions(body);
          bindCodeScroll(body);
          const focus = body.querySelector('button[data-segment-action="' + action + '"]:not(:disabled)') || body.querySelector('[role="status"]');
          focus?.focus({ preventScroll: true });
          scroller.scrollTop = oldTop + wrapper.getBoundingClientRect().top - top;
          view().top = scroller.scrollTop; updateJump();
        });
      });
    }
    function renderTimeline(turns, reading) {
      // Page by items rather than turns: a single tool-heavy turn can contain hundreds of cards.
      entries = turns.flatMap((turn, turnIndex) => (turn.items?.length ? turn.items : [null]).map((item, index) => ({
        turn, turnIndex, item, index, id: JSON.stringify([turn.id, item?.id ?? index])
      })));
      let start = reading.follow ? Math.max(0, entries.length - PAGE_SIZE)
        : reading.startKey ? entries.findIndex(entry => entry.id === reading.startKey) : 0;
      // If retention removed the old anchor, show the oldest surviving history.
      start = Math.max(0, start);
      const visible = entries.slice(start, start + PAGE_SIZE);
      reading.start = start; reading.end = start + visible.length; reading.total = entries.length;
      reading.startKey = visible[0]?.id || '';
      const contentSignature = JSON.stringify(visible.map(entry =>
        [entry.turn.id, entry.turnIndex, entry.turn.status, entry.index, entry.item]));
      const signature = window.hccUi.language + ':' + contentSignature;
      const last = turns[turns.length - 1];
      const updateSignature = JSON.stringify([contentSignature, turns.map(turn => [turn.id, turn.status, turn.items?.length || 0]),
        last?.items?.[last.items.length - 1], last?.diff, last?.plan, state.events?.[state.events.length - 1]]);
      if (!reading.follow && reading.signature && reading.signature !== updateSignature) reading.unread = true;
      reading.signature = updateSignature;
      if (signature !== timelineSignature) {
        copies = []; blocks = [];
        let previousTurn = null;
        let html = visible.map(({ turn, turnIndex, item, index }) => {
          let heading = '';
          if (turn !== previousTurn) {
            heading = (previousTurn ? '</section>' : '') + '<section class="codex-turn"><header class="codex-turn-heading"><strong>'
              + escape(text('Turn ', '第 ') + (turnIndex + 1) + (window.hccUi.language === 'zh' ? ' 轮' : ''))
              + '</strong><span>' + escape(statusLabel(turn.status)) + '</span></header>';
            previousTurn = turn;
          }
          return heading + (item ? itemCard(item, turn, index) : '');
        }).join('');
        html = html ? html + '</section>' : '<p class="codex-prose">' + escape(text('Send a message to start this thread.', '发送消息开始当前会话。')) + '</p>';
        if (html !== timelineHtml) {
          document.getElementById('codexTimeline').innerHTML = html;
          timelineHtml = html; bindReadActions(document.getElementById('codexTimeline'));
        }
        timelineSignature = signature; timelineCopies = copies.slice(); timelineBlocks = blocks.slice();
      } else { copies = timelineCopies.slice(); blocks = timelineBlocks.slice(); }
      document.getElementById('codexHistory').hidden = entries.length <= PAGE_SIZE;
      document.getElementById('codexHistory').setAttribute('aria-label', text('Conversation history', '会话历史'));
      document.getElementById('codexEarlier').textContent = text('Earlier', '更早记录');
      document.getElementById('codexEarlier').disabled = start === 0;
      document.getElementById('codexLater').textContent = text('Newer', '更新记录');
      document.getElementById('codexLater').disabled = reading.end === entries.length;
      document.getElementById('codexHistoryRange').textContent = text('Events ', '第 ') + (entries.length ? start + 1 : 0)
        + '–' + reading.end + text(' of ', ' 条，共 ') + entries.length + text('', ' 条');
    }
    function sync() {
      const next = draftKey();
      if (next !== key) {
        subjectRevision += 1;
        if (key && state) view().top = scroller.scrollTop || 0;
        key = next; pending = null; draft.value = ''; state = null;
        timelineHtml = ''; timelineSignature = ''; timelineCopies = []; copies = []; entries = []; blocks = []; timelineBlocks = [];
        document.getElementById('codexHistory').hidden = true;
        for (const id of ['codexStatus', 'codexTimeline', 'codexDiff', 'codexPlan', 'codexApprovals', 'codexSubmission']) document.getElementById(id).textContent = '';
        document.getElementById('codexReview').open = view().details.get('review') || false;
        document.getElementById('codexReview').hidden = true;
        scroller.scrollTop = view().top;
        try { const stored = JSON.parse(window.hccUi.safeGet(key) || '{}'); draft.value = stored.text || ''; pending = stored.pending || null; } catch (_) {}
      }
      document.getElementById('codexSend').textContent = turnId() ? text('Add instruction', '追加指令') : text('Send', '发送');
      document.getElementById('codexDraftLabel').textContent = text('Message saved in this browser', '消息草稿保存在当前浏览器');
      document.getElementById('codexInterrupt').textContent = text('Interrupt turn', '中断当前轮');
      document.getElementById('codexRecover').textContent = text('Read current state', '读取当前状态');
      document.getElementById('codexClear').textContent = text('Clear draft', '清除草稿');
      document.getElementById('codexReviewLabel').textContent = text('Latest turn changes and plan', '最新一轮的变更与计划');
      scroller.setAttribute('aria-label', text('Conversation', '会话内容'));
      draft.placeholder = text('Write a message · Ctrl / ⌘ + Enter to send', '输入消息 · Ctrl / ⌘ + Enter 发送');
      updateJump();
      document.getElementById('codexSend').disabled = !bridge().canControl || submitting || !!pending;
      document.getElementById('codexInterrupt').disabled = !bridge().canControl || !turnId();
      document.getElementById('codexApprovals').querySelectorAll('button[data-approval]').forEach(button => {
        button.disabled = !bridge().canControl || approving.has(button.dataset.requestKey) || (button.dataset.decision === 'accept' && button.dataset.truncated === 'true');
      });
      const approvals = state?.pendingApprovals || [], approvalJump = document.getElementById('codexApprovalJump');
      approvalJump.hidden = !approvals.length;
      approvalJump.textContent = text('Approval required: ', '待审批：') + approvals.length + text(' · View', ' · 查看');
      if (pending) message(text('Submission is unconfirmed. Read the current state and check history before clearing the draft or sending again.', '提交结果尚未确认。请读取当前状态并核对历史，再清除草稿或重新发送。'));
      if (state?.uncertainSubmissions?.length) {
        document.getElementById('codexSend').disabled = true;
        message(text('Executor admission is uncertain. Read history; if no acknowledgement arrives, stop this executor and explicitly resume its saved thread.', '执行器接收结果不确定。请读取历史；若回执仍未到达，请停止当前执行器后显式恢复保存的会话。'));
      }
    }
    async function action(name, body, target = subject()) {
      const b = bridge();
      return b.api(route(target, name),
        { method: 'POST', body: JSON.stringify({ ...body, action_token: target.token, epoch: target.epoch }) });
    }
    function render(value, resetScroll = false) {
      sync();
      // Local paging and preference redraws reuse state; incoming snapshots do not.
      if (value !== state) stateRevision += 1;
      state = value; sync();
      const thread = activeThread();
      document.getElementById('codexStatus').textContent = [text('Executor', '执行器') + ': ' + statusLabel(state.status),
        text('Thread', '会话') + ': ' + (thread?.id || ''), turnId() ? text('Turn', '当前轮') + ': ' + turnId() : text('Idle', '空闲'),
        state.truncated ? text('Retained history is partial', '保留历史不完整') : ''].filter(Boolean).join(' · ');
      const turns = thread?.turns || [];
      const reading = view(), oldTop = resetScroll ? 0 : reading.top;
      // Keep the visible message anchored even when the executor drops older retained turns.
      const anchor = resetScroll ? null : [...scroller.querySelectorAll('[data-card-key]')].find(node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
      const anchorKey = anchor?.dataset.cardKey, anchorTop = anchor?.getBoundingClientRect().top;
      renderTimeline(turns, reading);
      const last = turns[turns.length - 1];
      const plan = Array.isArray(last?.plan) ? last.plan : [];
      blockScope = 'plan:' + last?.id; blockOrder = 0;
      document.getElementById('codexPlan').innerHTML = plan.length ? '<h3>' + escape(text('Plan', '执行计划')) + '</h3>'
        + (last.explanation ? prose(last.explanation) : '') + '<ol class="codex-plan">' + plan.map(step =>
          '<li data-status="' + escape(step.status || '') + '"><span>' + escape(statusLabel(step.status)) + '</span><span>'
          + escape(step.step || '') + '</span></li>').join('') + '</ol>' : '';
      document.getElementById('codexDiff').innerHTML = last?.diff ? '<h3>' + escape(text('Latest turn · Executor-reported changes', '最新一轮 · 执行器报告的变更'))
        + '</h3>' + codeBlock(last.diff, text('Diff', '差异'), true, false, 'review:diff:' + last.id) : '';
      const review = document.getElementById('codexReview');
      review.hidden = !last?.diff && !plan.length;
      bindReadActions(document.getElementById('codexPlan'));
      bindReadActions(document.getElementById('codexDiff'));
      const approvals = state.pendingApprovals || [];
      const target = subject(), executorId = state.executorId;
      const container = document.getElementById('codexApprovals');
      window.hccInteractions.remember(container);
      container.innerHTML = approvals.map((approval, index) => {
        blockScope = 'approval:' + executorId + ':' + approval.requestId; blockOrder = 0;
        const params = approval.params || {}, fields = [
          [text('Operation', '操作'), approval.kind === 'mcp' ? text('MCP request', 'MCP 请求') : approval.kind === 'userInput' ? text('Answer questions', '回答问题') : approval.kind === 'permissions' ? text('Grant permissions', '授予权限') : approval.method?.includes('fileChange') ? text('Change files', '修改文件') : text('Run command', '执行命令')],
          [text('Command', '命令'), params.command], [text('Directory', '目录'), params.cwd],
          [text('MCP server', 'MCP 服务'), params.serverName], [text('Reason', '原因'), params.reason || params.message], [text('Path', '路径'), params.path],
          [text('Permission root', '权限目录'), params.grantRoot]
        ].filter(([, value]) => value != null && value !== '');
        return '<article class="codex-card codex-approval"><h3>' + escape(window.hccInteractions.requiresInput(approval) ? text('Your input is required', '等待您的答复') : text('Approval required', '等待人工审批'))
          + '</h3><dl>' + fields.map(([label, value], fieldIndex) => {
            const fullValue = typeof value === 'string' ? value : JSON.stringify(value);
            return '<dt>' + escape(label) + '</dt><dd>'
              + (segmentRanges(fullValue).length > 1 ? codeBlock(fullValue, text('Full value', '完整字段'), false, true, blockScope + ':field:' + fieldIndex) : escape(fullValue))
              + '</dd>';
          }).join('') + '</dl>'
          + (approval.truncated ? '<p class="codex-prose">' + escape(text('Parameters are truncated. Read the full operation before deciding.', '参数已截断，请核对完整操作后再决定。')) + '</p>' : '')
          + details('approval:' + approval.requestId, '<strong>' + escape(text('Raw parameters', '原始参数')) + '</strong>',
            codeBlock(JSON.stringify(window.hccInteractions.previewParams(approval), null, 2), 'JSON'), false)
          + '<div class="hcc-interaction-form">' + window.hccInteractions.form(approval, approvalKey(target, executorId, approval.requestId), escape, text) + '</div>'
          + '<div class="codex-approval-actions"><button data-approval="' + index + '" data-decision="accept" data-truncated="' + window.hccInteractions.approvalBlocked(approval) + '" data-request-key="' + escape(approvalKey(target, executorId, approval.requestId)) + '" type="button" class="primary">'
          + escape(window.hccInteractions.acceptLabel(approval, text)) + '</button><button data-approval="' + index + '" data-decision="' + (approval.kind === 'userInput' ? 'cancel' : 'decline') + '" data-request-key="' + escape(approvalKey(target, executorId, approval.requestId)) + '" type="button">'
          + escape(approval.kind === 'userInput' ? text('Cancel questions', '取消问答') : text('Decline', '拒绝')) + '</button>'
          + (approval.kind === 'mcp' ? '<button data-approval="' + index + '" data-decision="cancel" data-request-key="' + escape(approvalKey(target, executorId, approval.requestId)) + '" type="button">' + escape(text('Cancel request', '取消请求')) + '</button>' : '') + '</div></article>';
      }).join('');
      window.hccInteractions.restore(container);
      bindReadActions(container);
      container.querySelectorAll('button[data-approval]').forEach(button => {
        button.disabled = !bridge().canControl || approving.has(button.dataset.requestKey) || (button.dataset.decision === 'accept' && button.dataset.truncated === 'true');
        button.addEventListener('click', async () => {
          if (!matches(target) || !bridge().canControl || approving.has(button.dataset.requestKey)) return;
          const approval = approvals[Number(button.dataset.approval)];
          const requestKey = approvalKey(target, executorId, approval.requestId);
          approving.add(requestKey); sync();
          const requestTarget = { ...target, token: bridge().actionToken, epoch: bridge().epoch };
          let authorization;
          try {
            const payload = window.hccInteractions.payload(approval, ['userInput','permissions','mcp'].includes(approval.kind) ? button.closest('article') : null, button.dataset.decision);
            authorization = window.hccInteractions.prepareUrl(approval, button.dataset.decision, text);
            await action('approve', { executorId, threadId: approval.threadId,
            turnId: approval.turnId, requestId: approval.requestId,
            ...payload }, requestTarget);
            window.hccInteractions.forget(requestKey);
            const opened = authorization?.complete();
            if (opened && matches(target)) message(opened);
          }
          catch (error) { authorization?.cancel(); if (matches(target)) message(error.detail || error.message); }
          finally { approving.delete(requestKey); if (matches(target)) sync(); }
        });
      });
      if (reading.follow) scroller.scrollTop = scroller.scrollHeight;
      else {
        scroller.scrollTop = oldTop;
        if (anchorKey) {
          const restored = [...scroller.querySelectorAll('[data-card-key]')].find(node => node.dataset.cardKey === anchorKey);
          if (restored) scroller.scrollTop += restored.getBoundingClientRect().top - anchorTop;
        }
      }
      reading.top = scroller.scrollTop;
      updateJump();
    }
    scroller.addEventListener('scroll', () => {
      // Clearing the old DOM clamps scrollTop before the next subject has state.
      // Those layout events must not overwrite the saved position of that subject.
      if (!state) return;
      const current = view(); current.top = scroller.scrollTop; current.follow = pinned() && current.end === current.total;
      if (current.follow) current.unread = false;
      updateJump();
    });
    document.getElementById('codexJump').addEventListener('click', () => {
      view().follow = true; view().unread = false;
      if (state) render(state);
    });
    function pageHistory(direction) {
      if (!state) return;
      const reading = view(), start = Math.max(0, Math.min(entries.length - PAGE_SIZE, reading.start + direction * PAGE_SIZE));
      reading.startKey = entries[start]?.id || ''; reading.follow = false;
      reading.signature = ''; reading.top = 0;
      render(state, true);
      scroller.focus?.({ preventScroll: true });
    }
    document.getElementById('codexEarlier').addEventListener('click', () => pageHistory(-1));
    document.getElementById('codexLater').addEventListener('click', () => pageHistory(1));
    document.getElementById('codexApprovalJump').addEventListener('click', () => {
      scroller.scrollTop = 0; view().top = 0; view().follow = pinned() && view().end === view().total; updateJump();
    });
    document.getElementById('codexReview').addEventListener('toggle', () => { view().details.set('review', document.getElementById('codexReview').open); });
    draft.addEventListener('input', save);
    draft.addEventListener('keydown', event => {
      if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!document.getElementById('codexSend').disabled) document.getElementById('codexSend').click();
      }
    });
    document.getElementById('codexSend').addEventListener('click', async () => {
      if (!bridge().canControl || !draft.value.trim() || pending || submitting) return;
      const submittedText = draft.value;
      pending = 's_' + crypto.randomUUID(); submitting = true; save(); sync();
      const target = subject(), submissionId = pending;
      try {
        const currentTurn = turnId();
        await action(currentTurn ? 'steer' : 'turn', { text: submittedText, submissionId, turnId: currentTurn }, target);
        let stored = {};
        try { stored = JSON.parse(window.hccUi.safeGet(target.key) || '{}'); } catch (_) {}
        if (stored.pending === submissionId) {
          stored.pending = null;
          if (stored.text === submittedText) stored.text = '';
          window.hccUi.safeSet(target.key, JSON.stringify(stored));
        }
        if (matches(target)) {
          pending = stored.pending || null; draft.value = stored.text || '';
          message(text('Executor confirmed submission.', '执行器已确认提交。'));
        }
      } catch (error) { if (matches(target)) message((error.detail || error.message) + ' ' + text('Check current state before resending.', '重新发送前请核对当前状态。')); }
      finally { submitting = false; sync(); }
    });
    document.getElementById('codexInterrupt').addEventListener('click', async () => {
      const target = subject();
      try { await action('interrupt', { turnId: turnId() }, target); if (matches(target)) message(text('Interrupt requested; awaiting state update.', '已请求中断，等待状态更新。')); }
      catch (error) { if (matches(target)) message(error.detail || error.message); }
    });
    document.getElementById('codexRecover').addEventListener('click', async () => {
      const b = bridge(), target = subject();
      const subjectVersion = subjectRevision, sequence = ++readSequence;
      const current = () => matches(target) && subjectVersion === subjectRevision && sequence === readSequence;
      try {
        await b.api(route(target, 'read'));
        if (!current()) return;
        const version = stateRevision;
        const result = await b.api(route(target, 'state'));
        if (current() && version === stateRevision) render(result.state);
      } catch (error) { if (current()) message(error.detail || error.message); }
    });
    document.getElementById('codexClear').addEventListener('click', () => {
      if (!confirm(text('Clear this draft and its unconfirmed submission marker? Check thread history first.', '清除草稿及未确认提交标记？请先核对会话历史。'))) return;
      pending = null; draft.value = ''; save(); message(''); sync();
    });
    window.addEventListener('hcc:preferences', () => { if (state && !panel.hidden) render(state); });
    window.hccCodex = { render, sync };
  })();`;
}
