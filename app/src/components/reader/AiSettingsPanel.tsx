import { useState } from "react";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import type { AiConfig, AiProviderId, ReaderTheme } from "@/types";
import { AI_PROVIDERS } from "@/lib/aiConfig";
import { trpc } from "@/providers/trpc";

export function AiSettingsPanel({
  value,
  onChange,
  theme,
}: {
  value: AiConfig;
  onChange: (config: AiConfig) => void;
  theme: ReaderTheme;
}) {
  const [testResult, setTestResult] = useState<"" | "ok" | "error">("");
  const [testMessage, setTestMessage] = useState("");
  const testConnection = trpc.ai.testConnection.useMutation();
  const options = AI_PROVIDERS[value.provider];

  const switchProvider = (provider: AiProviderId) => {
    const next = AI_PROVIDERS[provider];
    setTestResult("");
    onChange({ provider, model: next.models[0], effort: next.efforts[0] });
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
      className="absolute inset-x-0 top-11 bottom-0 z-20 overflow-y-auto p-4"
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
          onChange={event => switchProvider(event.target.value as AiProviderId)}
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

      <Field label="Model">
        <select
          value={value.model}
          onChange={event => onChange({ ...value, model: event.target.value })}
          className="h-9 w-full rounded-md border bg-transparent px-2 text-[12px] outline-none"
          style={{ borderColor: theme.border }}
        >
          {options.models.map(model => (
            <option key={model}>{model}</option>
          ))}
        </select>
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

      {value.provider === "deepseek" && (
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
            密钥仅保存在当前浏览器会话；关闭浏览器后清除。也可配置
            DEEPSEEK_API_KEY。
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
