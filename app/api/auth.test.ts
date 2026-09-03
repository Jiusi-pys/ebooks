import { describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE,
  constantTimeTextEqual,
  createAuthRouter,
  createSessionToken,
  getRequestSession,
  verifyBrowserMutationRequest,
  verifySessionToken,
  type AppAuthConfig,
} from "./auth";
import type { CodexAuthController } from "./lib/codex";

const ORIGIN = "http://reader.test";
const config: AppAuthConfig = {
  appId: "owner",
  appSecret: "a-long-local-password",
  sessionTtlSeconds: 3600,
};

function fakeCodex(): CodexAuthController {
  return {
    status: vi.fn(async () => ({
      available: true,
      authenticated: true,
      method: "chatgpt" as const,
      loginRunning: false,
      lastLoginError: null,
    })),
    startLogin: vi.fn(async () => ({
      available: true,
      authenticated: false,
      method: "unknown" as const,
      loginRunning: true,
      lastLoginError: null,
      started: true,
    })),
    logout: vi.fn(async () => ({
      available: true,
      authenticated: false,
      method: "unknown" as const,
      loginRunning: false,
      lastLoginError: null,
    })),
  };
}

async function login(router: ReturnType<typeof createAuthRouter>) {
  const response = await router.request(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ appId: config.appId, appSecret: config.appSecret }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  return { response, cookie };
}

describe("application sessions", () => {
  it("signs expiring sessions and rejects tampering", () => {
    const now = Date.UTC(2026, 8, 4);
    const { token, session } = createSessionToken(config, now);
    expect(verifySessionToken(token, config, now)?.userId).toBe("owner");
    expect(session.expiresAt).toBe(now + 3600_000);
    const signatureStart = token.indexOf(".") + 1;
    const changedSignatureCharacter = token[signatureStart] === "A" ? "B" : "A";
    const tamperedToken =
      token.slice(0, signatureStart) +
      changedSignatureCharacter +
      token.slice(signatureStart + 1);
    expect(verifySessionToken(tamperedToken, config, now)).toBeNull();
    expect(verifySessionToken(token, config, now + 3600_000)).toBeNull();
  });

  it("compares the full credentials", () => {
    expect(constantTimeTextEqual("same", "same")).toBe(true);
    expect(constantTimeTextEqual("same", "different")).toBe(false);
    expect(constantTimeTextEqual("short", "shorter")).toBe(false);
  });

  it("logs in, reports the session, and clears it", async () => {
    const router = createAuthRouter(config, fakeCodex());
    const { response, cookie } = await login(router);
    expect(response.status).toBe(200);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");

    const sessionResponse = await router.request(`${ORIGIN}/session`, {
      headers: { cookie: cookie ?? "" },
    });
    expect(await sessionResponse.json()).toMatchObject({
      configured: true,
      authenticated: true,
      user: { id: "owner" },
    });
    expect(
      getRequestSession(
        new Request(`${ORIGIN}/anything`, {
          headers: { cookie: cookie ?? "" },
        }),
        config
      )?.userId
    ).toBe("owner");

    const logoutResponse = await router.request(`${ORIGIN}/logout`, {
      method: "POST",
      headers: { cookie: cookie ?? "", origin: ORIGIN },
    });
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects invalid credentials and cross-origin mutations", async () => {
    const router = createAuthRouter(config, fakeCodex());
    const invalid = await router.request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ appId: "owner", appSecret: "wrong" }),
    });
    expect(invalid.status).toBe(401);

    const crossOrigin = await router.request(`${ORIGIN}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        appId: config.appId,
        appSecret: config.appSecret,
      }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("backs off repeated failures without locking out correct credentials", async () => {
    const router = createAuthRouter(config, fakeCodex());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await router.request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ appId: "owner", appSecret: "wrong" }),
      });
      expect(response.status).toBe(401);
    }
    const throttled = await router.request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ appId: "owner", appSecret: "wrong" }),
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("1");

    const successful = await login(router);
    expect(successful.response.status).toBe(200);
  });

  it("does not trust a forged loopback Host and Origin without a session", () => {
    const request = new Request("http://127.0.0.1:3000/api/v1/events", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
    });
    expect(verifyBrowserMutationRequest(request, config)).toEqual({
      ok: false,
      status: 401,
    });
  });

  it("accepts an authenticated same-origin browser mutation", () => {
    const { token } = createSessionToken(config);
    const request = new Request(`${ORIGIN}/api/v1/events`, {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(verifyBrowserMutationRequest(request, config)).toMatchObject({
      ok: true,
      session: { userId: "owner" },
    });
  });

  it("uses only the configured public origin behind a TLS proxy", async () => {
    const publicOrigin = "https://books.example";
    const proxiedConfig: AppAuthConfig = {
      ...config,
      publicOrigin,
    };
    const router = createAuthRouter(proxiedConfig, fakeCodex());
    const response = await router.request("http://internal:3000/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({
        appId: proxiedConfig.appId,
        appSecret: proxiedConfig.appSecret,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");

    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const accepted = new Request("http://internal:3000/api/v1/events", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(verifyBrowserMutationRequest(accepted, proxiedConfig).ok).toBe(true);

    const forwardedSpoof = new Request("http://internal:3000/api/v1/events", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        origin: "https://attacker.example",
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "books.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(verifyBrowserMutationRequest(forwardedSpoof, proxiedConfig)).toEqual(
      { ok: false, status: 403 }
    );
  });

  it("protects Codex controls and only starts login after authentication", async () => {
    const codex = fakeCodex();
    const router = createAuthRouter(config, codex);
    const anonymous = await router.request(`${ORIGIN}/codex/status`);
    expect(anonymous.status).toBe(401);

    const { cookie } = await login(router);
    const started = await router.request(`${ORIGIN}/codex/login`, {
      method: "POST",
      headers: { cookie: cookie ?? "", origin: ORIGIN },
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      ok: true,
      started: true,
      loginRunning: true,
    });
    expect(codex.startLogin).toHaveBeenCalledOnce();

    const rejected = await router.request(`${ORIGIN}/codex/logout`, {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        origin: "https://attacker.example",
      },
    });
    expect(rejected.status).toBe(403);
    expect(codex.logout).not.toHaveBeenCalled();
  });
});
