// Shared plumbing for the OmniRoute-style compression engines (open-sse/compression).
//
// Engines operate on *text payloads* of the translated outbound body. This module
// collects every mutable text target across the wire shapes 9Router emits:
//   - OpenAI chat: body.messages[].content (string or {type:"text"} parts), role:tool
//   - Claude: body.system (string / text blocks) + messages[].content text parts
//   - OpenAI Responses: body.input[] message items (input_text/output_text) + function_call_output output
// Kiro (conversationState) and Gemini (contents[]) bodies are intentionally NOT
// targeted — return null so the pipeline no-ops on those shapes.
//
// Fail-open: helpers return empty/null on any malformed input, never throw.

const CODE_LINE_RE = /;\s*$|\{\s*$|^\s*[}\])]\s*$|^\s*(const|let|var|function|class|import|export|def|async|return)\b|^\s*\/\/|^\s*#/;
const URL_RE = /(?:https?|wss?|ftp):\/\/[^\s"'`<>()]+/g;

// ---- Text target collection -------------------------------------------------

function pushArrayParts(arr, target, kind, role) {
  for (const part of arr) {
    if (part && typeof part.text === "string" && part.text.length > 0) {
      target.parts.push({ obj: part, key: "text", kind, role });
    }
  }
}

function openaiMessageTargets(body) {
  const targets = [];
  if (!Array.isArray(body?.messages)) return targets;
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "system" || role === "developer") continue; // system text is never engine-processed
    if (role === "tool") {
      if (typeof msg.content === "string" && msg.content.length > 0) {
        targets.push({ parts: [{ obj: msg, key: "content", kind: "tool_output", role }] });
      } else if (Array.isArray(msg.content)) {
        const t = { parts: [] };
        pushArrayParts(msg.content, t, "tool_output", role);
        if (t.parts.length) targets.push(t);
      }
      continue;
    }
    if (typeof msg.content === "string" && msg.content.length > 0) {
      targets.push({ parts: [{ obj: msg, key: "content", kind: "prose", role }] });
    } else if (Array.isArray(msg.content)) {
      const t = { parts: [] };
      pushArrayParts(msg.content, t, "prose", role);
      if (t.parts.length) targets.push(t);
    }
  }
  targets._bodyShape = "chat";
  return targets;
}

function claudeTargets(body) {
  const targets = [];
  // body.system: string or array of blocks (schema-wise, only text blocks are engine-safe)
  if (typeof body?.system === "string" && body.system.length > 0) {
    targets.push({ parts: [{ obj: body, key: "system", kind: "prose", role: "system" }] });
  } else if (Array.isArray(body?.system)) {
    const t = { parts: [] };
    pushArrayParts(body.system, t, "prose", "system");
    if (t.parts.length) targets.push(t);
  }
  if (!Array.isArray(body?.messages)) return targets;
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (typeof msg.content === "string" && msg.content.length > 0) {
      targets.push({ parts: [{ obj: msg, key: "content", kind: role === "user" ? "prose" : "prose", role }] });
    } else if (Array.isArray(msg.content)) {
      const t = { parts: [] };
      for (const part of msg.content) {
        // tool_result content is RTK's domain; only plain text blocks are targeted here
        if (part && part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          t.parts.push({ obj: part, key: "text", kind: "prose", role });
        }
      }
      if (t.parts.length) targets.push(t);
    }
  }
  targets._bodyShape = "claude";
  return targets;
}

function responsesInputTargets(body) {
  const targets = [];
  if (Array.isArray(body?.instructions) || typeof body?.instructions === "string") {
    // instructions string holds system-level text — never engine-processed
  }
  if (!Array.isArray(body?.input)) return targets;
  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i];
    if (!item || typeof item !== "object") continue;
    // Shape 1: message items — content string or text parts
    if (item.type === "message") {
      const role = typeof item.role === "string" ? item.role : "";
      if (role === "system" || role === "developer") continue;
      if (typeof item.content === "string" && item.content.length > 0) {
        targets.push({ parts: [{ obj: item, key: "content", kind: "prose", role }] });
      } else if (Array.isArray(item.content)) {
        const t = { parts: [] };
        pushArrayParts(item.content, t, "prose", role);
        if (t.parts.length) targets.push(t);
      }
      continue;
    }
    // Shape 2: function_call_output — output is a string (or input_text array)
    if (item.type === "function_call_output") {
      if (typeof item.output === "string" && item.output.length > 0) {
        targets.push({ parts: [{ obj: item, key: "output", kind: "tool_output", role: "tool" }] });
      } else if (Array.isArray(item.output)) {
        const t = { parts: [] };
        pushArrayParts(item.output, t, "tool_output", "tool");
        if (t.parts.length) targets.push(t);
      }
    }
  }
  targets._bodyShape = "responses";
  return targets;
}

// Returns an ordered list of { parts: [{obj,key,kind,role}], _bodyShape } text targets
// or null when the body shape is unsupported (Kiro, Gemini, empty, unknown).
export function collectTextTargets(body) {
  try {
    if (!body || typeof body !== "object") return null;
    if (body.conversationState) return null;      // Kiro — RTK handles this shape
    if (Array.isArray(body.contents)) return null; // Gemini / Antigravity
    if (Array.isArray(body.messages)) {
      const t = openaiMessageTargets(body);
      if (t.length) return t;
    }
    if (Array.isArray(body.input)) {
      const t = responsesInputTargets(body);
      if (t.length) return t;
    }
    if (body.system !== undefined) {
      const t = claudeTargets(body);
      if (t.length) return t;
    }
  } catch (_) { /* fail-open */ }
  return null;
}

// ---- Segmentation & protection ----------------------------------------------

// Split text into paragraphs (`\n\n` separated) keeping them re-joinable.
export function splitParagraphs(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return text.split("\n\n");
}

// Heuristic: does this paragraph look like code / structured data? Those are
// always preserved byte-perfect (matching OmniRoute's preservation contract).
export function isLikelyCodeOrData(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (/^```|^~~~/.test(p)) return true; // fenced block
  // JSON-ish detection
  const trimmed = p.trim();
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) return true;
  let codeLines = 0;
  let nonEmpty = 0;
  const lines = p.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmpty++;
    if (CODE_LINE_RE.test(line)) codeLines++;
  }
  return nonEmpty >= 2 && codeLines / nonEmpty >= 0.4;
}

// Sentence splitter for extractive engines — splits on sentence boundaries but
// keeps fenced code blocks and URLs attached to their paragraph.
export function splitSentences(text) {
  if (typeof text !== "string") return [];
  // Merge sentences inside fences? Simpler: if the text contains a fence, treat
  // the whole fence as its own "sentence" unit.
  const units = [];
  const chunks = text.split(/\n\n+/);
  for (const chunk of chunks) {
    if (/^```|^~~~/.test(chunk)) { units.push(chunk); continue; }
    const sents = chunk.split(/(?<=[.!?])\s+(?=[A-Z0-9"`'(])/);
    for (const s of sents) {
      const t = s.trim();
      if (t) units.push(t);
    }
  }
  return units.filter(u => u.length > 0);
}

export function containsUrls(text) {
  return typeof text === "string" && URL_RE.test(text);
}

export { URL_RE };
