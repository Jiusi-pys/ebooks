import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { AiConfig, AiProviderId, ReaderTheme } from "@/types";
import {
  AI_PROVIDERS,
  defaultAiConfigFor,
  readProviderApiKey,
} from "@/lib/aiConfig";
import { readCodexAuthJson } from "@/lib/codexAuthResponse";
import { createLatestRequestGate } from "@/lib/latestRequest";
import { trpc } from "@/lib/trpc-client";

interface CodexAuthStatus {
  available: boolean;
  authenticated: boolean;
  method: "chatgpt" | "api-key" | "access-token" | "unknown";
  loginRunning: boolean;
  lastLoginError: string | null;
}

export function AiSettingsPanel({
  value,
  onChange,
  theme,
  inDrawer = false,
}: {
  value: AiConfig;
  onChange: (config: AiConfig) => void;
  theme: ReaderTheme;
  inDrawer?: boolean;
}) {
  const [testResult, setTestResult] = useState<"" | "ok" | "error">("");
  const [testMessage, setTestMessage] = useState("");
  const [codexStatus, setCodexStatus] = useState<CodexAuthStatus | null>(null);
  const [codexStatusError, setCodexStatusError] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsFor, setModelsFor] = useState("");
  const [modelsError, setModelsError] = useState("");
  const codexRequests = useRef<ReturnType<
    typeof createLatestRequestGate
  > | null>(null);
  if (!codexRequests.current) codexRequests.current = createLatestRequestGate();
  const testConnection = trpc.ai.testConnection.useMutation();
  const options =
    value.provider === "codex"
      ? AI_PROVIDERS.deepseek
      : AI_PROVIDERS[value.provider];
  const provider = (
    value.provider === "codex" ? "deepseek" : value.provider
  ) as Exclude<AiProviderId, "codex">;
  const modelRequestKey = `${provider}:${value.apiKey ?? ""}`;
  const availableModels = modelsFor === modelRequestKey ? models : [];
  const modelQuery = trpc.ai.models.useMutation();

  const switchProvider = (provider: Exclude<AiProviderId, "codex">) => {
    setTestResult("");
    onChange({
      ...defaultAiConfigFor(provider),
      apiKey: readProviderApiKey(provider),
    });
  };

  const fetchModels = modelQuery.mutateAsync;
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      fetchModels({ provider, apiKey: value.apiKey })
        .then(result => {
          if (active) {
            setModels(result.models);
            setModelsFor(modelRequestKey);
            setModelsError("");
            if (
              result.models.length > 0 &&
              !result.models.includes(value.model)
            ) {
              onChange({ ...value, model: result.models[0] });
            }
          }
        })
        .catch(error => {
          if (active)
            setModelsError(
              error instanceof Error ? error.message : String(error)
            );
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    fetchModels,
    modelRequestKey,
    onChange,
    provider,
    value.apiKey,
    value.model,
  ]);

  useEffect(() => {
    if (!value.model && models.length) onChange({ ...value, model: models[0] });
  }, [models, onChange, value]);

  const refreshCodexStatus = useCallback(async (showBusy = true) => {
    const requests = codexRequests.current!;
    const ticket = requests.begin();
    if (showBusy) setCodexBusy(true);
    setCodexStatusError("");
    try {
      const response = await fetch("/api/auth/codex/status", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const status = await readCodexAuthJson<CodexAuthStatus>(response);
      if (requests.isCurrent(ticket)) setCodexStatus(status);
    } catch (error) {
      if (requests.isCurrent(ticket)) {
        setCodexStatusError(
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      // Background polling may supersede this status response, but it must not
      // strand the spinner owned by the user's explicit refresh.
      if (showBusy) setCodexBusy(false);
    }
  }, []);

  useEffect(
    () => () => {
      codexRequests.current?.invalidate();
    },
    []
  );

  useEffect(() => {
    if (value.provider === "codex") void refreshCodexStatus(false);
  }, [refreshCodexStatus, value.provider]);

  useEffect(() => {
    if (value.provider !== "codex" || !codexStatus?.loginRunning) return;
    const timer = window.setInterval(() => {
      void refreshCodexStatus(false);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [codexStatus?.loginRunning, refreshCodexStatus, value.provider]);

  const startCodexLogin = async () => {
    const requests = codexRequests.current!;
    const ticket = requests.begin();
    setCodexBusy(true);
    setCodexStatusError("");
    try {
      const response = await fetch("/api/auth/codex/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await readCodexAuthJson(response);
      if (requests.isCurrent(ticket)) await refreshCodexStatus(false);
    } catch (error) {
      if (requests.isCurrent(ticket)) {
        setCodexStatusError(
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      setCodexBusy(false);
    }
  };

  const logoutCodex = async () => {
    if (!confirm("退出本机 Codex 登录？这会同时注销该用户的 Codex CLI。")) {
      return;
    }
    const requests = codexRequests.current!;
    const ticket = requests.begin();
    setCodexBusy(true);
    setCodexStatusError("");
    try {
      const response = await fetch("/api/auth/codex/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await readCodexAuthJson(response);
      if (requests.isCurrent(ticket)) await refreshCodexStatus(false);
    } catch (error) {
      if (requests.isCurrent(ticket)) {
        setCodexStatusError(
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      setCodexBusy(false);
    }
  };

  const test = async () => {
    setTestResult("");
    setTestMessage("");
    try {
      await testConnection.mutateAsync({ config: value });
      setTestResult("ok");
      setTestMessage("连接成功，模型已返回响应");
    } catch (error) {
      setTestResult("error");
      const message = error instanceof Error ? error.message : String(error);
      setTestMessage(message.split("\n")[0].slice(0, 160));
    }
  };

  return (
    <div
      className={`absolute inset-x-0 ${inDrawer ? "top-11 bottom-0" : "inset-y-0"} z-20 overflow-y-auto p-4`}
      style={{ background: theme.panel }}
    >
      <div className="mb-4">
        <h3 className="text-[14px] font-medium">AI 后台设置</h3>
        <p
          className="mt-1 text-[11px] leading-5"
          style={{ color: theme.muted }}
        >
          设置对伴读、翻译、制卡和脑图生成全局生效。
        </p>
      </div>

      <Field label="Provider">
        <select
          value={value.provider}
          onChange={event =>
            switchProvider(event.target.value as Exclude<AiProviderId, "codex">)
          }
          className="h-9 w-full rounded-md border bg-transparent px-2 text-[12px] outline-none"
          style={{ borderColor: theme.border }}
        >
          {Object.entries(AI_PROVIDERS).map(([id, provider]) => (
            <option key={id} value={id}>
              {provider.label}
            </option>
          ))}
        </select>
      </Field>

      {value.provider === "codex" && (
        <div
          className="mb-3 rounded-[16px] border p-3"
          style={{ borderColor: theme.border }}
        >
          <div className="flex items-start gap-2.5">
            <span className="app-icon-tile h-9 w-9 text-primary">
              <ShieldCheck size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium">ChatGPT Codex 登录</p>
              <p
                className="mt-0.5 text-[10px] leading-4"
                style={{ color: theme.muted }}
              >
                {codexStatus?.authenticated && codexStatus.method === "chatgpt"
                  ? "已复用本机 ChatGPT 登录态；不使用 OpenAI API Key。"
                  : codexStatus?.loginRunning
                    ? "登录窗口已启动，请在浏览器完成授权。"
                    : codexStatus?.available === false
                      ? "未找到 Codex CLI，请检查 CODEX_BIN。"
                      : "尚未检测到 ChatGPT 登录态。"}
              </p>
            </div>
            <button
              type="button"
              className="app-icon-button h-8 w-8"
              onClick={() => void refreshCodexStatus()}
              disabled={codexBusy}
              title="刷新 Codex 登录状态"
              aria-label="刷新 Codex 登录状态"
            >
              <RefreshCw
                size={14}
                className={codexBusy ? "animate-spin" : ""}
              />
            </button>
          </div>
          {(!codexStatus?.authenticated ||
            codexStatus.method !== "chatgpt") && (
            <button
              type="button"
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-primary/25 bg-primary/10 py-2 text-[11px] font-medium text-primary disabled:opacity-50"
              onClick={() => void startCodexLogin()}
              disabled={codexBusy || codexStatus?.loginRunning}
            >
              {codexBusy || codexStatus?.loginRunning ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <LogIn size={13} />
              )}
              {codexStatus?.loginRunning
                ? "等待浏览器授权…"
                : "使用 ChatGPT 登录"}
            </button>
          )}
          {codexStatus?.authenticated && codexStatus.method === "chatgpt" && (
            <button
              type="button"
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] border py-2 text-[10.5px] disabled:opacity-50"
              style={{ borderColor: theme.border, color: theme.muted }}
              onClick={() => void logoutCodex()}
              disabled={codexBusy}
            >
              <LogOut size={12} /> 退出 Codex 登录
            </button>
          )}
          {(codexStatusError || codexStatus?.lastLoginError) && (
            <p className="mt-2 text-[10px] leading-4 text-destructive">
              {codexStatusError || codexStatus?.lastLoginError}
            </p>
          )}
          <p
            className="mt-2 text-[9.5px] leading-4"
            style={{ color: theme.muted }}
          >
            无法打开浏览器时，可在终端运行
            <code> codex login --device-auth</code>；状态命令为
            <code> codex login status</code>。
          </p>
        </div>
      )}

      <Field label="Model">
        <select
          value={value.model}
          onChange={event => onChange({ ...value, model: event.target.value })}
          className="h-9 w-full rounded-md border bg-transparent px-2 text-[12px] outline-none"
          style={{ borderColor: theme.border }}
        >
          {value.model && !availableModels.includes(value.model) && (
            <option>{value.model}</option>
          )}
          {availableModels.map(model => (
            <option key={model}>{model}</option>
          ))}
        </select>
        <button
          type="button"
          className="mt-1 text-[10px] text-primary"
          onClick={() =>
            void modelQuery
              .mutateAsync({ provider, apiKey: value.apiKey })
              .then(result => {
                setModels(result.models);
                setModelsFor(modelRequestKey);
                setModelsError("");
              })
              .catch(error =>
                setModelsError(
                  error instanceof Error ? error.message : String(error)
                )
              )
          }
          disabled={modelQuery.isPending}
        >
          {modelQuery.isPending ? "正在获取模型列表…" : "刷新模型列表"}
        </button>
        {modelsError && (
          <p className="mt-1 text-[10px] text-destructive">{modelsError}</p>
        )}
      </Field>

      <Field label="Effort">
        <div className="grid grid-cols-4 gap-1.5">
          {options.efforts.map(effort => (
            <button
              key={effort}
              type="button"
              onClick={() => onChange({ ...value, effort })}
              className={`rounded-md border py-1.5 text-[11px] ${
                value.effort === effort
                  ? "border-primary bg-primary/10 text-primary"
                  : ""
              }`}
              style={{
                borderColor: value.effort === effort ? undefined : theme.border,
              }}
            >
              {effort}
            </button>
          ))}
        </div>
        {value.provider === "deepseek" && value.effort === "none" && (
          <p className="mt-1 text-[10px]" style={{ color: theme.muted }}>
            none 会关闭 Thinking Mode。
          </p>
        )}
      </Field>

      {value.provider !== "codex" && (
        <Field label="API Key">
          <div className="relative">
            <KeyRound
              size={13}
              className="absolute top-2.5 left-2.5"
              style={{ color: theme.muted }}
            />
            <input
              type="password"
              value={value.apiKey ?? ""}
              onChange={event =>
                onChange({ ...value, apiKey: event.target.value || undefined })
              }
              placeholder="sk-…（留空则读取服务端环境变量）"
              autoComplete="off"
              className="h-9 w-full rounded-md border bg-transparent pr-2 pl-8 text-[12px] outline-none"
              style={{ borderColor: theme.border }}
            />
          </div>
          <p
            className="mt-1 text-[10px] leading-4"
            style={{ color: theme.muted }}
          >
            密钥仅保存在当前浏览器会话；关闭浏览器后清除。也可在服务端配置对应
            Provider 的环境变量。
          </p>
        </Field>
      )}

      <button
        type="button"
        onClick={() => void test()}
        disabled={testConnection.isPending}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
      >
        {testConnection.isPending && (
          <Loader2 size={13} className="animate-spin" />
        )}
        测试连接
      </button>
      {testResult && (
        <div
          className={`mt-2 flex items-start gap-1.5 text-[11px] ${testResult === "ok" ? "text-green-600" : "text-destructive"}`}
        >
          {testResult === "ok" ? (
            <CheckCircle2 size={13} />
          ) : (
            <XCircle size={13} />
          )}
          <span className="min-w-0 break-words">{testMessage}</span>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="font-meta mb-1.5 block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
