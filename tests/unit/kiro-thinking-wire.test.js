import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const C2K = (body, model = "gpt-5.6-luna") =>
  translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, model, body, true, null, "kiro");

describe("kiro thinking wire invariant (THINK:* absent != no thinking)", () => {
  it("adaptive without effort defaults to native reasoning high for gpt-5.6 (not only legacy prompt)", () => {
    const out = C2K({ messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } });
    expect(out.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).not.toContain("<thinking_mode>");
    expect(out.systemPrompt).toBeUndefined();
  });

  it("explicit high still emits native reasoning", () => {
    const out = C2K({ messages: [{ role: "user", content: "hi" }], output_config: { effort: "high" } });
    expect(out.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
  });

  it("no thinking emits neither native nor legacy", () => {
    const out = C2K({ messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } });
    expect(out.additionalModelRequestFields || undefined).toBeUndefined();
    expect(out.conversationState.currentMessage.userInputMessage.content).not.toContain("<thinking_mode>");
  });
});
