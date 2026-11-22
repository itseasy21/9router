export default {
  id: "aws-quick",
  priority: 210,
  alias: "aws-quick",
  aliases: ["amazon-quick", "awsquick", "quick"],
  uiAlias: "AQ",
  display: {
    name: "AWS Quick",
    icon: "bolt",
    color: "#FF9900",
    textIcon: "AQ",
    website: "https://quick.aws.com",
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "webCookie",
  authType: "cookie",
  authHint:
    "Paste the Amazon Quick session JSON: {id_token, ws_host, refresh_token, client:{client_id, client_secret, idc_region, issuer_url}}. Add one connection per account. Uses Quick's internal desktop WebSocket (no public API) — likely against AWS terms of service; use only with your own accounts.",
  transport: {
    baseUrl: "https://quick.aws.com",
    format: "openai",
    authType: "cookie",
    // Quick's first turn can spend 30-60s reconciling the agent; the executor
    // additionally enforces its own per-turn idle timeout.
    timeoutMs: 180000,
    // Desktop-client handshake identity. Bump appVersion when a newer Quick
    // build changes it; per-connection overrides live in providerSpecificData
    // (awsQuickAppVersion/awsQuickSurface/awsQuickChannel/awsQuickUserAgent).
    quick: {
      // The desktop renderer reports MAC on darwin/linux and WINDOWS on win32;
      // leave surfaceType unset so the executor derives it from the host OS.
      appVersion: "1.2.4660",
      channel: "prod",
    },
  },
  // `agent_mode` is Quick's tier selector — the server picks the concrete model.
  models: [
    { id: "smart", name: "Quick Smart (Opus tier)", supportsReasoning: true },
    { id: "balanced", name: "Quick Balanced", supportsReasoning: true },
    { id: "fast", name: "Quick Fast (Haiku tier)", supportsReasoning: true },
    { id: "advanced", name: "Quick Advanced", supportsReasoning: true },
  ],
};
