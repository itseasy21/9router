import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { AgentRouterExecutor } from "../../open-sse/executors/agentrouter.js";

// Responses API requires max_output_tokens >= 16; Claude-Code-style helper
// requests (topic detection, haiku pings) send max_tokens:1, which otherwise
// surfaces as a 400 "The number must be `>= 16`" from the upstream gateway.

const OPENCODE_CREDS = { rawHeaders: {}, connectionId: "conn-test" };

describe("max_output_tokens floor on Responses-only models", () => {
  it("opencode: floors max_tokens:1 to 16 on muse-spark free", () => {
    const out = new OpenCodeExecutor().transformRequest(
      "muse-spark-1.3-contributor-free",
      { max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      true,
      OPENCODE_CREDS
    );
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("opencode: leaves valid values untouched", () => {
    const out = new OpenCodeExecutor().transformRequest(
      "muse-spark-1.3-contributor-free",
      { max_tokens: 4096, messages: [{ role: "user", content: "hi" }] },
      true,
      OPENCODE_CREDS
    );
    expect(out.max_output_tokens).toBe(4096);
  });

  it("opencode: floors via max_completion_tokens alias too", () => {
    const out = new OpenCodeExecutor().transformRequest(
      "muse-spark-1.3-contributor-free",
      { max_completion_tokens: 4, messages: [{ role: "user", content: "hi" }] },
      true,
      OPENCODE_CREDS
    );
    expect(out.max_output_tokens).toBe(16);
  });

  it("agentrouter: floors max_tokens:1 to 16 on gpt-6-astra", () => {
    const out = new AgentRouterExecutor().transformRequest(
      "gpt-6-astra",
      { max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      true,
      {}
    );
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
  });

  it("agentrouter: leaves valid values untouched", () => {
    const out = new AgentRouterExecutor().transformRequest(
      "gpt-6-astra",
      { max_tokens: 8192, messages: [{ role: "user", content: "hi" }] },
      true,
      {}
    );
    expect(out.max_output_tokens).toBe(8192);
  });
});
