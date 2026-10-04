import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createOAuthServer, OAuthStore } from "./oauth";

const origin = "https://books.example.test";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const owner = { userId: "reader", credentialVersion: 1 };

describe("MCP OAuth authorization boundary", () => {
  let directory: string;
  let now: number;
  let validOwner: boolean;
  let service: ReturnType<typeof createOAuthServer>;
  function start() {
    return createOAuthServer({
      origin,
      store: new OAuthStore(join(directory, "oauth.json")),
      now: () => now,
      browserOwner: async request =>
        request.headers.get("cookie")?.includes("session=owner") && validOwner
          ? owner
          : null,
      validOwner: async identity =>
        validOwner && identity.credentialVersion === 1,
    });
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "shufang-oauth-"));
    now = Date.now();
    validOwner = true;
    service = start();
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  async function register(uri = redirect) {
    return service.router.request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [uri],
        client_name: "ChatGPT",
        token_endpoint_auth_method: "none",
      }),
    });
  }
  async function begin() {
    const client = (await (await register()).json()) as { client_id: string };
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: "code",
      scope: "library:read",
      resource: `${origin}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
    });
    const response = await service.router.request(
      `${origin}/oauth/authorize?${params}`
    );
    const html = await response.text();
    // Native same-origin POST forms need a non-opaque Origin for CSRF checks.
    // Do not leak the authorization request URL to the external callback.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com;"
    );
    const requestId = html.match(/name="request_id" value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { client, params, requestId, csrf, cookie };
  }
  async function consent(
    flow: Awaited<ReturnType<typeof begin>>,
    overrides: { cookie?: string; origin?: string; csrf?: string } = {}
  ) {
    return service.router.request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: overrides.origin ?? origin,
        Cookie: overrides.cookie ?? `${flow.cookie}; session=owner`,
      },
      body: new URLSearchParams({
        request_id: flow.requestId,
        csrf: overrides.csrf ?? flow.csrf,
        decision: "allow",
      }),
    });
  }
  async function token(clientId: string, fields: Record<string, string>) {
    return service.router.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        resource: `${origin}/mcp`,
        ...fields,
      }),
    });
  }
  async function grant() {
    const flow = await begin();
    const approved = await consent(flow);
    expect(approved.status).toBe(302);
    const url = new URL(approved.headers.get("location")!);
    expect(url.searchParams.get("state")).toBe("client-state");
    expect(url.searchParams.get("iss")).toBe(origin);
    const fields = {
      grant_type: "authorization_code",
      code: url.searchParams.get("code")!,
      redirect_uri: redirect,
      code_verifier: verifier,
    };
    const response = await token(flow.client.client_id, fields);
    expect(response.status).toBe(200);
    return {
      flow,
      fields,
      tokens: (await response.json()) as {
        access_token: string;
        refresh_token: string;
      },
    };
  }
  it("publishes consistent HTTPS metadata, PKCE and public DCR", async () => {
    const metadata = await (
      await service.router.request(
        `${origin}/.well-known/oauth-authorization-server`
      )
    ).json();
    expect(metadata).toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
    const resource = await (
      await service.router.request(
        `${origin}/.well-known/oauth-protected-resource/mcp`
      )
    ).json();
    expect(resource).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["library:read"],
    });
    expect(service.challenge()).toContain(
      'resource_metadata="https://books.example.test/.well-known/oauth-protected-resource/mcp"'
    );
  });
  it.each([
    "https://evil.test/callback",
    "https://chatgpt.com.evil.test/connector/oauth/a",
    "https://chatgpt.com/connector/oauth/a?next=evil",
    "http://chatgpt.com/connector/oauth/a",
  ])("rejects unapproved redirect %s", async uri => {
    expect((await register(uri)).status).toBe(400);
  });
  it("requires login, transaction CSRF and same origin before issuing a code", async () => {
    const flow = await begin();
    expect((await consent(flow, { cookie: flow.cookie })).status).toBe(401);
    expect((await consent(flow, { origin: "https://evil.test" })).status).toBe(
      403
    );
    expect((await consent(flow, { csrf: "wrong" })).status).toBe(403);
    expect((await consent(flow)).status).toBe(302);
    expect((await consent(flow)).status).toBe(400);
  });
  it("validates PKCE, resource and exact redirect without issuing tokens", async () => {
    const flow = await begin();
    const result = await consent(flow);
    const code = new URL(result.headers.get("location")!).searchParams.get(
      "code"
    )!;
    const fields = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
    };
    expect(
      (
        await token(flow.client.client_id, {
          ...fields,
          resource: `${origin}/other`,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await token(flow.client.client_id, {
          ...fields,
          redirect_uri: `${redirect}/evil`,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await token(flow.client.client_id, {
          ...fields,
          code_verifier: "b".repeat(64),
        })
      ).status
    ).toBe(400);
  });
  it("issues opaque tokens, persists grants across restart and rejects code replay", async () => {
    const { flow, fields, tokens } = await grant();
    expect(await service.authorizeToken(tokens.access_token)).toEqual(owner);
    const stored = readFileSync(join(directory, "oauth.json"), "utf8");
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    service = start();
    expect(await service.authorizeToken(tokens.access_token)).toEqual(owner);
    expect((await token(flow.client.client_id, fields)).status).toBe(400);
  });
  it("rotates refresh tokens and revokes the family after reuse", async () => {
    const { flow, tokens } = await grant();
    const response = await token(flow.client.client_id, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(await service.authorizeToken(rotated.access_token)).toEqual(owner);
    expect(
      (
        await token(flow.client.client_id, {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        })
      ).status
    ).toBe(400);
    expect(await service.authorizeToken(rotated.access_token)).toBeNull();
  });
  it("enforces access expiry, owner invalidation and token revocation", async () => {
    const { flow, tokens } = await grant();
    validOwner = false;
    expect(await service.authorizeToken(tokens.access_token)).toBeNull();
    validOwner = true;
    now += 16 * 60 * 1000;
    expect(await service.authorizeToken(tokens.access_token)).toBeNull();
    const response = await token(flow.client.client_id, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    const rotated = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const revoked = await service.router.request(`${origin}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: flow.client.client_id,
        token: rotated.refresh_token,
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await service.authorizeToken(rotated.access_token)).toBeNull();
  });
  it("fails closed on corrupted persisted state", async () => {
    await grant();
    writeFileSync(join(directory, "oauth.json"), '{"version":999}');
    expect((await register()).status).toBe(503);
  });
  it("reclaims expired unused dynamic registrations without evicting grants", async () => {
    const flow = await begin();
    const approved = await consent(flow);
    const code = new URL(approved.headers.get("location")!).searchParams.get(
      "code"
    )!;
    const tokens = (await (
      await token(flow.client.client_id, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
      })
    ).json()) as { refresh_token: string };
    for (let index = 1; index < 128; index++) {
      if (index === 100) now += 60_000;
      expect((await register()).status).toBe(201);
    }
    expect((await register()).status).toBe(429);
    now += 25 * 60 * 60_000;
    expect((await register()).status).toBe(201);
    const rotated = await token(flow.client.client_id, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(rotated.status).toBe(200);
  });
  it("does not issue credentials when the atomic state write fails", async () => {
    const flow = await begin();
    mkdirSync(join(directory, "oauth.json.tmp"));
    expect((await consent(flow)).status).toBe(503);
    rmSync(join(directory, "oauth.json.tmp"), { recursive: true });
    expect((await consent(flow)).status).toBe(302);
  });
  it("rejects expired transactions and foreign clients", async () => {
    const flow = await begin();
    const approved = await consent(flow);
    const code = new URL(approved.headers.get("location")!).searchParams.get(
      "code"
    )!;
    const other = (await (await register()).json()) as { client_id: string };
    const fields = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    };
    expect((await token(other.client_id, fields)).status).toBe(400);
    now += 6 * 60_000;
    expect((await token(flow.client.client_id, fields)).status).toBe(400);
    expect((await consent(flow)).status).toBe(400);
  });
  it("serves MCP discovery and a read-only tool through the OAuth token", async () => {
    vi.stubEnv("OPEN_API_KEY", "internal-key");
    vi.stubEnv("MCP_API_KEY", "legacy-key");
    const { createMcpRouter } = await import("./mcp");
    const { tokens } = await grant();
    const mcp = createMcpRouter(service);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ books: [{ extId: "book-1", title: "Synced book" }] })
      )
    );
    async function rpc(
      method: string,
      params: unknown,
      bearer = tokens.access_token
    ) {
      return mcp.request("https://books.example.test/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    }
    expect(
      (
        await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).status
    ).toBe(200);
    const listing = (await (await rpc("tools/list", {})).json()) as {
      result: { tools: Array<{ _meta?: unknown }> };
    };
    expect(listing.result.tools).toHaveLength(6);
    expect(listing.result.tools.every(tool => !!tool._meta)).toBe(true);
    const result = await (
      await rpc("tools/call", { name: "list_books", arguments: { limit: 1 } })
    ).text();
    expect(result).toContain("Synced book");
    expect((await rpc("tools/list", {}, "legacy-key")).status).toBe(200);
    const denied = await rpc("tools/list", {}, "invalid");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(service.challenge());
  });
});
