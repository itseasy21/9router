// OpenCode fingerprint history handling (v2 semantics).
//
// v2 replaced the old quartet case-canonicalization with tool aliasing:
// a caller tool whose name exactly collides with a fingerprint tool (read/
// shell) and whose arguments cannot carry OpenCode's definition is aliased
// (read -> read_client) and its PRIOR-TURN calls in history are renamed via
// aliasHistoryToolCalls so the model never reads its own earlier calls as
// calls to OpenCode's tool. A compatible definition is normalized in place
// and keeps its name, so there is no alias to restore.
// Case variants (Bash/Read) are respected as separate tools and pass
// through untouched; upstream accepts them next to read/shell.
import { describe, expect, it } from "vitest";
import { concealFingerprintToolNames, aliasHistoryToolCalls, takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import "../translator/registerAll.js";

// `encoding` is not a fingerprint argument, so this definition cannot be swapped
// for OpenCode's in place and must travel under `read_client`.
const CLIENT_READ_DEF = {
  description: "Client's own read tool",
  parameters: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } }, required: ["path"] },
};
const CLIENT_READ_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, encoding: { type: "string" } },
  required: ["path"],
};

describe("aliasHistoryToolCalls (v2)", () => {
  it("renames prior function_call history for aliased caller tools", () => {
    const { map } = concealFingerprintToolNames([
      { name: "read", ...CLIENT_READ_DEF },
    ]);
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { type: "function_call", name: "read", call_id: "call_1", arguments: '{"path":"/etc"}' },
      ],
    };
    aliasHistoryToolCalls(body, map);
    expect(body.input[1].name).toBe("read_client");
    expect(body.input[1].call_id).toBe("call_1");
    expect(body.input[0].content[0].text).toBe("list files");
  });

  it("renames assistant tool_calls in chat-shaped history", () => {
    const { map } = concealFingerprintToolNames([
      { type: "function", function: { name: "read", ...CLIENT_READ_DEF } },
    ]);
    const body = {
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/etc"}' } }] },
      ],
    };
    aliasHistoryToolCalls(body, map);
    expect(body.messages[1].tool_calls[0].function.name).toBe("read_client");
  });

  it("leaves unrelated and case-variant names untouched", () => {
    const { map } = concealFingerprintToolNames([
      { name: "read", ...CLIENT_READ_DEF },
    ]);
    const body = {
      input: [
        { type: "function_call", name: "Bash", call_id: "c1", arguments: '{"command":"ls"}' },
        { type: "function_call", name: "edit_file", call_id: "c2", arguments: "{}" },
      ],
    };
    aliasHistoryToolCalls(body, map);
    expect(body.input[0].name).toBe("Bash");
    expect(body.input[1].name).toBe("edit_file");
  });

  it("is a no-op with an empty map or missing body", () => {
    const body = { input: [{ type: "function_call", name: "read", call_id: "c1", arguments: "{}" }] };
    const before = JSON.stringify(body);
    aliasHistoryToolCalls(body, new Map());
    aliasHistoryToolCalls(null, new Map([["a", "b"]]));
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("executor integration — history matches aliased declarations", () => {
  it("opencode free executor aliases a colliding client tool and its history", () => {
    const body = {
      model: "muse-spark-1.3-contributor-free",
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/etc/hosts"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "127.0.0.1 localhost" },
      ],
      tools: [{ type: "function", function: { name: "read", description: CLIENT_READ_DEF.description, parameters: CLIENT_READ_SCHEMA } }],
    };
    const executor = new OpenCodeExecutor();
    executor.transformRequest("muse-spark-1.3-contributor-free", body, true, {});
    const toolName = (t) => t.function?.name ?? t.name;
    const names = body.tools.map(toolName);
    expect(names).not.toContain("bash");
    expect(names).toContain("shell");
    // client's 'read' traveled under an alias; OpenCode's own read follows it
    expect(names).toContain("read_client");
    expect(names.filter((n) => n === "read").length).toBe(1);
    const map = takeRenamedToolNames(body);
    expect(map.get("read_client")).toBe("read");
    expect(body.messages[1].tool_calls[0].function.name).toBe("read_client");
  });

  it("opencode-zen responses executor aliases history function_calls too", () => {
    const claude = {
      model: "muse-spark-1.3-contributor",
      max_tokens: 2048,
      stream: true,
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "read", description: CLIENT_READ_DEF.description, input_schema: CLIENT_READ_SCHEMA }],
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "/x" } }] },
      ],
    };
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor", claude, true, null, "opencode-zen");
    const out = new OpenCodeZenExecutor().transformRequest("muse-spark-1.3-contributor", translated, true, null);
    const names = out.tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("read_client");
    const map = takeRenamedToolNames(out);
    expect(map.get("read_client")).toBe("read");
    const historyCalls = out.input.filter((i) => i?.type === "function_call");
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const call of historyCalls) expect(call.name).toBe("read_client");
  });
});
