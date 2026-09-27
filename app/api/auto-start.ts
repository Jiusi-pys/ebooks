import { Hono } from "hono";
import { z } from "zod";
import { requireBrowserMutation, requireBrowserSession } from "./auth";
import { autoStartManager } from "./lib/auto-start";

export function createAutoStartApi(
  manager = autoStartManager,
  middleware = {
    session: requireBrowserSession,
    mutation: requireBrowserMutation,
  }
) {
  const api = new Hono();
  api.use("/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return c.req.method === "GET"
      ? middleware.session(c, next)
      : middleware.mutation(c, next);
  });

  api.get("/status", async c => {
    try {
      return c.json(await manager.status());
    } catch {
      return c.json({ error: "启动项状态暂不可用" }, 503);
    }
  });

  api.post("/status", async c => {
    const parsed = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "无效的启动项设置" }, 400);
    try {
      return c.json(await manager.setEnabled(parsed.data.enabled));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "无法更新自动启动设置",
        },
        409
      );
    }
  });

  return api;
}

export const autoStart = createAutoStartApi();
