import { DefaultExecutor } from "./default.js";

// AgentRouter's Claude-wire endpoint (/v1/messages?beta=true) internally relays to
// the upstream /v1/chat/completions, which rejects "function tools with
// reasoning_effort" for gpt-6-astra (MaaS_GP_6_astra_*) with HTTP 400 and points at
// /v1/responses. That endpoint accepts both, so gpt-6-astra is a responses-only
// model: chatCore resolves its targetFormat to openai-responses (registry
// targetFormat) and this executor pins the URL + normalizes the Responses payload,
// mirroring the opencode-go Muse Spark handling.
const RESPONSES_BASE_URL = "https://agentrouter.org/v1/responses";

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return /^gpt-6-astra/i.test(baseModelId(model));
}

export class AgentRouterExecutor extends DefaultExecutor {
  constructor() {
    super("agentrouter");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // gpt-6-astra lives on /responses even when a stale runtimeTransport leaks in.
    if (isResponsesModel(model)) return RESPONSES_BASE_URL;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (!isResponsesModel(model || body?.model)) return out;

    // Responses names the output cap max_output_tokens, not max_tokens.
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    delete out.max_tokens;
    delete out.max_completion_tokens;

    // Chat param reasoning_effort must ride reasoning{effort} on /responses.
    // (Native Responses clients already send reasoning{}; keep it.) The responses
    // endpoint has no "none" — clamp to minimal, same as the Go Muse Spark quirk.
    if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
      const normalized = String(out.reasoning_effort).toLowerCase().trim();
      out.reasoning = { effort: (normalized === "none" || normalized === "off") ? "minimal" : normalized, summary: "auto" };
    }
    if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
    }
    delete out.reasoning_effort;

    out.stream = true;
    out.store = false;
    return out;
  }
}

export default AgentRouterExecutor;
