import { resolve } from "node:path";
import { createOAuthServer, OAuthStore } from "./oauth";
import { validatePersistedSession, validateRequestSession } from "./auth";

export const oauth =
  process.env.MCP_OAUTH_ENABLED === "true"
    ? createOAuthServer({
        origin: process.env.PUBLIC_ORIGIN?.trim() ?? "",
        store: new OAuthStore(
          resolve(process.cwd(), ".runtime/mcp-oauth-v1.json")
        ),
        allowedRedirects: process.env.MCP_OAUTH_REDIRECT_URIS?.split(",")
          .map(value => value.trim())
          .filter(Boolean),
        browserOwner: async request => {
          const result = await validateRequestSession(request);
          if (!result.ok && result.status === 503)
            throw new Error("Owner database unavailable");
          return result.ok && !result.session.setupRequired
            ? {
                userId: result.session.userId,
                credentialVersion: result.session.credentialVersion,
              }
            : null;
        },
        validOwner: async owner => {
          const result = await validatePersistedSession({
            ...owner,
            issuedAt: 0,
            expiresAt: 0,
            setupRequired: false,
          });
          if (!result.ok && result.status === 503)
            throw new Error("Owner database unavailable");
          return result.ok;
        },
      })
    : undefined;
