import { CODEX_INTERACTION_METHODS } from '../integrations/codex-interactions.mjs';

// A bounded upgrade gate, not a JSON Schema validator or a runtime permission
// check. Generated types remain the authoritative version-specific artifacts.
export const CODEX_CLIENT_METHODS = Object.freeze([
  'initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/list',
  'thread/fork', 'turn/start', 'turn/steer', 'turn/interrupt',
  'mcpServerStatus/list', 'mcpServer/tool/call', 'account/read', 'account/rateLimits/read'
]);
export const CODEX_NOTIFICATION_METHODS = Object.freeze([
  'thread/started', 'thread/status/changed', 'turn/started', 'turn/completed',
  'turn/plan/updated', 'turn/diff/updated', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'serverRequest/resolved', 'error',
  'account/updated', 'account/login/completed', 'account/rateLimits/updated'
]);
const ACCOUNT_SCHEMA_FILES = ['GetAccountParams', 'GetAccountResponse', 'GetAccountRateLimitsResponse',
  'AccountUpdatedNotification', 'AccountLoginCompletedNotification', 'AccountRateLimitsUpdatedNotification'];
export const CODEX_PROTOCOL_SCHEMA_FILES = Object.freeze([
  'ClientRequest', 'ClientNotification', 'ServerRequest', 'ServerNotification',
  'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse',
  'PermissionsRequestApprovalResponse', 'ToolRequestUserInputResponse',
  'McpServerElicitationRequestParams', 'McpServerElicitationRequestResponse',
  ...ACCOUNT_SCHEMA_FILES
]);
// Official account schemas are generated only in the versioned v2 directory.
export const CODEX_PROTOCOL_SCHEMA_PATHS = Object.freeze(Object.fromEntries(CODEX_PROTOCOL_SCHEMA_FILES
  .map(name => [name, (ACCOUNT_SCHEMA_FILES.includes(name) ? 'v2/' : '') + name + '.json'])));

function methods(schema) {
  return (schema?.oneOf || []).flatMap(row => row.properties?.method?.enum || []);
}
function enumValues(schema, document, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.$ref) {
    const ref = schema.$ref;
    if (seen.has(ref) || !ref.startsWith('#/definitions/')) return [];
    const next = new Set(seen); next.add(ref);
    return enumValues(document.definitions?.[ref.slice('#/definitions/'.length)], document, next);
  }
  return [...(schema.enum || []), ...(Object.hasOwn(schema, 'const') ? [schema.const] : []),
    ...['oneOf', 'anyOf', 'allOf'].flatMap(key => (schema[key] || []).flatMap(row => enumValues(row, document, seen)))];
}

export function inspectCodexProtocol(schemas) {
  const checks = [];
  const check = (contract, ok) => checks.push({ contract, status: ok ? 'pass' : 'fail' });
  for (const [file, expected] of [
    ['ClientRequest', CODEX_CLIENT_METHODS], ['ClientNotification', ['initialized']],
    ['ServerRequest', [...CODEX_INTERACTION_METHODS]], ['ServerNotification', CODEX_NOTIFICATION_METHODS]
  ]) {
    const available = methods(schemas[file]);
    for (const method of expected) check(`${file}: ${method}`, available.includes(method));
  }
  for (const [file, fields] of [
    ['CommandExecutionRequestApprovalResponse', ['decision']],
    ['FileChangeRequestApprovalResponse', ['decision']],
    ['PermissionsRequestApprovalResponse', ['permissions', 'scope']],
    ['ToolRequestUserInputResponse', ['answers']],
    ['McpServerElicitationRequestResponse', ['action', 'content']]
  ]) {
    const schema = schemas[file];
    check(`${file}: response fields`, fields.every(field => Object.hasOwn(schema?.properties || {}, field)));
    // HCC never supplies unknown required response fields. Optional extensions
    // are compatible with this gate; new required fields demand adapter review.
    check(`${file}: no new required response fields`, Boolean(schema) && (schema.required || []).every(field => fields.includes(field)));
  }
  for (const [file, field, expected] of [
    ['CommandExecutionRequestApprovalResponse', 'decision', ['accept', 'decline', 'cancel']],
    ['FileChangeRequestApprovalResponse', 'decision', ['accept', 'decline', 'cancel']],
    ['PermissionsRequestApprovalResponse', 'scope', ['turn', 'session']],
    ['McpServerElicitationRequestResponse', 'action', ['accept', 'decline', 'cancel']]
  ]) {
    const values = enumValues(schemas[file]?.properties?.[field], schemas[file] || {});
    check(`${file}: ${field} choices`, expected.every(value => values.includes(value)));
  }
  const elicitation = schemas.McpServerElicitationRequestParams;
  check('MCP elicitation: thread and server identity',
    ['threadId', 'serverName'].every(field => elicitation?.required?.includes(field)) &&
    Object.hasOwn(elicitation?.properties || {}, 'turnId'));
  for (const [mode, fields] of [['form', ['message', 'mode', 'requestedSchema']], ['url', ['message', 'mode', 'elicitationId', 'url']]]) {
    check(`MCP elicitation: ${mode} identity and payload`, Boolean(elicitation?.oneOf?.some(row =>
      row.properties?.mode?.enum?.includes(mode) && fields.every(field => row.required?.includes(field) && Object.hasOwn(row.properties || {}, field)))));
  }
  check('Account read: explicit nonrefreshing option', schemas.GetAccountParams?.properties?.refreshToken?.type === 'boolean' &&
    (schemas.GetAccountParams?.required || []).every(field => field === 'refreshToken'));
  check('Account read: auth requirement is explicit', schemas.GetAccountResponse?.required?.includes('requiresOpenaiAuth') &&
    schemas.GetAccountResponse?.properties?.requiresOpenaiAuth?.type === 'boolean');
  check('Account read: recognized account types', ['apiKey', 'chatgpt', 'amazonBedrock'].every(type =>
    schemas.GetAccountResponse?.definitions?.Account?.oneOf?.some(row => row.properties?.type?.enum?.includes(type))));
  check('Account limits: historical and multi-bucket fields', ['rateLimits', 'rateLimitsByLimitId'].every(field =>
    Object.hasOwn(schemas.GetAccountRateLimitsResponse?.properties || {}, field)));
  check('Account limits: window percentage', schemas.GetAccountRateLimitsResponse?.definitions?.RateLimitWindow?.required?.includes('usedPercent') &&
    ['integer', 'number'].includes(schemas.GetAccountRateLimitsResponse?.definitions?.RateLimitWindow?.properties?.usedPercent?.type));
  check('Account notifications: status and quota fields', Object.hasOwn(schemas.AccountUpdatedNotification?.properties || {}, 'authMode') &&
    Object.hasOwn(schemas.AccountUpdatedNotification?.properties || {}, 'planType') && schemas.AccountRateLimitsUpdatedNotification?.required?.includes('rateLimits'));
  check('Account notification: correlated login completion', schemas.AccountLoginCompletedNotification?.required?.includes('success') &&
    Object.hasOwn(schemas.AccountLoginCompletedNotification?.properties || {}, 'loginId'));
  const unsupportedServerRequests = methods(schemas.ServerRequest).filter(method => !CODEX_INTERACTION_METHODS.has(method)).sort();
  return {
    status: checks.every(entry => entry.status === 'pass') ? 'compatible' : 'incompatible',
    checks, unsupportedServerRequests,
    scope: 'Method presence, response fields and choices, MCP form/URL identity, and read-only account/quota fields; not full schema or runtime validation.',
    inferenceCalled: false, accountAccessed: false
  };
}
