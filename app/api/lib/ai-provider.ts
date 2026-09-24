import { askCodex, getCodexAuthStatus, type ChatMessage } from "./codex";

export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const DEEPSEEK_EFFORTS = ["none", "low", "high", "max"] as const;

export interface AiRuntimeConfig {
  provider: "codex" | "deepseek" | "openai" | "kimi" | "minimax";
  model: string;
  effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  apiKey?: string;
}

export const DEFAULT_AI_CONFIG: AiRuntimeConfig = {
  provider: "deepseek",
  model: "",
  effort: "none",
};

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

const PROVIDERS = {
  deepseek: {
    chat: "https://api.deepseek.com/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
  },
  openai: {
    chat: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
  },
  kimi: {
    chat: "https://api.moonshot.cn/v1/chat/completions",
    envKey: "KIMI_API_KEY",
  },
  minimax: {
    chat: "https://api.minimax.cn/v1/chat/completions",
    envKey: "MINIMAX_API_KEY",
  },
} as const;

export async function askOpenAiCompatible(
  messages: ChatMessage[],
  config: AiRuntimeConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (config.provider === "codex")
    throw new Error("Codex 不是 OpenAI-compatible API Provider");
  const provider = PROVIDERS[config.provider];
  const apiKey = config.apiKey?.trim() || process.env[provider.envKey]?.trim();
  if (!apiKey) throw new Error(`${config.provider} API Key 未配置`);
  const deepseek = config.provider === "deepseek";
  const response = await fetchImpl(provider.chat, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(deepseek
        ? {
            thinking: {
              type: config.effort === "none" ? "disabled" : "enabled",
            },
            ...(config.effort === "none"
              ? {}
              : { reasoning_effort: config.effort }),
          }
        : config.provider === "openai" &&
            config.effort !== "none" &&
            /^(gpt-5|o[134])/i.test(config.model)
          ? { reasoning_effort: config.effort }
          : {}),
      stream: false,
      ...(config.provider === "openai"
        ? { max_completion_tokens: 8192 }
        : { max_tokens: 8192 }),
    }),
    signal: AbortSignal.timeout(
      Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 180_000)
    ),
  });

  const data = (await response
    .json()
    .catch(() => ({}))) as ChatCompletionResponse;
  if (!response.ok) {
    const detail = data.error?.message?.slice(0, 240) || response.statusText;
    throw new Error(
      `${config.provider} API 调用失败 (${response.status}): ${detail}`
    );
  }
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`${config.provider} 未返回文本内容`);
  return content;
}

export function askDeepSeek(
  messages: ChatMessage[],
  config: AiRuntimeConfig,
  fetchImpl?: typeof fetch
) {
  return askOpenAiCompatible(
    messages,
    { ...config, provider: "deepseek" },
    fetchImpl
  );
}

export async function fetchProviderModels(
  provider: Exclude<AiRuntimeConfig["provider"], "codex">,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const urls = {
    deepseek: "https://api.deepseek.com/models",
    openai: "https://api.openai.com/v1/models",
    kimi: "https://api.moonshot.cn/v1/models",
    minimax: "https://api.minimax.cn/v1/models",
  };
  const response = await fetchImpl(urls[provider], {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    data?: Array<{ id?: unknown; type?: unknown }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      data.error?.message || `${provider} 模型列表获取失败 (${response.status})`
    );
  }
  return [
    ...new Set(
      (data.data ?? [])
        .filter(
          item =>
            typeof item.id === "string" &&
            (!item.type || item.type === "model") &&
            !/(embedding|moderation|whisper|tts|audio|realtime|transcri|dall-e|image|sora|video)/i.test(
              item.id
            )
        )
        .map(item => item.id as string)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export async function askModel(
  messages: ChatMessage[],
  config: AiRuntimeConfig = DEFAULT_AI_CONFIG
): Promise<string> {
  if (config.provider === "codex")
    return askCodex(messages, { model: config.model, effort: config.effort });
  return askOpenAiCompatible(messages, config);
}

export async function getAiStatus(config: AiRuntimeConfig = DEFAULT_AI_CONFIG) {
  if (config.provider !== "codex") {
    return {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.effort,
      auth: {
        available: true,
        authenticated: Boolean(
          config.apiKey?.trim() ||
          process.env[PROVIDERS[config.provider].envKey]?.trim()
        ),
        method: "api-key" as const,
      },
    };
  }
  return {
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.effort,
    auth: await getCodexAuthStatus(),
  };
}
