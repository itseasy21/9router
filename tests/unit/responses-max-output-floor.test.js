import { describe, expect, it } from "vitest";
import { AgentRouterExecutor } from "../../open-sse/executors/agentrouter.js";

// Responses API requires max_output_tokens >= 16; Claude-Code-style helper
// requests (topic detection, haiku pings) send max_tokens:1, which otherwise
// surfaces as a 400 "The number must be `>= 16`" from the upstream gateway.

describe("max_output_tokens floor on Responses-only models", () => {
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
