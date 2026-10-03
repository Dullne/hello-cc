import { createMcpFormValidator } from '../integrations/mcp-elicitation.mjs';
import { createMcpUrlValidator } from '../integrations/mcp-url-elicitation.mjs';

// Shared form controls for Web-owned and independent native executors.
export function interactionPanelScript() { return '(' + installInteractionPanel.toString() + ')(' + createMcpFormValidator.toString() + ',' + createMcpUrlValidator.toString() + ');'; }

export function installInteractionPanel(createForms = createMcpFormValidator, createUrls = createMcpUrlValidator) {
(() => {
    if (window.hccInteractions) return;
    const mcpForms = createForms(), mcpUrls = createUrls();
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
      while (drafts.size > 8192) drafts.delete(drafts.keys().next().value);
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
    function requiresInput(request) {
      return request.kind === 'userInput' || (request.kind === 'mcp' && request.params?.mode === 'form' && Object.keys(request.params.requestedSchema?.properties || {}).length > 0);
    }
    function approvalBlocked(request) {
      if (request.kind === 'mcp') { try { (isUrl(request) ? mcpUrls : mcpForms).describe(request.params); } catch (_) { return true; } }
      const tool = request.params?.toolCall;
      return Boolean(request.truncated || (request.method === 'session/request_permission' &&
        (!tool || tool.contextPending || tool.contextTruncated || !Object.hasOwn(tool, 'rawInput') ||
         !request.params.options?.some(option => option.kind === 'allow_once'))));
    }
    function isUrl(request) { return request.kind === 'mcp' && request.params?.mode === 'url'; }
    function acceptLabel(request, text) {
      return isUrl(request) ? text('Open authorization page', '打开授权页面') : requiresInput(request) ? text('Send answers', '提交答复')
        : request.kind === 'permissions' ? text('Grant selected permissions', '授予所选权限') : text('Approve once', '批准本次');
    }
    function previewParams(request) {
      if (!isUrl(request)) return request.params || {};
      let destination;
      try { destination = mcpUrls.describe(request.params).origin; } catch (_) {}
      return { mode: 'url', serverName: request.params?.serverName, destination };
    }
    function prepareUrl(request, decision, text) {
      if (!isUrl(request) || decision !== 'accept') return null;
      if (approvalBlocked(request)) throw new Error(text('This authorization request cannot be opened.', '当前授权请求不可打开。'));
      const { href } = mcpUrls.describe(request.params);
      // Reserve a tab within the explicit click; navigate only after the owning
      // executor accepts the exact request. A stale lease leaves no auth page.
      const page = window.open('about:blank', '_blank');
      if (!page) throw new Error(text('Allow pop-ups for this site, then try again. The request has not been accepted.', '请允许本站弹出新标签页后重试；请求尚未接受。'));
      let navigated = false;
      try {
        page.opener = null;
        page.document.write('<meta name="referrer" content="no-referrer"><title>Authorization / 授权</title><p>Opening authorization page / 正在打开授权页面…</p>');
        page.document.close();
      } catch (error) { page.close(); throw error; }
      return {
        complete() {
          if (page.closed) throw new Error(text('The request was accepted but the authorization tab was closed. Check the task result or request authorization again.', '请求已接受，但授权标签页已关闭。请查看任务结果或重新发起授权。'));
          page.location.replace(href); navigated = true;
          return text('Authorization page opened. Complete the steps there, then return to follow this task. Opening the page does not confirm authorization.', '授权页面已打开。请在该页面完成操作，再返回查看任务结果；打开页面不表示授权成功。');
        },
        cancel() { if (!navigated && !page.closed) page.close(); }
      };
    }
    function preview(request, key, esc, text) {
      const params = request.params || {}, tool = params.toolCall || {}, input = params.input || tool.rawInput || {};
      const rows = [], row = (label, value) => { if (typeof value === 'string' && value) rows.push('<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>'); };
      const name = params.tool || tool.title;
      row(text('Tool', '工具'), name);
      row(text('MCP server', 'MCP 服务'), params.serverName);
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
        + '<details class="hcc-interaction-details" data-interaction-details="' + esc(key) + '"' + (known ? '' : ' open') + '><summary>' + esc(text('Full operation details', '完整操作详情')) + '</summary><pre>' + esc(JSON.stringify(previewParams(request), null, 2)) + '</pre></details>';
    }
    function mcpForm(request, key, esc, text) {
      let fields;
      try { ({ fields } = mcpForms.describe(request.params)); }
      catch (_) { return '<p role="alert">' + esc(text('This MCP request mode or schema is unsupported. Decline or cancel this request.', '暂不支持此 MCP 请求模式或表单结构，请拒绝或取消请求。')) + '</p>'; }
      if (!fields.length) return '';
      const attr = suffix => ' data-interaction-field="' + esc(key + ':mcp:' + suffix) + '"';
      const select = (i, choices, value) => '<select data-mcp-field="' + i + '"' + attr(i) + '><option value="">' + esc(text('Choose a value', '请选择')) + '</option>'
        + choices.map((choice, n) => '<option value="' + n + '"' + (value === choice.value ? ' selected' : '') + '>' + esc(choice.label) + '</option>').join('') + '</select>';
      return '<p>' + esc(text('Required fields are marked *. Optional fields are sent only when selected. Responses are not saved in browser storage.', '带 * 的为必填项；可选项仅在勾选填写后发送。答复不会保存到浏览器存储。')) + '</p>'
        + fields.map((field, i) => {
          const label = esc(field.title || field.key) + (field.required ? ' *' : '');
          const optional = field.required ? '' : '<label><input type="checkbox" data-mcp-use="' + i + '"' + attr(i + ':use') + '> ' + esc(text('Provide this optional field', '填写此可选项')) + '</label>';
          let control;
          if (field.kind === 'enum') control = select(i, field.options, field.default);
          else if (field.type === 'boolean') control = select(i, [{ value: true, label: text('Yes', '是') }, { value: false, label: text('No', '否') }], field.default);
          else if (field.kind === 'multi') control = field.options.map((option, n) => '<label><input type="checkbox" data-mcp-field="' + i + '" data-mcp-option="' + n + '"' + attr(i + ':' + n)
            + (field.default?.includes(option.value) ? ' checked' : '') + '> ' + esc(option.label) + '</label>').join('');
          else control = '<input data-mcp-field="' + i + '"' + attr(i) + ' type="' + (['number', 'integer'].includes(field.type) ? 'number' : 'text') + '"'
            + (field.type === 'integer' ? ' step="1"' : field.type === 'number' ? ' step="any"' : ' maxlength="8192"')
            + (field.minimum != null ? ' min="' + esc(field.minimum) + '"' : '') + (field.maximum != null ? ' max="' + esc(field.maximum) + '"' : '')
            + ' value="' + esc(field.default ?? '') + '" autocomplete="off">';
          const limits = [field.format, field.minLength != null ? text('Min length: ', '最短长度：') + field.minLength : '', field.maxLength != null ? text('Max length: ', '最长长度：') + field.maxLength : '',
            field.minimum != null ? text('Minimum: ', '最小值：') + field.minimum : '', field.maximum != null ? text('Maximum: ', '最大值：') + field.maximum : '',
            field.minItems != null ? text('Min selections: ', '至少选择：') + field.minItems : '', field.maxItems != null ? text('Max selections: ', '最多选择：') + field.maxItems : ''].filter(Boolean).join(' · ');
          return '<fieldset class="hcc-mcp-field"><legend>' + label + '</legend>' + (field.description ? '<p>' + esc(field.description) + '</p>' : '') + optional
            + (field.kind === 'multi' ? control : '<label><span class="sr-only">' + label + '</span>' + control + '</label>') + (limits ? '<small>' + esc(limits) + '</small>' : '') + '</fieldset>';
        }).join('');
    }
    function form(request, key, esc, text) {
      if (isUrl(request)) {
        let destination;
        try { destination = mcpUrls.describe(request.params); }
        catch (_) { return '<p role="alert">' + esc(text('This authorization URL or identity is invalid. Decline or cancel this request.', '授权链接或请求标识无效，请拒绝或取消请求。')) + '</p>'; }
        return '<p class="hcc-url-destination">' + esc(text('Authorization destination: ', '授权目标：')) + '<strong>' + esc(destination.origin) + '</strong></p>'
          + '<p>' + esc(text('Open this page only if you trust the MCP server and destination. Finish authorization there, then return to this task. Opening acknowledges the request; it does not confirm authorization.', '确认信任此 MCP 服务和目标后打开页面，在该页面完成授权，再返回本任务查看结果。打开仅表示接受请求，不表示授权成功。')) + '</p>'
          + (destination.loopback ? '<p>' + esc(text('This address belongs to the executor computer. A browser on another device may not reach it; open this task on the executor computer to authorize.', '此地址位于执行器所在电脑。其他设备的浏览器可能无法访问，请在执行器所在电脑打开本任务完成授权。')) + '</p>' : '');
      }
      if (request.kind === 'mcp') return mcpForm(request, key, esc, text);
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
      if (isUrl(request)) { mcpUrls.describe(request.params); return { decision }; }
      if (request.kind === 'mcp') {
        const { fields } = mcpForms.describe(request.params), content = Object.create(null);
        for (const [i, field] of fields.entries()) {
          if (!field.required && !container?.querySelector('[data-mcp-use="' + i + '"]')?.checked) continue;
          const controls = container?.querySelectorAll('[data-mcp-field="' + i + '"]');
          if (!controls?.length) throw new Error('MCP form is unavailable / MCP 表单不可用');
          const control = controls[0];
          if (field.kind === 'multi') content[field.key] = Array.from(controls).filter(item => item.checked).map(item => field.options[Number(item.dataset.mcpOption)]?.value);
          else if (field.kind === 'enum' || field.type === 'boolean') {
            if (!/^\d+$/.test(control.value)) throw new Error('Choose a value / 请选择：' + field.key);
            content[field.key] = field.kind === 'enum' ? field.options[Number(control.value)]?.value : control.value === '0' ? true : control.value === '1' ? false : undefined;
          } else if (['number', 'integer'].includes(field.type)) {
            if (!control.value.trim()) throw new Error('Enter a number / 请填写数值：' + field.key);
            content[field.key] = Number(control.value);
          } else content[field.key] = control.value;
        }
        return { decision, content: mcpForms.validate(request.params, content) };
      }
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
    window.hccInteractions = { preview, previewParams, approvalBlocked, requiresInput, acceptLabel, prepareUrl, form, payload, remember, restore, forget };
  })();
}
