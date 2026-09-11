import { CLAUDE_CLI_SPOOF_HEADERS } from "../shared.js";

export default {
  id: "agentrouter",
  alias: "agentrouter",
  display: {
    name: "AgentRouter",
    icon: "hub",
    color: "#7C3AED",
    textIcon: "AR",
    website: "https://agentrouter.org",
    notice: { apiKeyUrl: "https://agentrouter.org" },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://agentrouter.org/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: { ...CLAUDE_CLI_SPOOF_HEADERS },
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  models: [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    // gpt-6-astra (MaaS_GP_6_astra_*): AgentRouter's /v1/messages relay forwards to
    // the upstream /v1/chat/completions, which rejects "function tools with
    // reasoning_effort" (400). Its /v1/responses endpoint accepts both, so this
    // model must always target the Responses wire — same pattern as opencode-go's
    // muse-spark/gpt-5.6-luna (see chatCore targetFormat + AgentRouterExecutor).
    { id: "gpt-6-astra", name: "GPT 6 Astra", targetFormat: "openai-responses" },
  ],
};
