import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLibraryMcpServer } from "../mcp/library-tools";
import { oauth } from "./oauth-runtime";

export function createMcpRouter(oauthServer: typeof oauth = oauth) {
  const mcp = new Hono();
  mcp.use("*", (c, next) => requireMcpApiKey(c, next, oauthServer));

  mcp.all("/", async c => {
    const apiKey = process.env.OPEN_API_KEY?.trim() ?? "";
    const baseUrl =
      process.env.MCP_API_BASE_URL?.trim() ||
      `http://127.0.0.1:${process.env.PORT || "3000"}`;
    const server = createLibraryMcpServer({
      baseUrl,
      apiKey,
      oauth: Boolean(oauthServer),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return mcp;
}
export const mcp = createMcpRouter();

async function requireMcpApiKey(
  c: Context,
  next: Next,
  oauthServer: typeof oauth
) {
  const expectedKey = process.env.MCP_API_KEY?.trim() ?? "";
  if (!expectedKey && !oauthServer) {
    return c.json(
      { error: "mcp_unavailable", message: "请配置独立的 MCP_API_KEY" },
      503
    );
  }
  const header = c.req.header("x-api-key");
  const authorization = c.req.header("authorization");
  const providedKey =
    header?.trim() ||
    (authorization?.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : "");
  const actual = createHash("sha256").update(providedKey).digest();
  const expected = createHash("sha256").update(expectedKey).digest();
  if (expectedKey && timingSafeEqual(actual, expected)) return next();
  if (oauthServer) {
    try {
      if (await oauthServer.authorizeToken(providedKey)) return next();
    } catch {
      return c.json({ error: "temporarily_unavailable" }, 503);
    }
    c.header("WWW-Authenticate", oauthServer.challenge());
  }
  return c.json({ error: "unauthorized" }, 401);
}
