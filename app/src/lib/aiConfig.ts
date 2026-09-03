import { useCallback, useEffect, useState } from "react";
import type { AiConfig, AiEffort, AiProviderId } from "@/types";

export const AI_PROVIDERS: Record<
  AiProviderId,
  { label: string; models: string[]; efforts: AiEffort[] }
> = {
  codex: {
    label: "Codex（ChatGPT 登录）",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  deepseek: {
    label: "DeepSeek API",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ],
    efforts: ["none", "low", "high", "max"],
  },
};

const CONFIG_KEY = "shufang:ai-config:v1";
const KEY_KEY = "shufang:deepseek-api-key";
const CHANGE_EVENT = "shufang:ai-config-change";

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "codex",
  model: "gpt-5.6-terra",
  effort: "medium",
};

export function loadAiConfig(): AiConfig {
  if (typeof window === "undefined") return DEFAULT_AI_CONFIG;
  try {
    const saved = JSON.parse(
      localStorage.getItem(CONFIG_KEY) ?? "{}"
    ) as Partial<AiConfig>;
    const provider =
      saved.provider && AI_PROVIDERS[saved.provider] ? saved.provider : "codex";
    const options = AI_PROVIDERS[provider];
    const model =
      saved.model && options.models.includes(saved.model)
        ? saved.model
        : options.models[0];
    const effort =
      saved.effort && options.efforts.includes(saved.effort)
        ? saved.effort
        : options.efforts[0];
    return {
      provider,
      model,
      effort,
      ...(provider === "deepseek"
        ? { apiKey: sessionStorage.getItem(KEY_KEY) || undefined }
        : {}),
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
  if (config.provider === "deepseek") {
    if (config.apiKey) sessionStorage.setItem(KEY_KEY, config.apiKey);
    else sessionStorage.removeItem(KEY_KEY);
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
