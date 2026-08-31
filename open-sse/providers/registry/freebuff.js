// Freebuff provider — free/ad-supported aggregated inference, OpenAI-shaped.
// Topology (verified against Freebuff2API + live probes): device LOGIN lives on
// freebuff.com (POST /api/auth/cli/code → browser confirm → GET /api/auth/cli/status,
// implemented in src/lib/oauth/providers/freebuff.js), while INFERENCE lives on
// www.codebuff.com/api/v1/* with Bearer authToken. Free-tier access requires the
// agent-run lifecycle + waiting-room session, handled by FreebuffExecutor
// (open-sse/executors/freebuff.js) — a plain chat-completions passthrough is
// rejected or falls out of the free tier.
export default {
  id: "freebuff",
  priority: 175,
  alias: "freebuff",
  display: {
    name: "Freebuff",
    icon: "auto_awesome",
    color: "#5B4FE8",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.com",
    },
  },
  category: "oauth",
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      // Freebuff2API parity: upstream identifies the official SDK user agent.
      "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
    },
    // Free-tier run lifecycle + waiting-room session (FreebuffExecutor).
    agentRunsUrl: "https://www.codebuff.com/api/v1/agent-runs",
    freeSessionUrl: "https://www.codebuff.com/api/v1/freebuff/session",
  },
  models: [
    // Verified working models matching OmniRoute v3.8.51 MODEL_TO_AGENT
    // and Freebuff-2API's curated list. The upstream free tier only honors
    // specific agent+model combinations — unlisted combos return 403.
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "crof/kimi-k3-eco", name: "Kimi K3" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
    // Gemini models (confirmed working by Freebuff-2API)
    { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
  ],
  serviceKinds: ["llm"],
  oauth: {
    // Fingerprint device login (not standard OAuth): no clientId/tokenUrl/refresh.
    // fingerprintHash = SHA-256(serverSecret+fingerprintId+expiresAt) is computed
    // server-side and returned in the code response; it must be stored verbatim
    // and echoed back on poll/logout. Login codes live ~1h; no refresh token —
    // expired authToken means re-login.
    loginCodeUrl: "https://freebuff.com/api/auth/cli/code",
    loginStatusUrl: "https://freebuff.com/api/auth/cli/status",
    logoutUrl: "https://freebuff.com/api/auth/cli/logout",
    websiteUrl: "https://freebuff.com",
    noRefresh: true,
  },
  features: {
    usage: false,
  },
};
