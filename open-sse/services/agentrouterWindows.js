/**
 * AgentRouter time-bound model gating.
 *
 * AgentRouter releases some models' supply in daily batches. When a batch is
 * exhausted the upstream returns:
 *
 *   HTTP 503: [agentrouter/<model>] [402]:
 *   {"error":{"message":"Budget pool quota has been exhausted. Please ask an
 *   administrator to increase the limit or select another budget pool."}}
 *
 * Schedule (Beijing = UTC+8):
 *   - claude-opus-5 : 10:00 / 19:00 Beijing = 02:00 / 11:00 UTC
 *   - gpt-6-astra   : 15:00 / 03:00 Beijing = 07:00 / 19:00 UTC — the supply of
 *                      a batch lasts only while it lasts
 *   - sol line      : released 24/7 ("gpt-6.1sol is no longer limited in
 *                      quantity — it is now available 24/7"), never gated
 *
 * Strategy:
 *   - When the exhausted-budget error is seen for a gated model, pause the model
 *     (in-memory) until the NEXT window start instead of letting every request
 *     burn a round-trip against a dead budget pool.
 *   - While paused, dispatch skips the model so combo/account fallback routes
 *     the request elsewhere; solo requests get a 503 with retry-after.
 *   - Pause expires automatically at the next window (budget refreshes) and is
 *     re-armed only if the upstream error appears again.
 *
 * Strictly scoped: provider `agentrouter` + the models that have a window
 * schedule below. Nothing else is ever gated. In-memory only — server restart
 * clears it, which is fine because the windows are daily.
 */

/** Provider this gating applies to */
export const AGENTROUTER_PROVIDER = "agentrouter";

/**
 * Daily budget allocation windows per model, in UTC hours (sorted ascending).
 * Beijing time = UTC + 8.
 */
export const AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS = {
  "claude-opus-5": [2, 11],  // 10:00 / 19:00 Beijing
  "gpt-6-astra": [7, 19],    // 15:00 / 03:00 Beijing
};

/**
 * Models released 24/7 — no batch, so never time-gated. Matched on the id
 * suffix so every sol revision (gpt-5.6-sol, gpt-6-sol, gpt-6.1-sol) stays
 * ungated even when it is not the id the upstream announcement used.
 */
export const AGENTROUTER_UNLIMITED_MODEL_PATTERN = /sol$/i;

/** The gated models (derived from the schedule map) */
export const AGENTROUTER_TIME_BOUND_MODELS = new Set(
  Object.keys(AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS)
);

/** Distinctive substring of the exhausted-budget-pool error (matched case-insensitively) */
const BUDGET_EXHAUSTED_MARKER = "budget pool quota has been exhausted";

/** model id → paused-until epoch ms (agentrouter models only) */
const pausedUntil = new Map();

const HOUR_MS = 60 * 60 * 1000;
const BEIJING_OFFSET_HOURS = 8;

/**
 * Strip the 9router thinking override "model(level)" — it is a client-side
 * annotation, not part of the upstream id (same convention as
 * open-sse/providers/models/helpers.js). The window schedule must match the
 * base id, otherwise "ar/gpt-6-astra(max)" would slip past the gate.
 * @param {string|null} model
 * @returns {string} base model id ("" when not a string)
 */
function baseModelId(model) {
  if (typeof model !== "string") return "";
  return model.replace(/\([^()]+\)\s*$/, "").trim();
}

/**
 * Budget windows (UTC hours) for a model, or null when it is not gated.
 * @param {string|null} model
 * @returns {number[]|null}
 */
export function getAgentRouterBudgetWindows(model) {
  const base = baseModelId(model);
  if (!base) return null;
  if (AGENTROUTER_UNLIMITED_MODEL_PATTERN.test(base)) return null;
  const hours = AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS[base];
  if (!Array.isArray(hours) || hours.length === 0) return null;
  return [...hours].sort((a, b) => a - b);
}

/**
 * Is this provider+model pair subject to AgentRouter budget windows?
 * @param {string|null} provider
 * @param {string|null} model
 * @returns {boolean}
 */
export function isAgentRouterTimeBoundModel(provider, model) {
  return provider === AGENTROUTER_PROVIDER && getAgentRouterBudgetWindows(model) !== null;
}

/**
 * Epoch ms of the next budget window start strictly after `now`.
 * Windows are daily, per model (see AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS).
 * @param {string|null} model
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {number|null} epoch ms, or null when the model has no windows
 */
export function getNextBudgetWindowStart(model, now = Date.now()) {
  const windows = getAgentRouterBudgetWindows(model);
  if (!windows) return null;
  const base = new Date(now);
  const todayMidnightUtc = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  for (const h of windows) {
    const t = todayMidnightUtc + h * HOUR_MS;
    if (t > now) return t;
  }
  // Past all of today's windows → first window tomorrow
  return todayMidnightUtc + 24 * HOUR_MS + windows[0] * HOUR_MS;
}

/**
 * Human-readable window times for logs and client messages,
 * e.g. "07:00/19:00 UTC (15:00/03:00 Beijing)".
 * @param {string|null} model
 * @returns {string|null}
 */
export function formatAgentRouterWindowTimes(model) {
  const windows = getAgentRouterBudgetWindows(model);
  if (!windows) return null;
  const utc = `${windows.map(h => `${String(h).padStart(2, "0")}:00`).join("/")} UTC`;
  const beijing = windows
    .map(h => `${String((h + BEIJING_OFFSET_HOURS) % 24).padStart(2, "0")}:00`)
    .join("/");
  return `${utc} (${beijing} Beijing)`;
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
  const until = getNextBudgetWindowStart(model, now);
  if (until === null) return false;
  pausedUntil.set(baseModelId(model), until);
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
  const base = baseModelId(model);
  const until = pausedUntil.get(base);
  if (!until) return false;
  if (now >= until) {
    // Window reached: budget refreshed, un-pause
    pausedUntil.delete(base);
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
  return pausedUntil.get(baseModelId(model)) ?? null;
}

/**
 * Clear all pauses (used by tests / manual admin override)
 */
export function clearAgentRouterPauses() {
  pausedUntil.clear();
}
