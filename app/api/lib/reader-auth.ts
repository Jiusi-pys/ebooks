import type { Context, Next } from "hono";
import { requireBrowserMutation, requireBrowserSession } from "../auth";
import { extractKey, requireApiKey } from "./openapi-auth";

/** Native and browser readers use their signed account session; peers use keys. */
export function requireReaderOrMachine(c: Context, next: Next) {
  // Webhook subscriptions administer server integrations, not reader content.
  if (
    c.req.path === "/api/v1/webhooks" ||
    c.req.path.startsWith("/api/v1/webhooks/")
  ) {
    return requireApiKey(c, next);
  }
  if (extractKey(c)) return requireApiKey(c, next);
  return c.req.method === "GET" || c.req.method === "HEAD"
    ? requireBrowserSession(c, next)
    : requireBrowserMutation(c, next);
}
