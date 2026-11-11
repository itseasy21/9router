// Shared AgentRouter retryable-capacity signals.
//
// The gateway pools upstream capacity and reports a spent budget as HTTP 200
// with the failure inside the body. Two sentence shapes are known:
//
//   "Your requests to gpt-6-astra for gpt-6-astra in eastus2 have exceeded token rate limit."
//   "The system is currently experiencing high demand and cannot process your request.
//    Your request exceeds the maximum usage size allowed during peak load. [...]"
//
// But the relay also forwards native upstream pressure shapes verbatim
// (Anthropic `overloaded_error`, OpenAI `rate_limit_exceeded` with different
// wording, ...), so a structured error frame must be judged by its code/type as
// well as by the two known sentences — otherwise a reworded rejection slips
// through the head-peek and reaches the client as an "[Error] ..." answer.
//
// Leaf module on purpose: both the executor (head-peek retry) and the streaming
// layer (mid-stream safety net) need these, and neither may pull the other's
// dependency chain.

/** The two known AgentRouter rejection sentences (strict, for assistant text). */
export const RETRYABLE_MESSAGE_TEXT =
  /exceeded\s+token\s+rate\s+limit|currently\s+experiencing\s+high\s+demand|maximum\s+usage\s+size|provisioned\s+throughput/i;

/**
 * Broad pressure hints. Only ever applied to STRUCTURED error frames
 * (`error` / `response.failed` / a top-level `error` object) — never to
 * assistant text, where words like "capacity" could appear in a real answer.
 */
export const RETRYABLE_ERROR_HINT =
  /rate.?limit|quota|capacity|overload|high.?demand|provisioned|insufficient/i;

/** Pull the human message out of an error payload of any observed shape. */
export function errorPayloadMessage(err) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    if (typeof err.message === "string") return err.message;
  }
  return null;
}

/** Pull the machine code/type out of an error payload of any observed shape. */
export function errorPayloadCode(err) {
  if (err && typeof err === "object") {
    if (typeof err.code === "string") return err.code;
    if (typeof err.type === "string") return err.type;
  }
  return null;
}

/**
 * Message of a structured retryable-capacity failure frame, or null.
 * Accepts the known sentences, native pressure codes (`overloaded_error`,
 * `rate_limit_exceeded`, ...), and pressure wording on an error frame —
 * whatever the relay's current phrasing is.
 */
export function retryableFailureMessage(json) {
  if (!json || typeof json !== "object") return null;
  const err = json.error ?? json.response?.error;
  if (err == null) return null;
  const message = errorPayloadMessage(err);
  const code = errorPayloadCode(err);
  const haystack = `${code || ""} ${message || ""}`;
  const strictHit = typeof message === "string" && RETRYABLE_MESSAGE_TEXT.test(message);
  const codeHit = typeof code === "string" && RETRYABLE_ERROR_HINT.test(code);
  // A coded pressure signal (e.g. overloaded_error) retries even when the
  // message was reworded; a bare message hint only counts on an explicit
  // error/failed frame, which is what makes it authoritative.
  const hintHit = RETRYABLE_ERROR_HINT.test(haystack)
    && (json.type === "error" || json.type === "response.failed" || err != null);
  if (!strictHit && !codeHit && !hintHit) return null;
  if (json.type === "error" || json.type === "response.failed" || err != null) {
    return message || code || "upstream capacity rejection";
  }
  return null;
}
