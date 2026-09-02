// Shared helper for appending a system-style instruction to a Kiro wire body.
//
// The Kiro (CodeWhisperer/Q) `generateAssistantResponse` backend rejects a
// top-level `systemPrompt` field with 400 REQUEST_BODY_INVALID (see the
// translators, which deliberately do NOT emit it and fold the system text into
// the first user turn's `content` instead). Any post-translation mutation —
// token savers (caveman/ponytail via rtk/systemInject.js) or the executor's
// integrity-repair retry — must follow the same rule: append into the chosen
// user turn's content, never write `body.systemPrompt`.
//
// Fail-open by contract (same as the rtk hooks): any error leaves the body
// untouched.

const SEP = "\n\n";

// Exact idempotency: prompt present as its own SEP-delimited segment (or the
// whole string), not as a substring of unrelated text.
function hasPrompt(haystack, prompt) {
  if (!haystack || typeof haystack !== "string") return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

function firstUserInputMessage(body) {
  try {
    const cs = body?.conversationState;
    if (!cs || typeof cs !== "object") return null;
    if (Array.isArray(cs.history)) {
      for (const item of cs.history) {
        if (item && item.userInputMessage) return item.userInputMessage;
      }
    }
    if (cs.currentMessage?.userInputMessage) return cs.currentMessage.userInputMessage;
  } catch (_) { /* fail-open */ }
  return null;
}

/**
 * Append `instruction` to the first user turn's content in a Kiro body.
 * Never touches a top-level `systemPrompt` (upstream rejects it).
 *
 * @param {object} body Kiro wire body (conversationState.history/currentMessage)
 * @param {string} instruction instruction text to append
 * @returns {boolean} true when the body was modified
 */
export function appendKiroSystemInstruction(body, instruction) {
  try {
    if (!body || typeof body !== "object" || !instruction) return false;
    const msg = firstUserInputMessage(body);
    if (!msg) return false;
    // Only string content (the only shape the kiro wire accepts) is modified;
    // anything unexpected is left untouched — fail-open.
    if (typeof msg.content !== "string" && msg.content !== undefined && msg.content !== null) return false;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (hasPrompt(content, instruction)) return false;
    // Prepend so the instruction reads as a system-style directive, not a user
    // afterthought. Existing text (system prefix, time context, user turn) follows.
    msg.content = content ? `${instruction}${SEP}${content}` : instruction;
    return true;
  } catch (_) {
    return false;
  }
}
