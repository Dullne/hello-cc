// Read-only projection of official App Server account and quota data. Never
// forward emails, credential identifiers, tokens, raw errors or unknown fields.
const PLANS = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'team',
  'self_serve_business_usage_based', 'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown']);
const TYPES = new Set(['apiKey', 'chatgpt', 'amazonBedrock']);
const REASONS = new Set(['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bucketId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;

function windowValue(value) {
  if (!record(value) || !finite(value.usedPercent)) return null;
  return { usedPercent: value.usedPercent,
    resetsAt: integer(value.resetsAt) ? value.resetsAt : null,
    windowDurationMins: integer(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null };
}
function bucketValue(value, id = null) {
  if (!record(value)) return null;
  const primary = windowValue(value.primary), secondary = windowValue(value.secondary);
  const credits = record(value.credits) && typeof value.credits.hasCredits === 'boolean' && typeof value.credits.unlimited === 'boolean'
    ? { hasCredits: value.credits.hasCredits, unlimited: value.credits.unlimited } : null;
  if (!primary && !secondary && !credits && !REASONS.has(value.rateLimitReachedType)) return null;
  return { id: bucketId(id) || bucketId(value.limitId), primary, secondary, credits,
    planType: PLANS.has(value.planType) ? value.planType : null,
    reached: REASONS.has(value.rateLimitReachedType) ? value.rateLimitReachedType : null };
}
function unavailableReason(error) {
  return error?.code === -32601 || (error?.extra?.rpcCode ?? error?.extra?.rpc_code) === -32601 ? 'unsupported' : 'unavailable';
}
function accountValue(value) {
  if (!record(value) || typeof value.requiresOpenaiAuth !== 'boolean' ||
      (value.account != null && (!record(value.account) || !TYPES.has(value.account.type)))) return null;
  const type = value.account?.type || null;
  return { requiresOpenaiAuth: value.requiresOpenaiAuth, type,
    planType: type === 'chatgpt' && PLANS.has(value.account.planType) ? value.account.planType : null,
    authentication: value.requiresOpenaiAuth === false ? 'providerManaged' : type ? 'authenticated' : 'required' };
}

export function createCodexAccountState({ request, onChange = () => {}, now = Date.now } = {}) {
  let state = { status: 'unknown', stale: false, reason: null, type: null, planType: null,
    authentication: 'unknown', requiresOpenaiAuth: null, checkedAt: null,
    rateLimits: { status: 'unknown', stale: false, reason: null, checkedAt: null, buckets: [] } };
  let accountRevision = 0, limitsRevision = 0, inFlight = null, closed = false, recheck = false;
  const snapshot = () => structuredClone(state);
  const publish = () => { try { onChange(snapshot()); } catch {} };
  function relevantLimits() { return state.status === 'ready' && state.type === 'chatgpt' && state.requiresOpenaiAuth === true; }
  function notification(method, params = {}) {
    if (!['account/updated', 'account/rateLimits/updated', 'account/login/completed'].includes(method)) return false;
    if (closed) return true;
    if (method !== 'account/rateLimits/updated') {
      // Account changes can precede a read reply. That older response cannot
      // reattach the previous account's quotas to the current executor.
      accountRevision++; limitsRevision++; recheck = true;
      state = { ...state, status: 'unknown', stale: true, reason: null, type: null, planType: null,
        authentication: 'unknown', requiresOpenaiAuth: null,
        rateLimits: { status: 'unknown', stale: false, reason: null, checkedAt: null, buckets: [] } };
      publish();
      queueMicrotask(() => { if (!closed && !inFlight) void refresh(); });
      return true;
    }
    if (!relevantLimits()) return true;
    const next = bucketValue(params.rateLimits);
    if (!next) return true;
    limitsRevision++;
    const buckets = state.rateLimits.buckets.slice();
    if (next.id === null && buckets.length === 1) next.id = buckets[0].id;
    if (next.id === null && buckets.length > 1 && !buckets.some(entry => entry.id === null)) return true;
    const index = buckets.findIndex(entry => entry.id === next.id);
    if (index < 0) { if (buckets.length < 16) buckets.push(next); }
    else {
      const previous = buckets[index];
      // Rolling updates are sparse. Null metadata/windows mean unavailable in
      // this update, not a quota of zero or a request to erase the prior value.
      buckets[index] = Object.fromEntries(Object.keys(next).map(key => [key,
        ['primary', 'secondary'].includes(key) && next[key] && previous[key]
          ? Object.fromEntries(Object.keys(next[key]).map(field => [field, next[key][field] ?? previous[key][field]]))
          : next[key] ?? previous[key]]));
    }
    state.rateLimits = { status: 'ready', stale: false, reason: null, checkedAt: now(), buckets };
    publish(); return true;
  }
  async function read() {
    const revision = accountRevision;
    recheck = false;
    let value;
    try { value = accountValue(await request('account/read', { refreshToken: false }));
      if (!value) throw Object.assign(new Error('Invalid account response'), { code: 'CODEX_ACCOUNT_PROTOCOL_ERROR' });
    } catch (error) {
      if (!closed && revision === accountRevision) {
        state.status = 'unavailable'; state.stale = state.checkedAt !== null; state.reason = unavailableReason(error);
        state.authentication = 'unknown';
        state.rateLimits = { ...state.rateLimits, status: 'unavailable', stale: state.rateLimits.checkedAt !== null, reason: 'unavailable' };
        publish();
      }
      return snapshot();
    }
    if (closed || revision !== accountRevision) return snapshot();
    state = { ...state, ...value, status: 'ready', stale: false, reason: null, checkedAt: now() };
    if (!relevantLimits()) {
      state.rateLimits = { status: 'notApplicable', stale: false, reason: null, checkedAt: null, buckets: [] };
      publish(); return snapshot();
    }
    publish();
    const quotaRevision = limitsRevision;
    try {
      const response = await request('account/rateLimits/read', {});
      if (!record(response) || !record(response.rateLimits)) throw new Error('Invalid quota response');
      const entries = record(response.rateLimitsByLimitId) ? Object.entries(response.rateLimitsByLimitId)
        .filter(([id]) => bucketId(id)).slice(0, 16).map(([id, bucket]) => bucketValue(bucket, id)).filter(Boolean) : [];
      const legacy = bucketValue(response.rateLimits);
      const buckets = entries.length ? entries : legacy ? [legacy] : [];
      if (!closed && revision === accountRevision && quotaRevision === limitsRevision) {
        state.rateLimits = { status: buckets.length ? 'ready' : 'unavailable', stale: false,
          reason: buckets.length ? null : 'unavailable', checkedAt: buckets.length ? now() : null, buckets };
        publish();
      }
    } catch (error) {
      if (!closed && revision === accountRevision && quotaRevision === limitsRevision) {
        state.rateLimits = { ...state.rateLimits, status: 'unavailable', stale: state.rateLimits.checkedAt !== null, reason: unavailableReason(error) };
        publish();
      }
    }
    return snapshot();
  }
  function refresh() {
    if (closed) return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    inFlight = read().finally(() => {
      inFlight = null;
      if (recheck && !closed) queueMicrotask(() => { if (!inFlight && !closed) void refresh(); });
    });
    return inFlight;
  }
  function close() {
    closed = true; accountRevision++; limitsRevision++;
    state.status = 'unavailable'; state.stale = state.checkedAt !== null; state.reason = 'disconnected';
    state.authentication = 'unknown';
    state.rateLimits = { ...state.rateLimits, status: 'unavailable', stale: state.rateLimits.checkedAt !== null, reason: 'disconnected' };
  }
  return { snapshot, refresh, notification, close };
}
