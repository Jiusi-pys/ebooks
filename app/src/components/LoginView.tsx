import { useState, type FormEvent } from "react";
import { BookOpenText, LockKeyhole, ShieldCheck } from "lucide-react";

export function LoginView({
  configured,
  serverError,
  onLogin,
  onRetry,
}: {
  configured: boolean;
  serverError?: string;
  onLogin: (appId: string, appSecret: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!appId.trim() || !appSecret) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(appId.trim(), appSecret);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-5 py-10 text-foreground">
      <div className="pointer-events-none absolute -left-24 -top-28 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-accent/40 blur-3xl" />
      <section className="relative w-full max-w-[420px] rounded-[28px] border border-white/55 bg-card/85 p-7 shadow-[0_30px_90px_-45px_rgba(51,42,31,0.65),inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-xl sm:p-9">
        <div className="mb-8 flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-primary text-primary-foreground shadow-[0_14px_30px_-15px_rgba(245,64,1,0.8)]">
            <BookOpenText size={27} strokeWidth={1.7} />
          </span>
          <div>
            <h1 className="font-reading text-[31px] font-bold tracking-[0.16em]">
              書房
            </h1>
            <p className="font-meta mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Private reading workspace
            </p>
          </div>
        </div>

        <div className="mb-6 flex items-start gap-3 rounded-[16px] border border-border/70 bg-secondary/65 p-3.5">
          <span className="app-icon-tile h-9 w-9 text-primary">
            <ShieldCheck size={18} strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-[13px] font-medium">仅允许已验证的使用者进入</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              登录后才能访问书架、AI 后台和开放接口管理。
            </p>
          </div>
        </div>

        {!configured ? (
          <div className="space-y-4">
            <div className="rounded-[16px] border border-destructive/25 bg-destructive/5 p-4 text-[12px] leading-6 text-destructive">
              尚未配置登录凭据。请在 <code>app/.env</code> 中填写
              <code> APP_ID</code> 和 <code> APP_SECRET</code>，然后重启服务。
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="w-full rounded-[14px] border border-border bg-card px-4 py-2.5 text-[13px] font-medium transition hover:-translate-y-0.5 hover:shadow-md"
            >
              重新检测
            </button>
          </div>
        ) : (
          <form onSubmit={event => void submit(event)} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium">账号</span>
              <input
                value={appId}
                onChange={event => setAppId(event.target.value)}
                autoComplete="username"
                autoFocus
                className="h-11 w-full rounded-[13px] border border-border bg-background/75 px-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
                placeholder="APP_ID"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium">密码</span>
              <div className="relative">
                <LockKeyhole
                  size={16}
                  className="absolute left-3.5 top-3.5 text-muted-foreground"
                />
                <input
                  type="password"
                  value={appSecret}
                  onChange={event => setAppSecret(event.target.value)}
                  autoComplete="current-password"
                  className="h-11 w-full rounded-[13px] border border-border bg-background/75 pl-10 pr-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
                  placeholder="APP_SECRET"
                />
              </div>
            </label>
            {(error || serverError) && (
              <p
                role="alert"
                className="text-[12px] leading-5 text-destructive"
              >
                {error || serverError}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !appId.trim() || !appSecret}
              className="w-full rounded-[14px] bg-primary px-4 py-3 text-[13px] font-semibold text-primary-foreground shadow-[0_14px_28px_-16px_rgba(245,64,1,0.9)] transition hover:-translate-y-0.5 hover:brightness-105 disabled:pointer-events-none disabled:opacity-45"
            >
              {busy ? "正在验证…" : "安全登录"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
