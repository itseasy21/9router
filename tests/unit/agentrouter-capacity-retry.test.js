// AgentRouter capacity rejection (high-demand / Provisioned Throughput) must be
// retried exactly like the token-rate-limit rejection: the gateway still answers
// HTTP 200 with the failure inside the body, which otherwise leaks to the client
// as an "[Error] ..." assistant message and ends the turn.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  AgentRouterExecutor,
  AGENTROUTER_RATE_LIMIT_MAX_RETRIES,
} = await import("../../open-sse/executors/agentrouter.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

const CAPACITY_MESSAGE =
  "The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sse(body, status = 200) {
  return new Response(body, { status, headers: SSE_HEADERS });
}

function capacityFailedSse(message = CAPACITY_MESSAGE) {
  return sse(
    [
      `event: response.failed`,
      `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"${message}"}}}`,
      ``,
    ].join("\n")
  );
}

const HEALTHY_BODY = [
  `event: response.created`,
  `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
  ``,
  `event: response.output_text.delta`,
  `data: {"type":"response.output_text.delta","delta":"hello"}`,
  ``,
  `event: response.completed`,
  `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}`,
  ``,
].join("\n");

function makeExecutor() {
  return new AgentRouterExecutor();
}

const args = { model: "gpt-6.1-sol", body: {}, stream: true, credentials: { apiKey: "sk-test" } };

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.useRealTimers());

describe("AgentRouterExecutor.execute — capacity (high-demand) rejection", () => {
  it("retries an in-body capacity error frame and returns the recovered stream", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(capacityFailedSse()).mockResolvedValueOnce(sse(HEALTHY_BODY));
    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  it("retries a capacity rejection split across assistant text deltas", async () => {
    const body = [
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"[Error] The system is currently experiencing "}`,
      ``,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load."}`,
      ``,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":" For improved capacity reliability, consider switching to Provisioned Throughput."}`,
      ``,
    ].join("\n");

    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sse(body)).mockResolvedValueOnce(sse(HEALTHY_BODY));
    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  it("retries a plain-text 200 body carrying the capacity rejection", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(CAPACITY_MESSAGE, { status: 200, headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(sse(HEALTHY_BODY));
    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  });

  it("retries the claude lane capacity error frame too", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        sse(`event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"${CAPACITY_MESSAGE}"}}\n\n`)
      )
      .mockResolvedValueOnce(
        sse(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n`)
      );
    const pending = makeExecutor().execute({ ...args, model: "claude-opus-5" });
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
  });

  it("does not retry a real answer that merely quotes the capacity sentence", async () => {
    const body = [
      `event: response.created`,
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      ``,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"upstream said: ${CAPACITY_MESSAGE}"}`,
      ``,
    ].join("\n");
    fetchMock.mockResolvedValueOnce(sse(body));
    const out = await makeExecutor().execute(args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(body);
  });

  it("gives up after retries with a 429 the fallback layers treat as rate limit", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => capacityFailedSse());
    const pending = makeExecutor().execute(args);
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(AGENTROUTER_RATE_LIMIT_MAX_RETRIES + 1);
    expect(out.response.status).toBe(429);
    const body = await out.response.json();
    expect(body.error.message).toContain("high demand");

    // Account rotation + combo fallthrough key off this classification.
    const classified = checkFallbackError(429, body.error.message, 0, "agentrouter");
    expect(classified.shouldFallback).toBe(true);
    expect(classified.cooldownMs).toBeGreaterThan(0);
  });
});
