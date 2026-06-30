export default {
  id: "tokenrouter",
  priority: 45,
  hasFree: true,
  alias: "trk",
  display: {
    name: "TokenRouter",
    icon: "alt_route",
    color: "#8B5CF6",
    textIcon: "TR",
    website: "https://tokenrouter.com",
    notice: { apiKeyUrl: "https://tokenrouter.com" },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://api.tokenrouter.com/v1/chat/completions",
    validateUrl: "https://api.tokenrouter.com/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "minimax-3", name: "MiniMax 3 (free, TokenRouter)", contextLength: 128000, toolCalling: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (TokenRouter)", contextLength: 163840, toolCalling: true, supportsReasoning: true },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (TokenRouter)", contextLength: 163840, toolCalling: true, supportsReasoning: true },
  ],
  modelsFetcher: { url: "https://api.tokenrouter.com/v1/models", type: "openai" },
  passthroughModels: true,
};
