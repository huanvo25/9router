export default {
  id: "scaleway",
  priority: 45,
  hasFree: true,
  alias: "scw",
  display: {
    name: "Scaleway AI",
    icon: "cloud",
    color: "#4F46E5",
    textIcon: "SC",
    website: "https://www.scaleway.com/en/generative-apis/",
    notice: {
      text: "EU/GDPR OpenAI-compatible endpoint. New accounts may receive free tokens.",
      apiKeyUrl: "https://console.scaleway.com/iam/api-keys",
    },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://api.scaleway.ai/v1/chat/completions",
    validateUrl: "https://api.scaleway.ai/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "qwen3-235b-a22b-instruct-2507", name: "Qwen3 235B A22B" },
    { id: "llama-3.1-70b-instruct", name: "Llama 3.1 70B" },
    { id: "llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
    { id: "mistral-small-3.2-24b-instruct-2506", name: "Mistral Small 3.2" },
    { id: "deepseek-v3-0324", name: "DeepSeek V3" },
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ],
  modelsFetcher: { url: "https://api.scaleway.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
