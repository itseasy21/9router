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

// Peeking buffers the head of the body. Only real *answer* output (visible text
// or tool arguments) proves the turn is generating, so only that stops the peek
// and replays what it read; SSE control frames (response.created, message_start,
// response.in_progress) never count as output on their own. Frames are parsed,
// not substring-matched: the relay emits `response.output_text.delta` keep-alives
// whose `delta` is empty *or whitespace* ("\n"), and counting either as real
// output let a rate-limit frame a couple hundred milliseconds later in the same
// body slip through unretried — the client then saw `[Error] …` as the answer.
const ANSWER_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

// Thinking is not an answer. Reasoning models (gpt-6-astra with THINK:xhigh)
// emit a reasoning-summary delta seconds before anything else, and the token
// rate-limit frame arrives right after it — counting that as output committed
// the body and handed the rejection to the client as `[Error] ...`. Keep
// peeking through thinking, but give up once enough of it has accumulated that
// the model is clearly generating, so a slow first answer token is not delayed
// by an unbounded buffer.
const REASONING_EVENT_TYPES = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning_content.delta",
]);

const PEEK_BYTES = 128 * 1024;
const REASONING_COMMIT_BYTES = 32 * 1024;
// Stop holding a possible rejection once the visible answer is clearly an answer.
const REJECTION_HOLD_CHARS = 4000;

// Zero-width and bidi markers are invisible: a keep-alive delta carrying one
// trims to a non-empty string, so it looked like the start of an answer and the
// rejection that followed went through unretried. Only visible characters prove
// a turn is actually answering.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u180E]/g;

/** Strip invisible formatting characters and surrounding whitespace. */
function visibleText(raw) {
  return String(raw ?? "").replace(INVISIBLE_CHARS, "").trim();
}

/** True when a string contains something the client can actually see. */
function hasVisibleText(raw) {
  return visibleText(raw).length > 0;
}

// The rejection can also arrive as ordinary assistant text instead of an error
// frame. These are the only ways that sentence can begin, so a partial match is
// held rather than committed: the relay routinely splits it over several deltas
// ("[Error] Your requests to gpt-6.1-sol for " → "gpt-6.1-sol in eastus2 have
// exceeded token rate limit."), and committing on the first one handed the
// client half a rejection as if it were the model's answer.
const REJECTION_LEADS = ["[error] your requests to", "your requests to", "[error]"];

/** True while `text` is still a possible prefix (or body) of a rejection. */
function isRejectionLead(text) {
  const normalized = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return REJECTION_LEADS.some((lead) => lead.startsWith(normalized) || normalized.startsWith(lead));
}

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

/** True when a parsed SSE frame carries real answer output (text or tool args). */
function isAnswerFrame(json) {
  if (!json || typeof json !== "object") return false;
  if (json.type === "content_block_delta") {
    const delta = json.delta || {};
    return hasVisibleText(delta.text) || hasVisibleText(delta.partial_json);
  }
  if (!ANSWER_EVENT_TYPES.has(json.type)) return false;
  // Whitespace- and zero-width-only deltas are keep-alives, not an answer.
  return typeof json.delta === "string" && hasVisibleText(json.delta);
}

/**
 * Message of a structured rejection frame (`error` / `response.failed`) when it
 * carries the token-rate-limit marker. This is the authoritative signal: a
 * gateway rejection is an error frame, so it wins over any answer text that
 * happened to land in the same read — nothing has been forwarded to the client
 * yet, so the request can still be retried instead of delivering a broken turn.
 */
function errorFrameMessage(json) {
  if (!json || typeof json !== "object") return null;
  const err = json.error ?? json.response?.error;
  const message = typeof err === "string" ? err : (typeof err?.message === "string" ? err.message : null);
  if (typeof message !== "string" || !RATE_LIMIT_TEXT.test(message)) return null;
  if (json.type === "error" || json.type === "response.failed" || err != null) return message;
  return null;
}

/** True when a parsed SSE frame carries thinking output. */
function isReasoningFrame(json) {
  if (!json || typeof json !== "object") return false;
  if (json.type === "content_block_delta") return Boolean(json.delta?.thinking);
  if (!REASONING_EVENT_TYPES.has(json.type)) return false;
  return typeof json.delta === "string" && json.delta.length > 0;
}

/**
 * Parse the frames that have completed since `from` and report what they carry.
 * `visible`/`thinking` are the deltas' text (the client-visible answer and the
 * reasoning), and `next` is the offset from which the next call must scan — a
 * trailing partial line is left unread until the rest of it arrives.
 */
function scanOutputFrames(text, from = 0) {
  let answer = false;
  let reasoning = false;
  let errorMessage = null;
  let visible = "";
  let thinking = "";

  const lines = text.slice(from).split("\n");
  const partial = text.endsWith("\n") ? null : lines.pop();
  const next = text.length - (partial ? partial.length : 0);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    let json;
    try {
      json = JSON.parse(trimmed.slice(5).trim());
    } catch {
      // Malformed frame — ignore it, the rest of the body may still be valid.
      continue;
    }
    if (json.type === "content_block_delta") {
      if (typeof json.delta?.text === "string") visible += json.delta.text;
      if (typeof json.delta?.thinking === "string") thinking += json.delta.thinking;
    }
    if (ANSWER_EVENT_TYPES.has(json.type) && typeof json.delta === "string") visible += json.delta;
    if (REASONING_EVENT_TYPES.has(json.type) && typeof json.delta === "string") thinking += json.delta;
    if (isAnswerFrame(json)) answer = true;
    if (isReasoningFrame(json)) reasoning = true;
    if (errorMessage === null) errorMessage = errorFrameMessage(json);
  }

  return { answer, reasoning, errorMessage, visible, thinking, next };
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
    let visible = "";
    let thinking = "";
    let answered = false;
    let reasoningSeen = false;
    let scanned = 0;

    try {
      while (text.length < PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });

        const scan = scanOutputFrames(text, scanned);
        scanned = scan.next;
        visible += scan.visible;
        thinking += scan.thinking;
        if (scan.answer) answered = true;
        if (scan.reasoning) reasoningSeen = true;

        // A structured rejection frame is decisive, even when a token landed
        // first: nothing reached the client yet, so retry the request.
        if (scan.errorMessage) {
          message = scan.errorMessage;
          break;
        }

        const shown = visibleText(visible);
        // The same rejection delivered as ordinary assistant text, whole or
        // split across deltas — checked before any answer commit. The text must
        // *start* like the rejection: a real answer that merely quotes the
        // sentence ("upstream said: …") stays an answer.
        if (RATE_LIMIT_TEXT.test(shown) && isRejectionLead(shown)) {
          message = extractRateLimitMessage(visible) || "token rate limit exceeded";
          break;
        }
        // Unparseable / plain-text / JSON body carrying the marker before any answer.
        if (RATE_LIMIT_TEXT.test(text) && (!shown || isRejectionLead(shown))) {
          message = extractRateLimitMessage(text) || "token rate limit exceeded";
          break;
        }

        if (answered) {
          // Hold while the text so far could still turn into a rejection.
          if (!isRejectionLead(shown) || shown.length > REJECTION_HOLD_CHARS) break;
          continue;
        }
        // Thinking only: keep waiting for the rejection frame within the budget.
        if (reasoningSeen && thinking.length >= REASONING_COMMIT_BYTES) break;
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
