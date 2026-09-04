// AgentRouter thinking bridge: per-model effort limits + claude-adaptive clamp.
// GLM-5.3 supports max (z.ai enum); GPT-5.6 Sol tops out at xhigh (no max).
// claude-adaptive output_config.effort must be gated by supportedLevels so the
// max→xhigh clamp applies on AgentRouter but official Claude (levelMax set) keeps max.
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const apply = (model, body, provider = "agentrouter") => {
  const b = JSON.parse(JSON.stringify(body));
  applyThinking("claude", model, b, provider);
  return b;
};

describe("agentrouter thinking levels (UI picker)", () => {
  it("glm-5.3 supports max (z.ai enum low|high|max, no none)", () => {
    expect(getThinkingLevels("agentrouter", "glm-5.3")).toEqual(["low", "high", "max"]);
  });
  it("gpt-5.6-sol tops out at xhigh (no max)", () => {
    expect(getThinkingLevels("agentrouter", "gpt-5.6-sol")).toEqual([
      "none", "minimal", "low", "medium", "high", "xhigh",
    ]);
  });
  it("deepseek-v4-flash keeps the claude-budget default set", () => {
    expect(getThinkingLevels("agentrouter", "deepseek-v4-flash")).toEqual([
      "none", "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

describe("agentrouter claude-adaptive effort clamp (gpt-5.6-sol)", () => {
  it("effort max → xhigh (upstream rejects max)", () => {
    const out = apply("gpt-5.6-sol", { output_config: { effort: "max" } });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });
  it("effort ultra → xhigh", () => {
    const out = apply("gpt-5.6-sol", { output_config: { effort: "ultra" } });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });
  it("effort xhigh passes through untouched", () => {
    const out = apply("gpt-5.6-sol", { output_config: { effort: "xhigh" } });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });
  it("reasoning_effort max (OpenAI source) → xhigh", () => {
    const out = apply("gpt-5.6-sol", { reasoning_effort: "max" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });
  it("low levels pass through", () => {
    const out = apply("gpt-5.6-sol", { reasoning_effort: "high" });
    expect(out.output_config).toEqual({ effort: "high" });
  });
});

describe("agentrouter claude-adaptive effort passthrough (glm-5.3)", () => {
  it("effort max is kept (GLM-5.3 supports it)", () => {
    const out = apply("glm-5.3", { output_config: { effort: "max" } });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "max" });
  });
  it("ultra → max (supported)", () => {
    const out = apply("glm-5.3", { output_config: { effort: "ultra" } });
    expect(out.output_config).toEqual({ effort: "max" });
  });
});

describe("official claude adaptive unchanged (regression guard)", () => {
  it("opus-4.7 keeps xhigh→high mapping (Anthropic output_config enum has no xhigh)", () => {
    const out = apply("claude-opus-4.7", { reasoning_effort: "xhigh" }, "claude");
    expect(out.output_config).toEqual({ effort: "high" });
  });
  it("opus-4.7 max stays max (levelMax supported)", () => {
    const out = apply("claude-opus-4.7", { reasoning_effort: "max" }, "claude");
    expect(out.output_config).toEqual({ effort: "max" });
  });
});

describe("agentrouter claude-budget models unchanged", () => {
  it("glm-5.3 with a budget override still uses claude-budget (suffix overrides)", () => {
    // deepseek-v4-flash is claude-budget: max → budget 128000, not adaptive
    const out = apply("deepseek-v4-flash", { reasoning_effort: "max" });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 128000 });
    expect(out.output_config).toBeUndefined();
  });
});
