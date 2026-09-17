import { useRef, useState } from "react";
import { CloudUpload, LoaderCircle } from "lucide-react";

export function LibrarySyncButton({
  onSync,
  disabled = false,
}: {
  onSync: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const running = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  async function sync() {
    if (running.current || disabled) return;
    running.current = true;
    setSyncing(true);
    setMessage("");
    try {
      const success = await onSync();
      setMessage(
        success
          ? `书籍已保存到 MySQL · ${new Date().toLocaleTimeString()}`
          : "同步失败，本地数据已保留，请重试"
      );
    } catch {
      setMessage("同步失败，本地数据已保留，请重试");
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void sync()}
        disabled={syncing || disabled}
        title={
          disabled
            ? "请等待书籍导入完成"
            : "同步书籍原文件、正文、封面、目录及阅读进度"
        }
        className="font-meta flex items-center gap-1.5 rounded-full border border-primary/40 px-3 py-1.5 text-[11px] tracking-wider text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
      >
        {syncing ? (
          <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <CloudUpload size={14} aria-hidden="true" />
        )}
        {syncing ? "同步中…" : "同步到 MySQL"}
      </button>
      <span role="status" className="text-xs text-muted-foreground">
        {message}
      </span>
    </div>
  );
}
