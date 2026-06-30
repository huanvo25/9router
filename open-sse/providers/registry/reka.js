export default {
  id: "reka",
  priority: 45,
  hasFree: true,
  alias: "reka",
  display: {
    name: "Reka",
    icon: "bolt",
    color: "#7C3AED",
    textIcon: "RK",
    website: "https://www.reka.ai",
    notice: { apiKeyUrl: "https://platform.reka.ai" },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://api.reka.ai/v1/chat/completions",
    validateUrl: "https://api.reka.ai/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "reka-flash-3", name: "Reka Flash 3" },
    { id: "reka-flash", name: "Reka Flash" },
    { id: "reka-edge-2603", name: "Reka Edge 2603" },
  ],
};
