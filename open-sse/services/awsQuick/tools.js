// OpenAI tools ⇄ AWS Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes its own tools server-side, so
// `message_complete.tool_calls` is always empty. The model does honor a strong
// inline text convention, so client tools are injected as instructions and
// calls are parsed back out of the streamed text:
//   <tool_call>{"name":"…","arguments":{…}}</tool_call>
// Tool results come back as role:"tool" messages and are rendered into the
// next turn's text (see translate.js renderDelta).

import { byteLen } from "./translate.js";

/** OpenAI tools[] → compact spec list (function tools only). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    const schema = fn.parameters ?? fn.input_schema;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: schema && typeof schema === "object" ? schema : { type: "object", properties: {} },
    });
  }
  return out;
}

// JSON-Schema annotation keywords that cost bytes but carry no structure.
const SCHEMA_ANNOTATIONS = new Set([
  "description", "title", "examples", "example", "default", "$comment",
  "deprecated", "readOnly", "writeOnly", "markdownDescription",
]);
const SCHEMA_NESTED = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_SINGLE = new Set(["items", "additionalProperties", "contains", "propertyNames", "if", "then", "else", "not"]);
const SCHEMA_ARRAY = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Strip annotation keywords recursively; keeps types/required/enum/structure. */
export function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_ANNOTATIONS.has(key)) continue;
    if (SCHEMA_NESTED.has(key) && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, slimSchema(v, depth + 1)]));
    } else if (SCHEMA_SINGLE.has(key) && value && typeof value === "object") {
      out[key] = slimSchema(value, depth + 1);
    } else if (SCHEMA_ARRAY.has(key) && Array.isArray(value)) {
      out[key] = value.map((entry) => slimSchema(entry, depth + 1));
    } else {
      out[key] = value;
    }
  }
  return out;
}

const SCHEMA_CAP = 3072;
const PREAMBLE_CAP = 40 * 1024;

function boundedParameters(tool) {
  const slim = slimSchema(tool.parameters);
  if (JSON.stringify(slim).length <= SCHEMA_CAP) return slim;
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  return { type: "object", properties: {}, ...(required.length ? { required } : {}) };
}

function toolSpecLine(tool) {
  return `- ${tool.name}: ${tool.description || "(no description)"}\n  parameters: ${JSON.stringify(boundedParameters(tool))}`;
}

/**
 * Instruction block prepended to the message text.
 * Degrades to name+description and then names-only when a big toolset would
 * crowd out the user's actual message inside Quick's 64 KB frame.
 */
export function buildToolPreamble(tools, toolChoice, { lite = false, namesOnly = false } = {}) {
  if (!tools.length) return "";
  const choice = typeof toolChoice === "object" && toolChoice !== null ? toolChoice : null;
  const named =
    choice?.function?.name ??
    (choice?.type === "tool" ? choice.name : undefined) ??
    (toolChoice === "required" || choice?.type === "any" ? true : false);
  const only = typeof named === "string" ? tools.filter((tool) => tool.name === named) : tools;
  const shown = only.length ? only : tools;
  const must = named
    ? only.length === 1 && typeof named === "string"
      ? `This request requires the client tool "${named}" — reply with only its <tool_call> block.`
      : "This request requires a client tool — reply with <tool_call> block(s) only."
    : "";

  const assemble = (specs, header) =>
    [
      "[Client tool calling]",
      "The application you are assisting exposes the tools below; it executes them on the user's machine and returns each result as a [tool_result …] message.",
      "This channel has no native function-calling API — the <tool_call> marker below is the only way to invoke these tools.",
      "When the task needs one of them, reply with ONLY a block in this format (no other text):",
      '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
      "Guidelines:",
      "- one block per call; several blocks are allowed for parallel calls;",
      '- "arguments" is a JSON object matching the parameters schema;',
      "- after a [tool_result …] message arrives, continue the task in plain text;",
      "- earlier [tool_result …] blocks may be truncated or omitted; when the task needs current file or command output, call the tools again instead of guessing from memory;",
      must,
      header,
      specs,
    ]
      .filter(Boolean)
      .join("\n");

  const describe = (tool) => String(tool.description || "(no description)").slice(0, 200);
  const liteSpecs = shown.map((tool) => `- ${tool.name}: ${describe(tool)}`).join("\n");
  const namesSpecs = shown.map((tool) => `- ${tool.name}`).join("\n");
  const liteHeader = "Tools provided by the client (parameter schemas omitted — use the tool name and reasonable arguments):";
  const namesHeader = "Tools provided by the client (names only — infer arguments from each tool's purpose):";

  let out = namesOnly
    ? assemble(namesSpecs, namesHeader)
    : lite
      ? assemble(liteSpecs, liteHeader)
      : assemble(shown.map(toolSpecLine).join("\n"), "Tools provided by the client:");

  if (!lite && !namesOnly && byteLen(out) > PREAMBLE_CAP) {
    out = assemble(liteSpecs, liteHeader);
  }
  return out;
}

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const OPEN_RE = /<tool_call>/g;
const CLOSE_RE = /<\/tool_call>/g;

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1);
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

function parseCall(json) {
  let obj;
  try {
    obj = JSON.parse(String(json).trim());
  } catch {
    return null;
  }
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name;
  if (typeof name !== "string" || !name) return null;
  let args = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      /* keep the raw string */
    }
  }
  if (args == null || typeof args !== "object") args = {};
  return { name, arguments: args };
}

/**
 * Incremental parser: feed text deltas, get back visible text and completed
 * tool calls. Handles tags split across deltas — including a tag split
 * mid-token (`<` + `tool_call>…`), which is held back rather than flushed.
 */
export function createToolCallParser() {
  let buf = "";
  let inBlock = false;
  let blockJson = "";
  let dropped = false;

  const drain = () => {
    const text = [];
    const calls = [];
    for (;;) {
      if (!inBlock) {
        OPEN_RE.lastIndex = 0;
        const match = OPEN_RE.exec(buf);
        if (!match) {
          const hold = heldPrefixLen(buf, OPEN_TAG);
          text.push(buf.slice(0, buf.length - hold));
          buf = buf.slice(buf.length - hold);
          break;
        }
        text.push(buf.slice(0, match.index));
        buf = buf.slice(match.index + match[0].length);
        inBlock = true;
        blockJson = "";
        continue;
      }
      CLOSE_RE.lastIndex = 0;
      const match = CLOSE_RE.exec(buf);
      if (!match) {
        const hold = heldPrefixLen(buf, CLOSE_TAG);
        blockJson += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        break;
      }
      blockJson += buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      inBlock = false;
      const call = parseCall(blockJson);
      if (call) calls.push(call);
      else dropped = true;
      blockJson = "";
    }
    return { text: text.join(""), calls };
  };

  return {
    push(delta) {
      if (!delta) return { text: "", calls: [] };
      buf += delta;
      return drain();
    },
    end() {
      const result = drain();
      let tail = result.text;
      if (inBlock) {
        dropped = true;
        inBlock = false;
        blockJson = "";
        buf = "";
      } else if (buf) {
        tail += buf;
        buf = "";
      }
      return { text: tail, calls: result.calls, dropped: dropped || undefined };
    },
  };
}

export function newToolCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
