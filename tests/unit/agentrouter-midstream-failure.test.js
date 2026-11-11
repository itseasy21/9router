// AgentRouter capacity failure arriving AFTER the executor already committed the
// body (real tokens flowed first): the head-peek can no longer retry, so the
// streaming layer must surface a real SSE error frame — never an "[Error] ..."
// assistant message that would poison the conversation history.
import { describe, it, expect } from "vitest";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const CAPACITY_MESSAGE =
  "The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";

const enc = (s) => new TextEncoder().encode(s);

function upstreamStream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc(f));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

const answerDelta = (delta) =>
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${delta}"}\n\n`;
const failedFrame = (message) =>
  `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"${message}"}}}\n\n`;

function transformTo(upstream, sourceFormat) {
  return upstream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      sourceFormat,
      "agentrouter",
      null, null, "gpt-6.1-sol", "conn-test", {}, null, null, null, null
    )
  );
}

describe("AgentRouter mid-stream capacity failure", () => {
  it("OpenAI client: real tokens pass, failure becomes an error frame (not [Error] text)", async () => {
    const text = await readAll(
      transformTo(
        upstreamStream([answerDelta("hello"), failedFrame(CAPACITY_MESSAGE)]),
        FORMATS.OPENAI
      )
    );

    expect(text).toContain("hello");
    expect(text).not.toContain("[Error]");
    expect(text).toContain('"error"');
    expect(text).toContain("high demand");
    expect(text).toContain("data: [DONE]");
  });

  it("Claude client: failure becomes event: error", async () => {
    const text = await readAll(
      transformTo(
        upstreamStream([answerDelta("hello"), failedFrame(CAPACITY_MESSAGE)]),
        FORMATS.CLAUDE
      )
    );

    expect(text).toContain("hello");
    expect(text).not.toContain("[Error]");
    expect(text).toContain("event: error");
  });

  it("native overloaded_error code matches the head-peek even with novel wording", async () => {
    const { AgentRouterExecutor } = await import("../../open-sse/executors/agentrouter.js");
    const body =
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
    const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const peek = await new AgentRouterExecutor().peekRateLimitError(res);
    expect(peek.matched).toBe(true);
    expect(peek.message).toContain("Overloaded");
  });

  it("non-agentrouter providers keep the legacy [Error] translation", async () => {
    const text = await readAll(
      upstreamStream([answerDelta("hello"), failedFrame(CAPACITY_MESSAGE)]).pipeThrough(
        createSSETransformStreamWithLogger(
          FORMATS.OPENAI_RESPONSES,
          FORMATS.OPENAI,
          "codex",
          null, null, "gpt-5", "conn-test", {}, null, null, null, null
        )
      )
    );

    expect(text).toContain("[Error]");
    expect(text).not.toContain('"error"');
  });
});
