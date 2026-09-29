import { expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createAuthRouter,
  validatePersistedSession,
  validateRequestSession,
} from "./auth";
import { encryptUsername, hashPassword } from "./lib/user-credentials";
import { createOAuthServer, OAuthStore } from "./oauth";

it("uses actual password login and signed session for consent, then revokes on credential change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-login-"));
  try {
    const origin = "https://books.example.test";
    const config = {
      appId: "bootstrap",
      appSecret: "bootstrap-secret",
      dataSecret: "d".repeat(32),
      sessionSecret: "s".repeat(32),
      publicOrigin: origin,
      secureCookies: true,
    };
    const account = {
      id: 1,
      usernameEncrypted: encryptUsername("owner", config.dataSecret),
      passwordHash: await hashPassword("test-owner-password"),
      credentialVersion: 1,
    };
    const userStore = {
      getSingleton: async () => account,
      createInitial: async () => false,
      updateCredentials: async () => false,
    };
    const oauth = createOAuthServer({
      origin,
      store: new OAuthStore(join(directory, "oauth.json")),
      browserOwner: async request => {
        const result = await validateRequestSession(request, config, userStore);
        return result.ok && !result.session.setupRequired
          ? result.session
          : null;
      },
      validOwner: async owner =>
        (
          await validatePersistedSession(
            { ...owner, issuedAt: 0, expiresAt: 0, setupRequired: false },
            config,
            userStore
          )
        ).ok,
    });
    const app = new Hono()
      .route("/api/auth", createAuthRouter(config, undefined, userStore))
      .route("/", oauth.router);
    const login = await app.request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "owner",
        appSecret: "test-owner-password",
      }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.get("set-cookie")!.split(";")[0];
    const registered = await app.request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
      }),
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const verifier = "a".repeat(64);
    const params = new URLSearchParams({
      client_id,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      response_type: "code",
      resource: `${origin}/mcp`,
      scope: "library:read",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const page = await app.request(`${origin}/oauth/authorize?${params}`);
    const html = await page.text();
    expect(html).toContain("/api/auth/login");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    const consent = await app.request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; ${page.headers.get("set-cookie")!.split(";")[0]}`,
      },
      body: new URLSearchParams({
        request_id: html.match(/name="request_id" value="([^"]+)"/)![1],
        csrf: html.match(/name="csrf" value="([^"]+)"/)![1],
        decision: "allow",
      }),
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get(
      "code"
    )!;
    const exchange = await app.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        resource: `${origin}/mcp`,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: params.get("redirect_uri")!,
      }),
    });
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as { access_token: string };
    expect(await oauth.authorizeToken(tokens.access_token)).toMatchObject({
      userId: "owner",
      credentialVersion: 1,
    });
    account.credentialVersion++;
    expect(await oauth.authorizeToken(tokens.access_token)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
