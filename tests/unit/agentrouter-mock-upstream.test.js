// End-to-end mock of AgentRouter's HTTP 200 + in-body rate-limit rejection.
//
// Unlike agentrouter-rate-limit-retry.test.js (which mocks proxyAwareFetch with
// Response objects), this test stands up a REAL HTTP/1.1 server and lets the
// executor's own fetch/streaming path talk to it, so chunk boundaries, TCP
// timing and undici's body reader are all exercised the way they are upstream.
//
// The executor hardcodes https://agentrouter.org/v1/... — proxyFetch calls the
// package's own undici instance (not globalThis.fetch), so the `undici` module
// is wrapped to redirect that host to 127.0.0.1 while still using real sockets.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";

const RATE_LIMIT_MESSAGE =
  "Your requests to gpt-6-astra for gpt-6-astra in eastus2 have exceeded token rate limit.";

const HEALTHY_BODY = [
  `event: response.created`,
  `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
  "",
  `event: response.reasoning_summary_text.delta`,
  `data: {"type":"response.reasoning_summary_text.delta","delta":"Checking the request"}`,
  "",
  `event: response.output_text.delta`,
  `data: {"type":"response.output_text.delta","delta":"hello"}`,
  "",
  `event: response.completed`,
  `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}`,
  "",
].join("\n");

const net = vi.hoisted(() => ({ port: 0 }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetch: (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url;
      const target = String(url).replace(/^https:\/\/agentrouter\.org/, `http://127.0.0.1:${net.port}`);
      // Drop the production TLS/keep-alive dispatcher: the mock is plain HTTP.
      const { dispatcher, ...rest } = init;
      return actual.fetch(target, rest);
    },
  };
});

const scenarios = [];
const requests = [];
let server;
let port = 0;

function respond(res, frames) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const frame of frames) res.write(frame);
  res.end();
}

// Write frames with a pause between them, like the relay does.
function respondSlowly(res, frames, gapMs = 60) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  (async () => {
    for (const frame of frames) {
      res.write(frame);
      await new Promise((r) => setTimeout(r, gapMs));
    }
    res.end();
  })();
}

const errorFrame = `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"${RATE_LIMIT_MESSAGE}"}}}\n\n`;

const { AgentRouterExecutor } = await import("../../open-sse/executors/agentrouter.js");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, body });
      const scenario = scenarios.shift();
      if (!scenario) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("no scenario queued");
        return;
      }
      scenario(res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  net.port = port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  scenarios.length = 0;
  requests.length = 0;
});

function execute(overrides = {}) {
  return new AgentRouterExecutor().execute({
    model: "gpt-6-astra",
    body: { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { apiKey: "sk-test" },
    ...overrides,
  });
}

describe("AgentRouter executor against a real SSE upstream", () => {
  it("retries a reasoning delta followed by a rate-limit frame", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n`,
          `event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Weighing the request"}\n\n`,
          errorFrame,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    expect(out.response.status).toBe(200);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries a rate-limit frame that TCP splits mid-sentence", async () => {
    const half = errorFrame.indexOf("token rate limit") + "token ra".length;
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n`,
          errorFrame.slice(0, half),
          errorFrame.slice(half),
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries when only a whitespace text delta precedes the frame", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"\\n"}\n\n`,
          errorFrame,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries when only a zero-width keep-alive delta precedes the frame", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"\u200b"}\n\n`,
          errorFrame,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries a rejection written as one whole assistant text delta", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n`,
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"[Error] ${RATE_LIMIT_MESSAGE}"}\n\n`,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries a rejection split across assistant text deltas", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"[Error] Your requests to gpt-6.1-sol for "}\n\n`,
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"gpt-6.1-sol in eastus2 have exceeded token "}\n\n`,
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"rate limit."}\n\n`,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute({ model: "gpt-6.1-sol" });

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries a prefixed-less rejection split across assistant text deltas", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Your requests to gpt-6.1-sol for "}\n\n`,
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"gpt-6.1-sol in eastus2 have exceeded token rate limit."}\n\n`,
        ]),
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute({ model: "gpt-6.1-sol" });

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("does not retry a healthy stream and replays it byte for byte", async () => {
    scenarios.push((res) => respond(res, [HEALTHY_BODY]));

    const out = await execute();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/responses");
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);

  it("retries the claude lane's thinking delta followed by an error event", async () => {
    scenarios.push(
      (res) =>
        respondSlowly(res, [
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}\n\n`,
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n`,
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Weighing"}}\n\n`,
          `event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"${RATE_LIMIT_MESSAGE}"}}\n\n`,
        ]),
      (res) => respond(res, [`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n`])
    );

    const out = await execute({ model: "claude-opus-5" });

    expect(requests).toHaveLength(2);
    expect(out.response.status).toBe(200);
  }, 20000);

  it("retries a plain-text 200 body that carries the rejection", async () => {
    scenarios.push(
      (res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(RATE_LIMIT_MESSAGE);
      },
      (res) => respond(res, [HEALTHY_BODY])
    );

    const out = await execute();

    expect(requests).toHaveLength(2);
    await expect(out.response.text()).resolves.toBe(HEALTHY_BODY);
  }, 20000);
});
