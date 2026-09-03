import { dispatchAppAuthRequired } from "./auth-events";

export async function readCodexAuthJson<T>(response: Response): Promise<T> {
  if (response.status === 401) dispatchAppAuthRequired();
  const body = (await response.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(body.message || `Codex 登录服务返回 ${response.status}`);
  }
  return body;
}
