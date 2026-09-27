import { Keyboard, Loader2, Power, Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSearchEngine } from "@/lib/searchEngine";
import { SyncStatus } from "./SyncStatus";

interface AutoStartState {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  platform: "windows" | "linux" | "unsupported";
}

/** Local, application-wide preferences that are independent of an account. */
export function AppSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [searchEngine, setSearchEngine] = useSearchEngine();
  const [autoStart, setAutoStart] = useState<AutoStartState | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartError, setAutoStartError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetch("/api/autostart/status", { credentials: "same-origin" })
      .then(async response => {
        if (!response.ok) throw new Error("无法读取自动启动状态");
        return (await response.json()) as AutoStartState;
      })
      .then(state => {
        if (alive) setAutoStart(state);
      })
      .catch(error => {
        if (alive)
          setAutoStartError(
            error instanceof Error ? error.message : "无法读取自动启动状态"
          );
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const changeAutoStart = async () => {
    if (!autoStart?.installed || autoStartBusy) return;
    setAutoStartBusy(true);
    setAutoStartError("");
    try {
      const response = await fetch("/api/autostart/status", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !autoStart.enabled }),
      });
      const result = (await response.json()) as
        AutoStartState | { error: string };
      if (!response.ok || "error" in result)
        throw new Error("error" in result ? result.error : "设置更新失败");
      setAutoStart(result);
    } catch (error) {
      setAutoStartError(
        error instanceof Error ? error.message : "无法更新自动启动设置"
      );
    } finally {
      setAutoStartBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto rounded-[22px] bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Search size={18} className="text-primary" /> 应用设置
          </DialogTitle>
        </DialogHeader>
        <section>
          <h3 className="text-[13px] font-medium">搜索引擎</h3>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            阅读时划选文字后，“搜索”会使用此引擎打开查询。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(["google", "bing"] as const).map(engine => (
              <button
                key={engine}
                type="button"
                onClick={() => setSearchEngine(engine)}
                className={`rounded-[12px] border px-3 py-2 text-[12px] transition-colors ${
                  searchEngine === engine
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-secondary"
                }`}
              >
                {engine === "google" ? "Google" : "Bing"}
              </button>
            ))}
          </div>
        </section>
        <section className="border-t border-border pt-4">
          <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
            <Power size={14} className="text-primary" /> 登录时自动启动
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            控制此服务器用户登录系统后是否自动启动书房；更改不会关闭当前运行的服务。
          </p>
          {autoStart?.installed ? (
            <button
              type="button"
              disabled={autoStartBusy}
              onClick={() => void changeAutoStart()}
              className="mt-3 flex w-full items-center justify-between rounded-[12px] border border-border px-3 py-2 text-[12px] hover:bg-secondary disabled:opacity-50"
            >
              <span>{autoStart.enabled ? "已启用" : "已关闭"}</span>
              <span className="text-primary">
                {autoStartBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : autoStart.enabled ? (
                  "关闭"
                ) : (
                  "启用"
                )}
              </span>
            </button>
          ) : autoStart?.supported ? (
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              尚未安装启动项。请在项目的 app 目录运行{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                {autoStart.platform === "windows"
                  ? "powershell -ExecutionPolicy Bypass -File .\\scripts\\install-autostart.ps1"
                  : "sh scripts/install-autostart.sh"}
              </code>
              ，安装时可选择是否启用，然后重新打开此设置。
            </p>
          ) : autoStart ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              当前运行平台或部署方式不支持在应用内切换自动启动；容器部署由宿主机的重启策略管理。
            </p>
          ) : null}
          {autoStartError && (
            <p role="alert" className="mt-2 text-[11px] text-destructive">
              {autoStartError}
            </p>
          )}
        </section>
        {open && <SyncStatus />}
        <section className="border-t border-border pt-4">
          <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
            <Keyboard size={14} className="text-primary" /> 快捷键说明
          </h3>
          <dl className="mt-2 space-y-1.5 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between gap-4">
              <dt>打开全局搜索</dt>
              <dd className="rounded border bg-muted px-1.5 py-0.5 text-foreground">
                Ctrl / ⌘ K
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt>退出浮层或沉浸阅读</dt>
              <dd className="rounded border bg-muted px-1.5 py-0.5 text-foreground">
                Esc
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt>翻页阅读</dt>
              <dd className="rounded border bg-muted px-1.5 py-0.5 text-foreground">
                ← / → 或 PageUp / PageDown
              </dd>
            </div>
          </dl>
        </section>
      </DialogContent>
    </Dialog>
  );
}
