/**
 * 浏览器端阅读事件上报：把阅读动作（划线 / 批注 / 问答 / 引用）发给服务端，
 * 服务端落镜像库并转发给所有 WebHook 订阅者（Hermes / OpenClaw 等）。
 * 失败静默——不影响本地阅读体验。
 */
export function emitEvent(type: string, data: Record<string, unknown>): void {
  void fetch('/api/v1/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, data }),
  }).catch(() => {});
}
