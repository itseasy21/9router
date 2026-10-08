// Responses Tool Output engine — OmniRoute stack #5. Lossless-first compaction
// of OpenAI Responses-API `function_call_output` payloads: minify whitespace in
// JSON dumps (key order / values untouched — lossless), then bounded diagnostic
// compression for shell/build/search outputs (duplicate-line collapse, capped
// head/tail) so the actionable tail survives. Never touches error outputs.

const DEFAULT_MIN_CHARS = 500;   // same floor as RTK's MIN_COMPRESS_SIZE
const MAX_KEEP_TAIL = 200;       // lines always kept from the tail
const MAX_KEEP_HEAD = 40;        // preview head

// Minify JSON if the text parses as a JSON object/array. Lossless.
function tryJsonMinify(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const minified = JSON.stringify(parsed);
    return minified.length < text.length ? minified : null;
  } catch {
    return null;
  }
}

// Collapse long runs of identical consecutive lines (progress bars, retry spam,
// repeated warnings) keeping 1 copy + a run count.
function collapseRepeatedLines(text, threshold = 4) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  const out = [];
  let run = [lines[0]];
  const flush = () => {
    const val = run[0];
    if (run.length >= threshold) {
      out.push(val);
      out.push(`… line repeated ${run.length}× (identical)`);
    } else {
      out.push(...run);
    }
  };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === run[0]) { run.push(lines[i]); continue; }
    flush();
    run = [lines[i]];
  }
  flush();
  const next = out.join("\n");
  return next.length < text.length ? next : null;
}

// Smart head/tail windowing for very long diagnostics: JS/TS stack traces, log
// dumps, test runner output. Keep the informative head and the decisive tail.
function windowDiagnostics(text, minChars) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  if (text.length < minChars || lines.length < MAX_KEEP_HEAD + 10) return null;
  // Skip tails that end in a JSON blob (likely structured result) — keep whole.
  const tailJoin = lines.slice(-5).join("\n");
  if (tailJoin.trim().startsWith("{") || tailJoin.trim().startsWith("[")) return null;
  const head = lines.slice(0, MAX_KEEP_HEAD);
  const tail = lines.slice(-MAX_KEEP_TAIL);
  const cut = lines.length - head.length - tail.length;
  if (cut <= 0) return null;
  return `${head.join("\n")}\n… [+${cut} lines elided; full output not retained] …\n${tail.join("\n")}`;
}

export function compressResponsesToolOutput(body, { minChars = DEFAULT_MIN_CHARS } = {}) {
  try {
    if (!body || !Array.isArray(body.input)) return null; // Responses shape only
    let saved = 0;
    let hits = 0;
    for (const item of body.input) {
      if (!item || item.type !== "function_call_output") continue;
      if (typeof item.output !== "string") continue;
      // Error outputs are preserved verbatim (trace fidelity).
      if (item.is_error === true || /(^|\n)\s*(error|traceback|fatal)\b/i.test(item.output.slice(0, 400))) continue;

      const before = item.output;
      let next = tryJsonMinify(before) || collapseRepeatedLines(before) || windowDiagnostics(before, minChars);
      if (next && next.length < before.length) {
        saved += before.length - next.length;
        hits++;
        try { item.output = next; } catch { /* frozen */ }
      }
    }
    if (hits === 0) return null;
    return { engine: "responses-tool-output", hits, savedChars: saved };
  } catch {
    return null;
  }
}
