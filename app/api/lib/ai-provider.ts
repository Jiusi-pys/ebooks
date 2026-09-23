import { askCodex, getCodexAuthStatus, type ChatMessage } from "./codex";

export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const DEEPSEEK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
] as const;
export const DEEPSEEK_EFFORTS = ["none", "low", "high", "max"] as const;

export interface AiRuntimeConfig {
  provider: "codex" | "deepseek";
  model: string;
  effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  apiKey?: string;
}

export const DEFAULT_AI_CONFIG: AiRuntimeConfig = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  effort: "none",
};

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

export async function askDeepSeek(
  messages: ChatMessage[],
  config: AiRuntimeConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const apiKey = config.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DeepSeek API Key 未配置");

  const thinking = config.effort === "none" ? "disabled" : "enabled";
  const response = await fetchImpl(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        thinking: { type: thinking },
        ...(config.effort === "none"
          ? {}
          : { reasoning_effort: config.effort }),
        stream: false,
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(
        Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 180_000)
      ),
    }
  );

  const data = (await response.json().catch(() => ({}))) as DeepSeekResponse;
  if (!response.ok) {
    const detail = data.error?.message?.slice(0, 240) || response.statusText;
    throw new Error(`DeepSeek API 调用失败 (${response.status}): ${detail}`);
  }
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek 未返回文本内容");
  return content;
}

export async function askModel(
  messages: ChatMessage[],
  config: AiRuntimeConfig = DEFAULT_AI_CONFIG
): Promise<string> {
  if (config.provider === "deepseek") return askDeepSeek(messages, config);
  return askCodex(messages, { model: config.model, effort: config.effort });
}

export async function getAiStatus(config: AiRuntimeConfig = DEFAULT_AI_CONFIG) {
  if (config.provider === "deepseek") {
    return {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.effort,
      auth: {
        available: true,
        authenticated: Boolean(
          config.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim()
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
