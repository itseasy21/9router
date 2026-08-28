export default {
  id: "modal",
  priority: 120,
  alias: "modal",
  uiAlias: "modal",
  display: {
    name: "Modal",
    icon: "bolt",
    color: "#7C3AED",
    textIcon: "MD",
    website: "https://modal.com",
    notice: {
      text: "OpenAI-compatible. Custom endpoint per account. API key = TOKEN_ID.TOKEN_SECRET from Modal proxy.",
      apiKeyUrl: "https://modal.com/docs/guide/secrets",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasProviderSpecificData: true,
  transport: {
    format: "openai",
    thinkingFormat: "modal",
  },
  models: [
    { id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
};