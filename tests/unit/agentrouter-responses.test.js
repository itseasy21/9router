// AgentRouter gpt-6-astra: responses-only routing contract.
//
// Upstream error (400): "Function tools with reasoning_effort are not supported
// for MaaS_GP_6_astra_* in /v1/chat/completions. To use function tools, use
// /v1/responses or set reasoning_effort to 'none'." AgentRouter's Claude-wire
// /v1/messages relays to the upstream chat/completions, so gpt-6-astra must
// target /v1/responses — same pattern as opencode-go muse-spark.
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { AgentRouterExecutor } from "../../open-sse/executors/agentrouter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "gpt-6-astra";
const PROVIDER = "agentrouter";

describe("agentrouter/gpt-6-astra catalog", () => {
  it("is registered with the responses targetFormat", () => {
    const entry = (PROVIDER_MODELS["agentrouter"] || []).find((m) => m.id === MODEL);
    expect(entry).toBeDefined();
    expect(entry.targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelTargetFormat("agentrouter", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
  });

  it("keeps other agentrouter models on the claude wire", () => {
    expect(getModelTargetFormat("agentrouter", "gpt-5.6-sol")).toBeNull();
    expect(getModelTargetFormat("agentrouter", "glm-5.3")).toBeNull();
  });

  it("never takes a sourceFormat-matched transport (agentrouter has none — always translates)", () => {
    expect(resolveTransport(PROVIDER, "openai")).toBeNull();
    expect(resolveTransport(PROVIDER, "claude")).toBeNull();
    expect(resolveTransport(PROVIDER, FORMATS.OPENAI_RESPONSES)).toBeNull();
  });

  it("advertises reasoning via the openai effort enum", () => {
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
    });
    const levels = getThinkingLevels(PROVIDER, MODEL);
    expect(levels).toContain("xhigh");
    expect(levels).toContain("none");
  });
});

describe("AgentRouterExecutor routing + request shaping", () => {
  it("is wired for agentrouter and routes gpt-6-astra to /v1/responses", () => {
    expect(getExecutor("agentrouter")).toBeInstanceOf(AgentRouterExecutor);
    const ex = new AgentRouterExecutor();
    expect(ex.buildUrl(MODEL)).toBe("https://agentrouter.org/v1/responses");
    // Even a stale runtimeTransport must not drag astra onto /messages
    expect(ex.buildUrl(MODEL, true, 0, {
      runtimeTransport: { baseUrl: "https://agentrouter.org/v1/messages?beta=true" },
    })).toBe("https://agentrouter.org/v1/responses");
  });

  it("honors the thinking suffix when picking the endpoint", () => {
    const ex = new AgentRouterExecutor();
    expect(ex.buildUrl("gpt-6-astra(max)")).toBe("https://agentrouter.org/v1/responses");
  });

  it("leaves other agentrouter models on the default /messages wire", () => {
    const ex = new AgentRouterExecutor();
    expect(ex.buildUrl("gpt-5.6-sol")).toBe("https://agentrouter.org/v1/messages?beta=true");
    expect(ex.buildUrl("glm-5.3")).toBe("https://agentrouter.org/v1/messages?beta=true");
  });

  it("normalizes max tokens + reasoning for the responses payload", () => {
    const ex = new AgentRouterExecutor();
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
      max_tokens: 2048,
      reasoning_effort: "high",
    };
    const out = ex.transformRequest(MODEL, body, true, {});
    expect(out.max_output_tokens).toBe(2048);
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    // function tools survive — the whole point of the /responses route
    expect(out.tools).toHaveLength(1);
  });

  it("clamps none/off effort to minimal (no disable on /responses)", () => {
    const ex = new AgentRouterExecutor();
    const out = ex.transformRequest(MODEL, { model: MODEL, messages: [], reasoning_effort: "none" }, true, {});
    expect(out.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });

  it("strips top_p and the sampling family from the astra responses payload", () => {
    // Upstream 400: "Unsupported parameter: 'top_p' is not supported with this model."
    const ex = new AgentRouterExecutor();
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      logprobs: true,
      top_logprobs: 5,
      n: 2,
      seed: 42,
      max_tokens: 512,
    };
    const out = ex.transformRequest(MODEL, body, true, {});
    for (const key of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "n", "seed"]) {
      expect(out[key]).toBeUndefined();
    }
    // Output cap still normalized alongside the strip
    expect(out.max_output_tokens).toBe(512);
  });

  it("strips sampling knobs that a native responses body passes through the translator", () => {
    // The openai-responses translator passes top_p/temperature through untouched
    // (pinned in openai-responses.js); the executor must strip them regardless
    // of whether the payload arrived translated or natively.
    const ex = new AgentRouterExecutor();
    const out = ex.transformRequest(
      MODEL,
      { model: MODEL, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], top_p: 0.9, temperature: 0.5 },
      true,
      {},
    );
    expect(out.top_p).toBeUndefined();
    expect(out.temperature).toBeUndefined();
    // input payload survives the strip
    expect(out.input).toHaveLength(1);
  });

  it("keeps an existing reasoning object and never overrides it with reasoning_effort", () => {
    const ex = new AgentRouterExecutor();
    const out = ex.transformRequest(
      MODEL,
      { model: MODEL, messages: [], reasoning: { effort: "xhigh" }, reasoning_effort: "low" },
      true,
      {},
    );
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("does not reshape non-astra models", () => {
    const ex = new AgentRouterExecutor();
    const body = { model: "gpt-5.6-sol", messages: [], max_tokens: 100, reasoning_effort: "high" };
    const out = ex.transformRequest("gpt-5.6-sol", body, true, {});
    expect(out.max_tokens).toBe(100);
    expect(out.reasoning).toBeUndefined();
    expect(out.stream).toBeUndefined(); // base transform never touches stream for non-astra models
  });

  it("keeps sampling knobs on non-astra models (strip is astra-only)", () => {
    const ex = new AgentRouterExecutor();
    const body = { model: "gpt-5.6-sol", messages: [], top_p: 0.9, temperature: 0.5 };
    const out = ex.transformRequest("gpt-5.6-sol", body, true, {});
    expect(out.top_p).toBe(0.9);
    expect(out.temperature).toBe(0.5);
  });
});

describe("translation into the Responses wire", () => {
  it("openai chat client → responses keeps tools as flat function declarations", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "gpt-6-astra",
      {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }],
        reasoning_effort: "high",
      },
      true,
      null,
      PROVIDER,
    );
    expect(translated.input).toBeDefined();
    expect(translated.tools).toHaveLength(1);
    expect(translated.tools[0].name).toBe("bash");
    // Post-#4610: translateRequest itself converts reasoning_effort into
    // reasoning{effort} for Responses targets; AgentRouterExecutor clamps
    // none/off and adds summary on the wire (covered above).
    expect(translated.reasoning).toEqual({ effort: "high" });
    expect(translated.reasoning_effort).toBeUndefined();
  });
});
