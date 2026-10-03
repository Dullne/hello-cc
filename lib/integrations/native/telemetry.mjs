// Preserve only counters actually reported by the upstream protocol. No token
// estimates, local duration substitutes, or cumulative-usage/context inference.
function fields(source, mapping) {
  const result = {};
  for (const [key, field] of Object.entries(mapping)) {
    const value = source?.[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

export function codexUsage(params, observedAt = Date.now()) {
  const usage = params?.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const counters = fields(usage.total, { inputTokens: 'inputTokens', outputTokens: 'outputTokens', cachedInputTokens: 'cachedInputTokens', totalTokens: 'totalTokens' });
  Object.assign(counters, fields(usage, { contextWindow: 'modelContextWindow' }));
  return Object.keys(counters).length ? { source: 'codex thread/tokenUsage/updated', scope: 'session', ...(params.turnId ? { turnId: params.turnId } : {}), observedAt, ...counters } : null;
}

export function claudeUsage(message, turnId, observedAt = Date.now()) {
  const counters = { ...fields(message?.usage, { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cachedInputTokens: 'cache_read_input_tokens', totalTokens: 'total_tokens' }),
    ...fields(message, { durationMs: 'duration_ms' }) };
  return Object.keys(counters).length ? { source: 'claude SDK result', scope: 'turn', ...(turnId ? { turnId } : {}), observedAt, ...counters } : null;
}

export function acpUsage(update, observedAt = Date.now()) {
  if (update?.sessionUpdate !== 'usage_update') return null;
  const counters = fields(update, { contextTokens: 'used', contextWindow: 'size' });
  return Object.keys(counters).length ? { source: 'ACP session/update usage_update', scope: 'session', observedAt, ...counters } : null;
}
