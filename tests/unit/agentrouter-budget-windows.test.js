// AgentRouter time-bound model gating. Supply is released in daily batches:
//   - claude-opus-5 : 10:00 / 19:00 Beijing = 02:00 / 11:00 UTC
//   - gpt-6-astra   : 15:00 / 03:00 Beijing = 07:00 / 19:00 UTC (batch lasts
//                      only while it lasts)
//   - the sol line   : released 24/7 — never gated
// When the upstream returns the "Budget pool quota has been exhausted" error,
// the model must pause until the next window start of ITS OWN schedule and
// un-pause automatically when it arrives. Strictly scoped to agentrouter —
// nothing else is gated.
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS,
  AGENTROUTER_TIME_BOUND_MODELS,
  clearAgentRouterPauses,
  formatAgentRouterWindowTimes,
  getAgentRouterBudgetWindows,
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

describe("getNextBudgetWindowStart — per-model daily windows", () => {
  it("claude-opus-5 keeps 02:00 / 11:00 UTC (10:00 / 19:00 Beijing)", () => {
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 1 * HOUR)).toBe(DAY + 2 * HOUR);
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 1 * HOUR + 59 * 60 * 1000 + 59 * 1000)).toBe(DAY + 2 * HOUR);
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 2 * HOUR)).toBe(DAY + 11 * HOUR);
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 10 * HOUR + 59 * 60 * 1000)).toBe(DAY + 11 * HOUR);
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 11 * HOUR)).toBe(DAY + 24 * HOUR + 2 * HOUR);
    expect(getNextBudgetWindowStart("claude-opus-5", DAY + 23 * HOUR + 59 * 60 * 1000)).toBe(DAY + 24 * HOUR + 2 * HOUR);
  });

  it("gpt-6-astra uses the new 07:00 / 19:00 UTC (15:00 / 03:00 Beijing)", () => {
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 1 * HOUR)).toBe(DAY + 7 * HOUR);
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 6 * HOUR + 59 * 60 * 1000)).toBe(DAY + 7 * HOUR);
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 7 * HOUR)).toBe(DAY + 19 * HOUR);
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 18 * HOUR + 59 * 60 * 1000)).toBe(DAY + 19 * HOUR);
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 19 * HOUR)).toBe(DAY + 24 * HOUR + 7 * HOUR);
    expect(getNextBudgetWindowStart("gpt-6-astra", DAY + 23 * HOUR + 59 * 60 * 1000)).toBe(DAY + 24 * HOUR + 7 * HOUR);
  });

  it("never returns a window in the past (strictly after now)", () => {
    const now = Date.now();
    expect(getNextBudgetWindowStart("claude-opus-5", now)).toBeGreaterThan(now);
    expect(getNextBudgetWindowStart("gpt-6-astra", now)).toBeGreaterThan(now);
  });

  it("returns null for models without a schedule (24/7 models)", () => {
    expect(getNextBudgetWindowStart("gpt-6.1-sol", DAY + 1 * HOUR)).toBeNull();
    expect(getNextBudgetWindowStart("gpt-5.6-sol", DAY + 1 * HOUR)).toBeNull();
  });
});

describe("getAgentRouterBudgetWindows — schedule lookup", () => {
  it("exposes the per-model window hours", () => {
    expect(getAgentRouterBudgetWindows("claude-opus-5")).toEqual([2, 11]);
    expect(getAgentRouterBudgetWindows("gpt-6-astra")).toEqual([7, 19]);
    expect(AGENTROUTER_BUDGET_WINDOWS_UTC_HOURS["gpt-6-astra"]).toEqual([7, 19]);
  });

  it("returns null for ungated models", () => {
    expect(getAgentRouterBudgetWindows("gpt-6.1-sol")).toBeNull();
    expect(getAgentRouterBudgetWindows("glm-5.3")).toBeNull();
    expect(getAgentRouterBudgetWindows(null)).toBeNull();
  });
});

describe("formatAgentRouterWindowTimes — logs and client messages", () => {
  it("renders both UTC and Beijing release times", () => {
    expect(formatAgentRouterWindowTimes("gpt-6-astra")).toBe("07:00/19:00 UTC (15:00/03:00 Beijing)");
    expect(formatAgentRouterWindowTimes("claude-opus-5")).toBe("02:00/11:00 UTC (10:00/19:00 Beijing)");
  });

  it("returns null for ungated models", () => {
    expect(formatAgentRouterWindowTimes("gpt-6.1-sol")).toBeNull();
  });
});

describe("isAgentRouterTimeBoundModel — strict scoping", () => {
  it("gates only agentrouter's claude-opus-5 and gpt-6-astra", () => {
    expect(isAgentRouterTimeBoundModel("agentrouter", "claude-opus-5")).toBe(true);
    expect(isAgentRouterTimeBoundModel("agentrouter", "gpt-6-astra")).toBe(true);
    expect(AGENTROUTER_TIME_BOUND_MODELS).toEqual(new Set(["claude-opus-5", "gpt-6-astra"]));
  });

  it("does not gate the sol line — it is released 24/7", () => {
    expect(isAgentRouterTimeBoundModel("agentrouter", "gpt-6.1-sol")).toBe(false);
    expect(isAgentRouterTimeBoundModel("agentrouter", "gpt-6-sol")).toBe(false);
    expect(isAgentRouterTimeBoundModel("agentrouter", "gpt-5.6-sol")).toBe(false);
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
    const now = DAY + 20 * HOUR; // after both windows → next is tomorrow 02:00
    const paused = noteAgentRouterBudgetError("agentrouter", "claude-opus-5", 503, BUDGET_ERROR, now);

    expect(paused).toBe(true);
    expect(getAgentRouterPauseUntil("claude-opus-5")).toBe(DAY + 24 * HOUR + 2 * HOUR);
    expect(isAgentRouterBudgetPaused("agentrouter", "claude-opus-5", now)).toBe(true);
  });

  it("pauses gpt-6-astra until ITS window, not the opus-5 schedule", () => {
    const now = DAY + 1 * HOUR;
    expect(noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, "Budget pool quota has been exhausted. Please ask an administrator...", now)).toBe(true);
    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBe(DAY + 7 * HOUR);
  });

  it("also pauses when the raw text is passed without the JSON envelope", () => {
    const now = DAY + 1 * HOUR;
    expect(noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, "Budget pool quota has been exhausted. Please ask an administrator...", now)).toBe(true);
    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBe(DAY + 7 * HOUR);
  });

  it("never pauses the 24/7 sol line", () => {
    const now = DAY + 12 * HOUR;
    expect(noteAgentRouterBudgetError("agentrouter", "gpt-6.1-sol", 503, BUDGET_ERROR, now)).toBe(false);
    expect(noteAgentRouterBudgetError("agentrouter", "gpt-5.6-sol", 503, BUDGET_ERROR, now)).toBe(false);
    expect(getAgentRouterPauseUntil("gpt-6.1-sol")).toBeNull();
    expect(isAgentRouterBudgetPaused("agentrouter", "gpt-6.1-sol", now)).toBe(false);
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

  it("un-pauses gpt-6-astra at its own 07:00 UTC window", () => {
    const now = DAY + 1 * HOUR;
    noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, BUDGET_ERROR, now);

    expect(isAgentRouterBudgetPaused("agentrouter", "gpt-6-astra", DAY + 6 * HOUR)).toBe(true);
    expect(isAgentRouterBudgetPaused("agentrouter", "gpt-6-astra", DAY + 7 * HOUR)).toBe(false);
    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBeNull();
  });

  it("re-arms the pause when the budget exhausts again in the new window", () => {
    const now = DAY + 1 * HOUR;
    noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, BUDGET_ERROR, now);

    const nextWindow = DAY + 7 * HOUR;
    isAgentRouterBudgetPaused("agentrouter", "gpt-6-astra", nextWindow); // un-pause
    noteAgentRouterBudgetError("agentrouter", "gpt-6-astra", 503, BUDGET_ERROR, nextWindow + 1);

    expect(getAgentRouterPauseUntil("gpt-6-astra")).toBe(DAY + 19 * HOUR);
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
    const gateMessage = "[agentrouter/gpt-6-astra] supply exhausted — next batch at 07:00/19:00 UTC (15:00/03:00 Beijing)";
    const result = checkFallbackError(503, gateMessage);
    expect(result.shouldFallback).toBe(true);
  });
});
