export default {
  id: "kiro",
  priority: 10,
  alias: "kr",
  uiAlias: "kr",
  display: {
    name: "Kiro AI",
    icon: "psychology_alt",
    color: "#FF6B35",
    website: "https://kiro.dev",
    notice: {
      signupUrl: "https://kiro.dev",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "free",
  transport: {
    baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    baseUrls: [
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
      "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    ],
    format: "kiro",
    retry: {
      "429": 0,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    },
    tokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authUrl: "https://prod.us-east-1.auth.desktop.kiro.dev",
    usage: {
      cwHost: "https://codewhisperer.us-east-1.amazonaws.com",
      qHost: "https://q.us-east-1.amazonaws.com",
      limitsPath: "/getUsageLimits",
    },
  },
  models: [
    // Synthetic -thinking/-agentic variants and the experimental GPT-5.6
    // tiers are NOT listed here. The kiro translator already strips those
    // suffixes (`resolveKiroModelIntent`) so `claude-sonnet-4.5-thinking-agentic`
    // resolves to `claude-sonnet-4.5` before reaching upstream, and the live
    // `ListAvailableModels` response drives per-account rollout for GPT-5.6.
    // Adding them statically used to advertise model ids that Kiro never
    // accepted (→ 400 INVALID_MODEL_ID) and the variants themselves doubled
    // as a way to set `thinking`/`agentic` that is now driven by request params
    // + suffix handling on the translator side.
    // Opus 5.5 — experimental preview, 1M context, 2x credits (#4410)
    // Announced 2026-09-22; confirmed in kiro.dev session UI.
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-opus-5.5-thinking", name: "Claude Opus 5.5 (Thinking)" },
    { id: "claude-opus-5.5-agentic", name: "Claude Opus 5.5 (Agentic)" },
    { id: "claude-opus-5.5-thinking-agentic", name: "Claude Opus 5.5 (Thinking + Agentic)" },
    // Opus 5
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "deepseek-3.2", name: "DeepSeek 3.2", strip: ["image","audio"] },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next", strip: ["image","audio"] },
    { id: "glm-5", name: "GLM 5" },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    // Kiro GPT-5.6 tiers run the full 1M window now (was 272k at launch).
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextLength: 1000000, rateMultiplier: 2.4, upstreamModelId: "gpt-5.6-sol", description: "Experimental preview of OpenAI GPT 5.6 Sol with 1M context window" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", contextLength: 1000000, rateMultiplier: 1.2, upstreamModelId: "gpt-5.6-terra", description: "Experimental preview of OpenAI GPT 5.6 Terra with 1M context window" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", contextLength: 1000000, rateMultiplier: 0.6, upstreamModelId: "gpt-5.6-luna", description: "Experimental preview of OpenAI GPT 5.6 Luna with 1M context window" },
  ],
  oauth: {
    ssoOidcEndpoint: "https://oidc.us-east-1.amazonaws.com",
    registerClientUrl: "https://oidc.us-east-1.amazonaws.com/client/register",
    deviceAuthUrl: "https://oidc.us-east-1.amazonaws.com/device_authorization",
    tokenUrl: "https://oidc.us-east-1.amazonaws.com/token",
    startUrl: "https://view.awsapps.com/start",
    clientName: "kiro-oauth-client",
    clientType: "public",
    scopes: [
      "codewhisperer:completions",
      "codewhisperer:analysis",
      "codewhisperer:conversations",
    ],
    grantTypes: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
    socialAuthEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
    socialLoginUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/login",
    socialTokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token",
    socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authMethods: [
      "builder-id",
      "idc",
      "google",
      "github",
      "import",
    ],
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
