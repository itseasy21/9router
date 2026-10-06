// Codex (OpenAI Responses API) rejects tool names that don't match
// ^[a-zA-Z0-9_-]+$ with 400 "Invalid 'input[291].name': string does not match
// pattern". Claude clients (Cline, MCP) routinely send dotted names like
// `mcp__slack.post_message` — in tools[], historical function_call items and
// tool_choice. The sanitization is CODEX-SCOPE ONLY: it lives in
// CodexExecutor.transformRequest, not the shared openai→openai-responses
// translator, because other responses targets (opencode muse-spark, etc.) have
// their own name contracts (e.g. the lowercase fingerprint quartet).
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { takeRenamedToolNames, restoreToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

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

// Real codex pipeline: shared claude→openai-responses pivot (untouched) then
// CodexExecutor.transformRequest (sanitizes here).
function codexTransformedBody() {
  const responsesBody = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", claudeBody(), true, null, "codex");
  const ex = new CodexExecutor();
  return ex.transformRequest("gpt-6.1-sol", responsesBody, true, null);
}

// All function-tool declarations across both wire placements: top-level
// tools[] (regular Responses) and the additional_tools input prefix (Lite).
function collectNames(out) {
  const flat = (Array.isArray(out.tools) ? out.tools : []).map((t) => t?.name).filter((n) => typeof n === "string");
  const prefixed = (out.input || [])
    .filter((i) => i?.type === "additional_tools" && Array.isArray(i.tools))
    .flatMap((i) => i.tools.map((t) => t?.name))
    .filter((n) => typeof n === "string");
  return [...flat, ...prefixed];
}

describe("codex tool-name sanitization (CodexExecutor, codex-scope only)", () => {
  const out = codexTransformedBody();

  it("sanitizes every tool declaration name to the Responses pattern (both wire placements)", () => {
    const names = collectNames(out);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      expect(name).toMatch(NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(128);
    }
    expect(names).toContain("mcp__slack_post_message");
    expect(names).toContain("Read");
  });

  it("resolves sanitized-name collisions without dropping tools", () => {
    const names = collectNames(out);
    expect(names.filter((n) => n === "mcp__slack_post_message").length).toBe(1);
    expect(names.filter((n) => n === "mcp__slack_post_message_2").length).toBe(1);
  });

  it("sanitizes historical function_call input items (the input[N].name 400)", () => {
    const calls = (out.input || []).filter((i) => i.type === "function_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.name).toMatch(NAME_PATTERN);
    }
    // history name matches a sanitized declaration so the model's replay stays
    // consistent with the advertised toolset
    expect(collectNames(out)).toContain(calls[0].name);
  });

  it("does not reference a sanitized name in tool_choice unless the tool exists", () => {
    if (out.tool_choice && typeof out.tool_choice === "object") {
      expect(collectNames(out)).toContain(out.tool_choice.name);
    }
  });

  it("exposes a sanitized → original reverse map for response restore", () => {
    const map = takeRenamedToolNames(out);
    expect(map).toBeInstanceOf(Map);
    expect(map.get("mcp__slack_post_message")).toBe("mcp__slack.post_message");
    expect(map.get("mcp__slack_post_message_2")).toBe("mcp__slack_post_message");
    // "Read" needed no rename, so it must not pollute the map
    expect([...map.values()]).not.toContain("Read");
  });

  it("restores the client's original name on streamed Claude tool_use blocks", () => {
    const map = takeRenamedToolNames(out);
    const chunk = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_01", name: "mcp__slack_post_message", input: {} },
    };
    const restored = restoreToolNames(chunk, map);
    expect(restored.content_block.name).toBe("mcp__slack.post_message");
  });
});

describe("shared openai→openai-responses translator stays untouched (opencode muse contract)", () => {
  it("does not sanitize or rename dotted tool names for non-codex responses targets", () => {
    const chatBody = {
      model: "muse-spark-1.3-contributor",
      stream: true,
      tools: [
        { type: "function", function: { name: "Bash", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "mcp__slack.post_message", description: "", parameters: { type: "object", properties: {} } } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor", chatBody, true, null, "opencode");
    const names = out.tools.map((t) => t.name);
    // names pass through verbatim — the opencode executor's fingerprint pass
    // owns casing/rename downstream
    expect(names).toContain("Bash");
    expect(names).toContain("mcp__slack.post_message");
    expect(out._toolNameMap).toBeUndefined();
  });
});
