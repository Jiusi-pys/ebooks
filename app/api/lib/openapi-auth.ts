/**
 * 对外开放的机器接口（REST + WebHook），供 Hermes / OpenClaw 等外部 AI 调用。
 *
 * 鉴权：请求头 `X-API-Key: <OPEN_API_KEY>`，或 `Authorization: Bearer <OPEN_API_KEY>`。
 * 密钥仅来自环境变量 OPEN_API_KEY。未配置时机器接口保持禁用。
 */
import type { Context, Next } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

export function resolveConfiguredApiKey(
  environment: Readonly<Record<string, string | undefined>>
): string {
  const dedicatedKey = environment.OPEN_API_KEY?.trim();
  return dedicatedKey ?? "";
}

const API_KEY = resolveConfiguredApiKey(process.env);

export function extractKey(c: Context): string {
  const h = c.req.header("x-api-key");
  if (h) return h.trim();
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

export function validKey(key: string): boolean {
  if (!API_KEY) return false;
  // 固定长度摘要后恒定时间比较，避免长度和首个差异位置泄漏。
  const supplied = createHash("sha256").update(key, "utf8").digest();
  const expected = createHash("sha256").update(API_KEY, "utf8").digest();
  return timingSafeEqual(supplied, expected);
}

/** Hono 中间件：保护 /api/v1 下的资源路由 */
export async function requireApiKey(c: Context, next: Next) {
  if (!API_KEY) {
    return c.json(
      {
        error: "machine_api_unavailable",
        message: "机器接口未启用，请配置 OPEN_API_KEY 后重启服务",
      },
      503
    );
  }
  if (!validKey(extractKey(c))) {
    return c.json(
      { error: "unauthorized", hint: "发送请求头 X-API-Key: <OPEN_API_KEY>" },
      401
    );
  }
  await next();
}
