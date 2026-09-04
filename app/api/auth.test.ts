import { beforeAll, describe, expect, it, vi } from "vitest";
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
import type { AppUserStore, StoredAppUser } from "./lib/app-user-store";
import type { CodexAuthController } from "./lib/codex";
import {
  decryptUsername,
  encryptUsername,
  hashPassword,
} from "./lib/user-credentials";

const ORIGIN = "http://reader.test";
const config: AppAuthConfig = {
  appId: "bootstrap-owner",
  appSecret: "a-long-local-bootstrap-password",
  dataSecret: "an-independent-data-secret-with-32-bytes",
  sessionSecret: "an-independent-session-secret-with-32-bytes",
  sessionTtlSeconds: 3600,
};
const CUSTOM_USERNAME = "书房主人";
const CUSTOM_PASSWORD = "a-new-custom-password";
let seededAccount: StoredAppUser;

class MemoryUserStore implements AppUserStore {
  record: StoredAppUser | null;
  fail = false;

  constructor(record: StoredAppUser | null = null) {
    this.record = record ? { ...record } : null;
  }

  async getSingleton() {
    if (this.fail) throw new Error("database offline");
    return this.record ? { ...this.record } : null;
  }

  async createInitial(input: {
    usernameEncrypted: string;
    passwordHash: string;
  }) {
    if (this.fail) throw new Error("database offline");
    if (this.record) return false;
    this.record = { id: 1, credentialVersion: 1, ...input };
    return true;
  }

  async updateCredentials(input: {
    expectedVersion: number;
    usernameEncrypted: string;
    passwordHash: string;
  }) {
    if (this.fail) throw new Error("database offline");
    if (
      !this.record ||
      this.record.credentialVersion !== input.expectedVersion
    ) {
      return false;
    }
    this.record = {
      id: 1,
      usernameEncrypted: input.usernameEncrypted,
      passwordHash: input.passwordHash,
      credentialVersion: input.expectedVersion + 1,
    };
    return true;
  }
}

beforeAll(async () => {
  seededAccount = {
    id: 1,
    usernameEncrypted: encryptUsername(CUSTOM_USERNAME, config.dataSecret),
    passwordHash: await hashPassword(CUSTOM_PASSWORD),
    credentialVersion: 1,
  };
});

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

async function login(
  router: ReturnType<typeof createAuthRouter>,
  appId = CUSTOM_USERNAME,
  appSecret = CUSTOM_PASSWORD,
  origin = ORIGIN,
  bindings?: unknown
) {
  const response = await router.request(
    `${ORIGIN}/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ appId, appSecret }),
    },
    bindings as never
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  return { response, cookie };
}

describe("application sessions", () => {
  it("signs expiring sessions and rejects tampering", () => {
    const now = Date.UTC(2026, 8, 4);
    const { token, session } = createSessionToken(config, now);
    expect(verifySessionToken(token, config, now)?.userId).toBe(
      "bootstrap-owner"
    );
    expect(session).toMatchObject({
      expiresAt: now + 3600_000,
      setupRequired: false,
      credentialVersion: 1,
    });
    const signatureStart = token.indexOf(".") + 1;
    const changed = token[signatureStart] === "A" ? "B" : "A";
    const tampered =
      token.slice(0, signatureStart) +
      changed +
      token.slice(signatureStart + 1);
    expect(verifySessionToken(tampered, config, now)).toBeNull();
    expect(verifySessionToken(token, config, now + 3600_000)).toBeNull();
  });

  it("signs sessions independently from the bootstrap and data secret", () => {
    const now = Date.UTC(2026, 8, 4);
    const { token } = createSessionToken(config, now);
    expect(
      verifySessionToken(
        token,
        { ...config, appSecret: "rotated-bootstrap" },
        now
      )
    ).not.toBeNull();
    expect(
      verifySessionToken(token, { ...config, dataSecret: "y".repeat(32) }, now)
    ).not.toBeNull();
    expect(
      verifySessionToken(
        token,
        { ...config, sessionSecret: "x".repeat(32) },
        now
      )
    ).toBeNull();
  });

  it("compares the full credentials", () => {
    expect(constantTimeTextEqual("same", "same")).toBe(true);
    expect(constantTimeTextEqual("same", "different")).toBe(false);
    expect(constantTimeTextEqual("short", "shorter")).toBe(false);
  });

  it("bootstraps once, forces setup, then authenticates only from the store", async () => {
    const store = new MemoryUserStore();
    const codex = fakeCodex();
    const router = createAuthRouter(config, codex, store);
    const bootstrap = await login(router, config.appId, config.appSecret);
    expect(bootstrap.response.status).toBe(200);
    expect(await bootstrap.response.json()).toMatchObject({
      ok: true,
      setupRequired: true,
      user: { id: config.appId },
    });

    const blocked = await router.request(`${ORIGIN}/codex/status`, {
      headers: { cookie: bootstrap.cookie ?? "" },
    });
    expect(blocked.status).toBe(428);
    expect(codex.status).not.toHaveBeenCalled();

    const setup = await router.request(`${ORIGIN}/setup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: bootstrap.cookie ?? "",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        username: CUSTOM_USERNAME,
        newPassword: CUSTOM_PASSWORD,
        confirmPassword: CUSTOM_PASSWORD,
      }),
    });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toMatchObject({ setupRequired: false });
    expect(
      decryptUsername(store.record!.usernameEncrypted, config.dataSecret)
    ).toBe(CUSTOM_USERNAME);
    expect(store.record!.passwordHash).not.toContain(CUSTOM_PASSWORD);

    const staleSetupSession = await router.request(`${ORIGIN}/session`, {
      headers: { cookie: bootstrap.cookie ?? "" },
    });
    expect(await staleSetupSession.json()).toMatchObject({
      authenticated: false,
      setupRequired: false,
    });
    expect(staleSetupSession.headers.get("set-cookie")).toContain("Max-Age=0");

    expect(
      (await login(router, config.appId, config.appSecret)).response.status
    ).toBe(401);
    const databaseCredentials = await login(router);
    expect(databaseCredentials.response.status).toBe(200);
    expect(await databaseCredentials.response.json()).toMatchObject({
      setupRequired: false,
      user: { id: CUSTOM_USERNAME },
    });
  });

  it("re-encrypts a legacy username with the independent data key", async () => {
    const legacyAccount: StoredAppUser = {
      ...seededAccount,
      usernameEncrypted: encryptUsername(CUSTOM_USERNAME, config.appSecret),
    };
    const store = new MemoryUserStore(legacyAccount);
    const router = createAuthRouter(config, fakeCodex(), store);

    const authenticated = await login(router);

    expect(authenticated.response.status).toBe(200);
    expect(store.record?.credentialVersion).toBe(2);
    expect(
      decryptUsername(store.record!.usernameEncrypted, config.dataSecret)
    ).toBe(CUSTOM_USERNAME);
    expect(() =>
      decryptUsername(store.record!.usernameEncrypted, config.appSecret)
    ).toThrow("无法解密用户名");
  });

  it("reads a normal session and clears it", async () => {
    const router = createAuthRouter(
      config,
      fakeCodex(),
      new MemoryUserStore(seededAccount)
    );
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
      setupRequired: false,
      user: { id: CUSTOM_USERNAME },
    });
    expect(
      getRequestSession(
        new Request(`${ORIGIN}/anything`, {
          headers: { cookie: cookie ?? "" },
        }),
        config
      )?.userId
    ).toBe(CUSTOM_USERNAME);

    const logoutResponse = await router.request(`${ORIGIN}/logout`, {
      method: "POST",
      headers: { cookie: cookie ?? "", origin: ORIGIN },
    });
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects a wrong stored password and cross-origin login", async () => {
    const router = createAuthRouter(
      config,
      fakeCodex(),
      new MemoryUserStore(seededAccount)
    );
    expect(
      (await login(router, CUSTOM_USERNAME, "wrong-password")).response.status
    ).toBe(401);
    expect(
      (
        await login(
          router,
          CUSTOM_USERNAME,
          CUSTOM_PASSWORD,
          "https://attacker.example"
        )
      ).response.status
    ).toBe(403);
  });

  it("returns 503 instead of falling back when the user store fails", async () => {
    const store = new MemoryUserStore();
    store.fail = true;
    const router = createAuthRouter(config, fakeCodex(), store);
    const result = await login(router, config.appId, config.appSecret);
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toMatchObject({
      error: "auth_store_unavailable",
    });
  });

  it("reads and updates the profile after checking the current password", async () => {
    const store = new MemoryUserStore(seededAccount);
    const router = createAuthRouter(config, fakeCodex(), store);
    const { cookie } = await login(router);
    const profile = await router.request(`${ORIGIN}/profile`, {
      headers: { cookie: cookie ?? "" },
    });
    expect(await profile.json()).toMatchObject({
      user: { id: CUSTOM_USERNAME },
      credentialVersion: 1,
    });

    const rejected = await router.request(`${ORIGIN}/profile`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: "wrong-password",
        username: "新用户名",
      }),
    });
    expect(rejected.status).toBe(401);

    const nextPassword = "another-secure-password";
    const updated = await router.request(`${ORIGIN}/profile`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: CUSTOM_PASSWORD,
        username: "新用户名",
        newPassword: nextPassword,
        confirmPassword: nextPassword,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      user: { id: "新用户名" },
      credentialVersion: 2,
    });
    const staleSession = await router.request(`${ORIGIN}/codex/status`, {
      headers: { cookie: cookie ?? "" },
    });
    expect(staleSession.status).toBe(401);
    expect(staleSession.headers.get("set-cookie")).toContain("Max-Age=0");

    const staleSessionRead = await router.request(`${ORIGIN}/session`, {
      headers: { cookie: cookie ?? "" },
    });
    expect(await staleSessionRead.json()).toMatchObject({
      authenticated: false,
      setupRequired: false,
    });
    expect((await login(router)).response.status).toBe(401);
    expect(
      (await login(router, "新用户名", nextPassword)).response.status
    ).toBe(200);
  });

  it("applies login backoff before another password hash", async () => {
    let now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const passwordVerifier = vi.fn(
      async (password: string) => password === CUSTOM_PASSWORD
    );
    const userStore = new MemoryUserStore(seededAccount);
    const getSingleton = vi.spyOn(userStore, "getSingleton");
    const router = createAuthRouter(
      config,
      fakeCodex(),
      userStore,
      passwordVerifier
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        (await login(router, CUSTOM_USERNAME, "wrong")).response.status
      ).toBe(401);
    }
    const throttled = await login(router, CUSTOM_USERNAME, "wrong");
    expect(throttled.response.status).toBe(429);
    expect(throttled.response.headers.get("retry-after")).toBe("1");
    expect(passwordVerifier).toHaveBeenCalledTimes(5);
    expect(getSingleton).toHaveBeenCalledTimes(5);
    expect((await login(router)).response.status).toBe(429);
    expect(passwordVerifier).toHaveBeenCalledTimes(5);
    expect(getSingleton).toHaveBeenCalledTimes(5);
    now += 1_001;
    expect((await login(router)).response.status).toBe(200);
    expect(passwordVerifier).toHaveBeenCalledTimes(6);
    expect(getSingleton).toHaveBeenCalledTimes(6);
    nowSpy.mockRestore();
  });

  it("isolates login backoff by the trusted socket peer", async () => {
    const router = createAuthRouter(
      config,
      fakeCodex(),
      new MemoryUserStore(seededAccount)
    );
    const peer = (remoteAddress: string) => ({
      incoming: { socket: { remoteAddress } },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(router, CUSTOM_USERNAME, "wrong", ORIGIN, peer("192.0.2.10"));
    }

    expect(
      (
        await login(
          router,
          CUSTOM_USERNAME,
          CUSTOM_PASSWORD,
          ORIGIN,
          peer("192.0.2.11")
        )
      ).response.status
    ).toBe(200);
  });

  it("applies profile backoff before another password hash", async () => {
    let now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const passwordVerifier = vi.fn(
      async (password: string) => password === CUSTOM_PASSWORD
    );
    const userStore = new MemoryUserStore(seededAccount);
    const getSingleton = vi.spyOn(userStore, "getSingleton");
    const router = createAuthRouter(
      config,
      fakeCodex(),
      userStore,
      passwordVerifier
    );
    const { cookie } = await login(router);
    passwordVerifier.mockClear();
    getSingleton.mockClear();

    const updateProfile = (currentPassword: string) =>
      router.request(`${ORIGIN}/profile`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: cookie ?? "",
          origin: ORIGIN,
        },
        body: JSON.stringify({ currentPassword, username: CUSTOM_USERNAME }),
      });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await updateProfile("wrong")).status).toBe(401);
    }
    const throttled = await updateProfile("wrong");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("1");
    expect(passwordVerifier).toHaveBeenCalledTimes(5);

    const readsBeforeCooldown = getSingleton.mock.calls.length;
    expect((await updateProfile(CUSTOM_PASSWORD)).status).toBe(429);
    expect(passwordVerifier).toHaveBeenCalledTimes(5);
    expect(getSingleton).toHaveBeenCalledTimes(readsBeforeCooldown);
    now += 1_001;
    expect((await updateProfile(CUSTOM_PASSWORD)).status).toBe(200);
    expect(passwordVerifier).toHaveBeenCalledTimes(6);
    expect(getSingleton).toHaveBeenCalledTimes(readsBeforeCooldown + 2);
    nowSpy.mockRestore();
  });

  it("caps concurrent profile password hashes", async () => {
    let blockVerification = false;
    const releases: Array<(value: boolean) => void> = [];
    const passwordVerifier = vi.fn((password: string) => {
      if (!blockVerification) {
        return Promise.resolve(password === CUSTOM_PASSWORD);
      }
      return new Promise<boolean>(resolve => releases.push(resolve));
    });
    const router = createAuthRouter(
      config,
      fakeCodex(),
      new MemoryUserStore(seededAccount),
      passwordVerifier
    );
    const { cookie } = await login(router);
    passwordVerifier.mockClear();
    blockVerification = true;
    const updateProfile = () =>
      router.request(`${ORIGIN}/profile`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: cookie ?? "",
          origin: ORIGIN,
        },
        body: JSON.stringify({
          currentPassword: "wrong",
          username: CUSTOM_USERNAME,
        }),
      });

    const first = updateProfile();
    const second = updateProfile();
    await vi.waitFor(() => expect(passwordVerifier).toHaveBeenCalledTimes(2));
    expect((await updateProfile()).status).toBe(429);
    expect(passwordVerifier).toHaveBeenCalledTimes(2);

    releases.forEach(resolve => resolve(false));
    const completed = await Promise.all([first, second]);
    expect(completed.map(response => response.status)).toEqual([401, 401]);
  });

  it("caps concurrent password hashes", async () => {
    const releases: Array<(value: boolean) => void> = [];
    const passwordVerifier = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          releases.push(resolve);
        })
    );
    const router = createAuthRouter(
      config,
      fakeCodex(),
      new MemoryUserStore(seededAccount),
      passwordVerifier
    );

    const first = login(router);
    const second = login(router);
    await vi.waitFor(() => expect(passwordVerifier).toHaveBeenCalledTimes(2));

    const rejected = await login(router);
    expect(rejected.response.status).toBe(429);
    expect(passwordVerifier).toHaveBeenCalledTimes(2);

    releases.forEach(resolve => resolve(false));
    const completed = await Promise.all([first, second]);
    expect(completed.map(result => result.response.status)).toEqual([401, 401]);
  });

  it("does not trust a forged loopback Host and Origin without a session", async () => {
    const request = new Request("http://127.0.0.1:3000/api/v1/events", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
    });
    expect(await verifyBrowserMutationRequest(request, config)).toEqual({
      ok: false,
      status: 401,
    });
  });

  it("accepts a current database-backed same-origin browser mutation", async () => {
    const store = new MemoryUserStore(seededAccount);
    const { token } = createSessionToken(config, Date.now(), {
      userId: CUSTOM_USERNAME,
      credentialVersion: 1,
    });
    const request = new Request(`${ORIGIN}/api/v1/events`, {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(
      await verifyBrowserMutationRequest(request, config, store)
    ).toMatchObject({
      ok: true,
      session: { userId: CUSTOM_USERNAME },
    });
  });

  it("uses only the configured public origin behind a TLS proxy", async () => {
    const publicOrigin = "https://books.example";
    const proxiedConfig: AppAuthConfig = { ...config, publicOrigin };
    const router = createAuthRouter(
      proxiedConfig,
      fakeCodex(),
      new MemoryUserStore(seededAccount)
    );
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
        appId: CUSTOM_USERNAME,
        appSecret: CUSTOM_PASSWORD,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("protects Codex controls until a normal database login", async () => {
    const codex = fakeCodex();
    const router = createAuthRouter(
      config,
      codex,
      new MemoryUserStore(seededAccount)
    );
    expect((await router.request(`${ORIGIN}/codex/status`)).status).toBe(401);
    const { cookie } = await login(router);
    const started = await router.request(`${ORIGIN}/codex/login`, {
      method: "POST",
      headers: { cookie: cookie ?? "", origin: ORIGIN },
    });
    expect(started.status).toBe(202);
    expect(codex.startLogin).toHaveBeenCalledOnce();
  });
});
