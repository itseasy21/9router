/**
 * AgentRouter time-bound model gating.
 *
 * AgentRouter allocates budget for `claude-opus-5` and `gpt-6-astra` in 2 daily
 * batches, at 10:00 and 19:00 Beijing Time = 02:00 and 11:00 UTC. Outside a
 * fresh batch the upstream returns:
 *
 *   HTTP 503: [agentrouter/claude-opus-5] [402]:
 *   {"error":{"message":"Budget pool quota has been exhausted. Please ask an
 *   administrator to increase the limit or select another budget pool."}}
 *
 * Strategy:
 *   - When that error is seen for a gated model, pause the model (in-memory)
 *     until the NEXT window start instead of letting every request burn a
 *     round-trip against a dead budget pool.
 *   - While paused, dispatch skips the model so combo/account fallback routes
 *     the request elsewhere; solo requests get a 503 with retry-after.
 *   - Pause expires automatically at the next window (budget refreshes) and is
 *     re-armed only if the upstream error appears again.
 *
 * Strictly scoped: provider `agentrouter` + the two model ids below. Nothing
 * else is ever gated. In-memory only — server restart clears it, which is fine
 * because the windows are daily.
 */

/** Provider this gating applies to */
export const AGENTROUTER_PROVIDER = "agentrouter";

/** Only these agentrouter models are budget-window bound */
export const AGENTROUTER_TIME_BOUND_MODELS = new Set([
  "claude-opus-5",
  "gpt-6-astra",
]);

/** Daily budget allocation windows, in UTC hours (10:00 / 19:00 Beijing) */
export const AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS = [2, 11];

/** Distinctive substring of the exhausted-budget-pool error (matched case-insensitively) */
const BUDGET_EXHAUSTED_MARKER = "budget pool quota has been exhausted";

/** model id → paused-until epoch ms (agentrouter models only) */
const pausedUntil = new Map();

const HOUR_MS = 60 * 60 * 1000;

/**
 * Is this provider+model pair subject to AgentRouter budget windows?
 * @param {string|null} provider
 * @param {string|null} model
 * @returns {boolean}
 */
export function isAgentRouterTimeBoundModel(provider, model) {
  return provider === AGENTROUTER_PROVIDER && AGENTROUTER_TIME_BOUND_MODELS.has(model);
}

/**
 * Epoch ms of the next budget window start strictly after `now`.
 * Windows are daily at 02:00 and 11:00 UTC.
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {number}
 */
export function getNextBudgetWindowStart(now = Date.now()) {
  const sorted = [...AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS].sort((a, b) => a - b);
  const base = new Date(now);
  const todayMidnightUtc = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  for (const h of sorted) {
    const t = todayMidnightUtc + h * HOUR_MS;
    if (t > now) return t;
  }
  // Past all of today's windows → first window tomorrow
  return todayMidnightUtc + 24 * HOUR_MS + sorted[0] * HOUR_MS;
}

/**
 * Record an upstream error: if it is the AgentRouter budget-pool exhaustion
 * error for a gated model, pause that model until the next window start.
 * @param {string|null} provider
 * @param {string|null} model
 * @param {number|string|null} status - HTTP status (503 envelope; [402] inside)
 * @param {string} errorText - upstream error message
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {boolean} true if a pause was recorded
 */
export function noteAgentRouterBudgetError(provider, model, status, errorText, now = Date.now()) {
  if (!isAgentRouterTimeBoundModel(provider, model)) return false;
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (!text.includes(BUDGET_EXHAUSTED_MARKER)) return false;
  const until = getNextBudgetWindowStart(now);
  pausedUntil.set(model, until);
  return true;
}

/**
 * Is the gated model currently paused (before the next window start)?
 * @param {string|null} provider
 * @param {string|null} model
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {boolean}
 */
export function isAgentRouterBudgetPaused(provider, model, now = Date.now()) {
  if (!isAgentRouterTimeBoundModel(provider, model)) return false;
  const until = pausedUntil.get(model);
  if (!until) return false;
  if (now >= until) {
    // Window reached: budget refreshed, un-pause
    pausedUntil.delete(model);
    return false;
  }
  return true;
}

/**
 * When does the pause for this model end? Null if not paused.
 * @param {string|null} model
 * @returns {number|null} epoch ms
 */
export function getAgentRouterPauseUntil(model) {
  return pausedUntil.get(model) ?? null;
}

/**
 * Clear all pauses (used by tests / manual admin override)
 */
export function clearAgentRouterPauses() {
  pausedUntil.clear();
}
