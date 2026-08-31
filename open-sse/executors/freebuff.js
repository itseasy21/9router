import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Free-tier access to Freebuff requires wrapping every chat completion in the
// agent-run lifecycle and holding a waiting-room session, mirroring the
// official CLI traffic (and Quorinex/Freebuff2API's faithful reimplementation):
//
//   1. Waiting-room session: POST /api/v1/freebuff/session ({} body) →
//      {status: active|queued|disabled, instanceId, expiresAt, ...}. While
//      queued, poll GET with x-freebuff-instance-id until active. 404 means
//      the waiting room is disabled → proceed without an instance id.
//   2. Agent run: POST /api/v1/agent-runs {action: "START", agentId} →
//      {runId}. The agentId is the free-agent name serving the model
//      (free-agents.ts mapping). FINISH with {action: "FINISH", runId,
//      status: "completed", totalSteps, directCredits: 0, totalCredits: 0}.
//   3. Chat request carries codebuff_metadata: {run_id, cost_mode: "free",
//      client_id, freebuff_instance_id}.
//
// Error classes (server.go): "freebuff_update_required", "waiting_room_*",
// "session_superseded", "session_expired" → invalidate session and retry once.
// A run-invalid error → rotate the run and retry once. 401 → the authToken is
// dead; surface it so the caller marks the connection for re-login (there is
// no refresh token).

const FREEBUFF_UPDATE_REQUIRED_ERRORS = new Set([
  "freebuff_update_required",
  "waiting_room_required",
  "waiting_room_queued",
  "session_superseded",
  "session_expired",
]);

const FREEBUFF_UPDATE_REQUIRED_MESSAGE =
  "Freebuff requires a client update or session refresh " +
  "(freebuff_update_required). Reconnect the provider from the dashboard; " +
  "if it persists, update 9router to a version the upstream accepts.";

const SESSION_POLL_INTERVAL_MS = 5000;
const SESSION_MAX_WAIT_MS = 120000;
const SESSION_EXPIRY_SAFETY_MS = 5000;
const RUN_IDLE_TTL_MS = 600000; // retire a run after 10 idle minutes
const MAX_ATTEMPTS = 2;

// Freebuff validates the agent id against the selected model. These are the
// exact root ids from Codebuff's FREEBUFF_ROOT_AGENT_ID_BY_MODEL map.
const FREEBUFF_AGENT_BY_MODEL = Object.freeze({
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro-max": "base2-free-deepseek-pro-max",
  "deepseek/deepseek-v4-flash-max": "base2-free-deepseek-flash-max",
  "z-ai/glm-5.2": "base2-free-glm",
  "anthropic/claude-fable-5": "base2-free-fable",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
  "ox/alpha": "base2-free-ox-alpha",
});

function generateClientSessionId() {
  // Official SDK shape: Math.random().toString(36).substring(2, 15)
  return Math.random().toString(36).substring(2, 15);
}

function errorMessage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error ?? parsed?.message;
    if (typeof err === "string") return err;
    if (err?.message) return String(err.message);
  } catch {
    /* not json */
  }
  return (bodyText || "").trim();
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff);
    // Lifecycle state is isolated by authToken. Freebuff session/run IDs are
    // account-bound and must never be reused by another OAuth connection.
    this.states = new Map(); // authToken → {runs, session, sessionPending, cooldownUntil}
  }

  getState(credentials) {
    const key = String(credentials?.accessToken || credentials?.apiKey || "");
    if (!key) throw Object.assign(new Error("freebuff credentials missing authToken"), { freebuffAuth: true });
    let state = this.states.get(key);
    if (!state) {
      state = {
        runs: new Map(),
        session: null,
        sessionPending: null,
        cooldownUntil: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }

  buildUrl() {
    return this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = { ...this.config.headers };
    if (credentials.accessToken) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
    } else if (credentials.apiKey) {
      headers.Authorization = `Bearer ${credentials.apiKey}`;
    }
    headers.Accept = stream ? "text/event-stream" : "application/json";
    return headers;
  }

  // Return the exact root agent ID required by Freebuff for this model.
  agentForModel(model) {
    const modelId = String(model || "").replace(/\s*\([^()]+\)\s*$/, "").trim();
    return FREEBUFF_AGENT_BY_MODEL[modelId] || "base2-free";
  }

  async upstreamFetch(path, { method = "POST", credentials, body = null, headers = {}, signal, proxyOptions, log } = {}) {
    // config.baseUrl already includes /api/v1/chat/completions; lifecycle
    // paths also include /api/v1, so derive the origin to avoid duplication.
    const base = this.config.baseUrl.replace(/\/api\/v1(?:\/.*)?$/, "");
    const url = `${base}${path}`;
    const allHeaders = {
      Authorization: `Bearer ${credentials.accessToken || credentials.apiKey || ""}`,
      Accept: "application/json",
      "User-Agent": this.config.headers["User-Agent"],
      ...headers,
    };
    if (method === "POST" && body !== null) {
      allHeaders["Content-Type"] = "application/json";
    }
    return proxyAwareFetch(url, {
      method,
      headers: allHeaders,
      body: method === "POST" && body !== null ? JSON.stringify(body) : undefined,
      signal,
    }, proxyOptions);
  }

  // ---- Waiting-room session --------------------------------------------

  async ensureSession({ credentials, signal, log, proxyOptions }) {
    const state = this.getState(credentials);
    const now = Date.now();
    if (state.session?.status === "disabled") return "";
    if (
      state.session?.status === "active" &&
      state.session.instanceId &&
      now < state.session.expiresAtMs - SESSION_EXPIRY_SAFETY_MS
    ) {
      return state.session.instanceId;
    }
    if (state.session?.status === "queued" && state.session.instanceId) {
      const instanceId = await this.pollQueuedSession({ credentials, signal, log, proxyOptions });
      if (instanceId != null) return instanceId;
    }
    return this.refreshSession({ credentials, signal, log, proxyOptions });
  }

  async refreshSession({ credentials, signal, log, proxyOptions }) {
    const state = this.getState(credentials);
    if (state.sessionPending) return state.sessionPending;
    state.sessionPending = (async () => {
      let responseState = await this.sessionRequest("POST", { credentials, signal, log, proxyOptions });
      for (let hop = 0; hop < 3; hop++) {
        const status = String(responseState.status || "").trim();
        if (status === "disabled") {
          state.session = { status: "disabled" };
          return "";
        }
        if (status === "active") {
          const instanceId = String(responseState.instanceId || "").trim();
          if (!instanceId) throw new Error("freebuff session active response missing instanceId");
          const expiresAtMs = responseState.expiresAt ? Date.parse(responseState.expiresAt) : NaN;
          state.session = {
            status: "active",
            instanceId,
            expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 300000,
          };
          log?.debug?.("SESSION", `freebuff session active ${instanceId.slice(0, 8)}…`);
          return instanceId;
        }
        if (status === "queued") {
          const instanceId = String(responseState.instanceId || "").trim();
          if (!instanceId) throw new Error("freebuff session queued response missing instanceId");
          state.session = { status: "queued", instanceId };
          const instance = await this.pollQueuedSession({ credentials, signal, log, proxyOptions, firstState: responseState });
          if (instance != null) return instance;
          responseState = await this.sessionRequest("POST", { credentials, signal, log, proxyOptions });
          continue;
        }
        // none / ended / superseded → create-or-refresh once more
        if (status === "none" || status === "ended" || status === "superseded") {
          responseState = await this.sessionRequest("POST", { credentials, signal, log, proxyOptions });
          continue;
        }
        throw new Error(`unexpected freebuff session status "${responseState.status}"`);
      }
      throw new Error("freebuff session did not become active");
    })();
    try {
      return await state.sessionPending;
    } finally {
      state.sessionPending = null;
    }
  }

  async sessionRequest(method, { credentials, signal, log, proxyOptions, instanceId = null }) {
    const headers = {};
    if (method === "GET" && instanceId) headers["x-freebuff-instance-id"] = instanceId;
    const response = await this.upstreamFetch("/api/v1/freebuff/session", {
      method,
      credentials,
      body: method === "POST" ? {} : null,
      headers,
      signal,
      proxyOptions,
      log,
    });
    if (response.status === 404) {
      // No waiting room deployed → treat as disabled and proceed.
      return { status: "disabled" };
    }
    if (response.status === 401) {
      throw Object.assign(new Error("freebuff session unauthorized (401)"), { freebuffAuth: true });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`freebuff session request failed: ${response.status} ${errorMessage(text)}`);
    }
    const parsed = await response.json().catch(() => null);
    if (!parsed?.status) throw new Error("freebuff session response missing status");
    return parsed;
  }

  async pollQueuedSession({ credentials, signal, log, proxyOptions, firstState = null }) {
    const lifecycle = this.getState(credentials);
    const deadline = Date.now() + SESSION_MAX_WAIT_MS;
    let state = firstState;
    let instanceId = lifecycle.session?.instanceId || "";
    while (Date.now() < deadline) {
      if (!state) {
        state = await this.sessionRequest("GET", { credentials, signal, log, proxyOptions, instanceId });
      }
      const status = String(state.status || "").trim();
      if (status === "active") {
        const activeId = String(state.instanceId || instanceId).trim();
        const expiresAtMs = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
        lifecycle.session = {
          status: "active",
          instanceId: activeId,
          expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 300000,
        };
        return activeId;
      }
      if (status !== "queued") {
        // Ended/superseded → caller re-creates.
        lifecycle.session = null;
        return null;
      }
      const position = Math.max(Number(state.position) || 1, 1);
      const waitMs = state.estimatedWaitMs > 0
        ? Math.min(Math.max(state.estimatedWaitMs, 1000), SESSION_POLL_INTERVAL_MS)
        : SESSION_POLL_INTERVAL_MS;
      log?.debug?.("SESSION", `freebuff waiting room: position ${position}/${Math.max(Number(state.queueDepth) || position, position)}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      state = null;
      instanceId = lifecycle.session?.instanceId || instanceId;
    }
    throw Object.assign(
      new Error(`freebuff waiting room did not admit within ${SESSION_MAX_WAIT_MS / 1000}s`),
      { waitingRoom: true },
    );
  }

  // ---- Agent-run lifecycle ---------------------------------------------

  async acquireRun(agentId, { credentials, signal, log, proxyOptions }) {
    const state = this.getState(credentials);
    const now = Date.now();
    if (now < state.cooldownUntil) {
      throw Object.assign(
        new Error(`freebuff token cooling down for ${Math.ceil((state.cooldownUntil - now) / 1000)}s`),
        { cooldown: true },
      );
    }
    const current = state.runs.get(agentId);
    if (current && now - current.startedAt < RUN_IDLE_TTL_MS) {
      current.inflight += 1;
      current.requestCount += 1;
      return current;
    }
    const run = await this.startRun(agentId, { credentials, signal, log, proxyOptions });
    if (current) {
      // Fire-and-forget FINISH for the rotated-out run (Freebuff2API drains).
      this.finishRun(current, credentials, proxyOptions).catch(() => {});
    }
    state.runs.set(agentId, run);
    return run;
  }

  async startRun(agentId, { credentials, signal, log, proxyOptions }) {
    const response = await this.upstreamFetch("/api/v1/agent-runs", {
      credentials,
      body: { action: "START", agentId },
      signal,
      proxyOptions,
      log,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`freebuff START run failed: ${response.status} ${errorMessage(text)}`);
    }
    const parsed = await response.json().catch(() => null);
    const runId = String(parsed?.runId || "").trim();
    if (!runId) throw new Error("freebuff START run response missing runId");
    log?.debug?.("RUN", `freebuff run started ${runId.slice(0, 8)}… for ${agentId}`);
    return { id: runId, agentId, startedAt: Date.now(), requestCount: 1, inflight: 1 };
  }

  async finishRun(run, credentials, proxyOptions) {
    try {
      await this.upstreamFetch("/api/v1/agent-runs", {
        credentials,
        body: {
          action: "FINISH",
          runId: run.id,
          status: "completed",
          totalSteps: run.requestCount,
          directCredits: 0,
          totalCredits: 0,
        },
        proxyOptions,
      });
    } catch {
      // Best-effort drain; upstream expires runs on its own.
    }
  }

  releaseRun(run) {
    if (run && run.inflight > 0) run.inflight -= 1;
  }

  // ---- Request transformation ------------------------------------------

  transformRequest(model, body, stream, credentials) {
    return body; // metadata injected in execute() where the run id is known
  }

  injectMetadata(body, model, runId, sessionInstanceId) {
    const cloned = { ...body, model };
    const metadata = { ...(cloned.codebuff_metadata || {}) };
    metadata.run_id = runId;
    metadata.cost_mode = "free";
    metadata.client_id = generateClientSessionId();
    if (sessionInstanceId) metadata.freebuff_instance_id = sessionInstanceId;
    cloned.codebuff_metadata = metadata;
    return cloned;
  }

  // ---- Execution --------------------------------------------------------

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const state = this.getState(credentials);
    const agentId = this.agentForModel(model);
    let run = null;
    let sessionInstanceId = "";
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        sessionInstanceId = await this.ensureSession({ credentials, signal, log, proxyOptions });
        run = await this.acquireRun(agentId, { credentials, signal, log, proxyOptions });
      } catch (error) {
        if (error.freebuffAuth) throw error;
        lastError = error;
        if (error.waitingRoom || error.cooldown) throw error;
        // Session/run bootstrap failed once → invalidate and retry.
        state.session = null;
        continue;
      }

      const url = this.buildUrl();
      const transformedBody = this.injectMetadata(body, model, run.id, sessionInstanceId);
      const headers = this.buildHeaders(credentials, stream);
      const bodyStr = JSON.stringify(transformedBody);
      log?.debug?.("FETCH", `FREEBUFF → ${url} | run=${run.id.slice(0, 8)}… | body=${bodyStr.length}B`);

      let response;
      try {
        response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal,
        }, proxyOptions);
      } catch (error) {
        this.releaseRun(run);
        throw error;
      }

      if (response.ok) {
        this.releaseRun(run);
        return { response, url, headers, transformedBody };
      }

      const errorBody = await response.text().catch(() => "");
      const message = errorMessage(errorBody);
      this.releaseRun(run);

      if (response.status === 401) {
        // Auth token rejected → 30-min cooldown like Freebuff2API, and surface
        // for reconnect (no refresh token exists).
        state.cooldownUntil = Date.now() + 30 * 60 * 1000;
        state.session = null;
        state.runs.delete(agentId);
        throw Object.assign(
          new Error("freebuff authToken rejected (401). Reconnect the provider from the dashboard."),
          { freebuffAuth: true },
        );
      }

      if (FREEBUFF_UPDATE_REQUIRED_ERRORS.has(message)) {
        if (attempt < MAX_ATTEMPTS) {
          log?.debug?.("SESSION", `freebuff session invalid (${message}), refreshing and retrying`);
          state.session = null;
          continue;
        }
        throw Object.assign(new Error(FREEBUFF_UPDATE_REQUIRED_MESSAGE), {
          freebuffUpdateRequired: true,
          status: response.status,
        });
      }

      if (message === "run_expired" || message === "run_not_found" || /run/i.test(message) && response.status === 400) {
        if (attempt < MAX_ATTEMPTS) {
          log?.debug?.("RUN", `freebuff run invalid (${message}), rotating and retrying`);
          state.runs.delete(agentId);
          continue;
        }
      }

      throw Object.assign(
        new Error(`freebuff chat failed: ${response.status} ${message}`),
        { status: response.status },
      );
    }

    throw lastError || new Error("freebuff run expired twice in a row");
  }
}

export const __test__ = {
  generateClientSessionId,
  errorMessage,
  FREEBUFF_UPDATE_REQUIRED_ERRORS,
  SESSION_POLL_INTERVAL_MS,
  RUN_IDLE_TTL_MS,
  MAX_ATTEMPTS,
};

export default FreebuffExecutor;
