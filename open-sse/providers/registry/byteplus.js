export default {
  id: "byteplus",
  priority: 70,
  alias: "byteplus",
  aliases: [
    "bpm",
  ],
  uiAlias: "bpm",
  display: {
    name: "BytePlus ModelArk",
    icon: "cloud",
    color: "#2563EB",
    textIcon: "BP",
    website: "https://console.byteplus.com/ark",
    notice: {
      text: "Free credits for new accounts. Access to Kimi K2 Thinking, GLM 4.7, GPT-OSS-120B models.",
      apiKeyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey",
    },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3/chat/completions",
    headers: {},
  },
  models: [
    { id: "kimi-k2-thinking-251104", name: "Kimi K2 Thinking" },
    { id: "glm-4-7-251222", name: "GLM 4.7" },
    { id: "gpt-oss-120b-250805", name: "GPT-OSS-120B" },
  ],
  serviceKinds: ["llm"],
};
