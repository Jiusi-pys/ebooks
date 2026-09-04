import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./router";
import type { TrpcContext } from "./context";

function context(overrides: Partial<TrpcContext> = {}): TrpcContext {
  return {
    req: new Request("http://reader.test/api/trpc/ping"),
    resHeaders: new Headers(),
    session: null,
    authStoreUnavailable: false,
    sameOrigin: false,
    ...overrides,
  };
}

describe("tRPC authentication middleware", () => {
  it("fails closed when the credential store is unavailable", async () => {
    await expect(
      appRouter.createCaller(context({ authStoreUnavailable: true })).ping()
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects an anonymous caller", async () => {
    await expect(
      appRouter.createCaller(context()).ping()
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    } satisfies Partial<TRPCError>);
  });

  it("allows an authenticated safe query", async () => {
    const result = await appRouter
      .createCaller(
        context({
          session: {
            userId: "owner",
            issuedAt: 1,
            expiresAt: 2,
            setupRequired: false,
            credentialVersion: 1,
          },
        })
      )
      .ping();
    expect(result.ok).toBe(true);
  });

  it("rejects an authenticated cross-origin POST", async () => {
    const caller = appRouter.createCaller(
      context({
        req: new Request("http://reader.test/api/trpc/ping", {
          method: "POST",
        }),
        session: {
          userId: "owner",
          issuedAt: 1,
          expiresAt: 2,
          setupRequired: false,
          credentialVersion: 1,
        },
      })
    );
    await expect(caller.ping()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a first-run setup session", async () => {
    await expect(
      appRouter
        .createCaller(
          context({
            session: {
              userId: "bootstrap",
              issuedAt: 1,
              expiresAt: 2,
              setupRequired: true,
              credentialVersion: 0,
            },
          })
        )
        .ping()
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
