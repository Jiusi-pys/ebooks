import { useEffect, useState } from "react";
import { OfflineBooks } from "./OfflineBooks";
import {
  isWorkspaceSyncActive,
  trySyncWorkspace,
  workspaceStatus,
} from "@/lib/workspaceSync";

export function SyncStatus() {
  const [text, setText] = useState("");
  const [detail, setDetail] = useState("");
  useEffect(() => {
    let alive = true;
    const update = async () => {
      if (!isWorkspaceSyncActive()) return;
      try {
        const status = await workspaceStatus();
        if (!alive) return;
        setText(
          status.pending || status.pendingFiles || status.pendingContent
            ? `本机已保存 · ${status.pending} 项修改 / ${status.pendingFiles} 个文件待上传 / ${status.pendingContent} 项正文待下载`
            : "当前节点已确认"
        );
        const peers = Object.entries(status.server.peers ?? {}) as [
          string,
          { error?: string; lastSuccess?: string },
        ][];
        setDetail(
          peers
            .map(
              ([id, peer]) =>
                `${id}：${peer.error ?? (peer.lastSuccess ? `最近同步 ${peer.lastSuccess}` : "等待连接")}`
            )
            .join("\n") || "尚未配置其他节点"
        );
      } catch {
        if (alive) setText("本机已保存 · 服务暂不可达");
      }
    };
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!text) return null;
  return (
    <details className="fixed bottom-3 right-3 z-50 max-w-sm rounded border bg-background p-2 text-xs shadow">
      <summary className="cursor-pointer">同步：{text}</summary>
      <pre className="my-2 whitespace-pre-wrap">{detail}</pre>
      <button
        className="underline"
        onClick={() =>
          void trySyncWorkspace().catch(error => setDetail(String(error)))
        }
      >
        立即同步
      </button>
      <OfflineBooks />
    </details>
  );
}
