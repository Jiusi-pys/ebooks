import {
  useEffect,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { KeyRound, ShieldCheck, UserRoundPen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AccountUpdateInput {
  currentPassword: string;
  username: string;
  newPassword?: string;
  confirmPassword?: string;
}

export function AccountSettingsDialog({
  open,
  username: currentUsername,
  onOpenChange,
  onUpdate,
}: {
  open: boolean;
  username: string;
  onOpenChange: (open: boolean) => void;
  onUpdate: (input: AccountUpdateInput) => Promise<void>;
}) {
  const [username, setUsername] = useState(currentUsername);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setUsername(currentUsername);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  }, [currentUsername, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword && newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onUpdate({
        currentPassword,
        username: username.trim(),
        ...(newPassword ? { newPassword, confirmPassword } : {}),
      });
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md rounded-[22px] bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <ShieldCheck size={18} className="text-primary" /> 账户设置
          </DialogTitle>
          <DialogDescription className="leading-5">
            修改会写入 MySQL。保留新密码为空时，只更新用户名。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-4">
          <AccountField
            label="用户名"
            icon={<UserRoundPen size={15} />}
            value={username}
            onChange={setUsername}
            autoComplete="username"
            minLength={2}
            maxLength={64}
            required
          />
          <AccountField
            label="当前密码（用于确认身份）"
            icon={<KeyRound size={15} />}
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            maxLength={1024}
            required
          />
          <AccountField
            label="新密码（可选）"
            icon={<KeyRound size={15} />}
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            minLength={newPassword ? 12 : undefined}
            maxLength={1024}
            placeholder="至少 12 个字符"
          />
          {newPassword && (
            <AccountField
              label="确认新密码"
              icon={<KeyRound size={15} />}
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
            />
          )}
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="rounded-[12px] border border-border px-4 py-2 text-[12px]"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy || username.trim().length < 2 || !currentPassword}
              className="rounded-[12px] bg-primary px-4 py-2 text-[12px] font-medium text-primary-foreground disabled:opacity-45"
            >
              {busy ? "正在保存…" : "保存账户"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountField({
  label,
  icon,
  onChange,
  ...inputProps
}: Omit<ComponentProps<"input">, "onChange"> & {
  label: string;
  icon: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium">{label}</span>
      <span className="relative block">
        <span className="absolute left-3.5 top-3.5 text-muted-foreground">
          {icon}
        </span>
        <input
          {...inputProps}
          onChange={event => onChange(event.target.value)}
          className="h-11 w-full rounded-[13px] border border-border bg-background/75 pl-10 pr-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
        />
      </span>
    </label>
  );
}
