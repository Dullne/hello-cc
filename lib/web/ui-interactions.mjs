// Shared form controls for Web-owned and independent native executors.
export function interactionPanelScript() {
  return String.raw`(() => {
    if (window.hccInteractions) return;
    const drafts = new Map(), expanded = new Map();
    let focus = null;
    function remember(container) {
      container.querySelectorAll('[data-interaction-field]').forEach(control => {
        if (!control.dataset.interactionField) return;
        drafts.set(control.dataset.interactionField, { value: control.value, checked: control.checked });
        if (control === document.activeElement) focus = { key: control.dataset.interactionField, start: control.selectionStart, end: control.selectionEnd };
      });
      container.querySelectorAll('[data-interaction-details]').forEach(detail => expanded.set(detail.dataset.interactionDetails, detail.open));
      while (expanded.size > 256) expanded.delete(expanded.keys().next().value);
      while (drafts.size > 256) drafts.delete(drafts.keys().next().value);
    }
    function restore(container) {
      const live = new Set();
      container.querySelectorAll('[data-interaction-field]').forEach(control => {
        live.add(control.dataset.interactionField);
        const saved = drafts.get(control.dataset.interactionField);
        if (saved) { control.value = saved.value; if (control.type === 'checkbox') control.checked = saved.checked; }
        if (focus && focus.key === control.dataset.interactionField) { control.focus?.({preventScroll:true}); if (typeof focus.start === 'number') control.setSelectionRange?.(focus.start, focus.end); }
      });
      for (const key of drafts.keys()) if (!live.has(key)) drafts.delete(key);
      if (focus && !live.has(focus.key)) focus = null;
      const detailKeys = new Set();
      container.querySelectorAll('[data-interaction-details]').forEach(detail => {
        const key = detail.dataset.interactionDetails; detailKeys.add(key);
        if (expanded.has(key)) detail.open = expanded.get(key);
      });
      for (const key of expanded.keys()) if (!detailKeys.has(key)) expanded.delete(key);
    }
    function approvalBlocked(request) {
      const tool = request.params?.toolCall;
      return Boolean(request.truncated || (request.method === 'session/request_permission' &&
        (!tool || tool.contextPending || tool.contextTruncated || !Object.hasOwn(tool, 'rawInput') ||
         !request.params.options?.some(option => option.kind === 'allow_once'))));
    }
    function preview(request, key, esc, text) {
      const params = request.params || {}, tool = params.toolCall || {}, input = params.input || tool.rawInput || {};
      const rows = [], row = (label, value) => { if (typeof value === 'string' && value) rows.push('<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>'); };
      const name = params.tool || tool.title;
      row(text('Tool', '工具'), name);
      row(text('Command', '命令'), params.command || input.command);
      row(text('File', '文件'), input.file_path || input.path || params.path || params.grantRoot);
      row(text('Working directory', '工作目录'), params.cwd || input.cwd);
      row(text('Reason', '原因'), params.reason || params.message);
      const content = typeof input.content === 'string' ? input.content : null;
      const previewLimit = 1024;
      const contentPreview = content === null ? '' : '<p>' + esc(text('Content preview', '内容预览')) + '</p><pre class="hcc-interaction-content">' + esc(content.slice(0, previewLimit)) + '</pre>'
        + (content.length > previewLimit ? '<p>' + esc(text('Preview shortened; expand the full operation details to review all content.', '预览已缩短，展开完整操作详情可核对全部内容。')) + '</p>' : '');
      const known = rows.length || ['permissions', 'userInput'].includes(request.kind);
      const missingContext = request.method === 'session/request_permission' && approvalBlocked(request);
      return (rows.length ? '<dl class="hcc-interaction-summary">' + rows.join('') + '</dl>' : '') + contentPreview
        + (missingContext ? '<p role="alert">' + esc(text('The operation input or one-time approval option is unavailable. Only rejection is available.', '操作输入或单次批准选项不可用，目前只能拒绝。')) + '</p>' : '')
        + (request.kind === 'approval' && !missingContext ? '<p>' + esc(text('Approval applies only to this operation. Later requests require another decision.', '仅批准本次操作，后续请求仍需单独确认。')) + '</p>' : '')
        + '<details class="hcc-interaction-details" data-interaction-details="' + esc(key) + '"' + (known ? '' : ' open') + '><summary>' + esc(text('Full operation details', '完整操作详情')) + '</summary><pre>' + esc(JSON.stringify(params, null, 2)) + '</pre></details>';
    }
    function form(request, key, esc, text) {
      const field = suffix => ' data-interaction-field="' + esc(key + ':' + suffix) + '"';
      if (request.kind === 'userInput') return (request.params?.questions || []).map((q, i) => {
        const label = '<label>' + esc(q.header || '') + '<p>' + esc(q.question || '') + '</p>';
        const free = '<input data-answer="' + i + '" type="' + (q.isSecret ? 'password' : 'text') + '" maxlength="8192" autocomplete="off"' + field('answer:' + i) + '>';
        if (!q.options?.length) return label + free + '</label>';
        return label + '<select data-question="' + i + '"' + field('question:' + i) + '><option value="">' + esc(text('Choose an answer', '请选择答案')) + '</option>'
          + q.options.map((o, n) => '<option value="' + n + '">' + esc(o.label + (o.description ? ' — ' + o.description : '')) + '</option>').join('')
          + (q.isOther ? '<option value="other">' + esc(text('Other (enter below)', '其他（在下方输入）')) + '</option>' : '') + '</select>'
          + (q.isOther ? free : '') + '</label>';
      }).join('');
      if (request.kind !== 'permissions') return '';
      const p = request.params?.permissions || {}, fs = p.fileSystem || {};
      const choice = (name, index, label) => '<label><input type="checkbox" data-permission="' + name + '" data-index="' + index + '"' + field(name + ':' + index) + '> ' + esc(label) + '</label>';
      return '<p>' + esc(text('Select the requested permissions to grant. Unchecked permissions remain denied.', '勾选要授予的请求权限，未勾选的权限不授予。')) + '</p>'
        + (p.network?.enabled === true ? choice('network', 0, text('Network access', '网络访问')) : '')
        + ['read', 'write'].map(type => (fs[type] || []).map((path, i) => (fs.entries || []).some(entry => entry.access === type && entry.path?.type === 'path' && entry.path.path === path) ? '' : choice(type, i, text(type === 'read' ? 'Read: ' : 'Write: ', type === 'read' ? '读取：' : '写入：') + path)).join('')).join('')
        + (fs.entries || []).map((entry, i) => entry.access === 'deny' ? '<p>' + esc(text('Retained denial: ', '保留禁止规则：') + JSON.stringify(entry.path)) + '</p>'
          : choice('entries', i, (entry.access === 'write' ? text('Write: ', '写入：') : text('Read: ', '读取：')) + JSON.stringify(entry.path))).join('')
        + '<label>' + esc(text('Permission duration', '权限有效期')) + '<select data-scope' + field('scope') + '><option value="turn">' + esc(text('This turn', '仅本轮')) + '</option><option value="session">' + esc(text('This session', '本会话')) + '</option></select></label>';
    }
    function payload(request, container, decision) {
      if (decision !== 'accept') return { decision };
      if (request.kind === 'userInput') {
        const answers = Object.create(null);
        for (const [i, q] of (request.params?.questions || []).entries()) {
          const select = container.querySelector('[data-question="' + i + '"]');
          const value = select && select.value !== 'other' ? q.options?.[Number(select.value)]?.label : container.querySelector('[data-answer="' + i + '"]')?.value;
          if ((select && select.value === '') || !value?.trim()) throw new Error('Please answer every question / 请回答每个问题');
          answers[q.id] = { answers: [value] };
        }
        return { answers };
      }
      if (request.kind !== 'permissions') return { decision };
      const wanted = request.params.permissions, permissions = {}, fs = {};
      container.querySelectorAll('[data-permission]').forEach(control => {
        if (!control.checked) return;
        const field = control.dataset.permission;
        if (field === 'network') permissions.network = { enabled: true };
        else { fs[field] ||= []; fs[field].push(wanted.fileSystem[field][Number(control.dataset.index)]); }
      });
      if (Object.keys(fs).length) {
        const denies = (wanted.fileSystem.entries || []).filter(entry => entry.access === 'deny');
        if (denies.length) fs.entries = [...(fs.entries || []), ...denies];
        if (wanted.fileSystem.globScanMaxDepth != null) fs.globScanMaxDepth = wanted.fileSystem.globScanMaxDepth;
        permissions.fileSystem = fs;
      }
      return { decision, permissions, scope: container.querySelector('[data-scope]').value };
    }
    function forget(key) { for (const field of drafts.keys()) if (field.startsWith(key + ':')) drafts.delete(field); expanded.delete(key); }
    window.hccInteractions = { preview, approvalBlocked, form, payload, remember, restore, forget };
  })();`;
}
