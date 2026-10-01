// GitHub Copilot Claude 5.x: thinking.type.enabled → 400 "Use thinking.type.adaptive
// and output_config.effort". claude-sonnet-5.5 previously fell through the generic
// *claude*sonnet* pattern to claude-budget (thinking.type.enabled) because the exact
// MODEL_CAPABILITIES entries only cover bare claude-sonnet-5 ids.
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

const apply = (model, body, provider = "github") => {
  const b = JSON.parse(JSON.stringify(body));
  applyThinking("claude", model, b, provider);
  return b;
};

describe("github claude-sonnet-5.5 capabilities", () => {
  it("resolves to claude-adaptive (not claude-budget)", () => {
    const caps = getCapabilitiesForModel("github", "claude-sonnet-5.5");
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.reasoning).toBe(true);
  });

  it("effort levels match the claude-adaptive set (xhigh added upstream)", () => {
    expect(getThinkingLevels("github", "claude-sonnet-5.5")).toEqual([
      "none", "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("claude 4.6 models keep the no-xhigh level set", () => {
    expect(getThinkingLevels("github", "claude-sonnet-4.6")).toEqual([
      "none", "low", "medium", "high", "max",
    ]);
  });
});

describe("github claude-adaptive wire shape", () => {
  it("adaptive switch + output_config.effort (the shape Copilot demands)", () => {
    const out = apply("claude-sonnet-5.5", { reasoning_effort: "high" });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("client effort max passes through (official Claude supports max)", () => {
    const out = apply("claude-sonnet-5.5", { output_config: { effort: "max" } });
    expect(out.output_config).toEqual({ effort: "max" });
  });

  it("disabled intent emits thinking.type.disabled, not enabled", () => {
    const out = apply("claude-sonnet-5.5", { thinking: { type: "disabled" } });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.output_config).toBeUndefined();
  });

  it("auto intent resolves to high (output_config.effort rejects auto)", () => {
    const out = apply("claude-sonnet-5.5", { reasoning_effort: "auto" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("claude-native adaptive intent is normalized to the same wire shape", () => {
    const out = apply("claude-sonnet-5.5", { thinking: { type: "adaptive" } });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("opus-5.5 and sonnet-5-thinking variants also get adaptive", () => {
    for (const m of ["claude-opus-5.5", "claude-sonnet-5-thinking", "github/claude-sonnet-5.5"]) {
      const out = apply(m.replace("github/", ""), { reasoning_effort: "high" });
      expect(out.thinking).toEqual({ type: "adaptive" });
      expect(out.output_config).toEqual({ effort: "high" });
    }
  });
});

describe("github claude 4.x and older keep claude-budget", () => {
  it("sonnet-4.5 still emits budget thinking", () => {
    const caps = getCapabilitiesForModel("github", "claude-sonnet-4.5");
    expect(caps.thinkingFormat).toBe("claude-budget");
    const out = apply("claude-sonnet-4.5", { reasoning_effort: "high" });
    expect(out.thinking).toMatchObject({ type: "enabled" });
    expect(out.thinking.budget_tokens).toBeGreaterThan(0);
  });

  it("haiku-4.5 still emits budget thinking", () => {
    const caps = getCapabilitiesForModel("github", "claude-haiku-4.5");
    expect(caps.thinkingFormat).toBe("claude-budget");
  });
});

describe("github paramSupport drop rule interplay", () => {
  // The /chat/completions path strips thinking for non-4.6 claude models; the
  // /v1/messages path (where applyThinking runs) must not be re-stripped of
  // output_config afterwards.
  it("drop rule does not strip output_config from the messages body", () => {
    const body = {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    };
    stripUnsupportedParams("github", "claude-sonnet-5.5", body);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("drop rule still strips thinking/reasoning_effort on the chat path", () => {
    const body = { reasoning_effort: "high", thinking: { type: "enabled" }, messages: [] };
    stripUnsupportedParams("github", "claude-sonnet-4.5", body);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});
