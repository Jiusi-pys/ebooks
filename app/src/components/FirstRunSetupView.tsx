import { useState, type FormEvent } from "react";
import {
  BookOpenText,
  CheckCircle2,
  KeyRound,
  LogOut,
  UserRoundPen,
} from "lucide-react";

export interface InitialAccountInput {
  username: string;
  newPassword: string;
  confirmPassword: string;
}

export function FirstRunSetupView({
  serverError,
  onComplete,
  onLogout,
}: {
  serverError?: string;
  onComplete: (input: InitialAccountInput) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onComplete({
        username: username.trim(),
        newPassword,
        confirmPassword,
      });
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
      <section className="relative w-full max-w-[460px] rounded-[28px] border border-white/55 bg-card/90 p-7 shadow-[0_30px_90px_-45px_rgba(51,42,31,0.65)] backdrop-blur-xl sm:p-9">
        <div className="mb-7 flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-primary text-primary-foreground">
            <BookOpenText size={27} strokeWidth={1.7} />
          </span>
          <div>
            <h1 className="font-reading text-[25px] font-bold">设置你的账户</h1>
            <p className="mt-1 text-[11px] text-muted-foreground">
              首次登录必须完成，此后不再使用 .env 初始凭据
            </p>
          </div>
        </div>

        <div className="mb-6 flex gap-3 rounded-[16px] border border-border/70 bg-secondary/65 p-3.5">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
          <p className="text-[11px] leading-5 text-muted-foreground">
            用户名会加密后保存；密码使用带随机盐的强哈希保存，服务不会存储或显示原始密码。
          </p>
        </div>

        <form onSubmit={event => void submit(event)} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium">
              自定义用户名
            </span>
            <div className="relative">
              <UserRoundPen
                size={16}
                className="absolute left-3.5 top-3.5 text-muted-foreground"
              />
              <input
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                minLength={2}
                maxLength={64}
                required
                className="h-11 w-full rounded-[13px] border border-border bg-background/75 pl-10 pr-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
                placeholder="2–64 个字符"
              />
            </div>
          </label>
          <PasswordField
            label="新密码"
            value={newPassword}
            autoComplete="new-password"
            onChange={setNewPassword}
          />
          <PasswordField
            label="确认新密码"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={setConfirmPassword}
          />
          {(error || serverError) && (
            <p role="alert" className="text-[12px] leading-5 text-destructive">
              {error || serverError}
            </p>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              username.trim().length < 2 ||
              newPassword.length < 12 ||
              confirmPassword.length < 12
            }
            className="w-full rounded-[14px] bg-primary px-4 py-3 text-[13px] font-semibold text-primary-foreground transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-45"
          >
            {busy ? "正在安全保存…" : "保存并进入书房"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onLogout().catch(() => undefined)}
            className="flex w-full items-center justify-center gap-1.5 rounded-[14px] px-4 py-2 text-[12px] text-muted-foreground transition hover:bg-secondary"
          >
            <LogOut size={14} aria-hidden="true" /> 返回登录
          </button>
        </form>
      </section>
    </main>
  );
}

function PasswordField({
  label,
  value,
  autoComplete,
  onChange,
}: {
  label: string;
  value: string;
  autoComplete: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium">{label}</span>
      <div className="relative">
        <KeyRound
          size={16}
          className="absolute left-3.5 top-3.5 text-muted-foreground"
        />
        <input
          type="password"
          value={value}
          onChange={event => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={12}
          maxLength={1024}
          required
          className="h-11 w-full rounded-[13px] border border-border bg-background/75 pl-10 pr-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
          placeholder="至少 12 个字符"
        />
      </div>
    </label>
  );
}
