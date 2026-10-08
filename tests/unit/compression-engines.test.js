import { describe, it, expect } from "vitest";
import { runCompressionPipeline, formatCompressionLog } from "../../open-sse/compression/pipeline.js";
import { compressSessionDedup } from "../../open-sse/compression/sessionDedup.js";
import { compressCcr } from "../../open-sse/compression/ccr.js";
import { compressLite } from "../../open-sse/compression/lite.js";
import { compressResponsesToolOutput } from "../../open-sse/compression/responsesToolOutput.js";
import { compressRelevance } from "../../open-sse/compression/relevance.js";
import { compressAggressive } from "../../open-sse/compression/aggressive.js";
import { compressUltra } from "../../open-sse/compression/ultra.js";

const bigParagraph = (n, seed) =>
  Array.from({ length: n }, (_, i) => `${seed} paragraph line ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.`).join("\n\n");

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
    // first occurrence intact
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

describe("ccr", () => {
  it("elides the middle of a very large prose block, keeping head and tail", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `log line ${i} with some filler content to pad size`);
    const body = { messages: [{ role: "assistant", content: lines.join("\n") }] };
    const stats = compressCcr(body);
    expect(stats).not.toBeNull();
    const out = body.messages[0].content;
    expect(out).toContain("[ccr:archive sha=");
    expect(out).toContain("log line 0 ");
    expect(out).toContain("log line 199");
    expect(out).not.toContain("log line 100\n");
  });

  it("never touches code or fenced blocks", () => {
    const code = "```\n" + Array.from({ length: 200 }, (_, i) => `const x${i} = ${i}; // padding`).join("\n") + "\n```";
    const body = { messages: [{ role: "assistant", content: code }] };
    expect(compressCcr(body)).toBeNull();
    expect(body.messages[0].content).toBe(code);
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

describe("relevance", () => {
  const query = "fix the failing auth middleware test";
  const oldIrrelevant = Array.from({ length: 12 }, (_, i) => `The weather today is quite pleasant number ${i}. We discuss gardening tips at length here.`);
  const oldRelevant = "The auth middleware test fails because token expiry check uses `<` instead of `<=`. Fix the comparison in auth/middleware.js. The middleware test then passes.";

  it("keeps relevant sentences in old messages, drops irrelevant ones", () => {
    const body = {
      messages: [
        { role: "user", content: oldIrrelevant.join(" ") + " " + oldRelevant },
        { role: "user", content: oldIrrelevant.join(" ") },
        { role: "user", content: oldIrrelevant.join(" ") },
        { role: "user", content: query },
      ],
    };
    const stats = compressRelevance(body);
    expect(stats).not.toBeNull();
    const out = body.messages[0].content;
    expect(out).toContain("auth middleware");
    expect(out).not.toContain("gardening");
  });

  it("never touches the most recent messages", () => {
    const text = oldIrrelevant.join(" ") + " " + oldRelevant;
    const body = { messages: [{ role: "user", content: text }, { role: "user", content: query }] };
    const before = body.messages[0].content;
    compressRelevance(body, { lastUserProtected: 3 });
    expect(body.messages[0].content).toBe(before);
  });

  it("fails open when there is no user query", () => {
    const body = { messages: [{ role: "assistant", content: oldIrrelevant.join(" ") }] };
    expect(compressRelevance(body)).toBeNull();
  });
});

describe("aggressive", () => {
  it("ages old assistant prose per the progressive-aging gate, keeps recent untouched", () => {
    const longText = Array.from({ length: 60 }, (_, i) => `assistant rambling line ${i} with detail nobody needs anymore`).join("\n");
    const body = {
      messages: [
        { role: "assistant", content: longText },
        { role: "user", content: "ok next" },
        { role: "assistant", content: longText },
        { role: "user", content: "thanks, continue" },
        { role: "assistant", content: longText },
        { role: "user", content: "go on" },
      ],
    };
    const stats = compressAggressive(body, { maxTurns: 6 });
    expect(stats).not.toBeNull();
    // Oldest assistant turn (index 0) should be aged
    expect(body.messages[0].content).toContain("[aggressive:aged]");
    expect(body.messages[0].content.length).toBeLessThan(longText.length);
  });
});

describe("ultra", () => {
  it("removes filler phrases from prose", () => {
    const text = "Basically, I'd be happy to help you with that. In order to fix it, simply run the command below. This is padded with some extra text so the message clears the minimum length gate for the engine.";
    const body = { messages: [{ role: "assistant", content: text }] };
    const stats = compressUltra(body);
    expect(stats).not.toBeNull();
    const out = body.messages[0].content;
    expect(out).not.toMatch(/basically/i);
    expect(out).not.toMatch(/happy to help/i);
    expect(out).toContain("to fix it");
  });

  it("never rewrites fenced code", () => {
    const code = "```\nconst x = 1; // basically filler comment here\n```";
    const body = { messages: [{ role: "assistant", content: `Preamble. ${code} Basically done.` }] };
    const before = body.messages[0].content;
    compressUltra(body);
    expect(body.messages[0].content).toContain(code);
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
    const stats = await runCompressionPipeline(body, { sessionDedupEnabled: true, liteEnabled: true, ccrEnabled: false });
    const ids = stats.map((s) => s.engine);
    expect(ids).toContain("lite");
    expect(ids).not.toContain("ccr");
    expect(body.messages[1].content).toContain("[session-dedup:ref sha=");
  });

  it("returns empty stats when nothing is enabled (default off = zero change)", async () => {
    const body = { messages: [{ role: "user", content: "hello world" }] };
    const before = JSON.stringify(body);
    const stats = await runCompressionPipeline(body, {});
    expect(stats).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("fail-open: engine errors do not break the pipeline", async () => {
    const body = { messages: [{ role: "user", content: "x" }] };
    const stats = await runCompressionPipeline(body, { sessionDedupEnabled: true, ccrEnabled: true, liteEnabled: true });
    expect(Array.isArray(stats)).toBe(true);
  });

  it("formats a log line", () => {
    expect(formatCompressionLog([{ engine: "lite", hits: 2, savedChars: 120 }])).toContain("lite");
    expect(formatCompressionLog([])).toBeNull();
  });
});
