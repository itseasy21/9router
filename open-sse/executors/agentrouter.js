import { DefaultExecutor } from "./default.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

// AgentRouter routes each model by its id prefix (mirrored by the
// getModelTargetFormat family fallback in providerModels.js):
//   gpt-*    → /v1/responses — the Claude-wire /v1/messages endpoint relays to the
//              upstream /v1/chat/completions, which rejects "function tools with
//              reasoning_effort" (400) and points at /v1/responses, which accepts both.
//   claude-* → /v1/messages  — the deterministic default (claude wire) transport.
//   others   → /v1/chat/completions — plain OpenAI-compatible fallback lane.
const RESPONSES_BASE_URL = "https://agentrouter.org/v1/responses";
const CHAT_COMPLETIONS_BASE_URL = "https://agentrouter.org/v1/chat/completions";

// AgentRouter pools upstream capacity, so a model's token budget can be spent at
// any moment. When that happens the gateway answers HTTP 200 and reports the
// failure inside the body — an `error` / `response.failed` frame whose message
// reads:
//   "Your requests to gpt-6-astra for gpt-6-astra in eastus2 have exceeded token rate limit."
// HTTP 200 is already committed by then, so BaseExecutor's status-based retry
// never fires: the frame is translated into an ordinary assistant text chunk
// ("[Error] ..."), the combo records a 0-token "success", and the client gets
// the failure as the model's answer. Peek the head of the body instead and retry
// the request itself with exponential backoff, so a momentary budget exhaustion
// recovers rather than failing the turn. Once retries are spent, answer a real
// 429 so account/backoff handling and combo fallthrough work as usual.
const RATE_LIMIT_TEXT = /exceeded\s+token\s+rate\s+limit/i;

// Peeking buffers the head of the body. A *non-empty* payload delta proves the
// turn is generating output, so the peek stops and replays everything it read;
// SSE control frames (response.created, message_start, response.in_progress)
// never count as output on their own. Frames are parsed, not substring-matched:
// the relay also emits `response.output_text.delta` with an empty `delta` as a
// keep-alive, and treating that as real output let a rate-limit frame later in
// the same body slip through unretried.
const CONTENT_EVENTS = new Set([
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "content_block_delta",
]);

const PEEK_BYTES = 64 * 1024;

/** Retries after the first attempt (1 initial call + 3 retries) */
export const AGENTROUTER_RATE_LIMIT_MAX_RETRIES = 3;
/** First backoff step; each retry doubles it (2s → 4s → 8s) */
export const AGENTROUTER_RATE_LIMIT_BACKOFF_BASE_MS = 2000;

/**
 * Exponential backoff delay for retry `attempt` (0-based): 2s, 4s, 8s.
 * @param {number} attempt
 * @returns {number} delay in ms
 */
export function agentRouterBackoffDelay(attempt) {
  return AGENTROUTER_RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt));
}

/** True when a parsed SSE frame carries non-empty model output. */
function frameHasOutput(json) {
  if (!json || typeof json !== "object" || !CONTENT_EVENTS.has(json.type)) return false;
  if (json.type === "content_block_delta") {
    const delta = json.delta || {};
    return Boolean(delta.text || delta.thinking || delta.partial_json);
  }
  return typeof json.delta === "string" && json.delta.length > 0;
}

/** Index of the earliest non-empty output frame in `text`, or -1 when none was seen. */
function firstOutputIndex(text) {
  let first = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      if (frameHasOutput(JSON.parse(trimmed.slice(5).trim())) && first === -1) first = lineStart;
    } catch {
      // Partial frame — re-scanned from the full text on the next read.
    }
  }
  return first;
}

/**
 * Pull the upstream message out of the buffered head. Prefers the parsed
 * `error.message` of an SSE/JSON frame; falls back to the sentence carrying the
 * marker so a plain-text body still yields something readable.
 */
function extractRateLimitMessage(text) {
  for (const line of text.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : null;
    if (!payload || !payload.startsWith("{")) continue;
    try {
      const json = JSON.parse(payload);
      const message = json?.error?.message
        || (typeof json?.error === "string" ? json.error : null)
        || json?.response?.error?.message
        || json?.message;
      if (typeof message === "string" && RATE_LIMIT_TEXT.test(message)) return message;
    } catch {
      // Partial frame — the fallback below still finds the sentence.
    }
  }
  const match = text.match(/([^\n]*?exceeded\s+token\s+rate\s+limit[^\n]*)/i);
  return match ? match[1].replace(/^data:\s*/, "").replace(/[\\"]+$/, "").trim() : null;
}

/** Synthetic 429 so chatCore/account fallback see a real rate limit. */
function rateLimitResponse(message) {
  return new Response(
    JSON.stringify({
      error: {
        message: `[agentrouter] ${message}`,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    }),
    { status: HTTP_STATUS.RATE_LIMITED, headers: { "Content-Type": "application/json" } }
  );
}

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return /^gpt-/i.test(baseModelId(model));
}

// Neither the gpt nor claude lane → plain chat-completions fallback.
function isChatCompletionsModel(model) {
  const base = baseModelId(model);
  return !/^gpt-/i.test(base) && !/^claude-/i.test(base);
}

export class AgentRouterExecutor extends DefaultExecutor {
  constructor() {
    super("agentrouter");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // gpt-* live on /responses even when a stale runtimeTransport leaks in.
    if (isResponsesModel(model)) return RESPONSES_BASE_URL;
    // claude-* keep the registry default /messages?beta=true wire.
    if (isChatCompletionsModel(model)) return CHAT_COMPLETIONS_BASE_URL;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  /**
   * Retry a request whose HTTP 200 body is actually the upstream token rate
   * limit. Backoff is exponential (2s/4s/8s) and bounded at
   * AGENTROUTER_RATE_LIMIT_MAX_RETRIES; after that the turn reports a 429 so the
   * combo moves on and the account takes its normal rate-limit cooldown.
   */
  async execute(args) {
    const { log } = args;
    for (let attempt = 0; ; attempt++) {
      const result = await super.execute(args);
      const peek = await this.peekRateLimitError(result.response);
      if (!peek.matched) {
        // Healthy body: hand back a stream that replays the peeked head.
        if (attempt > 0) {
          log?.info?.("RETRY", `AGENTROUTER | ${args.model} recovered on attempt ${attempt + 1}`);
        }
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }

      if (attempt >= AGENTROUTER_RATE_LIMIT_MAX_RETRIES) {
        const message = peek.message || "token rate limit exceeded";
        log?.warn?.("RETRY", `AGENTROUTER | ${args.model} ${message} — retries exhausted (${attempt}/${AGENTROUTER_RATE_LIMIT_MAX_RETRIES})`);
        result.response = rateLimitResponse(message);
        return result;
      }

      const delayMs = agentRouterBackoffDelay(attempt);
      // info, not debug: the retry is the difference between a failed turn and a
      // recovered one, and production logs (incl. containers) only show info+.
      log?.info?.("RETRY", `AGENTROUTER | ${args.model} token rate limit — retry ${attempt + 1}/${AGENTROUTER_RATE_LIMIT_MAX_RETRIES} after ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /**
   * Buffer the head of the body looking for the AgentRouter token-rate-limit
   * error. Returns `{ matched, message, replacementBody }`; when nothing matched
   * the caller MUST use `replacementBody` (the original body was already read).
   * Never throws — a peek failure degrades to "no match".
   */
  async peekRateLimitError(response) {
    const empty = { matched: false, message: null, replacementBody: null };
    if (!response || !response.ok || !response.body) return empty;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let message = null;

    try {
      while (text.length < PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        const errorIndex = text.search(RATE_LIMIT_TEXT);
        const contentIndex = firstOutputIndex(text);
        // Real output already started before the marker — this is response text,
        // not a gateway error frame, so stop peeking and let it through.
        if (contentIndex !== -1 && (errorIndex === -1 || contentIndex < errorIndex)) break;
        if (errorIndex !== -1) {
          message = extractRateLimitMessage(text) || "token rate limit exceeded";
          break;
        }
      }
    } catch {
      // Fail open: replay whatever was read and let the stream layer decide.
    }

    if (message) {
      try { await reader.cancel(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return { matched: true, message, replacementBody: null };
    }

    reader.releaseLock();

    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });

    return { matched: false, message: null, replacementBody };
  }

  // Surface the synthetic 429's message instead of the raw JSON envelope.
  parseError(response, bodyText) {
    if (response.status === HTTP_STATUS.RATE_LIMITED && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const message = json?.error?.message || json?.message;
        if (typeof message === "string" && message) return { status: response.status, message };
      } catch {
        // Plain-text body — fall through to the default parser.
      }
    }
    return super.parseError(response, bodyText);
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (!isResponsesModel(model || body?.model)) return out;

    // AgentRouter's /v1/responses relay rejects sampling knobs for gpt-* models
    // ("Unsupported parameter: 'top_p' is not supported with this model", 400).
    // Mirror the Codex Responses handling: strip the sampling family — the model
    // is reasoning-first and ignores them anyway.
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
    delete out.frequency_penalty;
    delete out.presence_penalty;
    delete out.logprobs;
    delete out.top_logprobs;
    delete out.n;
    delete out.seed;

    // Responses names the output cap max_output_tokens, not max_tokens.
    // Floor 16: Responses API 400s below that (Claude Code pings send max_tokens:1).
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    if (typeof out.max_output_tokens === "number" && out.max_output_tokens < 16) out.max_output_tokens = 16;
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
      // The shared translator (PR #4610) may deliver the effort inside reasoning{};
      // the none/off clamp must cover that shape too.
      if (typeof out.reasoning.effort === "string") {
        const effort = out.reasoning.effort.toLowerCase().trim();
        if (effort === "none" || effort === "off") out.reasoning.effort = "minimal";
      }
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
    }
    delete out.reasoning_effort;

    out.stream = true;
    out.store = false;
    return out;
  }
}

export default AgentRouterExecutor;
