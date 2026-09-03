import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "./lib/env";
import { codexAuthController, type CodexAuthController } from "./lib/codex";

export const SESSION_COOKIE = "shufang_session";
const SESSION_VERSION = 1;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 5 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_BACKOFF_AFTER_FAILURES = 5;
const MAX_LOGIN_BACKOFF_MS = 30_000;

export interface AppAuthConfig {
  appId: string;
  appSecret: string;
  sessionTtlSeconds?: number;
  secureCookies?: boolean;
  /** Browser-visible origin when TLS is terminated by a trusted proxy. */
  publicOrigin?: string;
}

export interface AppSession {
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

interface SessionPayload {
  v: number;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

const loginBody = z.object({
  appId: z.string().min(1).max(256),
  appSecret: z.string().min(1).max(4096),
});

function runtimeConfig(): AppAuthConfig {
  const configuredTtl = Number(process.env.SESSION_TTL_SECONDS);
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim();
  if (publicOrigin) normalizePublicOrigin(publicOrigin);
  return {
    appId: env.appId,
    appSecret: env.appSecret,
    sessionTtlSeconds: Number.isFinite(configuredTtl)
      ? configuredTtl
      : DEFAULT_SESSION_TTL_SECONDS,
    secureCookies: process.env.SESSION_COOKIE_SECURE === "true",
    publicOrigin,
  };
}

function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only scheme, host, and port");
  }
  return url.origin;
}

function sessionTtlSeconds(config: AppAuthConfig): number {
  const requested = Math.floor(
    config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
  );
  return Math.min(
    MAX_SESSION_TTL_SECONDS,
    Math.max(MIN_SESSION_TTL_SECONDS, requested)
  );
}

function hmac(config: AppAuthConfig, value: string): Buffer {
  return createHmac(
    "sha256",
    `${config.appSecret}\0shufang-session-v${SESSION_VERSION}`
  )
    .update(value, "utf8")
    .digest();
}

/** Compare credentials without leaking their length or an early mismatch. */
export function constantTimeTextEqual(
  actual: string,
  expected: string
): boolean {
  const left = createHmac("sha256", "shufang-credential-compare")
    .update(actual, "utf8")
    .digest();
  const right = createHmac("sha256", "shufang-credential-compare")
    .update(expected, "utf8")
    .digest();
  return timingSafeEqual(left, right);
}

export function isAppAuthConfigured(config = runtimeConfig()): boolean {
  return config.appId.length > 0 && config.appSecret.length > 0;
}

export function createSessionToken(
  config: AppAuthConfig,
  nowMs = Date.now()
): { token: string; session: AppSession } {
  if (!isAppAuthConfigured(config)) {
    throw new Error("Application authentication is not configured");
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + sessionTtlSeconds(config);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    sub: config.appId,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = hmac(config, encoded).toString("base64url");
  return {
    token: `${encoded}.${signature}`,
    session: {
      userId: payload.sub,
      issuedAt: payload.iat * 1000,
      expiresAt: payload.exp * 1000,
    },
  };
}

export function verifySessionToken(
  token: string | undefined,
  config: AppAuthConfig,
  nowMs = Date.now()
): AppSession | null {
  if (!token || !isAppAuthConfigured(config) || token.length > 4096)
    return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signatureText] = parts;
  if (
    !encoded ||
    !signatureText ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signatureText)
  ) {
    return null;
  }

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(signatureText, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = hmac(config, encoded);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<SessionPayload>;
    const now = Math.floor(nowMs / 1000);
    if (
      payload.v !== SESSION_VERSION ||
      payload.sub !== config.appId ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 16 ||
      (payload.iat as number) > now + 60 ||
      (payload.exp as number) <= now ||
      (payload.exp as number) - (payload.iat as number) >
        MAX_SESSION_TTL_SECONDS
    ) {
      return null;
    }
    return {
      userId: payload.sub,
      issuedAt: (payload.iat as number) * 1000,
      expiresAt: (payload.exp as number) * 1000,
    };
  } catch {
    return null;
  }
}

export function isSameOriginRequest(
  request: Request,
  config: AppAuthConfig = runtimeConfig()
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expectedOrigin = config.publicOrigin
      ? normalizePublicOrigin(config.publicOrigin)
      : new URL(request.url).origin;
    const originUrl = new URL(origin);
    if (originUrl.origin !== expectedOrigin) return false;
    const fetchSite = request.headers.get("sec-fetch-site");
    return !fetchSite || fetchSite === "same-origin";
  } catch {
    return false;
  }
}

export function getRequestSession(
  request: Request,
  config = runtimeConfig()
): AppSession | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return verifySessionToken(token, config);
}

export function verifyBrowserMutationRequest(
  request: Request,
  config = runtimeConfig()
): { ok: true; session: AppSession } | { ok: false; status: 401 | 403 } {
  const session = getRequestSession(request, config);
  if (!session) return { ok: false, status: 401 };
  if (!isSameOriginRequest(request, config)) return { ok: false, status: 403 };
  return { ok: true, session };
}

function cookieIsSecure(request: Request, config: AppAuthConfig): boolean {
  if (config.secureCookies === true) return true;
  try {
    if (config.publicOrigin) {
      return (
        new URL(normalizePublicOrigin(config.publicOrigin)).protocol ===
        "https:"
      );
    }
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function sessionError(c: Context, status: 401 | 403) {
  return c.json(
    status === 401
      ? { error: "unauthorized", message: "请先登录书房" }
      : { error: "csrf_rejected", message: "请求必须来自书房同源页面" },
    status
  );
}

export async function requireBrowserSession(c: Context, next: Next) {
  if (!getRequestSession(c.req.raw)) return sessionError(c, 401);
  await next();
}

export async function requireBrowserMutation(c: Context, next: Next) {
  const authorization = verifyBrowserMutationRequest(c.req.raw);
  if (!authorization.ok) return sessionError(c, authorization.status);
  await next();
}

function noStore(c: Context, next: Next) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return next();
}

export function createAuthRouter(
  config: AppAuthConfig = runtimeConfig(),
  codex: CodexAuthController = codexAuthController
) {
  const auth = new Hono();
  let failedLoginAttempts = 0;
  let loginRetryAt = 0;
  auth.use("/*", noStore);

  auth.get("/session", c => {
    const session = verifySessionToken(getCookie(c, SESSION_COOKIE), config);
    return c.json({
      configured: isAppAuthConfigured(config),
      authenticated: session !== null,
      user: session ? { id: session.userId } : null,
      expiresAt: session?.expiresAt ?? null,
    });
  });

  auth.post(
    "/login",
    async (c, next) => {
      if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
      await next();
    },
    zValidator("json", loginBody, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "invalid_request", message: "请输入应用 ID 和登录密码" },
          400
        );
      }
    }),
    c => {
      if (!isAppAuthConfigured(config)) {
        return c.json(
          {
            error: "auth_not_configured",
            message: "请先配置 APP_ID 和 APP_SECRET",
          },
          503
        );
      }
      const credentials = c.req.valid("json");
      const validId = constantTimeTextEqual(credentials.appId, config.appId);
      const validSecret = constantTimeTextEqual(
        credentials.appSecret,
        config.appSecret
      );
      if (!(validId && validSecret)) {
        const now = Date.now();
        if (now < loginRetryAt) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((loginRetryAt - now) / 1000)
          );
          c.header("Retry-After", String(retryAfterSeconds));
          return c.json(
            {
              error: "login_rate_limited",
              message: "登录尝试过多，请稍后重试",
            },
            429
          );
        }
        failedLoginAttempts += 1;
        const exponent = Math.max(
          0,
          failedLoginAttempts - LOGIN_BACKOFF_AFTER_FAILURES
        );
        const backoffMs =
          failedLoginAttempts < LOGIN_BACKOFF_AFTER_FAILURES
            ? 0
            : Math.min(MAX_LOGIN_BACKOFF_MS, 1000 * 2 ** exponent);
        loginRetryAt = now + backoffMs;
        if (backoffMs > 0) {
          c.header("Retry-After", String(Math.ceil(backoffMs / 1000)));
          return c.json(
            {
              error: "login_rate_limited",
              message: "登录尝试过多，请稍后重试",
            },
            429
          );
        }
        return c.json(
          { error: "invalid_credentials", message: "应用 ID 或登录密码错误" },
          401
        );
      }

      // A correct credential is never locked out by forged failed requests.
      failedLoginAttempts = 0;
      loginRetryAt = 0;

      const { token, session } = createSessionToken(config);
      setCookie(c, SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        secure: cookieIsSecure(c.req.raw, config),
        maxAge: sessionTtlSeconds(config),
        expires: new Date(session.expiresAt),
        priority: "High",
      });
      return c.json({
        ok: true,
        user: { id: session.userId },
        expiresAt: session.expiresAt,
      });
    }
  );

  auth.post("/logout", async c => {
    if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      secure: cookieIsSecure(c.req.raw, config),
    });
    return c.json({ ok: true });
  });

  auth.get("/codex/status", async c => {
    if (!verifySessionToken(getCookie(c, SESSION_COOKIE), config)) {
      return sessionError(c, 401);
    }
    const status = await codex.status();
    return c.json(status);
  });

  auth.post("/codex/login", async c => {
    if (!verifySessionToken(getCookie(c, SESSION_COOKIE), config)) {
      return sessionError(c, 401);
    }
    if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
    const result = await codex.startLogin();
    if (!result.available) {
      return c.json(
        {
          error: "codex_unavailable",
          message: "无法启动 Codex CLI，请确认 CODEX_BIN 配置",
        },
        503
      );
    }
    return c.json(
      {
        ok: true,
        started: result.started,
        loginRunning: result.loginRunning,
        authenticated: result.authenticated,
      },
      result.started ? 202 : 200
    );
  });

  auth.post("/codex/logout", async c => {
    if (!verifySessionToken(getCookie(c, SESSION_COOKIE), config)) {
      return sessionError(c, 401);
    }
    if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
    try {
      const status = await codex.logout();
      return c.json({ ok: true, ...status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 登出失败";
      return c.json({ error: "codex_logout_failed", message }, 409);
    }
  });

  return auth;
}

export const auth = createAuthRouter();
