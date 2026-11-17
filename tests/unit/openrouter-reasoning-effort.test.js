import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// OpenRouter (and the clones of its catalogue) accept any model id and publish
// each model's reasoning enum themselves — particle-1:free advertises the full
// OpenAI effort set in GET /api/v1/models. Such ids are absent from our
// capability tables, so they resolve to reasoning:false; applyThinking used to
// strip the client's effort on that signal and the request reached OpenRouter
// with no reasoning config at all.
const MODEL = "particle-ai/particle-1:free";

describe("OpenRouter passthrough models keep the client's effort", () => {
  it("the table has no entry for the model (the reason the strip used to fire)", () => {
    expect(getCapabilitiesForModel("openrouter", MODEL).reasoning).toBe(false);
  });

  it("forwards reasoning_effort sent by an OpenAI-shaped client", () => {
    const body = { reasoning_effort: "high", messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, body, "openrouter");
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });

  it("forwards a dashboard effort suffix", () => {
    const body = { messages: [] };
    applyThinking(FORMATS.OPENAI, `${MODEL}(xhigh)`, body, "openrouter");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("maps the internal ultra tier to the gateway enum's max", () => {
    const body = { messages: [] };
    applyThinking(FORMATS.OPENAI, `${MODEL}(ultra)`, body, "openrouter");
    expect(body.reasoning_effort).toBe("max");
  });

  it("converts a Claude-style budget into an effort level", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 24576 }, messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, body, "openrouter");
    expect(body.reasoning_effort).toBe("high");
  });

  it("sends no field when the client asked for auto/none or sent nothing", () => {
    const auto = { messages: [] };
    applyThinking(FORMATS.OPENAI, `${MODEL}(auto)`, auto, "openrouter");
    expect(auto.reasoning_effort).toBeUndefined();

    const none = { reasoning_effort: "none", messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, none, "openrouter");
    expect(none.reasoning_effort).toBeUndefined();

    const empty = { messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, empty, "openrouter");
    expect(empty.reasoning_effort).toBeUndefined();
  });

  it.each(["kilocode", "vercel-ai-gateway"])("%s (OpenRouter clone) forwards it too", (provider) => {
    const body = { reasoning_effort: "medium", messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, body, provider);
    expect(body.reasoning_effort).toBe("medium");
  });

  it("keeps stripping for providers that speak for the model", () => {
    const body = { reasoning_effort: "high", messages: [] };
    applyThinking(FORMATS.OPENAI, "some-unknown-model", body, "nvidia");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("does not change catalogued OpenRouter models", () => {
    // openrouter's transport declares thinkingFormat "openai", so even a model
    // whose family pattern is DeepSeek-shaped travels as reasoning_effort here.
    const body = { reasoning_effort: "high", messages: [] };
    applyThinking(FORMATS.OPENAI, "deepseek/deepseek-v3.2", body, "openrouter");
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });
});
