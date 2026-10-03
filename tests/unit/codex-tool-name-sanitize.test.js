// Codex (OpenAI Responses API) rejects tool names that don't match
// ^[a-zA-Z0-9_-]+$ with 400 "Invalid 'input[291].name': string does not match
// pattern". Claude clients (Cline, MCP) routinely send dotted names like
// `mcp__slack.post_message` — both in tools[] and in historical function_call
// input items. The claude→openai→openai-responses pivot must sanitize every
// name consistently and expose a reverse map so streamed tool calls restore
// the client's original spelling.
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { restoreToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function claudeBody() {
  return {
    model: "gpt-6.1-sol",
    max_tokens: 8192,
    stream: true,
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [
      {
        name: "mcp__slack.post_message",
        description: "Post a message",
        input_schema: { type: "object", properties: { channel: { type: "string" } } },
      },
      // collides with the sanitized form of the first name
      { name: "mcp__slack_post_message", description: "Colliding name", input_schema: { type: "object", properties: {} } },
      // already valid — must pass through untouched
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "mcp__slack.post_message" },
    messages: [
      { role: "user", content: [{ type: "text", text: "post to #general" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01", name: "mcp__slack.post_message", input: { channel: "#general" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "sent" }],
      },
    ],
  };
}

describe("codex tool-name sanitization (claude → openai-responses)", () => {
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", claudeBody(), true, null, "codex");

  it("sanitizes every tools[] declaration name to the Responses pattern", () => {
    expect(Array.isArray(out.tools)).toBe(true);
    for (const tool of out.tools) {
      expect(tool.name).toMatch(NAME_PATTERN);
      expect(tool.name.length).toBeLessThanOrEqual(128);
    }
    const names = out.tools.map((t) => t.name);
    expect(names).toContain("mcp__slack_post_message");
    expect(names).toContain("Read");
  });

  it("resolves sanitized-name collisions without dropping tools", () => {
    const names = out.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
  });

  it("sanitizes historical function_call input items (the input[N].name 400)", () => {
    const calls = out.input.filter((i) => i.type === "function_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.name).toMatch(NAME_PATTERN);
    }
    // history name matches the sanitized declaration so the model's replay
    // stays consistent with the advertised toolset
    expect(out.tools.map((t) => t.name)).toContain(calls[0].name);
  });

  it("sanitizes tool_choice name", () => {
    expect(out.tool_choice?.name).toMatch(NAME_PATTERN);
    expect(out.tool_choice?.name).toBe("mcp__slack_post_message");
  });

  it("exposes a sanitized → original reverse map for response restore", () => {
    const map = out._toolNameMap;
    expect(map).toBeInstanceOf(Map);
    expect(map.get("mcp__slack_post_message")).toBe("mcp__slack.post_message");
    // "Read" needed no rename, so it must not pollute the map
    expect([...map.values()]).not.toContain("Read");
  });

  it("restores the client's original name on streamed Claude tool_use blocks", () => {
    const map = out._toolNameMap;
    const chunk = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_01", name: "mcp__slack_post_message", input: {} },
    };
    const restored = restoreToolNames(chunk, map);
    expect(restored.content_block.name).toBe("mcp__slack.post_message");
  });

  it("leaves already-valid names untouched end to end", () => {
    const map = out._toolNameMap;
    const chunk = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_02", name: "Read", input: {} },
    };
    expect(restoreToolNames(chunk, map).content_block.name).toBe("Read");
  });
});
