import { afterEach, describe, expect, it, vi } from "vitest";
import { bookDigests } from "@db/schema";
import { mirrorBooks } from "@db/mirror-schema";
import { syncEntities, syncHeads } from "@db/sync-schema";
import { saveDigestIfReferenced } from "./book-digest-lifecycle";

const digest = {
  contentHash: "a".repeat(64),
  title: "Book",
  author: "",
  structure: "{}",
  overview: "Overview",
};
function database(
  options: {
    deleted?: boolean;
    removed?: boolean;
    legacy?: boolean;
    fail?: boolean;
  } = {}
) {
  const locks: unknown[] = [];
  const write = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const query = {
        where: vi.fn(() => query),
        limit: vi.fn(() => query),
        for: vi.fn(async () => {
          locks.push(table);
          if (options.fail) throw new Error("database unavailable");
          if (table === syncHeads) return [{ workspace: "workspace-a" }];
          if (table === syncEntities)
            return [
              {
                state: JSON.stringify({
                  id: "book-1",
                  kind: "books",
                  deleted: options.deleted ?? false,
                  fields: {
                    contentHash: {
                      version: "1",
                      value: digest.contentHash,
                      removed: options.removed,
                    },
                  },
                }),
              },
            ];
          return table === mirrorBooks && options.legacy
            ? [{ extId: "book-1" }]
            : [];
        }),
      };
      return query;
    },
  }));
  return {
    client: {
      select,
      insert: () => ({ values: () => ({ onDuplicateKeyUpdate: write }) }),
    } as unknown as Parameters<typeof saveDigestIfReferenced>[0],
    locks,
    write,
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("digest ownership in the active book store", () => {
  it("saves a synced book absent from the legacy mirror and locks the sync head first", async () => {
    vi.stubEnv("SYNC_ENABLED", "true");
    vi.stubEnv("SYNC_WORKSPACE_ID", "workspace-a");
    const db = database();
    expect(await saveDigestIfReferenced(db.client, digest)).toBe(true);
    expect(db.locks).toEqual([syncHeads, syncEntities, bookDigests]);
    expect(db.write).toHaveBeenCalledOnce();
  });
  it.each([{ deleted: true }, { removed: true }])(
    "rejects deleted or removed sync ownership despite a stale mirror: %j",
    async options => {
      vi.stubEnv("SYNC_ENABLED", "true");
      vi.stubEnv("SYNC_WORKSPACE_ID", "workspace-a");
      const db = database({ ...options, legacy: true });
      expect(await saveDigestIfReferenced(db.client, digest)).toBe(false);
      expect(db.write).not.toHaveBeenCalled();
    }
  );
  it("keeps legacy ownership when sync is disabled", async () => {
    vi.stubEnv("SYNC_ENABLED", "false");
    const db = database({ legacy: true });
    expect(await saveDigestIfReferenced(db.client, digest)).toBe(true);
    expect(db.locks).toEqual([mirrorBooks, bookDigests]);
  });
  it("propagates database failures without writing a cache", async () => {
    vi.stubEnv("SYNC_ENABLED", "true");
    vi.stubEnv("SYNC_WORKSPACE_ID", "workspace-a");
    const db = database({ fail: true });
    await expect(saveDigestIfReferenced(db.client, digest)).rejects.toThrow(
      "database unavailable"
    );
    expect(db.write).not.toHaveBeenCalled();
  });
});
