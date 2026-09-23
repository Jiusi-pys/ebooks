import { useRef, useState } from "react";
import { CloudDownload, CloudUpload, LoaderCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LibrarySyncButton({
  onPush,
  onPull,
  disabled = false,
}: {
  onPush: () => Promise<boolean>;
  onPull: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const running = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  async function sync(direction: "push" | "pull") {
    if (running.current || disabled) return;
    running.current = true;
    setSyncing(true);
    setMessage("");
    try {
      const success = await (direction === "push" ? onPush() : onPull());
      setMessage(
        success
          ? `${
              direction === "push" ? "已上传到 MySQL" : "已从 MySQL 下载"
            } · ${new Date().toLocaleTimeString()}`
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={syncing || disabled}
            title={disabled ? "请等待书籍导入完成" : "选择书籍同步方向"}
            className="font-meta flex items-center gap-1.5 rounded-full border border-primary/40 px-3 py-1.5 text-[11px] tracking-wider text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
          >
            {syncing ? (
              <LoaderCircle
                size={14}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <CloudUpload size={14} aria-hidden="true" />
            )}
            {syncing ? "同步中…" : "同步书籍"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem
            onSelect={() => void sync("push")}
            className="flex items-start gap-2 py-2"
          >
            <CloudUpload size={15} className="mt-0.5 shrink-0" />
            <span>
              <span className="block">浏览器 → MySQL</span>
              <span className="block text-[11px] text-muted-foreground">
                将此设备的书籍、原文件与阅读状态上传到 MySQL
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void sync("pull")}
            className="flex items-start gap-2 py-2"
          >
            <CloudDownload size={15} className="mt-0.5 shrink-0" />
            <span>
              <span className="block">MySQL → 浏览器</span>
              <span className="block text-[11px] text-muted-foreground">
                从 MySQL 下载书籍、原文件与阅读状态到此设备
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" className="text-xs text-muted-foreground">
        {message}
      </span>
    </div>
  );
}
