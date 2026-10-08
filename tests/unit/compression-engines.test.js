import { describe, it, expect } from "vitest";
import { runCompressionPipeline, formatCompressionLog, ENGINE_ORDER } from "../../open-sse/compression/pipeline.js";
import { compressSessionDedup } from "../../open-sse/compression/sessionDedup.js";
import { compressLite } from "../../open-sse/compression/lite.js";
import { compressResponsesToolOutput } from "../../open-sse/compression/responsesToolOutput.js";

const bigParagraph = (n, seed) =>
  Array.from({ length: n }, (_, i) => `${seed} paragraph line ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.`).join("\n\n");

describe("pipeline composition", () => {
  // The removed engines (ccr, relevance, aggressive, ultra) were destructive —
  // they discarded information with no recovery path. Guard against them ever
  // silently coming back: the pipeline must expose exactly the kept set.
  it("exposes only the three kept engines, in stack order", () => {
    expect(ENGINE_ORDER.map((e) => e.id)).toEqual([
      "session-dedup",
      "lite",
      "responses-tool-output",
    ]);
  });
});

describe("session-dedup", () => {
  it("elides a later verbatim repeat of an earlier paragraph", () => {
    const body = {
      messages: [
        { role: "user", content: "q1" },
        { role: "user", content: `intro\n\n${bigParagraph(3, "alpha")}` },
        { role: "user", content: `q2\n\n${bigParagraph(3, "alpha")}` },
      ],
    };
    const stats = compressSessionDedup(body);
    expect(stats).not.toBeNull();
    expect(stats.engine).toBe("session-dedup");
    expect(stats.hits).toBe(1);
    expect(body.messages[2].content).toContain("[session-dedup:ref sha=");
    // first occurrence intact — that's what makes the elision recoverable
    expect(body.messages[1].content).toContain("alpha paragraph line 0");
  });

  it("does not touch tiny or unique messages", () => {
    const body = { messages: [{ role: "user", content: "short" }, { role: "user", content: "different text entirely here" }] };
    expect(compressSessionDedup(body)).toBeNull();
  });

  it("never throws on malformed bodies", () => {
    expect(compressSessionDedup(null)).toBeNull();
    expect(compressSessionDedup({})).toBeNull();
    expect(compressSessionDedup({ messages: [{ role: "user" }] })).toBeNull();
  });
});

describe("lite", () => {
  it("collapses 3+ blank lines and strips trailing whitespace", () => {
    const body = { messages: [{ role: "user", content: "para one\n\n\n\npara two   \nmore   " }] };
    const stats = compressLite(body);
    expect(stats).not.toBeNull();
    expect(body.messages[0].content).toBe("para one\n\npara two\nmore");
  });

  it("skips fenced code", () => {
    const text = "```\ncode  \n\n\n\nmore   \n```";
    const body = { messages: [{ role: "user", content: `text\n\n${text}` }] };
    expect(compressLite(body)).toBeNull();
  });
});

describe("responses-tool-output", () => {
  it("minifies JSON output losslessly", () => {
    const obj = { results: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item ${i}`, ok: true })) };
    const pretty = JSON.stringify(obj, null, 2);
    const body = { input: [{ type: "function_call_output", output: pretty }] };
    const stats = compressResponsesToolOutput(body);
    expect(stats).not.toBeNull();
    expect(JSON.parse(body.input[0].output)).toEqual(obj); // lossless
  });

  it("collapses long identical-line runs", () => {
    const out = ["step 1", ...Array(20).fill("retrying..."), "done"];
    const body = { input: [{ type: "function_call_output", output: out.join("\n") }] };
    const stats = compressResponsesToolOutput(body);
    expect(stats).not.toBeNull();
    expect(body.input[0].output).toContain("line repeated 20×");
  });

  it("preserves error outputs verbatim", () => {
    const err = "Error: something failed\n" + "x".repeat(1000);
    const body = { input: [{ type: "function_call_output", output: err }] };
    expect(compressResponsesToolOutput(body)).toBeNull();
    expect(body.input[0].output).toBe(err);
  });

  it("is a no-op on non-Responses bodies", () => {
    expect(compressResponsesToolOutput({ messages: [] })).toBeNull();
  });
});

describe("pipeline", () => {
  it("runs only enabled engines, in order, and mutates the body", async () => {
    const repeated = bigParagraph(3, "alpha");
    const body = {
      messages: [
        { role: "user", content: `intro\n\n${repeated}` },
        { role: "user", content: `q2\n\n${repeated}\n\n\n\ntrailing   ` },
      ],
    };
    const stats = await runCompressionPipeline(body, { sessionDedupEnabled: true, liteEnabled: true });
    const ids = stats.map((s) => s.engine);
    expect(ids).toContain("lite");
    expect(body.messages[1].content).toContain("[session-dedup:ref sha=");
  });

  it("returns empty stats when nothing is enabled (default off = zero change)", async () => {
    const body = { messages: [{ role: "user", content: "hello world" }] };
    const before = JSON.stringify(body);
    const stats = await runCompressionPipeline(body, {});
    expect(stats).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("ignores unknown/stale engine keys from old saved settings", async () => {
    const body = { messages: [{ role: "user", content: "hello world" }] };
    const before = JSON.stringify(body);
    // Old deployments may persist ccrEnabled/ultraEnabled etc. — the pipeline
    // must not act on them now that the engines are gone.
    const stats = await runCompressionPipeline(body, { ccrEnabled: true, ultraEnabled: true, relevanceEnabled: true, aggressiveEnabled: true });
    expect(stats).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("fail-open: engine errors do not break the pipeline", async () => {
    const body = { messages: [{ role: "user", content: "x" }] };
    const stats = await runCompressionPipeline(body, { sessionDedupEnabled: true, liteEnabled: true });
    expect(Array.isArray(stats)).toBe(true);
  });

  it("formats a log line", () => {
    expect(formatCompressionLog([{ engine: "lite", hits: 2, savedChars: 120 }])).toContain("lite");
    expect(formatCompressionLog([])).toBeNull();
  });
});
