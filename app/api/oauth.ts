import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { authorizationPage } from "./oauth-page";

export const READ_SCOPE = "library:read";
const ACCESS_MS = 15 * 60_000;
const GRANT_MS = 30 * 24 * 60 * 60_000;
const CODE_MS = 5 * 60_000;
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const ownerSchema = z.object({
  userId: z.string().min(1).max(256),
  credentialVersion: z.number().int().positive(),
});
export type OAuthOwner = z.infer<typeof ownerSchema>;
const clientSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()).max(5),
});
const authorizationSchema = z.object({
  client_id: z.string().min(1).max(256),
  redirect_uri: z.string().max(2048),
  response_type: z.literal("code"),
  resource: z.string().max(2048),
  scope: z.literal(READ_SCOPE),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2048).default(""),
});
const pendingSchema = z.object({
  request: authorizationSchema,
  csrfHash: z.string(),
  expires: z.number(),
});
const codeSchema = z.object({
  request: authorizationSchema,
  owner: ownerSchema,
  expires: z.number(),
});
const grantSchema = z.object({
  owner: ownerSchema,
  clientId: z.string(),
  resource: z.string(),
  scope: z.literal(READ_SCOPE),
  expires: z.number(),
  revoked: z.boolean(),
});
const tokenSchema = z.object({
  grantId: z.string(),
  kind: z.enum(["access", "refresh"]),
  expires: z.number(),
  used: z.boolean(),
});
const stateSchema = z.object({
  version: z.literal(1),
  clients: z.record(z.string(), clientSchema),
  pending: z.record(z.string(), pendingSchema),
  codes: z.record(z.string(), codeSchema),
  grants: z.record(z.string(), grantSchema),
  tokens: z.record(z.string(), tokenSchema),
});
type OAuthState = z.infer<typeof stateSchema>;

/** One writer process per file. A failed atomic replacement never commits in memory. */
export class OAuthStore {
  constructor(readonly path: string) {}
  read(): OAuthState {
    if (!existsSync(this.path))
      return {
        version: 1,
        clients: {},
        pending: {},
        codes: {},
        grants: {},
        tokens: {},
      };
    try {
      return stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (cause) {
      throw new Error("OAuth state is unavailable", { cause });
    }
  }
  update<T>(operation: (state: OAuthState) => T): T {
    const state = this.read();
    const result = operation(state);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    return result;
  }
}

class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly status: 400 | 401 | 403 | 429 = 400
  ) {
    super(error);
  }
}
function requireValue(
  condition: unknown,
  error = "invalid_request",
  status: 400 | 401 | 403 | 429 = 400
): asserts condition {
  if (!condition) throw new OAuthError(error, status);
}
function prune(state: OAuthState, now: number) {
  for (const records of [
    state.pending,
    state.codes,
    state.grants,
    state.tokens,
  ]) {
    for (const [key, item] of Object.entries(records))
      if (item.expires <= now) delete records[key];
  }
  for (const [key, item] of Object.entries(state.tokens))
    if (!state.grants[item.grantId]) delete state.tokens[key];
}
function capacity(records: object, max: number) {
  requireValue(
    Object.keys(records).length < max,
    "temporarily_unavailable",
    429
  );
}

export function createOAuthServer(options: {
  origin: string;
  store: OAuthStore;
  now?: () => number;
  allowedRedirects?: string[];
  browserOwner: (request: Request) => Promise<OAuthOwner | null>;
  validOwner: (owner: OAuthOwner) => Promise<boolean>;
}) {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.origin ||
    origin.username ||
    origin.password
  )
    throw new Error("OAuth PUBLIC_ORIGIN must be an exact HTTPS origin");
  const issuer = options.origin;
  const resource = `${issuer}/mcp`;
  const now = options.now ?? Date.now;
  const store = options.store;
  const router = new Hono();
  const challenge = () =>
    `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${READ_SCOPE}"`;
  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [READ_SCOPE],
    bearer_methods_supported: ["header"],
  };
  const authorizationMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [READ_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  router.use("/oauth/*", bodyLimit({ maxSize: 16 * 1024 }));
  // Global bounded admission avoids trusting spoofable forwarding headers.
  let windowStart = now();
  let requests = 0;
  router.use("/oauth/*", async (c, next) => {
    if (now() - windowStart >= 60_000) {
      windowStart = now();
      requests = 0;
    }
    if (++requests > 120) {
      c.header("Retry-After", "60");
      return c.json({ error: "temporarily_unavailable" }, 429);
    }
    await next();
  });
  router.onError((error, c) => {
    if (error instanceof OAuthError)
      return c.json({ error: error.error }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "invalid_request" }, 400);
    return c.json({ error: "temporarily_unavailable" }, 503);
  });
  router.get("/.well-known/oauth-protected-resource", c =>
    c.json(resourceMetadata)
  );
  router.get("/.well-known/oauth-protected-resource/mcp", c =>
    c.json(resourceMetadata)
  );
  router.get("/.well-known/oauth-authorization-server", c =>
    c.json(authorizationMetadata)
  );

  function allowedRedirect(value: string) {
    try {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        url.protocol !== "https:"
      )
        return false;
      return (
        (url.origin === "https://chatgpt.com" &&
          (url.pathname === "/connector_platform_oauth_redirect" ||
            /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))) ||
        (options.allowedRedirects ?? []).includes(value)
      );
    } catch {
      return false;
    }
  }
  router.post("/oauth/register", async c => {
    requireValue(c.req.header("content-type")?.includes("application/json"));
    const input = z
      .object({
        client_name: z.string().min(1).max(100).default("MCP client"),
        redirect_uris: z.array(z.string().max(2048)).min(1).max(5),
        token_endpoint_auth_method: z.literal("none").default("none"),
        grant_types: z
          .array(z.enum(["authorization_code", "refresh_token"]))
          .max(2)
          .optional(),
        response_types: z.array(z.literal("code")).max(1).optional(),
        scope: z.literal(READ_SCOPE).optional(),
      })
      .parse(await c.req.json());
    requireValue(
      input.redirect_uris.every(allowedRedirect),
      "invalid_redirect_uri"
    );
    const client = store.update(state => {
      capacity(state.clients, 128);
      const client_id = random();
      const created = {
        client_id,
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
      };
      state.clients[client_id] = created;
      return created;
    });
    return c.json(
      {
        ...client,
        client_id_issued_at: Math.floor(now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: READ_SCOPE,
      },
      201
    );
  });
  router.get("/oauth/authorize", c => {
    const query = new URL(c.req.url).searchParams;
    requireValue(
      [...new Set(query.keys())].every(key => query.getAll(key).length === 1)
    );
    const request = authorizationSchema.parse(Object.fromEntries(query));
    requireValue(request.resource === resource, "invalid_target");
    const state = store.read();
    const client = Object.hasOwn(state.clients, request.client_id)
      ? state.clients[request.client_id]
      : undefined;
    requireValue(
      client && client.redirect_uris.includes(request.redirect_uri),
      "invalid_client"
    );
    const id = random();
    const csrf = random();
    const nonce = random();
    store.update(data => {
      prune(data, now());
      capacity(data.pending, 256);
      data.pending[id] = {
        request,
        csrfHash: hash(csrf),
        expires: now() + CODE_MS,
      };
    });
    setCookie(c, "mcp_oauth_csrf", csrf, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/oauth",
      maxAge: 300,
    });
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    c.header("X-Frame-Options", "DENY");
    return c.html(
      authorizationPage({
        id,
        csrf,
        nonce,
        clientName: client.client_name,
        redirect: request.redirect_uri,
      })
    );
  });
  async function form(request: Request) {
    requireValue(
      request.headers.get("content-type")?.split(";")[0] ===
        "application/x-www-form-urlencoded"
    );
    const params = new URLSearchParams(await request.text());
    requireValue(
      [...new Set(params.keys())].every(key => params.getAll(key).length === 1)
    );
    return Object.fromEntries(params);
  }
  router.post("/oauth/authorize", async c => {
    requireValue(
      c.req.header("origin") === issuer &&
        (!c.req.header("sec-fetch-site") ||
          c.req.header("sec-fetch-site") === "same-origin"),
      "access_denied",
      403
    );
    const input = z
      .object({
        request_id: z.string().max(100),
        csrf: z.string().max(100),
        decision: z.enum(["allow", "deny"]),
      })
      .parse(await form(c.req.raw));
    const pending = store.read().pending[input.request_id];
    requireValue(pending && pending.expires > now());
    requireValue(
      hash(input.csrf) === pending.csrfHash &&
        getCookie(c, "mcp_oauth_csrf") === input.csrf,
      "access_denied",
      403
    );
    const owner = await options.browserOwner(c.req.raw);
    requireValue(owner, "login_required", 401);
    const code = random();
    store.update(state => {
      requireValue(
        state.pending[input.request_id] &&
          state.pending[input.request_id].expires > now()
      );
      delete state.pending[input.request_id];
      prune(state, now());
      if (input.decision === "allow") {
        capacity(state.codes, 256);
        state.codes[hash(code)] = {
          request: pending.request,
          owner,
          expires: now() + CODE_MS,
        };
      }
    });
    const callback = new URL(pending.request.redirect_uri);
    callback.searchParams.set("iss", issuer);
    if (pending.request.state)
      callback.searchParams.set("state", pending.request.state);
    callback.searchParams.set(
      input.decision === "allow" ? "code" : "error",
      input.decision === "allow" ? code : "access_denied"
    );
    return c.redirect(callback.toString(), 302);
  });
  function issue(state: OAuthState, grantId: string) {
    capacity(state.tokens, 8192);
    const access_token = random();
    const refresh_token = random();
    const grant = state.grants[grantId];
    state.tokens[hash(access_token)] = {
      grantId,
      kind: "access",
      expires: Math.min(now() + ACCESS_MS, grant.expires),
      used: false,
    };
    state.tokens[hash(refresh_token)] = {
      grantId,
      kind: "refresh",
      expires: grant.expires,
      used: false,
    };
    return {
      access_token,
      refresh_token,
      token_type: "Bearer",
      expires_in: Math.floor(
        (state.tokens[hash(access_token)].expires - now()) / 1000
      ),
      scope: READ_SCOPE,
    };
  }
  router.post("/oauth/token", async c => {
    const input = await form(c.req.raw);
    requireValue(
      !c.req.header("authorization") && !input.client_secret,
      "invalid_client"
    );
    requireValue(input.resource === resource, "invalid_target");
    const state = store.read();
    requireValue(
      input.client_id && Object.hasOwn(state.clients, input.client_id),
      "invalid_client"
    );
    if (input.grant_type === "authorization_code") {
      const key = hash(input.code ?? "");
      const code = state.codes[key];
      requireValue(code && code.expires > now(), "invalid_grant");
      requireValue(
        code.request.client_id === input.client_id &&
          code.request.redirect_uri === input.redirect_uri &&
          code.request.resource === input.resource,
        "invalid_grant"
      );
      requireValue(
        /^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? "") &&
          createHash("sha256")
            .update(input.code_verifier)
            .digest("base64url") === code.request.code_challenge,
        "invalid_grant"
      );
      requireValue(await options.validOwner(code.owner), "invalid_grant");
      const tokens = store.update(data => {
        requireValue(
          data.codes[key] && data.codes[key].expires > now(),
          "invalid_grant"
        );
        delete data.codes[key];
        prune(data, now());
        capacity(data.grants, 512);
        const grantId = random();
        data.grants[grantId] = {
          owner: code.owner,
          clientId: input.client_id,
          resource,
          scope: READ_SCOPE,
          expires: now() + GRANT_MS,
          revoked: false,
        };
        return issue(data, grantId);
      });
      return c.json(tokens);
    }
    requireValue(
      input.grant_type === "refresh_token",
      "unsupported_grant_type"
    );
    requireValue(!input.scope || input.scope === READ_SCOPE, "invalid_scope");
    const key = hash(input.refresh_token ?? "");
    const token = state.tokens[key];
    const grant = token && state.grants[token.grantId];
    requireValue(
      token &&
        token.kind === "refresh" &&
        token.expires > now() &&
        grant &&
        !grant.revoked &&
        grant.expires > now() &&
        grant.clientId === input.client_id &&
        grant.resource === resource,
      "invalid_grant"
    );
    requireValue(await options.validOwner(grant.owner), "invalid_grant");
    const result = store.update(data => {
      const current = data.tokens[key];
      const currentGrant = data.grants[token.grantId];
      requireValue(
        current &&
          currentGrant &&
          !currentGrant.revoked &&
          current.expires > now(),
        "invalid_grant"
      );
      if (current.used) {
        currentGrant.revoked = true;
        return null;
      }
      current.used = true;
      prune(data, now());
      return issue(data, token.grantId);
    });
    requireValue(result, "invalid_grant");
    return c.json(result);
  });
  router.post("/oauth/revoke", async c => {
    const input = await form(c.req.raw);
    requireValue(
      input.client_id && !c.req.header("authorization"),
      "invalid_client"
    );
    store.update(state => {
      requireValue(
        Object.hasOwn(state.clients, input.client_id),
        "invalid_client"
      );
      const token = state.tokens[hash(input.token ?? "")];
      const grant = token && state.grants[token.grantId];
      if (grant?.clientId === input.client_id) grant.revoked = true;
    });
    return c.json({});
  });
  async function authorizeToken(value: string): Promise<OAuthOwner | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const state = store.read();
    const token = state.tokens[hash(value)];
    const grant = token && state.grants[token.grantId];
    if (
      !token ||
      token.kind !== "access" ||
      token.expires <= now() ||
      !grant ||
      grant.revoked ||
      grant.expires <= now() ||
      grant.resource !== resource ||
      grant.scope !== READ_SCOPE
    )
      return null;
    return (await options.validOwner(grant.owner)) ? grant.owner : null;
  }
  return { router, authorizeToken, challenge };
}
