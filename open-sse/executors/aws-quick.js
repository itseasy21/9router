import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import {
  QuickSessionError,
  isSessionFresh,
  refreshQuickSession,
  sessionCredentialUpdates,
  sessionFromCredentials,
} from "../services/awsQuick/session.js";
import { QuickSocket, QuickSocketError } from "../services/awsQuick/quickSocket.js";
import {
  SYSTEM_PROMPT_CAP,
  UPSTREAM_TEXT_LIMIT,
  byteLen,
  capText,
  canonRole,
  effortFor,
  modeFor,
  pickImages,
  renderDelta,
  renderTranscript,
  textOf,
} from "../services/awsQuick/translate.js";
import { buildToolPreamble, createToolCallParser, newToolCallId, normalizeTools } from "../services/awsQuick/tools.js";
import { findReuse, rememberTurn, scopeFor } from "../services/awsQuick/threads.js";
import {
  QUICK_APP_VERSION,
  QUICK_CHANNEL,
  QUICK_IDLE_TIMEOUT_MS,
  QUICK_IMAGE_BUDGET,
  QUICK_IMAGE_TEXT_RESERVE,
  QUICK_SOCKET_IDLE_MS,
  QUICK_SURFACE,
} from "../services/awsQuick/constants.js";

const encoder = new TextEncoder();

// One live socket per connection row. Quick multiplexes threads over a single
// socket, so concurrent requests share it; idle sockets close after 5 minutes.
const SOCKETS = new Map();
// The desktop keeps one workingSessionId for the whole app launch, not one per
// turn. Keep it for the connection's lifetime (including socket reconnects) so
// Quick sees the same working session across a conversation.
const WORKING_SESSIONS = new Map();

function workingSessionIdFor(key) {
  let id = WORKING_SESSIONS.get(key);
  if (!id) {
    id = crypto.randomUUID();
    WORKING_SESSIONS.set(key, id);
  }
  return id;
}

function socketKeyFor(credentials, session) {
  return credentials?.connectionId || `${session.ws_host}:${session.actor_arn || session.email || "anon"}`;
}

function quickConfig() {
  return PROVIDERS["aws-quick"]?.quick || {};
}

function fingerprintFor(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const config = quickConfig();
  return {
    surfaceType: psd.awsQuickSurface || config.surfaceType || QUICK_SURFACE,
    appVersion: psd.awsQuickAppVersion || config.appVersion || QUICK_APP_VERSION,
    channel: psd.awsQuickChannel || config.channel || QUICK_CHANNEL,
    userAgent: psd.awsQuickUserAgent || config.userAgent || undefined,
    origin: psd.awsQuickOrigin || config.origin || undefined,
    acceptLanguage: psd.awsQuickAcceptLanguage || config.acceptLanguage || undefined,
  };
}

function acquireSocket({ credentials, session, log }) {
  const key = socketKeyFor(credentials, session);
  const existing = SOCKETS.get(key);
  if (existing) {
    clearTimeout(existing.idleTimer);
    Object.assign(existing.holder, {
      ws_host: session.ws_host,
      jwt: session.jwt,
      actor_arn: session.actor_arn,
    });
    // The bearer token is baked into the socket URL, so a refreshed session
    // needs a fresh connection rather than a reused one.
    if (existing.socket.isOpen && existing.token === session.jwt) return { key, entry: existing };
    SOCKETS.delete(key);
    existing.socket.close().catch(() => {});
  }

  const holder = { ws_host: session.ws_host, jwt: session.jwt, actor_arn: session.actor_arn };
  const psd = credentials?.providerSpecificData || {};
  const fingerprint = fingerprintFor(credentials);
  const socket = new QuickSocket({
    getSession: async () => ({ ...holder }),
    outpostId: psd.awsQuickOutpostId || session.outpost_id || "",
    extra: fingerprint,
    log,
    workingSessionId: workingSessionIdFor(key),
  });
  const entry = { socket, holder, token: session.jwt, idleTimer: null };
  SOCKETS.set(key, entry);
  return { key, entry };
}

async function dropSocket(key) {
  const entry = SOCKETS.get(key);
  if (!entry) return;
  SOCKETS.delete(key);
  clearTimeout(entry.idleTimer);
  await entry.socket.close().catch(() => {});
}

function releaseSocket(key, entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.socket.hasActiveTurns()) return;
    SOCKETS.delete(key);
    entry.socket.close().catch(() => {});
  }, QUICK_SOCKET_IDLE_MS);
  entry.idleTimer.unref?.();
}

function persistSession(credentials, session) {
  if (!credentials) return;
  Object.assign(credentials, sessionCredentialUpdates(session, credentials));
}

function statusFor(error) {
  if (error?.status) return error.status;
  if (error?.kind === "invalid") return 400;
  if (error?.kind === "auth") return 401;
  if (error?.kind === "quota") return 429;
  if (error?.kind === "busy") return 409;
  if (error?.kind === "abort") return 499;
  if (error?.kind === "timeout") return 504;
  return 502;
}

function isAuthFailure(error) {
  if (!error) return false;
  if (error.kind === "auth" || error.status === 401 || error.status === 403) return true;
  if ([4003, 4401, 4403, 1008].includes(Number(error.code))) return true;
  return /unauthor|forbidden|expired|invalid.?token|token.*(invalid|expired)|401|403/i.test(String(error.message || ""));
}

function errorResponse(error, log) {
  const status = statusFor(error);
  const message = error?.message || String(error);
  log?.warn?.("AWS-QUICK", `${status} ${message}`);
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error",
        code: error?.code || status,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// chatCore expects every executor to return { response, url, headers, transformedBody }.
// Keep the log URL free of the bearer query string.
function targetUrl(session) {
  return session?.ws_host ? `wss://${session.ws_host}` : "aws-quick:websocket";
}

function executeResult(response, { body, session }) {
  return { response, url: targetUrl(session), headers: {}, transformedBody: body };
}

function usageFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = Number(raw.input_tokens ?? raw.inputTokens) || 0;
  const cached = Number(raw.cache_read_tokens ?? raw.cached_input_tokens ?? raw.cachedInputTokens) || 0;
  const written = Number(raw.cache_write_tokens ?? raw.cacheWriteTokens) || 0;
  const completion = Number(raw.output_tokens ?? raw.outputTokens) || 0;
  const prompt = input + cached + written;
  const total = Number(raw.total_tokens ?? raw.totalTokens) || prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function customPromptFor(hasTools) {
  return hasTools
    ? "Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user's machine; this session has no connected device, so built-in device tools (local files, apps) cannot run here. For questions about the user's project, files or code, call the client tools to read current contents — earlier tool results may be partial, and a fresh read beats guessing."
    : "Calling context: this chat is driven by an external application and has no connected device. Built-in tools that need the user's device (local files, apps) cannot run in this session — say so plainly rather than attempting them.";
}

function lastAssistantIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (canonRole(messages[index]?.role) === "assistant") return index;
  }
  return -1;
}

function buildTurn({ body, model, credentials, session, forceFresh }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) {
    throw new QuickSessionError("messages is required", { kind: "invalid", status: 400 });
  }

  const systemText = messages
    .filter((message) => canonRole(message?.role) === "system" || message?.role === "developer")
    .map((message) => textOf(message?.content))
    .filter(Boolean)
    .join("\n\n");
  const convo = messages.filter((message) => canonRole(message?.role) !== "system" && message?.role !== "developer");

  const mode = modeFor(model);
  const effort = effortFor(body);
  const toolsDisabled = body?.tool_choice === "none" || (typeof body?.tool_choice === "object" && body?.tool_choice?.type === "none");
  const tools = toolsDisabled ? [] : normalizeTools(body?.tools);

  const systemPrompt = systemText ? capText(systemText, SYSTEM_PROMPT_CAP) : "";
  const customPrompt = customPromptFor(tools.length > 0);
  const psd = credentials?.providerSpecificData || {};
  const identity = credentials?.connectionId || session.email || session.ws_host;
  const scope = scopeFor(identity, mode, effort, systemText, tools.map((tool) => tool.name));
  const reuse = !forceFresh && psd.awsQuickThreadReuse !== false ? findReuse(scope, convo) : null;

  const textCap = Math.max(8 * 1024, UPSTREAM_TEXT_LIMIT - byteLen(systemPrompt) - byteLen(customPrompt) - 1024);
  let preamble = tools.length ? buildToolPreamble(tools, body?.tool_choice) : "";
  if (preamble && byteLen(preamble) > textCap - 8192) {
    preamble = buildToolPreamble(tools, body?.tool_choice, { lite: true });
  }
  if (preamble && byteLen(preamble) > textCap - 4096) {
    preamble = buildToolPreamble(tools, body?.tool_choice, { namesOnly: true });
  }
  const textBudget = Math.max(4 * 1024, textCap - byteLen(preamble));

  const imageBudget = Math.max(0, Math.min(QUICK_IMAGE_BUDGET, textBudget - QUICK_IMAGE_TEXT_RESERVE));
  const imageMessages = reuse ? reuse.delta : convo.slice(lastAssistantIndex(convo) + 1);
  const images = pickImages(imageMessages, imageBudget);
  const imageNote = images.skipped ? `\n\n[${images.skipped} image(s) not delivered: over Quick's 64 KB message limit, or not inline data]` : "";
  const turnBudget = Math.max(1024, textBudget - images.bytes);

  const stats = {};
  const bodyText = reuse
    ? renderDelta(reuse.delta, { maxBytes: turnBudget, stats })
    : renderTranscript(convo, { maxBytes: turnBudget, stats });
  let text = `${bodyText || "(empty)"}${imageNote}`;
  let upstreamText = preamble ? `${preamble}\n\n${text}` : text;
  if (byteLen(upstreamText) > textCap) {
    upstreamText = byteLen(text) <= textCap ? text : capText(text, textCap);
    stats.truncated = true;
  }
  if (!upstreamText.trim()) upstreamText = "(empty)";

  const payload = {
    text: upstreamText,
    message_id: crypto.randomUUID(),
    agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || "en-US").replace("_", "-"),
  };
  if (effort) payload.thinking_effort = effort;
  if (systemPrompt) payload.system_prompt = systemPrompt;
  if (customPrompt) payload.custom_prompt = customPrompt;
  if (tools.length) payload.web_search_enabled = false;
  if (images.attachments.length) payload.attachments = images.attachments;

  return {
    convo,
    scope,
    mode,
    threadId: reuse?.threadId || crypto.randomUUID(),
    reused: Boolean(reuse),
    payload,
    parser: tools.length ? createToolCallParser() : null,
    truncated: Boolean(stats.truncated),
  };
}

async function* quickTurnEvents({ socket, threadId, payload, parser, signal, idleTimeoutMs }) {
  let fedText = false;
  for await (const event of socket.turn(threadId, payload, { signal, idleTimeoutMs })) {
    const type = event.type;
    const data = event.payload || {};
    if (type === "text_delta" && typeof data.delta === "string") {
      fedText = true;
      const parsed = parser ? parser.push(data.delta) : { text: data.delta, calls: [] };
      if (parsed.text) yield { type: "text", text: parsed.text };
      for (const call of parsed.calls) {
        yield { type: "tool_call", id: newToolCallId(), name: call.name, arguments: JSON.stringify(call.arguments ?? {}) };
      }
    } else if (type === "thinking_delta" && typeof data.delta === "string") {
      yield { type: "reasoning", text: data.delta };
    } else if (type === "turn_usage") {
      const usage = usageFrom(data);
      if (usage) yield { type: "usage", usage };
    } else if (type === "message_complete") {
      // Deltas can be dropped; the complete payload carries the full text.
      if (!fedText && typeof data.text === "string" && data.text) {
        fedText = true;
        const parsed = parser ? parser.push(data.text) : { text: data.text, calls: [] };
        if (parsed.text) yield { type: "text", text: parsed.text };
        for (const call of parsed.calls) {
          yield { type: "tool_call", id: newToolCallId(), name: call.name, arguments: JSON.stringify(call.arguments ?? {}) };
        }
      }
    } else if (type === "status") {
      const status = data.status || data.message;
      if (status && !/pong|ok/i.test(String(status))) yield { type: "note", text: String(status) };
    }
  }
  if (parser) {
    const tail = parser.end();
    if (tail.text) yield { type: "text", text: tail.text };
    for (const call of tail.calls) {
      yield { type: "tool_call", id: newToolCallId(), name: call.name, arguments: JSON.stringify(call.arguments ?? {}) };
    }
    if (tail.dropped) yield { type: "note", text: "tool call output was truncated" };
  }
}

function applyItem(item, state) {
  if (item.type === "text") state.text += item.text;
  else if (item.type === "reasoning") state.reasoning += item.text;
  else if (item.type === "tool_call") {
    state.calls.push({ id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } });
  } else if (item.type === "usage") {
    const usage = item.usage;
    if (!state.usage) state.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    state.usage.prompt_tokens += usage.prompt_tokens || 0;
    state.usage.completion_tokens += usage.completion_tokens || 0;
    state.usage.total_tokens += usage.total_tokens || 0;
    if (usage.prompt_tokens_details?.cached_tokens) {
      state.usage.prompt_tokens_details = state.usage.prompt_tokens_details || { cached_tokens: 0 };
      state.usage.prompt_tokens_details.cached_tokens += usage.prompt_tokens_details.cached_tokens;
    }
  } else if (item.type === "note") {
    state.notes.push(item.text);
  }
}

function replyMessage(state) {
  return {
    role: "assistant",
    content: state.text,
    ...(state.calls.length ? { tool_calls: state.calls } : {}),
  };
}

async function drain(items, state) {
  for await (const item of items) applyItem(item, state);
  return state;
}

async function prefetch(iterator) {
  const pre = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { pre, done: true };
    pre.push(next.value);
    if (next.value.type !== "note") return { pre, done: false };
  }
}

export class AwsQuickExecutor extends BaseExecutor {
  constructor() {
    super("aws-quick", PROVIDERS["aws-quick"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const toResult = (response, session) => executeResult(response, { body, session });
    let session;
    try {
      session = sessionFromCredentials(credentials);
    } catch (error) {
      return toResult(errorResponse(error, log), session);
    }

    if (!isSessionFresh(session) && session.tokens.refresh_token) {
      try {
        session = await refreshQuickSession(session, { log, userAgent: fingerprintFor(credentials).userAgent });
        persistSession(credentials, session);
      } catch (error) {
        log?.warn?.("AWS-QUICK", `proactive token refresh failed: ${error.message}`);
      }
    }

    try {
      return toResult(await this.runOnce({ model, body, stream, credentials, session, signal, log }), session);
    } catch (error) {
      // Quick reports an expired/revoked bearer as a stream failure, so the
      // generic 401 retry in chatCore never sees it. Refresh here and retry
      // once on a new socket (the token is part of the socket URL).
      if (!isAuthFailure(error) || !session?.tokens?.refresh_token) {
        return toResult(errorResponse(error, log), session);
      }
      log?.warn?.("AWS-QUICK", `auth failed (${error.message}); refreshing the session`);
      try {
        const fresh = await refreshQuickSession(session, { log, userAgent: fingerprintFor(credentials).userAgent });
        persistSession(credentials, fresh);
        await dropSocket(socketKeyFor(credentials, session));
        return toResult(await this.runOnce({ model, body, stream, credentials, session: fresh, signal, log }), fresh);
      } catch (refreshError) {
        return toResult(errorResponse(refreshError?.kind ? refreshError : error, log), session);
      }
    }
  }

  async runOnce({ model, body, stream, credentials, session, signal, log, forceFresh = false }) {
    const turn = buildTurn({ body, model, credentials, session, forceFresh });
    const { key, entry } = acquireSocket({ credentials, session, log });
    const idleTimeoutMs = Number(credentials?.providerSpecificData?.awsQuickIdleTimeoutMs) || QUICK_IDLE_TIMEOUT_MS;

    const iterator = quickTurnEvents({
      socket: entry.socket,
      threadId: turn.threadId,
      payload: turn.payload,
      parser: turn.parser,
      signal,
      idleTimeoutMs,
    });

    let started;
    try {
      started = await prefetch(iterator);
    } catch (error) {
      iterator.return?.();
      releaseSocket(key, entry);
      if (turn.reused && !isAuthFailure(error) && !signal?.aborted) {
        // A cached thread may be gone server-side — retry once with the full
        // transcript on a fresh thread.
        log?.debug?.("AWS-QUICK", `thread reuse failed (${error.message}); retrying fresh`);
        return this.runOnce({ model, body, stream, credentials, session, signal, log, forceFresh: true });
      }
      throw error;
    }

    const items = (async function* () {
      yield* started.pre;
      if (started.done) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })();

    const id = `chatcmpl-aq-${turn.threadId.slice(0, 8)}-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const state = { text: "", reasoning: "", calls: [], usage: null, notes: [] };
    let finished = false;
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (state.text || state.calls.length) {
        try {
          rememberTurn(turn.scope, turn.convo, replyMessage(state), turn.threadId);
        } catch (error) {
          log?.warn?.("AWS-QUICK", `thread bookkeeping failed: ${error.message}`);
        }
      }
      releaseSocket(key, entry);
    };

    if (!stream) {
      try {
        await drain(items, state);
        finalize();
      } catch (error) {
        finalize();
        return errorResponse(error, log);
      }
      const message = { role: "assistant", content: state.text };
      if (state.reasoning) message.reasoning_content = state.reasoning;
      if (state.calls.length) message.tool_calls = state.calls;
      if (state.notes.length) message.content = `${message.content}\n\n${state.notes.map((note) => `> [quick] ${note}`).join("\n")}`;
      return new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message,
              finish_reason: state.calls.length ? "tool_calls" : "stop",
              logprobs: null,
            },
          ],
          usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const includeUsage = body?.stream_options?.include_usage === true;
    const output = new ReadableStream({
      async start(controller) {
        let sentRole = false;
        let toolIndex = 0;
        const send = (obj) => controller.enqueue(encoder.encode(sseChunk(obj)));
        const chunk = (delta, finish = null) =>
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            system_fingerprint: null,
            choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
          });
        const ensureRole = () => {
          if (sentRole) return;
          sentRole = true;
          chunk({ role: "assistant", content: "" });
        };

        try {
          for await (const item of items) {
            applyItem(item, state);
            if (item.type === "text") {
              ensureRole();
              chunk({ content: item.text });
            } else if (item.type === "reasoning") {
              ensureRole();
              chunk({ reasoning_content: item.text });
            } else if (item.type === "tool_call") {
              ensureRole();
              chunk({
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: item.id,
                    type: "function",
                    function: { name: item.name, arguments: item.arguments },
                  },
                ],
              });
            } else if (item.type === "note") {
              ensureRole();
              chunk({ content: `\n\n> [quick] ${item.text}` });
            }
          }
          if (turn.truncated) {
            ensureRole();
            chunk({ content: "\n\n> [quick] context exceeded the 64 KB frame limit; older content was truncated" });
          }
          ensureRole();
          chunk({}, toolIndex > 0 ? "tool_calls" : "stop");
          if (includeUsage) {
            send({ id, object: "chat.completion.chunk", created, model, choices: [], usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
          }
        } catch (error) {
          try {
            send({ error: { message: error?.message || String(error), type: statusFor(error) === 401 ? "authentication_error" : "api_error", code: statusFor(error) } });
          } catch { /* consumer cancelled */ }
        } finally {
          finalize();
          try {
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } catch { /* consumer cancelled */ }
        }
      },
      cancel() {
        iterator.return?.();
        finalize();
      },
    });

    return new Response(output, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
  }

  async refreshCredentials(credentials, log) {
    let session;
    try {
      session = sessionFromCredentials(credentials);
    } catch {
      return null;
    }
    if (!session.tokens.refresh_token) return null;
    try {
      const fresh = await refreshQuickSession(session, { log });
      const updates = sessionCredentialUpdates(fresh, credentials);
      Object.assign(credentials, updates);
      return updates;
    } catch (error) {
      log?.warn?.("AWS-QUICK", `token refresh failed: ${error.message}`);
      return null;
    }
  }

  needsRefresh(credentials) {
    try {
      return !isSessionFresh(sessionFromCredentials(credentials));
    } catch {
      return false;
    }
  }
}

export default AwsQuickExecutor;
