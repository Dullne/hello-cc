import { createMcpFormValidator } from './mcp-elicitation.mjs';
import { createMcpUrlValidator } from './mcp-url-elicitation.mjs';

const mcpForms = createMcpFormValidator(), mcpUrls = createMcpUrlValidator();
// Shared validation for the official App Server command/file/permissions/input
// server requests. Human responses may narrow a request, never widen it.
export const CODEX_INTERACTION_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'
]);
// These per-thread switches expose the model tools served by our responder.
// They are experimental in Codex 0.144.6; they grant no permissions and never
// write the caller's global config. Noninteractive adapters retain defaults.
export function codexInteractiveConfig(config = {}, interactive = true) {
  return { ...config, ...(interactive ? {
    'features.default_mode_request_user_input': true,
    'features.request_permissions_tool': true
  } : {}) };
}
export function codexInteractionKind(method) {
  return method === 'mcpServer/elicitation/request' ? 'mcp' : method === 'item/tool/requestUserInput' ? 'userInput'
    : method === 'item/permissions/requestApproval' ? 'permissions' : 'approval';
}
export function cancelCodexInteraction(method) {
  return method === 'mcpServer/elicitation/request' ? { action: 'cancel' } : method === 'item/tool/requestUserInput' ? { answers: {} }
    : method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' };
}
function fail(message) { throw Object.assign(new Error(message), { code: 'INTERACTION_RESPONSE_INVALID' }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected interaction response fields');
}
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (object(a) || object(b)) return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  return a === b;
}
function subset(selected, requested) {
  if (!Array.isArray(selected) || !Array.isArray(requested) || selected.length > requested.length ||
      selected.some((entry, index) => !requested.some(value => same(entry, value)) || selected.slice(0, index).some(value => same(entry, value)))) {
    fail('Granted permissions must be an exact subset of the requested permissions');
  }
}
// Reply only to the correlated request. URL acceptance has no form content or
// authentication result; the MCP server owns completion of the external flow.
function mcpResponse(request, input) {
  if (!['accept', 'decline', 'cancel'].includes(input.decision)) fail('An MCP decision is required');
  if (input.decision !== 'accept') return { action: input.decision };
  if (request.params?.mode === 'url') {
    mcpUrls.describe(request.params);
    if (input.content !== undefined || input.answers !== undefined || input.permissions !== undefined) fail('MCP URL responses cannot contain form content or permissions');
    return { action: 'accept' };
  }
  const { fields } = mcpForms.describe(request.params);
  return { action: 'accept', content: mcpForms.validate(request.params, input.content === undefined && !fields.length ? {} : input.content) };
}

function permissionsResponse(request, input) {
  if (['decline', 'cancel'].includes(input.decision)) return { permissions: {}, scope: 'turn' };
  if (input.decision !== 'accept') fail('A permission decision is required');
  const requested = request.params.permissions;
  keys(requested, ['fileSystem', 'network']);
  const selected = input.permissions;
  keys(selected, ['fileSystem', 'network']);
  if (!['turn', 'session'].includes(input.scope)) fail('Choose an explicit turn or session permission scope');
  if (selected.network != null) {
    keys(selected.network, ['enabled']);
    if (selected.network.enabled !== true || requested.network?.enabled !== true) fail('Network access was not requested');
  }
  if (selected.fileSystem != null) {
    const fs = selected.fileSystem, wanted = requested.fileSystem;
    keys(fs, ['read', 'write', 'entries', 'globScanMaxDepth']);
    keys(wanted, ['read', 'write', 'entries', 'globScanMaxDepth']);
    for (const field of ['read', 'write', 'entries']) {
      if (fs[field] != null) subset(fs[field], wanted[field]);
    }
    // Deny entries constrain other granted paths; dropping them would widen access.
    if ((wanted.entries || []).some(entry => entry.access === 'deny' && !(fs.entries || []).some(value => same(entry, value)))) {
      fail('Requested filesystem deny entries must be retained');
    }
    if (fs.globScanMaxDepth != null && (!Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 1 || fs.globScanMaxDepth !== wanted.globScanMaxDepth)) {
      fail('Filesystem scan depth must match the request');
    }
  }
  return { permissions: structuredClone(selected), scope: input.scope };
}
function inputResponse(request, input) {
  if (input.decision === 'cancel') return { answers: {} };
  const questions = request.params.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 20) fail('Questions cannot be answered safely');
  const ids = questions.map(q => q?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id.length > 512) || new Set(ids).size !== ids.length) fail('Question identities are invalid');
  keys(input.answers, ids);
  if (Object.keys(input.answers).length !== ids.length) fail('Answer every question explicitly');
  const answers = Object.create(null);
  for (const q of questions) {
    const entry = input.answers[q.id];
    keys(entry, ['answers']);
    if (!Array.isArray(entry.answers) || entry.answers.length !== 1 || typeof entry.answers[0] !== 'string' ||
        !entry.answers[0].trim() || entry.answers[0].length > 8192) fail('Each question needs one nonempty answer');
    if (q.options?.length && !q.isOther && !q.options.some(option => option.label === entry.answers[0])) fail('Choose an offered answer');
    answers[q.id] = { answers: [...entry.answers] };
  }
  return { answers };
}
export function codexInteractionResponse(request, input) {
  const granting = request.kind === 'userInput' ? input.decision !== 'cancel' : input.decision === 'accept';
  if (request.truncated && granting) throw Object.assign(new Error('Interaction details are truncated; cancel or decline this request'), { code: 'INTERACTION_TRUNCATED' });
  if (request.method === 'mcpServer/elicitation/request') return mcpResponse(request, input);
  if (request.kind === 'permissions') return permissionsResponse(request, input);
  if (request.kind === 'userInput') return inputResponse(request, input);
  if (!['accept', 'decline', 'cancel'].includes(input.decision)) fail('Approval decision is invalid');
  if (input.decision === 'accept' && Array.isArray(request.params.availableDecisions) &&
      !request.params.availableDecisions.includes('accept')) fail('This command did not offer approval');
  return { decision: input.decision };
}
