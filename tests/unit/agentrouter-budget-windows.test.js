// AgentRouter time-bound model gating: claude-opus-5 and gpt-6-astra get budget
// in 2 daily batches at 10:00/19:00 Beijing = 02:00/11:00 UTC. When the upstream
// returns the "Budget pool quota has been exhausted" error, the model must pause
// until the next window start and un-pause automatically when it arrives.
// Strictly scoped to agentrouter + those two models — nothing else is gated.
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTROUTER_TIME_BOUND_MODELS,
  clearAgentRouterPauses,
  getAgentRouterPauseUntil,
  getNextBudgetWindowStart,
  isAgentRouterBudgetPaused,
  isAgentRouterTimeBoundModel,
  noteAgentRouterBudgetError,
} from "../../open-sse/services/agentrouterWindows.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const HOUR = 60 * 60 * 1000;
// 2026-10-05 is a Tuesday; all timestamps below are UTC.
const DAY = Date.UTC(2026, 9, 5);

const BUDGET_ERROR = JSON.stringify({
  error: {
    message: "Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool. (request id: 202610051731517583271655k8kcJdQ5RbQV)",
    type: "bad_response_status_code",
  },
  type: "error",
});

afterEach(() => clearAgentRouterPauses());

describe("getNextBudgetWindowStart — 02:00 / 11:00 UTC daily windows", () => {
  it("returns 02:00 UTC when before the first window", () => {
    expect(getNextBudgetWindowStart(DAY + 1 * HOUR)).toBe(DAY + 2 * HOUR);
    expect(getNextBudgetWindowStart(DAY + 1 * HOUR + 59 * 60 * 1000 + 59 * 1000)).toBe(DAY + 2 * HOUR);
  });

  it("returns 11:00 UTC between the two windows", () => {
    expect(getNextBudgetWindowStart(DAY + 2 * HOUR)).toBe(DAY + 11 * HOUR);
    expect(getNextBudgetWindowStart(DAY + 10 * HOUR + 59 * 60 * 1000)).toBe(DAY + 11 * HOUR);
  });

  it("rolls over to tomorrow's 02:00 UTC after the last window", () => {
    expect(getNextBudgetWindowStart(DAY + 11 * HOUR)).toBe(DAY + 24 * HOUR + 2 * HOUR);
    expect(getNextBudgetWindowStart(DAY + 23 * HOUR + 59 * 60 * 1000)).toBe(DAY + 24 * HOUR + 2 * HOUR);
  });

  it("never returns a window in the past (strictly after now)", () => {
    const now = Date.now();
    expect(getNextBudgetWindowStart(now)).toBeGreaterThan(now);
  });
});

describe("isAgentRouterTimeBoundModel — strict scoping", () => {
  it("gates only agentrouter's claude-opus-5 and gpt-6-astra", () => {
    expect(isAgentRouterTimeBoundModel("agentrouter", "claude-opus-5")).toBe(true);
    expect(isAgentRouterTimeBoundModel("agentrouter", "gpt-6-astra")).toBe(true);
    expect(AGENTROUTER_TIME_BOUND_MODELS).toEqual(new Set(["claude-opus-5", "gpt-6-astra"]));
  });

  it("does not gate other agentrouter models", () => {
    expect(isAgentRouterTimeBoundModel("agentrouter", "glm-5.3")).toBe(false);
    expect(isAgentRouterTimeBoundModel("agentrouter", "claude-sonnet-5")).toBe(false);
  });

  it("does not gate the same model ids on other providers", () => {
    expect(isAgentRouterTimeBoundModel("openrouter", "claude-opus-5")).toBe(false);
    expect(isAgentRouterTimeBoundModel(null, "gpt-6-astra")).toBe(false);
    expect(isAgentRouterTimeBoundModel("agentrouter", null)).toBe(false);
  });
});

describe("noteAgentRouterBudgetError — pause on the upstream error", () => {
  it("pauses the gated model until the next window on the exact 503/[402] error", () => {
    const now = DAY + 12 * HOUR; // after both windows → next is tomorrow 02:00
    const paused = noteAgentRouterBudgetError("agentrouter", "claude-opus-5", 503, BUDGET_ERROR, now);

    expect(paused).toBe(true);
    expect(getAgentRouterPauseUntil("claude-opus-5")).toBe(DAY + 24 * HOUR + 2 * HOUR);
    expect(isAgentRouterBudgetPaused("agentrouter", "claude-opus-5", now)).toBe(true);
  });

  it("also pauses when the raw text is passed without the JSON envelope", () => {
    const now = DAY + 1 * HOUR;
    expect(noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, "Budget pool quota has been exhausted. Please ask an administrator...", now)).toBe(true);
    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBe(DAY + 2 * HOUR);
  });

  it("does not pause for other errors on a gated model", () => {
    expect(noteAgentRouterBudgetError("agentrouter", "claude-opus-5", 503, "overloaded", DAY + 12 * HOUR)).toBe(false);
    expect(noteAgentRouterBudgetError("agentrouter", "claude-opus-5", 401, BUDGET_ERROR.replace("Budget pool quota has been exhausted", "unauthorized"), DAY + 12 * HOUR)).toBe(false);
    expect(isAgentRouterBudgetPaused("agentrouter", "claude-opus-5", DAY + 12 * HOUR)).toBe(false);
  });

  it("does not pause non-gated models even with the budget error", () => {
    expect(noteAgentRouterBudgetError("agentrouter", "glm-5.3", 503, BUDGET_ERROR, DAY + 12 * HOUR)).toBe(false);
    expect(noteAgentRouterBudgetError("openrouter", "claude-opus-5", 503, BUDGET_ERROR, DAY + 12 * HOUR)).toBe(false);
    expect(getAgentRouterPauseUntil("glm-5.3")).toBeNull();
  });
});

describe("isAgentRouterBudgetPaused — un-pause at the next window", () => {
  it("stays paused until the window, then un-pauses automatically", () => {
    const now = DAY + 1 * HOUR; // next window: 02:00
    noteAgentRouterBudgetError("agentrouter", "claude-opus-5", 503, BUDGET_ERROR, now);

    expect(isAgentRouterBudgetPaused("agentrouter", "claude-opus-5", now + 30 * 60 * 1000)).toBe(true);
    // Exactly at the window start: budget refreshed, model usable again
    expect(isAgentRouterBudgetPaused("agentrouter", "claude-opus-5", DAY + 2 * HOUR)).toBe(false);
    // Pause state is consumed after expiry
    expect(getAgentRouterPauseUntil("claude-opus-5")).toBeNull();
  });

  it("re-arms the pause when the budget exhausts again in the new window", () => {
    const now = DAY + 1 * HOUR;
    noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, BUDGET_ERROR, now);

    const nextWindow = DAY + 2 * HOUR;
    isAgentRouterBudgetPaused("agentrouter", "gpt-6-astra", nextWindow); // un-pause
    noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, BUDGET_ERROR, nextWindow + 1);

    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBe(DAY + 11 * HOUR);
    expect(isAgentRouterBudgetPaused("agentrouter", "gpt-6-astra", nextWindow + 1)).toBe(true);
  });
});

describe("integration with existing fallback machinery", () => {
  it("budget-pool exhaustion still triggers account/model fallback", () => {
    const result = checkFallbackError(503, `HTTP 503: [agentrouter/claude-opus-5] [402]: ${BUDGET_ERROR}`);
    expect(result.shouldFallback).toBe(true);
  });

  it("the gate's 503 response text falls through to the next combo model", () => {
    // handleSingleModelChat returns this message while paused; the combo loop
    // must treat it as a fallback-able failure, not a hard stop.
    const gateMessage = "[agentrouter/claude-opus-5] budget window exhausted — retry after next allocation window";
    const result = checkFallbackError(503, gateMessage);
    expect(result.shouldFallback).toBe(true);
  });
});
