export default {
  id: "dgrid",
  priority: 45,
  hasFree: true,
  alias: "dgrid",
  display: {
    name: "DGrid AI",
    icon: "route",
    color: "#10B981",
    textIcon: "DG",
    website: "https://dgrid.ai",
    notice: {
      text: "OpenAI-compatible gateway with a free router tier.",
      apiKeyUrl: "https://dgrid.ai",
    },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://api.dgrid.ai/v1/chat/completions",
    validateUrl: "https://api.dgrid.ai/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "dgridai/free", name: "DGrid Free Models Router" },
  ],
  modelsFetcher: { url: "https://api.dgrid.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
