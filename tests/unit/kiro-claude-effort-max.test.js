// Kiro claude-opus-5.5 effort passthrough. extractKiroEffortLevel used to clamp
// xhigh AND max → "high" on the Claude output_config path, so clients asking for
// max/xhigh silently got high on the wire and in the THINK: log. max must pass
// through (official Claude adaptive enum tops out at max); xhigh still clamps
// (Anthropic's output_config.effort enum has no xhigh — mirrored from agentrouter).
import { describe, it, expect } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import {
  extractKiroEffortLevel,
  buildKiroAdditionalModelRequestFields,
  resolveKiroEffortPath,
} from "../../open-sse/config/kiroConstants.js";

const FIELDS = { thinking: { type: "adaptive", display: "summarized" }, output_config: {} };

describe("extractKiroEffortLevel (Claude output_config path)", () => {
  it("max passes through as max", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "max" } })).toBe("max");
  });

  it("xhigh still clamps to high (official enum has no xhigh)", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } })).toBe("high");
  });

  it("low/medium/high pass through, none-ish returns null", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "high" } })).toBe("high");
    expect(extractKiroEffortLevel({ output_config: { effort: "none" } })).toBeNull();
    expect(extractKiroEffortLevel({ reasoning_effort: "disabled" })).toBeNull();
  });
});

describe("kiro claude-opus-5.5 additionalModelRequestFields effort", () => {
  it.each(["openai-to-kiro", "claude-to-kiro"])("%s: effort max reaches the wire as max", (dir) => {
    const body = { output_config: { effort: "max" }, messages: [{ role: "user", content: "go deep" }] };
    const out = dir === "openai-to-kiro"
      ? openaiToKiroRequest("claude-opus-5.5", body, true, {})
      : claudeToKiroRequest("claude-opus-5.5", body, true, {});
    expect(out.additionalModelRequestFields).toEqual({
      ...FIELDS,
      output_config: { effort: "max" },
    });
  });

  it("openai-to-kiro: effort xhigh clamps to high on the wire", () => {
    const out = openaiToKiroRequest("claude-opus-5.5", {
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "go deep" }],
    }, true, {});
    expect(out.additionalModelRequestFields).toEqual({
      ...FIELDS,
      output_config: { effort: "high" },
    });
  });

  it("sonnet-5 family rides the same effort path", () => {
    expect(resolveKiroEffortPath("claude-sonnet-5.5")).toBe("output_config");
    const out = openaiToKiroRequest("claude-sonnet-5.5", {
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "go deep" }],
    }, true, {});
    expect(out.additionalModelRequestFields.output_config).toEqual({ effort: "max" });
  });

  it("legacy models (4.5) still get no effort fields", () => {
    expect(resolveKiroEffortPath("claude-sonnet-4.5")).toBeNull();
  });
});

describe("GPT-5.6 reasoning path unchanged", () => {
  it("max still maps to xhigh (kiro GPT enum tops at xhigh)", () => {
    const out = openaiToKiroRequest("gpt-5.6-sol", {
      reasoning: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    }, true, {});
    expect(out.additionalModelRequestFields).toEqual({ reasoning: { effort: "xhigh" } });
  });

  it("buildKiroAdditionalModelRequestFields claude shape accepts max", () => {
    const fields = buildKiroAdditionalModelRequestFields(
      { output_config: { effort: "max" } },
      "output_config",
    );
    expect(fields.output_config).toEqual({ effort: "max" });
  });
});
