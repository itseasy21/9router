// OpenAI ⇄ AWS Quick message rendering + model/effort mapping.
//
// Quick's `user_message` carries the whole turn as a single `text` field. The
// caller's system prompt rides the dedicated `payload.system_prompt` channel;
// history and tool results are rendered into the text itself. The frame is
// hard-capped at 64 KB, so everything below is budgeted in UTF-8 bytes.

import {
  QUICK_AGENT_MODES,
  QUICK_DEFAULT_AGENT_MODE,
  QUICK_EFFORT_ALIASES,
  QUICK_EFFORT_LEVELS,
  QUICK_FRAME_LIMIT,
  QUICK_STALE_TOOL_CAP,
  QUICK_SYSTEM_CAP,
  QUICK_TOOL_RESULT_CAP,
  QUICK_USER_TURN_CAP,
} from "./constants.js";

const encoder = new TextEncoder();
const TRUNC_MARK = "\n…[truncated]";

export const UPSTREAM_TEXT_LIMIT = QUICK_FRAME_LIMIT;
export const SYSTEM_PROMPT_CAP = QUICK_SYSTEM_CAP;

export const byteLen = (value) => encoder.encode(String(value ?? "")).length;

export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content.map(partText).filter(Boolean).join("\n");
}

function partText(part) {
  if (typeof part === "string") return part;
  const type = part?.type;
  if (type === "text" || type === "input_text" || type === "output_text") return part.text ?? "";
  if (type === "image_url" || type === "input_image" || type === "image") return "[image]";
  if (type === "file" || type === "input_file") return "[file omitted]";
  if (type === "tool_result") return textOf(part.content);
  if (type === "tool_use") {
    const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
    return `[called tool ${part.name ?? "tool"}(${args})]`;
  }
  return "";
}

/** Canonical role across client dialects (OpenAI, Anthropic, Responses, …). */
export function canonRole(role) {
  const r = String(role ?? "").toLowerCase();
  if (r === "assistant" || r === "ai" || r === "bot" || r === "model" || r === "assistant_message") return "assistant";
  if (r === "user" || r === "human" || r === "input") return "user";
  if (r === "tool" || r === "tool_result" || r === "observation" || r === "tool_output" || r === "function") return "tool";
  return r;
}

/** Map a requested model id to Quick's agent_mode tier. */
export function modeFor(model) {
  const raw = String(model ?? "").trim().toLowerCase();
  const bare = raw.includes("/") ? raw.split("/").pop() : raw;
  return QUICK_AGENT_MODES.includes(bare) ? bare : QUICK_DEFAULT_AGENT_MODE;
}

/** thinking_effort from the request body (OpenAI/Responses/Claude shapes). */
export function effortFor(body) {
  const raw =
    body?.reasoning_effort ??
    body?.thinking_effort ??
    body?.reasoning?.effort ??
    body?.thinking?.effort ??
    (body?.thinking?.type === "enabled" ? "high" : body?.thinking?.type === "disabled" ? "off" : undefined);
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (QUICK_EFFORT_LEVELS.includes(value)) return value;
  if (body?.reasoning?.enabled === false) return "off";
  return QUICK_EFFORT_ALIASES[value];
}

export function capText(value, maxBytes) {
  const text = String(value ?? "");
  if (byteLen(text) <= maxBytes) return text;
  const room = maxBytes - byteLen(TRUNC_MARK);
  if (room <= 0) return fitBytes(text, maxBytes);
  return fitBytes(text, room) + TRUNC_MARK;
}

function fitBytes(text, maxBytes) {
  if (byteLen(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLen(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function tailBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byteLen(text.slice(mid)) <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  return text.slice(lo);
}

/** Keep head + tail of a big tool result and say how to get the rest. */
function shrinkToolResult(body, maxBytes) {
  const total = byteLen(body);
  if (total <= maxBytes) return body;
  const mark = `\n…[${total}-byte result, middle omitted to fit Quick's 64 KB frame — re-run the tool with a narrower range if you need it]…\n`;
  const room = maxBytes - byteLen(mark);
  if (room < 256) return `[${total}-byte result omitted to fit Quick's 64 KB frame — re-run the tool if you need it]`;
  const head = fitBytes(body, Math.floor((room * 2) / 3));
  return head + mark + tailBytes(body, room - byteLen(head));
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

function partImage(part) {
  const type = part?.type;
  if (type !== "image_url" && type !== "input_image" && type !== "image") return null;
  const source = part.source;
  if (source?.type === "base64" && typeof source.data === "string") {
    return { mimeType: source.media_type || "image/png", data: source.data.replace(/\s+/g, "") };
  }
  const url =
    typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url ?? part.url ?? (typeof part.data === "string" && part.mimeType ? `data:${part.mimeType};base64,${part.data}` : "");
  const match = DATA_URL.exec(String(url ?? ""));
  return match ? { mimeType: match[1], data: match[2].replace(/\s+/g, "") } : { url: String(url ?? "") };
}

export function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part?.type === "tool_result" ? imagesOf(part.content) : [partImage(part)].filter(Boolean)));
}

/**
 * Inline images for user_message.attachments. Attachment bytes share the frame
 * with the text, so only images that fit `maxBytes` are sent; the rest are
 * reported as skipped (Quick's upload API needs a connected device).
 */
export function pickImages(messages, maxBytes) {
  const attachments = [];
  let bytes = 0;
  let skipped = 0;
  for (const message of messages) {
    for (const image of imagesOf(message?.content)) {
      const cost = (image.data?.length ?? Infinity) + 256;
      if (!image.data || bytes + cost > maxBytes) {
        skipped++;
        continue;
      }
      const pad = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
      const ext = image.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "img";
      attachments.push({
        type: "image",
        name: `image-${attachments.length + 1}.${ext}`,
        size: Math.floor((image.data.length * 3) / 4) - pad,
        mimeType: image.mimeType,
        data: image.data,
      });
      bytes += cost;
    }
  }
  return { attachments, bytes, skipped };
}

function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return "";
  return calls
    .map((call) => {
      const name = call?.function?.name ?? call?.name ?? "tool";
      const args = call?.function?.arguments ?? call?.arguments ?? "";
      return `[called tool ${name}(${typeof args === "string" ? args : JSON.stringify(args)})]`;
    })
    .join("\n");
}

function toolHead(message) {
  return `[tool_result ${[message.name, message.tool_call_id].filter(Boolean).join(" ")}]`;
}

function isToolMessage(message) {
  return message?.role === "function" || canonRole(message?.role) === "tool";
}

function toolBlock(message, cap, cut) {
  let body = textOf(message?.content);
  if (byteLen(body) > cap) {
    body = shrinkToolResult(body, cap);
    cut();
  }
  return { tool: true, head: toolHead(message), body };
}

function transcriptLine(message) {
  const text = textOf(message?.content);
  const role = canonRole(message?.role);
  if (role === "assistant") {
    const calls = renderToolCalls(message?.tool_calls);
    return `assistant: ${[text, calls].filter(Boolean).join("\n")}`;
  }
  return `${role}: ${text}`;
}

function renderBlock(block) {
  return block.tool ? `${block.head}\n${block.body}` : block.body;
}

/**
 * Fit blocks into `maxBytes`. Tool-result bodies share whatever room the fixed
 * text leaves (small results stay whole, large ones split the remainder
 * evenly), so a fresh tool result survives partially instead of vanishing.
 * Only if text alone overflows are the oldest blocks dropped; the last block
 * is never dropped.
 */
function fitBlocks(blocks, maxBytes, cut) {
  if (!Number.isFinite(maxBytes)) return blocks.map(renderBlock).join("\n\n");

  const total = blocks.reduce((sum, block) => sum + byteLen(renderBlock(block)) + 2, 0);
  if (total <= maxBytes) return blocks.map(renderBlock).join("\n\n");

  const fixed =
    blocks.reduce((sum, block) => sum + (block.tool ? byteLen(block.head) + 1 : 0), 0) +
    blocks.filter((block) => !block.tool).reduce((sum, block) => sum + byteLen(block.body), 0) +
    2 * blocks.length;
  let available = maxBytes - fixed;
  const toolBlocks = blocks.filter((block) => block.tool).sort((a, b) => byteLen(a.body) - byteLen(b.body));
  let remaining = toolBlocks.length;
  for (const block of toolBlocks) {
    const share = Math.max(0, Math.floor(available / remaining--));
    if (byteLen(block.body) > share) {
      block.body = share >= 256 ? shrinkToolResult(block.body, share) : "";
      cut();
    }
    available -= byteLen(block.body);
  }

  const out = blocks.map(renderBlock);
  let used = out.reduce((sum, text) => sum + byteLen(text) + 2, 0);
  let dropped = 0;
  while (used > maxBytes && dropped < out.length - 1) {
    used -= byteLen(out[dropped++]) + 2;
    cut();
  }
  const kept = out.slice(dropped);
  if (used > maxBytes && kept.length) {
    kept[kept.length - 1] = capText(kept[kept.length - 1], Math.max(0, maxBytes - 2));
    cut();
  }
  return kept.join("\n\n");
}

/**
 * Full transcript text for a NEW thread. The system prompt is not included —
 * it travels in user_message.system_prompt so it does not consume text bytes.
 * `stats.truncated` is set when anything had to be cut.
 */
export function renderTranscript(messages, { maxBytes = Infinity, stats } = {}) {
  const cut = () => {
    if (stats) stats.truncated = true;
  };
  if (!Array.isArray(messages) || !messages.length) return "(empty)";

  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (canonRole(message?.role) === "assistant") lastAssistant = index;
  });

  const blocks = messages.map((message, index) => {
    if (isToolMessage(message)) {
      return {
        tool: true,
        head: toolHead(message),
        body: (() => {
          const cap = index < lastAssistant ? QUICK_STALE_TOOL_CAP : QUICK_TOOL_RESULT_CAP;
          let body = textOf(message?.content);
          if (byteLen(body) > cap) {
            body = shrinkToolResult(body, cap);
            cut();
          }
          return body;
        })(),
      };
    }
    if (index === messages.length - 1 && canonRole(message?.role) === "user") {
      let text = textOf(message?.content);
      if (byteLen(text) > QUICK_USER_TURN_CAP) {
        text = capText(text, QUICK_USER_TURN_CAP);
        cut();
      }
      return { tool: false, body: text || "(empty)" };
    }
    return { tool: false, body: transcriptLine(message) };
  });

  return fitBlocks(blocks, maxBytes, cut);
}

/**
 * Delta text for a REUSED thread: only the new user/tool content. Assistant
 * messages never belong in a valid delta (the prefix match already covered
 * them).
 */
export function renderDelta(delta, { maxBytes = Infinity, stats } = {}) {
  const cut = () => {
    if (stats) stats.truncated = true;
  };
  if (!Array.isArray(delta) || !delta.length) return "";

  const blocks = [];
  for (const message of delta) {
    if (isToolMessage(message)) {
      let body = textOf(message?.content);
      if (byteLen(body) > QUICK_TOOL_RESULT_CAP) {
        body = shrinkToolResult(body, QUICK_TOOL_RESULT_CAP);
        cut();
      }
      blocks.push({ tool: true, head: toolHead(message), body });
      continue;
    }
    if (canonRole(message?.role) !== "user") continue;
    let text = textOf(message?.content);
    if (!text) continue;
    if (byteLen(text) > QUICK_USER_TURN_CAP) {
      text = capText(text, QUICK_USER_TURN_CAP);
      cut();
    }
    blocks.push({ tool: false, body: text });
  }
  if (!blocks.length) return "";
  return fitBlocks(blocks, maxBytes, cut);
}
