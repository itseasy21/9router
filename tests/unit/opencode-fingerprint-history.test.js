// Live-probed regression (opencode free muse /zen/v1/responses): a multi-turn
// session sends prior tool calls in input[] history with the CLIENT's spelling
// ("Bash"), while applyFingerprintTools cloaks only the tools[] declarations to
// lowercase ("bash"). The model then imitates the history spelling, calls the
// undeclared "Bash", and emits EMPTY arguments (argsFinal="" → client-side
// "required parameter 'command' is missing"). History items must be
// canonicalized to match the declarations; no reverse mapping needed since
// history is context-only and never streamed back.
import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import {
  applyFingerprintTools,
  concealFingerprintHistoryNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

const FREE_MODEL = "muse-spark-1.3-contributor-free";
const ZEN_RESPONSES_MODEL = "muse-spark-1.3";

const BASH_TOOL = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

describe("concealFingerprintHistoryNames", () => {
  it("canonicalizes quartet case-variants in Responses function_call history", () => {
    const body = {
      input: [
        { type: "function_call", name: "Bash", call_id: "call_1", arguments: "{\"command\":\"ls\"}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    };
    concealFingerprintHistoryNames(body);
    expect(body.input[0].name).toBe("bash");
    // Non-quartet history names are outside the fingerprint contract
    const body2 = {
      input: [{ type: "function_call", name: "mcp__slack.post_message", call_id: "call_2", arguments: "{}" }],
    };
    concealFingerprintHistoryNames(body2);
    expect(body2.input[0].name).toBe("mcp__slack.post_message");
  });

  it("canonicalizes assistant tool_calls in chat-shaped history", () => {
    const body = {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    };
    concealFingerprintHistoryNames(body);
    expect(body.messages[0].tool_calls[0].function.name).toBe("bash");
  });

  it("leaves already-canonical and flat-call names untouched", () => {
    const body = {
      messages: [{ role: "assistant", tool_calls: [{ name: "read" }] }],
      input: [{ type: "function_call", name: "grep", call_id: "c", arguments: "{}" }],
    };
    concealFingerprintHistoryNames(body);
    expect(body.messages[0].tool_calls[0].name).toBe("read");
    expect(body.input[0].name).toBe("grep");
  });
});

describe("executor integration — history matches cloaked declarations", () => {
  it("opencode free executor rewrites 'Bash' function_call history to 'bash'", () => {
    const ex = new OpenCodeExecutor();
    const body = {
      model: FREE_MODEL,
      input: [
        { type: "function_call", name: "Bash", call_id: "call_1", arguments: "{\"command\":\"echo hi\"}" },
        { type: "function_call_output", call_id: "call_1", output: "hi" },
      ],
      messages: [{ role: "user", content: "continue" }],
      tools: [BASH_TOOL],
    };
    const out = ex.transformRequest(FREE_MODEL, body, true, {});
    const declared = out.tools.filter((t) => t?.type === "function").map((t) => t.name);
    expect(declared).toContain("bash");
    expect(declared).not.toContain("Bash");
    const historyCalls = out.input.filter((i) => i?.type === "function_call");
    for (const item of historyCalls) {
      expect(declared).toContain(item.name); // history names must be declared tools
    }
  });

  it("opencode-zen responses executor rewrites history too", () => {
    const ex = new OpenCodeZenExecutor();
    const body = {
      model: ZEN_RESPONSES_MODEL,
      input: [
        { type: "function_call", name: "Read", call_id: "call_9", arguments: "{\"file_path\":\"/x\"}" },
        { type: "function_call_output", call_id: "call_9", output: "contents" },
      ],
      messages: [{ role: "user", content: "go on" }],
      tools: [BASH_TOOL],
    };
    const out = ex.transformRequest(ZEN_RESPONSES_MODEL, body, true, {});
    const declared = out.tools.filter((t) => t?.type === "function").map((t) => t.name);
    const historyCalls = out.input.filter((i) => i?.type === "function_call");
    expect(historyCalls.map((i) => i.name)).toEqual(["read"]);
    for (const item of historyCalls) expect(declared).toContain(item.name);
  });

  it("applyFingerprintTools covers history in one pass and keeps the rename map declaration-only", () => {
    const body = {
      tools: [BASH_TOOL],
      input: [{ type: "function_call", name: "Bash", call_id: "c", arguments: "{}" }],
    };
    const map = applyFingerprintTools(body, true);
    expect([...map.entries()]).toEqual([["bash", "Bash"]]); // response restore unaffected
    expect(body.input[0].name).toBe("bash");
  });
});
