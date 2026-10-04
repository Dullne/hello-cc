// Bounded metadata for the opt-in real-interaction fixture. Never persist
// provider bodies, raw tool input, environment values, or arbitrary paths.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const methods = new Set(['session/request_permission', 'claude/canUseTool']);
const tools = new Set(['write', 'read', 'get', 'str_replace_editor', 'bash', 'Write', 'Read', 'Edit', 'Bash']);
const statuses = new Set(['ready', 'idle', 'busy', 'running', 'completed', 'failed', 'stopped', 'disconnected']);
const deliveryStates = new Set(['queued', 'pending', 'dispatching', 'dispatched', 'running', 'completed', 'failed', 'uncertain']);
const eventTypes = new Set(['item', 'turn', 'status', 'error', 'approval_requested', 'approval_resolved',
  'usage_update', 'agent_message', 'agent_thought', 'tool_call', 'tool_call_update', 'session_update']);
const kinds = new Set(['approval', 'permissions', 'userInput', 'elicitation']);
const safe = (value, allowed) => allowed.has(value) ? value : value == null ? null : 'other';
const identifier = value => Number.isSafeInteger(value) || (typeof value === 'string' && /^[\w.-]{1,120}$/.test(value)) ? value : null;
const timestamp = value => Number.isFinite(value) ? value : typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? value : null;

// rc.2 can ask once at tools/pre-execute and once inside write's explicit
// sandbox escalation. This recognizes only that same exact test-owned write;
// it never grants permission and is not a product approval policy.
export function isKnownDshEscalationApproval(first, next, { target, content, priorDecision, additionalAnswers = 0 } = {}) {
  if (priorDecision !== 'accept' || additionalAnswers !== 0 || !first || !next || first.requestId === next.requestId) return false;
  for (const key of ['executorId', 'sessionId', 'turnId']) if (typeof first[key] !== 'string' || !first[key] || first[key] !== next[key]) return false;
  for (const request of [first, next]) {
    if (identifier(request.requestId) === null) return false;
    if (request.method !== 'session/request_permission' || request.kind !== 'approval' || request.truncated) return false;
    const call = request.params?.toolCall, input = call?.rawInput;
    if (call?.title !== 'write' || call.contextPending || call.contextTruncated || typeof call.toolCallId !== 'string' || identifier(call.toolCallId) === null) return false;
    if (!input || input.file_path !== target || input.content !== content || input.sandbox_permissions !== 'danger-full-access') return false;
    if (typeof input.justification !== 'string' || !input.justification.trim() || input.justification.length > 1000) return false;
    if (!isDeepStrictEqual(Object.keys(input).sort(), ['content', 'file_path', 'justification', 'sandbox_permissions'])) return false;
    if (!request.params.options?.some(option => option.kind === 'allow_once')) return false;
  }
  return first.params.toolCall.toolCallId === next.params.toolCall.toolCallId &&
    isDeepStrictEqual(first.params.toolCall.rawInput, next.params.toolCall.rawInput);
}

function fileEvidence(target) {
  const result = { role: target.role, exists: false, regularFile: false, sha256: null };
  try {
    const stat = fs.lstatSync(target.path);
    result.exists = true; result.regularFile = stat.isFile();
    if (stat.isFile() && stat.size <= 8192) {
      const descriptor = fs.openSync(target.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(descriptor);
        if (current.isFile() && current.dev === stat.dev && current.ino === stat.ino && current.size <= 8192) {
          const content = Buffer.alloc(8193);
          const bytes = fs.readSync(descriptor, content, 0, content.length, 0);
          if (bytes <= 8192) result.sha256 = createHash('sha256').update(content.subarray(0, bytes)).digest('hex');
        }
      } finally { fs.closeSync(descriptor); }
    }
  } catch { /* An absent or unreadable test-owned target is not completion. */ }
  return result;
}

export function interactionCompletionDiagnostics(state, { answeredRequest, submissionId, ownedTargets = [] } = {}) {
  const pending = state?.snapshot?.pendingApprovals || [];
  const targets = ownedTargets.filter(target => ['allowed', 'denied'].includes(target.role) && typeof target.path === 'string');
  const differentRequest = Boolean(answeredRequest) && pending.some(request => request.requestId !== answeredRequest.requestId);
  const delivery = state?.deliveries?.find(row => row.submission_id === submissionId);
  const requests = pending.slice(0, 4).map(request => {
    const tool = request.params?.toolCall, input = tool?.rawInput || request.params?.input;
    const target = targets.find(target => input?.file_path === target.path || input?.path === target.path);
    return { requestId: identifier(request.requestId), method: safe(request.method, methods), kind: safe(request.kind, kinds),
      toolName: safe(tool?.title || request.params?.tool, tools), toolCallId: identifier(tool?.toolCallId),
      targetExactOwned: Boolean(target), targetRole: target?.role || null };
  });
  return {
    schemaVersion: 1, differentPendingRequest: differentRequest,
    answeredRequestId: identifier(answeredRequest?.requestId), status: safe(state?.snapshot?.status, statuses),
    deliveryState: safe(delivery?.state, deliveryStates), pendingCount: pending.length, pending: requests,
    recentEvents: (state?.events || []).slice(-8).map(event => ({
      type: safe(event.payload?.type || event.type, eventTypes),
      timestamp: timestamp(event.created_at ?? event.timestamp ?? event.at),
    })),
    targets: targets.map(fileEvidence),
  };
}
