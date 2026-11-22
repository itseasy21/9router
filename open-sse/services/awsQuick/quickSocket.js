// AWS Quick chat bidi WebSocket client.
//
// Quick exposes no HTTP chat API. The desktop client opens one bidi socket and
// multiplexes threads over it:
//   wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
//     ?surfaceType=…&token=<id_token>&outpostId=<id>&workingSessionId=<uuid>&channel=prod
//
// Uplink frames are binary UTF-8 JSON:
//   {"eventType":"rawInputEvent","payload":{"payload":"<base64(inner JSON)>"}}
// Downlink frames are AWS event-stream messages (`:event-type=rawOutputEvent`)
// whose JSON body carries the same base64-wrapped inner event.

import { WebSocket } from "undici";
import { parseEventFrame } from "../../utils/awsEventStream.js";
import { buildQuickHeaders, buildQuickSessionConnect, buildQuickWsUrl, encodeQuickInputFrame } from "./fingerprint.js";
import {
  QUICK_APP_VERSION,
  QUICK_CHANNEL,
  QUICK_CONNECT_TIMEOUT_MS,
  QUICK_HANDSHAKE_ACK_MS,
  QUICK_IDLE_TIMEOUT_MS,
  QUICK_PING_MS,
  QUICK_SURFACE,
} from "./constants.js";

const encoder = new TextEncoder();
const MaxFrameBytes = 16 * 1024 * 1024;
const OPEN = 1;

// Executors pass the app logger module (an object with debug/info/warn/error),
// while a few callers pass a plain function. Normalize both to one sink so
// socket diagnostics never throw a TypeError mid-connect.
export function normalizeLogSink(log) {
  if (typeof log === "function") return log;
  if (typeof log?.debug === "function") return (message) => log.debug("AWS-QUICK", message);
  if (typeof log?.log === "function") return (message) => log.log(message);
  return () => {};
}

// The 9Router connector has no AIDP enterprise session to stamp from main, but
// when the pasted session is an enterprise AIDP one the desktop drops ?token=
// and main supplies `Authorization: Bearer`. Detect the same host/provider
// pair so the direct socket follows that branch instead of overflowing AIDP's
// 4 KB request line with a large IdP token.
export function quickAuthUsesHeader(session) {
  if (session?.provider !== "enterprise") return false;
  const host = String(session.ws_host || "").toLowerCase();
  if (!host || host.includes(":")) return false;
  return /\.(?:desktop\.)?enterprise\.quick\.aws\.(?:dev|com)$/.test(host);
}

export class QuickSocketError extends Error {
  constructor(message, { code, kind = "ws", status } = {}) {
    super(message);
    this.name = "QuickSocketError";
    this.code = code;
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Decode one complete AWS event-stream frame into a Quick event.
 * Returns {event}, {error} for protocol-level error frames, or null.
 */
export function decodeDownlinkFrame(frameBytes) {
  const { headers, payload } = parseEventFrame(frameBytes);
  const messageType = headers[":message-type"];
  if (messageType === "error" || messageType === "exception") {
    return {
      error: {
        code: String(headers[":error-code"] || headers[":exception-type"] || "error"),
        message: String(headers[":error-message"] || "").slice(0, 300),
      },
    };
  }
  if (headers[":event-type"] !== "rawOutputEvent" || !payload) return null;
  const inner = payload?.payload;
  if (typeof inner !== "string") return null;
  try {
    return { event: JSON.parse(Buffer.from(inner, "base64").toString("utf8")) };
  } catch {
    return null;
  }
}

/**
 * One bidi socket, multiplexed across threads by thread_id. Events are routed
 * to per-thread waiters created by turn().
 */
export class QuickSocket {
  constructor({ getSession, outpostId = "", extra = {}, log = () => {}, workingSessionId = crypto.randomUUID() }) {
    this.getSession = getSession;
    this.outpostId = outpostId;
    this.extra = extra;
    this.log = normalizeLogSink(log);
    this.workingSessionId = workingSessionId;
    this.ws = null;
    this.buffer = new Uint8Array(0);
    this.waiters = new Map();
    this.connecting = null;
    this.pingTimer = null;
    this.sessionAck = null;
    this.connectFail = null;
  }

  get isOpen() {
    return this.ws?.readyState === OPEN;
  }

  hasActiveTurns() {
    return this.waiters.size > 0;
  }

  async connect() {
    if (this.isOpen) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect() {
    const session = await this.getSession();
    if (!session?.ws_host || !session?.jwt) {
      throw new QuickSocketError("AWS Quick session has no ws_host/id_token", { kind: "auth", status: 401 });
    }
    const surface = this.extra.surfaceType || QUICK_SURFACE;
    const channel = this.extra.channel ?? QUICK_CHANNEL;
    const tokenInHeader = quickAuthUsesHeader(session);
    const url = buildQuickWsUrl(session, {
      surfaceType: surface,
      channel,
      outpostId: this.outpostId,
      workingSessionId: this.workingSessionId,
      agentRuntimeArnOverride: this.extra.agentRuntimeArnOverride,
      omitToken: tokenInHeader,
    });
    const extraHeaders = {
      ...(this.extra.headers || {}),
      ...(tokenInHeader ? { Authorization: `Bearer ${session.jwt}` } : {}),
    };
    const headers = buildQuickHeaders({
      userAgent: this.extra.userAgent,
      origin: this.extra.origin,
      acceptLanguage: this.extra.acceptLanguage,
      extra: extraHeaders,
    });

    this.log(`[aws-quick] connecting wss://${session.ws_host}/…`);
    let ws;
    try {
      // undici extension: a header list on the WebSocket handshake. Matching the
      // desktop client's UA/headers is what keeps this indistinguishable from the app.
      ws = new WebSocket(url, { headers });
    } catch (error) {
      throw new QuickSocketError(`AWS Quick WebSocket URL rejected: ${error.message}`, { kind: "ws" });
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.buffer = new Uint8Array(0);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new QuickSocketError("AWS Quick WebSocket connect timed out", { kind: "timeout", status: 504 })), QUICK_CONNECT_TIMEOUT_MS);
      timer.unref?.();
      const finish = () => clearTimeout(timer);
      ws.addEventListener("open", () => { finish(); resolve(); }, { once: true });
      ws.addEventListener("error", () => { finish(); reject(new QuickSocketError("AWS Quick WebSocket connection failed", { kind: "ws" })); }, { once: true });
      ws.addEventListener("close", (event) => {
        finish();
        if (this.ws === ws) {
          this.ws = null;
          this._failAll(new QuickSocketError(`AWS Quick socket closed (${event.code})`, { code: event.code, kind: "ws" }));
        }
        reject(new QuickSocketError(`AWS Quick socket closed before open (${event.code})`, { code: event.code, kind: "ws" }));
      }, { once: true });
      ws.addEventListener("message", (event) => this._onFrame(event));
    });

    this._sendRaw({
      type: "session_connect",
      payload: buildQuickSessionConnect({
        actorId: session.actor_arn,
        surfaceType: surface,
        outpostId: this.outpostId,
        appVersion: this.extra.appVersion || QUICK_APP_VERSION,
      }),
    });

    // The server answers session_connect with session_established/connected;
    // user_message sent before that can be dropped. A timeout is non-fatal
    // (some gateways never send the ack) but an explicit error frame is not.
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.sessionAck = null;
          this.connectFail = null;
          resolve();
        }, QUICK_HANDSHAKE_ACK_MS);
        timer.unref?.();
        const done = (fn, value) => {
          clearTimeout(timer);
          this.sessionAck = null;
          this.connectFail = null;
          fn(value);
        };
        this.sessionAck = () => done(resolve);
        this.connectFail = (error) => done(reject, error);
      });
    } catch (error) {
      try { ws.close(4000, "connect failed"); } catch { /* ignore */ }
      if (this.ws === ws) this.ws = null;
      throw error;
    }

    this._startPing();
    this.log("[aws-quick] socket open");
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this._sendRaw({ type: "ping", payload: { timestamp: Date.now() } });
      } catch {
        /* socket closed — the close handler fails pending turns */
      }
    }, QUICK_PING_MS);
    this.pingTimer.unref?.();
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _sendRaw(obj) {
    if (!this.isOpen) throw new QuickSocketError("AWS Quick socket is not open", { kind: "ws" });
    this.ws.send(encodeQuickInputFrame(obj));
  }

  send(obj) {
    this._sendRaw(obj);
  }

  _onFrame(event) {
    let data;
    if (typeof event.data === "string") data = encoder.encode(event.data);
    else if (event.data instanceof ArrayBuffer) data = new Uint8Array(event.data);
    else if (ArrayBuffer.isView(event.data)) data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    if (!data) return;

    const merged = new Uint8Array(this.buffer.length + data.length);
    merged.set(this.buffer);
    merged.set(data, this.buffer.length);

    let pos = 0;
    while (merged.length - pos >= 16) {
      const view = new DataView(merged.buffer, merged.byteOffset + pos);
      const total = view.getUint32(0, false);
      if (total < 16 || total > MaxFrameBytes) {
        pos += 1;
        continue;
      }
      if (pos + total > merged.length) break;
      try {
        const decoded = decodeDownlinkFrame(merged.subarray(pos, pos + total));
        if (decoded?.error) {
          this.log(`[aws-quick] error frame ${decoded.error.code}: ${decoded.error.message}`);
          this._dispatch({ type: "error", code: decoded.error.code, message: decoded.error.message || "stream error" });
        } else if (decoded?.event) {
          this._dispatch(decoded.event);
        }
      } catch (error) {
        this.log(`[aws-quick] frame decode error: ${error.message}`);
      }
      pos += total;
    }
    this.buffer = merged.slice(pos);
  }

  _dispatch(event) {
    if ((event.type === "session_established" || event.type === "connected") && this.sessionAck) {
      this.sessionAck();
    }
    if (event.type === "error" && this.connectFail) {
      this.connectFail(new QuickSocketError(event.message || `connect ${event.code || "error"}`, { kind: "stream", code: event.code }));
      return;
    }
    const threadId = event.thread_id || event.threadId || event.payload?.thread_id || "";
    if (threadId) {
      this.waiters.get(threadId)?.push(event);
      return;
    }
    // Session-level events (status/keepalive/errors) reach every turn.
    for (const waiter of this.waiters.values()) waiter.push(event);
  }

  _failAll(error) {
    for (const waiter of this.waiters.values()) waiter.fail(error);
    this.waiters.clear();
  }

  /**
   * Run one chat turn on `threadId`, yielding every event routed to it until a
   * terminal event. Throws QuickSocketError on protocol errors, abort, or when
   * no event arrives within `idleTimeoutMs`.
   */
  async *turn(threadId, payload, { signal, idleTimeoutMs = QUICK_IDLE_TIMEOUT_MS } = {}) {
    await this.connect();
    if (this.waiters.has(threadId)) {
      throw new QuickSocketError(`thread ${threadId} already has an active turn`, { kind: "busy" });
    }

    const queue = [];
    let failure = null;
    let notify = null;
    const waiter = {
      push: (event) => {
        queue.push(event);
        const wake = notify;
        notify = null;
        wake?.();
      },
      fail: (error) => {
        failure = error;
        const wake = notify;
        notify = null;
        wake?.();
      },
    };
    this.waiters.set(threadId, waiter);

    try {
      this._sendRaw({ type: "user_message", payload: { thread_id: threadId, ...payload } });
      for (;;) {
        while (queue.length) {
          const event = queue.shift();
          yield event;
          const type = event.type;
          const body = event.payload || {};
          // Turn termination on this transport (verified): message_complete
          // without continuation_expected===true is the last assistant
          // message; agentic turns emit one completed message per step.
          if (type === "message_complete" && body.continuation_expected !== true) return;
          if (type === "stream_ended" || type === "turn_aborted") return;
          if (type === "error" || type === "guardrail_blocked" || type === "stream_truncated") {
            throw new QuickSocketError(body.message || body.error || body.reason || `stream ${type}`, { kind: "stream" });
          }
        }
        if (failure) throw failure;
        if (signal?.aborted) throw new QuickSocketError("aborted", { kind: "abort" });

        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            notify = null;
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new QuickSocketError("AWS Quick turn timed out waiting for events", { kind: "timeout", status: 504 }));
          }, idleTimeoutMs);
          timer.unref?.();
          const onAbort = () => {
            cleanup();
            reject(new QuickSocketError("aborted", { kind: "abort" }));
          };
          notify = () => {
            cleanup();
            resolve();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (failure) {
            cleanup();
            reject(failure);
          }
        });
      }
    } finally {
      if (this.waiters.get(threadId) === waiter) this.waiters.delete(threadId);
    }
  }

  async reconnect() {
    this._stopPing();
    try { this.ws?.close(4001, "reconnect"); } catch { /* ignore */ }
    this.ws = null;
    await this.connect();
  }

  async close() {
    this._stopPing();
    this._failAll(new QuickSocketError("AWS Quick socket closed", { kind: "ws" }));
    try { this.ws?.close(1000, "bye"); } catch { /* ignore */ }
    this.ws = null;
    this.sessionAck = null;
    this.connectFail = null;
  }
}
