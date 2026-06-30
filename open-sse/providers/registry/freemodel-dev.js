export default {
  id: "freemodel-dev",
  priority: 45,
  hasFree: true,
  alias: "fmd",
  display: {
    name: "FreeModel.dev",
    icon: "generating_tokens",
    color: "#14B8A6",
    textIcon: "FM",
    website: "https://freemodel.dev",
    notice: { apiKeyUrl: "https://freemodel.dev" },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://api.freemodel.dev/v1/chat/completions",
    validateUrl: "https://api.freemodel.dev/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "gpt-5.5", name: "GPT-5.5", contextLength: 400000 },
    { id: "gpt-5.4", name: "GPT-5.4", contextLength: 400000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  ],
  modelsFetcher: { url: "https://api.freemodel.dev/v1/models", type: "openai" },
  passthroughModels: true,
};
