const TEXT_ONLY_STRIP = ["image", "audio"];

const KIRO_UPSTREAM_MODELS = [
  { id: "auto", name: "Auto", contextLength: 1000000, maxOutput: 64000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", rateMultiplier: 1.3, contextLength: 1000000, maxOutput: 64000 },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8", rateMultiplier: 2.2, contextLength: 1000000, maxOutput: 128000 },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7", rateMultiplier: 2.2, contextLength: 1000000, maxOutput: 128000 },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6", rateMultiplier: 2.2, contextLength: 1000000, maxOutput: 64000 },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", rateMultiplier: 1.3, contextLength: 1000000, maxOutput: 64000 },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5", rateMultiplier: 2.2, contextLength: 200000, maxOutput: 64000 },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", rateMultiplier: 1.3, contextLength: 200000, maxOutput: 64000 },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", rateMultiplier: 1.3, contextLength: 200000, maxOutput: 64000 },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", rateMultiplier: 0.4, contextLength: 200000, maxOutput: 64000 },
  { id: "deepseek-3.2", name: "DeepSeek 3.2", rateMultiplier: 0.25, contextLength: 164000, maxOutput: 64000, strip: TEXT_ONLY_STRIP },
  { id: "minimax-m2.5", name: "MiniMax M2.5", rateMultiplier: 0.25, contextLength: 196000, maxOutput: 64000, strip: TEXT_ONLY_STRIP },
  { id: "minimax-m2.1", name: "MiniMax M2.1", rateMultiplier: 0.15, contextLength: 196000, maxOutput: 64000, strip: TEXT_ONLY_STRIP },
  { id: "glm-5", name: "GLM 5", rateMultiplier: 0.5, contextLength: 200000, maxOutput: 64000, strip: TEXT_ONLY_STRIP },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", rateMultiplier: 0.05, contextLength: 256000, maxOutput: 64000, strip: TEXT_ONLY_STRIP },
];

function buildKiroModelEntry(model, suffix = "", label = "") {
  const entry = {
    id: `${model.id}${suffix}`,
    name: label ? `${model.name} (${label})` : model.name,
  };
  if (model.strip) entry.strip = model.strip;
  if (model.rateMultiplier !== undefined) entry.rateMultiplier = model.rateMultiplier;
  if (model.contextLength !== undefined) entry.contextLength = model.contextLength;
  if (model.maxOutput !== undefined) entry.maxOutput = model.maxOutput;
  return entry;
}

function buildKiroModelVariants(model) {
  const variants = [
    buildKiroModelEntry(model),
    buildKiroModelEntry(model, "-thinking", "Thinking"),
  ];
  if (model.id !== "auto") {
    variants.push(buildKiroModelEntry(model, "-agentic", "Agentic"));
    variants.push(buildKiroModelEntry(model, "-thinking-agentic", "Thinking + Agentic"));
  }
  return variants;
}

const KIRO_MODELS = KIRO_UPSTREAM_MODELS.flatMap(buildKiroModelVariants);

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
      "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
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
  models: KIRO_MODELS,
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
