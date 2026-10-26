// OpenCode Zen executor: fingerprint handling on the Responses lane (v2).
//
// Updated for the /inference/v1 v2 fingerprint: the executor delegates to the
// shared applyFingerprintTools pipeline, which appends OpenCode's verbatim
// `read`/`shell` definitions and passes case variants (Bash/Read) through
// untouched — upstream accepts them next to read/shell. Duplicate
// declarations of one name are still rejected upstream, so a caller tool
// whose name collides with a fingerprint tool and carries a different
// definition travels under a `_client` alias, with prior-turn calls renamed
// too, and the rename map restores the client's spelling on the way back.
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

describe("opencode-zen fingerprint (Responses lane, v2)", () => {
  it("appends OpenCode's verbatim read/shell definitions next to the client's tools", () => {
    const tools = transformed().tools;
    const read = tools.find((t) => t.name === "read");
    expect(read).toBeDefined();
    expect(typeof read.description).toBe("string");
    expect(read.description.length).toBeGreaterThan(20);
    expect(read.parameters).toBeDefined();
    const shell = tools.find((t) => t.name === "shell");
    expect(shell).toBeDefined();
  });

  it("passes the client's case-variant tools through untouched (Bash, Read)", () => {
    const names = transformed().tools.map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    // client schemas preserved verbatim
    const bash = transformed().tools.find((t) => t.name === "Bash");
    expect(bash.parameters.required).toEqual(["command"]);
    expect(bash.parameters.properties.command).toBeDefined();
  });

  it("never emits duplicate declarations of one name", () => {
    const names = transformed().tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("restores aliased caller tool names end to end", () => {
    const body = claudeBody();
    // A caller tool that exactly collides with the fingerprint name 'read'
    // and declares an argument OpenCode's definition lacks cannot be normalized
    // in place, so it gets aliased to read_client.
    body.tools = [
      { name: "read", description: "Client's own read tool", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ];
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor", body, true, null, "opencode-zen");
    const out = new OpenCodeZenExecutor().transformRequest("muse-spark-1.3-contributor", translated, true, null);
    const names = out.tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("read_client");
    const map = takeRenamedToolNames(out);
    expect(map).toBeInstanceOf(Map);
    expect(map.get("read_client")).toBe("read");
    expect(names.filter((n) => n === "read").length).toBe(1);

    // Response side: a model call to read_client restores the client's 'read'.
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.toolNameMap = map;
    const events = [
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_client", arguments: "" } } },
      { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"file_path": "/etc/hosts"}' } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_client", arguments: '{"file_path": "/etc/hosts"}' } } },
      { event: "response.completed", data: { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
    ];
    let all = [];
    for (const ev of events) all.push(...(translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state) || []));
    const start = all.find((o) => o.type === "content_block_start");
    const args = all.filter((o) => o.type === "content_block_delta" && o.delta?.type === "input_json_delta").map((o) => o.delta.partial_json).join("");
    expect(start.content_block.name).toBe("read");
    expect(JSON.parse(args)).toEqual({ file_path: "/etc/hosts" });
  });
});
