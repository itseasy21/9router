// AgentRouter reports a spent token budget as HTTP 200 + an in-body error frame.
// Without retrying, the error frame becomes an ordinary assistant text chunk
// ("[Error] ...") and the turn is recorded as a successful 0-token answer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  AgentRouterExecutor,
  agentRouterBackoffDelay,
  AGENTROUTER_RATE_LIMIT_MAX_RETRIES,
} = await import("../../open-sse/executors/agentrouter.js");

const RATE_LIMIT_MESSAGE =
  "Your requests to gpt-6-astra for gpt-6-astra in eastus2 have exceeded token rate limit.";

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sse(body, status = 200) {
  return new Response(body, { status, headers: SSE_HEADERS });
}

// Shape returned by AgentRouter's /v1/responses relay when the pool budget is spent.
function rateLimitSse(message = RATE_LIMIT_MESSAGE) {
  return sse(
    [
      `event: error`,
      `data: {"type":"error","error":{"type":"rate_limit_error","message":"${message}"}}`,
      "",
      `event: response.failed`,
      `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"${message}"}}}`,
      "",
    ].join("\n")
  );
}

const HEALTHY_BODY = [
  `event: response.created`,
  `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
  "",
  `event: response.output_text.delta`,
  `data: {"type":"response.output_text.delta","delta":"hello"}`,
  "",
  `event: response.completed`,
  `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}`,
  "",
].join("\n");

function makeExecutor() {
  return new AgentRouterExecutor();
}

const args = { model: "gpt-6-astra", body: {}, stream: true, credentials: { apiKey: "sk-test" } };

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.useRealTimers());

describe("agentRouterBackoffDelay — exponential schedule", () => {
  it("doubles from the configured base", () => {
    expect(agentRouterBackoffDelay(0)).toBe(2000);
    expect(agentRouterBackoffDelay(1)).toBe(4000);
    expect(agentRouterBackoffDelay(2)).toBe(8000);
  });
});

describe("AgentRouterExecutor.execute — in-body token rate limit", () => {
  it("retries the same request with backoff and returns the recovered stream", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(rateLimitSse())
      .mockResolvedValueOnce(rateLimitSse())
      .mockResolvedValueOnce(sse(HEALTHY_BODY));

    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(agentRouterBackoffDelay(0) + agentRouterBackoffDelay(1));
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  it(`gives up after ${AGENTROUTER_RATE_LIMIT_MAX_RETRIES} retries with a real 429`, async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => rateLimitSse());

    const pending = makeExecutor().execute(args);
    // Allow every backoff step: 2s + 4s + 8s.
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(AGENTROUTER_RATE_LIMIT_MAX_RETRIES + 1);
    expect(out.response.status).toBe(429);
    const body = await out.response.json();
    expect(body.error.message).toContain("exceeded token rate limit");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("does not retry a healthy stream and replays it byte for byte", async () => {
    fetchMock.mockResolvedValueOnce(sse(HEALTHY_BODY));
    const out = await makeExecutor().execute(args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  // The relay emits empty `response.output_text.delta` frames as keep-alives.
  // They carry no answer, so the peek must keep reading and still see the error.
  it("retries when an empty delta keep-alive precedes the error frame", async () => {
    const body = [
      `event: response.created`,
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      "",
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":""}`,
      "",
      `event: response.failed`,
      `data: {"type":"response.failed","response":{"status":"failed","error":{"message":"${RATE_LIMIT_MESSAGE}"}}}`,
      "",
    ].join("\n");

    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sse(body)).mockResolvedValueOnce(sse(HEALTHY_BODY));
    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(agentRouterBackoffDelay(0));
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  it("does not retry when the marker arrives inside real output", async () => {
    const body = [
      `event: response.created`,
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      "",
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"upstream said: ${RATE_LIMIT_MESSAGE}"}`,
      "",
    ].join("\n");
    fetchMock.mockResolvedValueOnce(sse(body));
    const out = await makeExecutor().execute(args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(body);
  });

  // A status error is BaseExecutor's job (503 retries there, 400 does not); the
  // in-body peek must leave it completely alone.
  it("passes a non-2xx response through untouched", async () => {
    fetchMock.mockResolvedValueOnce(
      sse(`{"error":{"message":"${RATE_LIMIT_MESSAGE}"}}`, 400)
    );
    const out = await makeExecutor().execute(args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(400);
    await expect(out.response.json()).resolves.toEqual({
      error: { message: RATE_LIMIT_MESSAGE },
    });
  });

  it("retries the claude lane's error frame too", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sse(`event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"${RATE_LIMIT_MESSAGE}"}}\n\n`)
      )
      .mockResolvedValueOnce(
        sse(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n`)
      );

    vi.useFakeTimers();
    const pending = makeExecutor().execute({ ...args, model: "claude-opus-5" });
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
  });
});
