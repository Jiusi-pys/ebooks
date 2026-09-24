import { useCallback, useEffect, useState } from "react";
import type { AiConfig, AiEffort, AiProviderId } from "@/types";

export const AI_PROVIDERS: Record<
  Exclude<AiProviderId, "codex">,
  { label: string; efforts: AiEffort[] }
> = {
  deepseek: {
    label: "DeepSeek API",
    efforts: ["none", "low", "high", "max"],
  },
  openai: {
    label: "OpenAI API",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  kimi: {
    label: "Kimi (Moonshot AI)",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  minimax: {
    label: "MiniMax",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
};

const CONFIG_KEY = "shufang:ai-config:v1";
const KEY_KEY = "shufang:ai-api-key:";
const CHANGE_EVENT = "shufang:ai-config-change";

export function readProviderApiKey(provider: Exclude<AiProviderId, "codex">) {
  return typeof window === "undefined"
    ? undefined
    : sessionStorage.getItem(`${KEY_KEY}${provider}`) || undefined;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "deepseek",
  model: "",
  effort: "none",
};

export function defaultAiConfigFor(
  provider: Exclude<AiProviderId, "codex">
): AiConfig {
  const options = AI_PROVIDERS[provider];
  return {
    provider,
    model: "",
    effort: options.efforts[0],
  };
}

export function loadAiConfig(): AiConfig {
  if (typeof window === "undefined") return DEFAULT_AI_CONFIG;
  try {
    const saved = JSON.parse(
      localStorage.getItem(CONFIG_KEY) ?? "{}"
    ) as Partial<AiConfig>;
    const provider =
      saved.provider && saved.provider in AI_PROVIDERS
        ? (saved.provider as Exclude<AiProviderId, "codex">)
        : "deepseek";
    const options = AI_PROVIDERS[provider];
    const defaults = defaultAiConfigFor(provider);
    return {
      provider,
      model: saved.model ?? defaults.model,
      effort:
        saved.effort && options.efforts.includes(saved.effort)
          ? saved.effort
          : defaults.effort,
      apiKey:
        readProviderApiKey(provider) ||
        (provider === "deepseek"
          ? sessionStorage.getItem("shufang:deepseek-api-key") || undefined
          : undefined),
    };
  } catch {
    return DEFAULT_AI_CONFIG;
  }
}

export function saveAiConfig(config: AiConfig) {
  const publicConfig = {
    provider: config.provider,
    model: config.model,
    effort: config.effort,
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(publicConfig));
  if (config.provider !== "codex") {
    const key = `${KEY_KEY}${config.provider}`;
    if (config.apiKey) sessionStorage.setItem(key, config.apiKey);
    else sessionStorage.removeItem(key);
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useAiConfig(): [AiConfig, (config: AiConfig) => void] {
  const [config, setConfig] = useState(loadAiConfig);
  useEffect(() => {
    const sync = () => setConfig(loadAiConfig());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((next: AiConfig) => {
    saveAiConfig(next);
    setConfig(next);
  }, []);
  return [config, update];
}
