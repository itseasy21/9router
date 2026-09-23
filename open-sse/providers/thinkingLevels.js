// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { PROVIDERS } from "./index.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // claude-adaptive, kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.levelMax,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  opencode: L.levelMax,   // zen gateway enum: none|low|medium|high|max (no xhigh/minimal)
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  ollama: L.levelMax,
  modal: L.levelMax,   // reasoning:{enabled,effort} — passes max through (normalizeOpenAILevel clamps only when absent)
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  // AgentRouter relays to upstream models that keep their native effort limits:
  // GLM-5.3 accepts max (z.ai enum low|high|max — no none/disable); GPT-5.6 Sol
  // tops out at xhigh (upstream rejects max) via the claude-adaptive bridge.
  { provider: "agentrouter", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "agentrouter", pattern: "gpt-5.6-sol*", levels: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  // gpt-6-astra rides /v1/responses (reasoning.effort, no disable) — GPT-6.x enum.
  { provider: "agentrouter", pattern: "gpt-6-astra*", levels: CODEX_GPT_5_6_LEVELS },
  // opencode Muse models route to /zen/v1/responses (reasoning.effort) which
  // expects the standard OpenAI enum none|minimal|low|medium|high|xhigh —
  // the zen gateway's none|low|medium|high|max is rejected with 400 max→xhigh.
  { provider: "opencode", pattern: "*muse*", levels: L.openai },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // Ollama GPT-OSS only supports low/medium/high (no max, per Ollama docs)
  { provider: "ollama", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  { provider: "ollama-local", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / glm-5v-turbo / kimi-k2.x /
  // kimi-k3-1 / minimax-m3) fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "hy3*",         levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4*",         levels: ["high"] },
  // NVIDIA NIM serves GLM-5.3 models on the OpenAI wire and accepts the full
  // effort enum (verified live: none|minimal|low|medium|high|xhigh|max all 200,
  // only "auto" rejected) — include max so the client level passes through
  // instead of clamping to xhigh.
  { provider: "nvidia", pattern: "z-ai/glm-5.3*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
];

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  // Provider-level thinkingFormat override (e.g., ollama→ollama) takes priority over per-model caps
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  const fmt = providerFmt || caps.thinkingFormat;
  let levels = hit?.levels || FORMAT_LEVELS[fmt] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}
