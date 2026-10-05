// OpenCode Zen executor: fingerprint quartet handling on the Responses lane.
//
// Regression: the zen executor's local ensureResponsesFingerprintTools checked
// for existing quartet tools case-sensitively, so a Claude Code client
// declaring "Bash" got a duplicate lowercase "bash" decoy with an EMPTY schema
// next to it. The model then called the decoy and freeballed arguments that
// failed client validation ("The required parameter `command` is missing" /
// "`file_path` is missing"). The executor must use the shared fingerprint
// helper: canonicalize case-variants into one declaration with a rename map
// (bash → Bash) so streamed tool calls restore the client's spelling.
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import "../translator/registerAll.js";

function claudeBody() {
  return {
    model: "muse-spark-1.3-contributor",
    max_tokens: 8192,
    stream: true,
    system: [{ type: "text", text: "sys" }],
    tools: [
      { name: "Bash", description: "Executes a bash command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "run ls" }] }],
  };
}

function transformed() {
  const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor", claudeBody(), true, null, "opencode-zen");
  new OpenCodeZenExecutor().transformRequest("muse-spark-1.3-contributor", translated, true, null);
  return translated;
}

describe("opencode-zen fingerprint quartet (Responses lane)", () => {
  it("never sends duplicate case-variant tools (Bash + bash)", () => {
    const names = transformed().tools.map((t) => t.name);
    const lower = names.map((n) => n.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(names).toContain("bash");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("read");
  });

  it("keeps the client's real schema on the canonical declaration", () => {
    const bash = transformed().tools.find((t) => t.name === "bash");
    expect(bash.parameters.required).toEqual(["command"]);
    expect(bash.parameters.properties.command).toBeDefined();
  });

  it("records a rename map so streamed calls restore the client's spelling", () => {
    const map = takeRenamedToolNames(transformed());
    expect(map).toBeInstanceOf(Map);
    expect(map.get("bash")).toBe("Bash");
    expect(map.get("read")).toBe("Read");
  });

  it("restores name + args end to end for a model call to the canonical name", () => {
    const out = transformed();
    const map = takeRenamedToolNames(out) || new Map();
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.toolNameMap = map;
    const events = [
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "" } } },
      { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"command": "ls -la"}' } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command": "ls -la"}' } } },
      { event: "response.completed", data: { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
    ];
    let all = [];
    for (const ev of events) all.push(...(translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state) || []));
    const start = all.find((o) => o.type === "content_block_start");
    const args = all.filter((o) => o.type === "content_block_delta" && o.delta?.type === "input_json_delta").map((o) => o.delta.partial_json).join("");
    expect(start.content_block.name).toBe("Bash");
    expect(JSON.parse(args)).toEqual({ command: "ls -la" });
  });
});
