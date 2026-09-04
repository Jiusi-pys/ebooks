import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "./lib/env";
import { resolveDataSecret, resolveSessionSecret } from "./lib/session-secret";
import { codexAuthController, type CodexAuthController } from "./lib/codex";
import {
  mysqlAppUserStore,
  type AppUserStore,
  type StoredAppUser,
} from "./lib/app-user-store";
import {
  decryptUsername,
  encryptUsername,
  hashPassword,
  normalizeUsername,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./lib/user-credentials";

export const SESSION_COOKIE = "shufang_session";
const SESSION_VERSION = 2;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 5 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_BACKOFF_AFTER_FAILURES = 5;
const MAX_LOGIN_BACKOFF_MS = 30_000;
const MAX_CONCURRENT_LOGIN_HASHES = 2;
const MAX_BACKOFF_PEERS = 1_024;
const BACKOFF_STATE_TTL_MS = 10 * 60 * 1000;
const RUNTIME_SESSION_SECRET = resolveSessionSecret();
const RUNTIME_DATA_SECRET = resolveDataSecret();

export interface AppAuthConfig {
  appId: string;
  appSecret: string;
  dataSecret: string;
  sessionSecret: string;
  sessionTtlSeconds?: number;
  secureCookies?: boolean;
  /** Browser-visible origin when TLS is terminated by a trusted proxy. */
  publicOrigin?: string;
}

export interface AppSession {
  userId: string;
  issuedAt: number;
  expiresAt: number;
  setupRequired: boolean;
  credentialVersion: number;
}

interface SessionPayload {
  v: number;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
  setup: boolean;
  cv: number;
}

const loginBody = z.object({
  appId: z.string().min(1).max(256),
  appSecret: z.string().min(1).max(4096),
});

const setupBody = z.object({
  username: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(1024),
  confirmPassword: z.string().min(1).max(1024),
});

const profileBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  username: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(1024).optional(),
  confirmPassword: z.string().max(1024).optional(),
});

function runtimeConfig(): AppAuthConfig {
  const configuredTtl = Number(process.env.SESSION_TTL_SECONDS);
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim();
  if (publicOrigin) normalizePublicOrigin(publicOrigin);
  return {
    appId: env.appId,
    appSecret: env.appSecret,
    dataSecret: RUNTIME_DATA_SECRET,
    sessionSecret: RUNTIME_SESSION_SECRET,
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
    `${config.sessionSecret}\0shufang-session-v${SESSION_VERSION}`
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
  return (
    Buffer.byteLength(config.dataSecret, "utf8") >= 32 &&
    Buffer.byteLength(config.sessionSecret, "utf8") >= 32
  );
}

function isBootstrapAuthConfigured(config: AppAuthConfig): boolean {
  return (
    isAppAuthConfigured(config) &&
    config.appId.length > 0 &&
    config.appSecret.length > 0
  );
}

export function createSessionToken(
  config: AppAuthConfig,
  nowMs = Date.now(),
  options: {
    userId?: string;
    setupRequired?: boolean;
    credentialVersion?: number;
  } = {}
): { token: string; session: AppSession } {
  if (!isAppAuthConfigured(config)) {
    throw new Error("Application authentication is not configured");
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + sessionTtlSeconds(config);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    sub: options.userId ?? config.appId,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomBytes(16).toString("base64url"),
    setup: options.setupRequired ?? false,
    cv: options.credentialVersion ?? 1,
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
      setupRequired: payload.setup,
      credentialVersion: payload.cv,
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
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.sub.length > 256 ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 16 ||
      typeof payload.setup !== "boolean" ||
      !Number.isInteger(payload.cv) ||
      (payload.cv as number) < 0 ||
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
      setupRequired: payload.setup,
      credentialVersion: payload.cv as number,
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

export type PersistedSessionValidation =
  { ok: true; session: AppSession } | { ok: false; status: 401 | 503 };

function decryptStoredUsername(
  account: StoredAppUser,
  config: AppAuthConfig
): { username: string; legacy: boolean } {
  try {
    return {
      username: decryptUsername(account.usernameEncrypted, config.dataSecret),
      legacy: false,
    };
  } catch (dataSecretError) {
    // Upgrade accounts created before APP_DATA_SECRET existed. A successful
    // password login immediately re-encrypts the username with dataSecret.
    if (config.appSecret && config.appSecret !== config.dataSecret) {
      try {
        return {
          username: decryptUsername(
            account.usernameEncrypted,
            config.appSecret
          ),
          legacy: true,
        };
      } catch {
        // Surface one uniform storage/configuration failure to the caller.
      }
    }
    throw dataSecretError;
  }
}

/**
 * Bind a validly signed cookie to the current single-user database record.
 * Credential-version checks revoke every older cookie after an account update.
 */
export async function validatePersistedSession(
  session: AppSession,
  config: AppAuthConfig = runtimeConfig(),
  userStore: AppUserStore = mysqlAppUserStore
): Promise<PersistedSessionValidation> {
  let account: StoredAppUser | null;
  try {
    account = await userStore.getSingleton();
  } catch {
    return { ok: false, status: 503 };
  }

  if (session.setupRequired) {
    return account ? { ok: false, status: 401 } : { ok: true, session };
  }
  if (!account || account.credentialVersion !== session.credentialVersion) {
    return { ok: false, status: 401 };
  }
  try {
    const username = decryptStoredUsername(account, config).username;
    return constantTimeTextEqual(session.userId, username)
      ? { ok: true, session }
      : { ok: false, status: 401 };
  } catch {
    return { ok: false, status: 503 };
  }
}

export async function validateRequestSession(
  request: Request,
  config: AppAuthConfig = runtimeConfig(),
  userStore: AppUserStore = mysqlAppUserStore
): Promise<PersistedSessionValidation> {
  const session = getRequestSession(request, config);
  return session
    ? validatePersistedSession(session, config, userStore)
    : { ok: false, status: 401 };
}

export async function verifyBrowserMutationRequest(
  request: Request,
  config = runtimeConfig(),
  userStore: AppUserStore = mysqlAppUserStore
): Promise<
  | { ok: true; session: AppSession }
  | { ok: false; status: 401 | 403 | 428 | 503 }
> {
  const session = getRequestSession(request, config);
  if (!session) return { ok: false, status: 401 };
  if (!isSameOriginRequest(request, config)) return { ok: false, status: 403 };
  if (session.setupRequired) return { ok: false, status: 428 };
  return validatePersistedSession(session, config, userStore);
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

function sessionError(c: Context, status: 401 | 403 | 428) {
  return c.json(
    status === 401
      ? { error: "unauthorized", message: "请先登录书房" }
      : status === 403
        ? { error: "csrf_rejected", message: "请求必须来自书房同源页面" }
        : { error: "setup_required", message: "请先完成首次账户设置" },
    status
  );
}

function authStoreUnavailable(c: Context) {
  return c.json(
    {
      error: "auth_store_unavailable",
      message: "无法读取用户数据，请检查 MySQL 连接与迁移状态",
    },
    503
  );
}

export async function requireBrowserSession(c: Context, next: Next) {
  const validation = await validateRequestSession(c.req.raw);
  if (!validation.ok) {
    return validation.status === 503
      ? authStoreUnavailable(c)
      : sessionError(c, 401);
  }
  if (validation.session.setupRequired) return sessionError(c, 428);
  await next();
}

export async function requireBrowserMutation(c: Context, next: Next) {
  const authorization = await verifyBrowserMutationRequest(c.req.raw);
  if (!authorization.ok) {
    return authorization.status === 503
      ? authStoreUnavailable(c)
      : sessionError(c, authorization.status);
  }
  await next();
}

function noStore(c: Context, next: Next) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return next();
}

export function createAuthRouter(
  config: AppAuthConfig = runtimeConfig(),
  codex: CodexAuthController = codexAuthController,
  userStore: AppUserStore = mysqlAppUserStore,
  passwordVerifier: typeof verifyPassword = verifyPassword
) {
  const auth = new Hono();
  interface BackoffState {
    failures: number;
    retryAt: number;
    lastSeen: number;
  }
  const loginBackoff = new Map<string, BackoffState>();
  const profileBackoff = new Map<string, BackoffState>();
  let activePasswordHashes = 0;
  auth.use("/*", noStore);

  function setSignedSession(
    c: Context,
    options: {
      userId: string;
      setupRequired: boolean;
      credentialVersion: number;
    }
  ) {
    const { token, session } = createSessionToken(config, Date.now(), options);
    setCookie(c, SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: cookieIsSecure(c.req.raw, config),
      maxAge: sessionTtlSeconds(config),
      expires: new Date(session.expiresAt),
      priority: "High",
    });
    return session;
  }

  function currentSession(c: Context): AppSession | null {
    return verifySessionToken(getCookie(c, SESSION_COOKIE), config);
  }

  function clearSignedSession(c: Context) {
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      secure: cookieIsSecure(c.req.raw, config),
    });
  }

  async function currentValidatedSession(
    c: Context
  ): Promise<AppSession | Response> {
    const session = currentSession(c);
    if (!session) return sessionError(c, 401);
    const validation = await validatePersistedSession(
      session,
      config,
      userStore
    );
    if (!validation.ok) {
      if (validation.status === 503) return authStoreUnavailable(c);
      clearSignedSession(c);
      return sessionError(c, 401);
    }
    return validation.session;
  }

  async function requireNormalSession(
    c: Context
  ): Promise<AppSession | Response> {
    const session = await currentValidatedSession(c);
    if (session instanceof Response) return session;
    if (session.setupRequired) return sessionError(c, 428);
    return session;
  }

  function storeUnavailable(c: Context) {
    return authStoreUnavailable(c);
  }

  function passwordHashPreflight(c: Context): Response | null {
    if (activePasswordHashes >= MAX_CONCURRENT_LOGIN_HASHES) {
      c.header("Retry-After", "1");
      return c.json(
        { error: "login_rate_limited", message: "登录尝试过多，请稍后重试" },
        429
      );
    }
    return null;
  }

  async function withPasswordHash<T>(operation: () => Promise<T>): Promise<T> {
    activePasswordHashes += 1;
    try {
      return await operation();
    } finally {
      activePasswordHashes -= 1;
    }
  }

  function requestPeer(c: Context): string {
    // This is the actual Node socket address. Deliberately ignore forwarded
    // headers because an untrusted client can forge them.
    const bindings = c.env as
      { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return bindings?.incoming?.socket?.remoteAddress || "local-or-unknown";
  }

  function backoffState(
    states: Map<string, BackoffState>,
    key: string,
    now: number
  ): BackoffState {
    const existing = states.get(key);
    if (
      existing &&
      (now < existing.retryAt || now - existing.lastSeen < BACKOFF_STATE_TTL_MS)
    ) {
      existing.lastSeen = now;
      return existing;
    }
    if (!existing && states.size >= MAX_BACKOFF_PEERS) {
      let oldestKey: string | undefined;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [candidate, state] of states) {
        if (state.lastSeen < oldestSeen) {
          oldestKey = candidate;
          oldestSeen = state.lastSeen;
        }
      }
      if (oldestKey) states.delete(oldestKey);
    }
    const state = { failures: 0, retryAt: 0, lastSeen: now };
    states.set(key, state);
    return state;
  }

  function loginCooldown(c: Context, key: string): Response | null {
    const now = Date.now();
    const state = backoffState(loginBackoff, key, now);
    if (now >= state.retryAt) return null;
    c.header(
      "Retry-After",
      String(Math.max(1, Math.ceil((state.retryAt - now) / 1000)))
    );
    return c.json(
      { error: "login_rate_limited", message: "登录尝试过多，请稍后重试" },
      429
    );
  }

  function profileCooldown(c: Context, key: string): Response | null {
    const now = Date.now();
    const state = backoffState(profileBackoff, key, now);
    if (now >= state.retryAt) return null;
    c.header(
      "Retry-After",
      String(Math.max(1, Math.ceil((state.retryAt - now) / 1000)))
    );
    return c.json(
      { error: "profile_rate_limited", message: "密码尝试过多，请稍后重试" },
      429
    );
  }

  function invalidLogin(c: Context, key: string) {
    const now = Date.now();
    const cooldown = loginCooldown(c, key);
    if (cooldown) return cooldown;
    const state = backoffState(loginBackoff, key, now);
    state.failures += 1;
    const exponent = Math.max(0, state.failures - LOGIN_BACKOFF_AFTER_FAILURES);
    const backoffMs =
      state.failures < LOGIN_BACKOFF_AFTER_FAILURES
        ? 0
        : Math.min(MAX_LOGIN_BACKOFF_MS, 1000 * 2 ** exponent);
    state.retryAt = now + backoffMs;
    if (backoffMs > 0) {
      c.header("Retry-After", String(Math.ceil(backoffMs / 1000)));
      return c.json(
        { error: "login_rate_limited", message: "登录尝试过多，请稍后重试" },
        429
      );
    }
    return c.json(
      { error: "invalid_credentials", message: "用户名或登录密码错误" },
      401
    );
  }

  function invalidProfilePassword(c: Context, key: string) {
    const now = Date.now();
    const cooldown = profileCooldown(c, key);
    if (cooldown) return cooldown;
    const state = backoffState(profileBackoff, key, now);
    state.failures += 1;
    const exponent = Math.max(0, state.failures - LOGIN_BACKOFF_AFTER_FAILURES);
    const backoffMs =
      state.failures < LOGIN_BACKOFF_AFTER_FAILURES
        ? 0
        : Math.min(MAX_LOGIN_BACKOFF_MS, 1000 * 2 ** exponent);
    state.retryAt = now + backoffMs;
    if (backoffMs > 0) {
      c.header("Retry-After", String(Math.ceil(backoffMs / 1000)));
      return c.json(
        { error: "profile_rate_limited", message: "密码尝试过多，请稍后重试" },
        429
      );
    }
    return c.json(
      { error: "invalid_credentials", message: "当前密码错误" },
      401
    );
  }

  function readStoredUsername(account: StoredAppUser) {
    return decryptStoredUsername(account, config);
  }

  auth.get("/session", async c => {
    let accountInitialized = false;
    try {
      accountInitialized = (await userStore.getSingleton()) !== null;
    } catch {
      return authStoreUnavailable(c);
    }
    const signedSession = currentSession(c);
    let session: AppSession | null = null;
    if (signedSession) {
      const validation = await validatePersistedSession(
        signedSession,
        config,
        userStore
      );
      if (!validation.ok && validation.status === 503) {
        return authStoreUnavailable(c);
      }
      if (validation.ok) session = validation.session;
      else clearSignedSession(c);
    }
    return c.json({
      configured: accountInitialized
        ? isAppAuthConfigured(config)
        : isBootstrapAuthConfigured(config),
      authenticated: session !== null,
      user: session ? { id: session.userId } : null,
      expiresAt: session?.expiresAt ?? null,
      setupRequired: session?.setupRequired ?? false,
      accountInitialized,
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
    async c => {
      const credentials = c.req.valid("json");
      const loginKey = requestPeer(c);
      const cooldown = loginCooldown(c, loginKey);
      if (cooldown) return cooldown;

      let account: StoredAppUser | null;
      try {
        account = await userStore.getSingleton();
      } catch {
        return storeUnavailable(c);
      }
      if (
        !isAppAuthConfigured(config) ||
        (!account && !isBootstrapAuthConfigured(config))
      ) {
        return c.json(
          {
            error: "auth_not_configured",
            message: account
              ? "请配置 APP_DATA_SECRET 与 APP_SESSION_SECRET"
              : "请先配置 APP_ID 和 APP_SECRET",
          },
          503
        );
      }

      let validId = false;
      let validSecret = false;
      let userId = config.appId;
      let setupRequired = true;
      let credentialVersion = 0;
      let legacyUsernameEncryption = false;
      if (account) {
        try {
          const storedUsername = readStoredUsername(account);
          userId = storedUsername.username;
          legacyUsernameEncryption = storedUsername.legacy;
        } catch {
          return storeUnavailable(c);
        }
        validId = constantTimeTextEqual(
          normalizeUsername(credentials.appId),
          userId
        );
        const hashLimited = passwordHashPreflight(c);
        if (hashLimited) return hashLimited;
        validSecret = await withPasswordHash(() =>
          passwordVerifier(credentials.appSecret, account.passwordHash)
        );
        setupRequired = false;
        credentialVersion = account.credentialVersion;
      } else {
        validId = constantTimeTextEqual(credentials.appId, config.appId);
        validSecret = constantTimeTextEqual(
          credentials.appSecret,
          config.appSecret
        );
      }
      if (!(validId && validSecret)) {
        return invalidLogin(c, loginKey);
      }

      if (account && legacyUsernameEncryption) {
        try {
          const migrated = await userStore.updateCredentials({
            expectedVersion: account.credentialVersion,
            usernameEncrypted: encryptUsername(userId, config.dataSecret),
            passwordHash: account.passwordHash,
          });
          if (!migrated) {
            return c.json(
              {
                error: "credential_conflict",
                message: "账户已更新，请重新登录后再试",
              },
              409
            );
          }
          credentialVersion = account.credentialVersion + 1;
        } catch {
          return storeUnavailable(c);
        }
      }

      loginBackoff.delete(loginKey);

      const session = setSignedSession(c, {
        userId,
        setupRequired,
        credentialVersion,
      });
      return c.json({
        ok: true,
        user: { id: session.userId },
        expiresAt: session.expiresAt,
        setupRequired: session.setupRequired,
      });
    }
  );

  auth.post(
    "/setup",
    zValidator("json", setupBody, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "invalid_request", message: "请填写用户名并确认新密码" },
          400
        );
      }
    }),
    async c => {
      const session = await currentValidatedSession(c);
      if (session instanceof Response) return session;
      if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
      if (!session.setupRequired) {
        return c.json(
          { error: "setup_completed", message: "账户已完成初始设置" },
          409
        );
      }
      const input = c.req.valid("json");
      const username = normalizeUsername(input.username);
      const usernameError = validateUsername(username);
      const passwordError = validatePassword(input.newPassword);
      if (usernameError || passwordError) {
        return c.json(
          {
            error: "invalid_account_details",
            message: usernameError ?? passwordError ?? "账户信息无效",
          },
          400
        );
      }
      if (!constantTimeTextEqual(input.newPassword, input.confirmPassword)) {
        return c.json(
          { error: "password_mismatch", message: "两次输入的新密码不一致" },
          400
        );
      }
      try {
        if (await userStore.getSingleton()) {
          return c.json(
            {
              error: "setup_completed",
              message: "账户已完成初始设置，请重新登录",
            },
            409
          );
        }
        const hashLimited = passwordHashPreflight(c);
        if (hashLimited) return hashLimited;
        const passwordHash = await withPasswordHash(() =>
          hashPassword(input.newPassword)
        );
        const created = await userStore.createInitial({
          usernameEncrypted: encryptUsername(username, config.dataSecret),
          passwordHash,
        });
        if (!created) {
          return c.json(
            {
              error: "setup_completed",
              message: "账户已完成初始设置，请重新登录",
            },
            409
          );
        }
      } catch {
        return storeUnavailable(c);
      }
      const nextSession = setSignedSession(c, {
        userId: username,
        setupRequired: false,
        credentialVersion: 1,
      });
      return c.json({
        ok: true,
        user: { id: username },
        expiresAt: nextSession.expiresAt,
        setupRequired: false,
      });
    }
  );

  auth.get("/profile", async c => {
    const session = await requireNormalSession(c);
    if (session instanceof Response) return session;
    try {
      const account = await userStore.getSingleton();
      if (!account) return sessionError(c, 401);
      const username = readStoredUsername(account).username;
      if (account.credentialVersion !== session.credentialVersion) {
        return sessionError(c, 401);
      }
      return c.json({
        user: { id: username },
        credentialVersion: account.credentialVersion,
      });
    } catch {
      return storeUnavailable(c);
    }
  });

  auth.patch(
    "/profile",
    zValidator("json", profileBody, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "invalid_request", message: "请填写当前密码和用户名" },
          400
        );
      }
    }),
    async c => {
      // A validly signed cookie gives us a stable per-user key without touching
      // MySQL. Keep cooldown checks ahead of persisted-session validation so a
      // throttled peer cannot continue consuming database connections.
      const signedSession = currentSession(c);
      if (!signedSession) return sessionError(c, 401);
      if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
      if (signedSession.setupRequired) return sessionError(c, 428);
      const profileKey = `${requestPeer(c)}\0${signedSession.userId}`;
      const cooldown = profileCooldown(c, profileKey);
      if (cooldown) return cooldown;

      const session = await requireNormalSession(c);
      if (session instanceof Response) return session;
      const input = c.req.valid("json");
      const username = normalizeUsername(input.username);
      const usernameError = validateUsername(username);
      const passwordError = input.newPassword
        ? validatePassword(input.newPassword)
        : null;
      if (usernameError || passwordError) {
        return c.json(
          {
            error: "invalid_account_details",
            message: usernameError ?? passwordError ?? "账户信息无效",
          },
          400
        );
      }
      if (
        input.newPassword &&
        !constantTimeTextEqual(input.newPassword, input.confirmPassword ?? "")
      ) {
        return c.json(
          { error: "password_mismatch", message: "两次输入的新密码不一致" },
          400
        );
      }
      try {
        const account = await userStore.getSingleton();
        if (
          !account ||
          account.credentialVersion !== session.credentialVersion
        ) {
          return sessionError(c, 401);
        }
        const hashLimited = passwordHashPreflight(c);
        if (hashLimited) return hashLimited;
        const currentPasswordValid = await withPasswordHash(() =>
          passwordVerifier(input.currentPassword, account.passwordHash)
        );
        if (!currentPasswordValid) return invalidProfilePassword(c, profileKey);
        profileBackoff.delete(profileKey);
        let passwordHash = account.passwordHash;
        if (input.newPassword) {
          const nextHashLimited = passwordHashPreflight(c);
          if (nextHashLimited) return nextHashLimited;
          passwordHash = await withPasswordHash(() =>
            hashPassword(input.newPassword!)
          );
        }
        const updated = await userStore.updateCredentials({
          expectedVersion: account.credentialVersion,
          usernameEncrypted: encryptUsername(username, config.dataSecret),
          passwordHash,
        });
        if (!updated) {
          return c.json(
            {
              error: "credential_conflict",
              message: "账户已更新，请重新登录后再试",
            },
            409
          );
        }
        const credentialVersion = account.credentialVersion + 1;
        const nextSession = setSignedSession(c, {
          userId: username,
          setupRequired: false,
          credentialVersion,
        });
        return c.json({
          ok: true,
          user: { id: username },
          credentialVersion,
          expiresAt: nextSession.expiresAt,
          setupRequired: false,
        });
      } catch {
        return storeUnavailable(c);
      }
    }
  );

  auth.post("/logout", async c => {
    if (!isSameOriginRequest(c.req.raw, config)) return sessionError(c, 403);
    clearSignedSession(c);
    return c.json({ ok: true });
  });

  auth.get("/codex/status", async c => {
    const session = await requireNormalSession(c);
    if (session instanceof Response) return session;
    const status = await codex.status();
    return c.json(status);
  });

  auth.post("/codex/login", async c => {
    const session = await requireNormalSession(c);
    if (session instanceof Response) return session;
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
    const session = await requireNormalSession(c);
    if (session instanceof Response) return session;
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
