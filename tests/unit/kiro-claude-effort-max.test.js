// Kiro claude-opus-5.5 effort passthrough. extractKiroEffortLevel used to clamp
// xhigh AND max → "high" on the Claude output_config path, so clients asking for
// max/xhigh silently got high on the wire and in the THINK: log. max passes
// through (official Claude adaptive enum tops out at max); xhigh is now
// model-gated (merged upstream): 4.6-and-older Claude models clamp xhigh→high,
// 4.7+ and opus-5.5/sonnet-5.x accept xhigh natively (Kiro additionalModelRequestFieldsSchema).
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
    expect(extractKiroEffortLevel({ output_config: { effort: "max" } }, "claude-opus-5.5")).toBe("max");
  });

  it("xhigh passes through on 4.7+ / 5.x models", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } }, "claude-opus-4.7")).toBe("xhigh");
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } }, "claude-opus-5.5")).toBe("xhigh");
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } }, "claude-sonnet-5.5")).toBe("xhigh");
  });

  it("xhigh clamps to high on 4.6-and-older Claude models", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } }, "claude-opus-4.6")).toBe("high");
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } }, "claude-sonnet-4.5")).toBe("high");
    expect(extractKiroEffortLevel({ output_config: { effort: "xhigh" } })).toBe("high");
  });

  it("low/medium/high pass through, none-ish returns null", () => {
    expect(extractKiroEffortLevel({ output_config: { effort: "high" } }, "claude-opus-5.5")).toBe("high");
    expect(extractKiroEffortLevel({ output_config: { effort: "none" } }, "claude-opus-5.5")).toBeNull();
    expect(extractKiroEffortLevel({ reasoning_effort: "disabled" }, "claude-opus-5.5")).toBeNull();
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

  it("openai-to-kiro: effort xhigh reaches the wire on opus-5.5 (model-gated passthrough)", () => {
    const out = openaiToKiroRequest("claude-opus-5.5", {
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "go deep" }],
    }, true, {});
    expect(out.additionalModelRequestFields).toEqual({
      ...FIELDS,
      output_config: { effort: "xhigh" },
    });
  });

  it("openai-to-kiro: effort xhigh clamps to high on opus-4.6", () => {
    const out = openaiToKiroRequest("claude-opus-4.6", {
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
      "claude-opus-5.5",
    );
    expect(fields.output_config).toEqual({ effort: "max" });
  });
});
