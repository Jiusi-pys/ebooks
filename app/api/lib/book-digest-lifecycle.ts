import { and, eq } from "drizzle-orm";

import { bookDigests } from "@db/schema";
import { mirrorBooks } from "@db/mirror-schema";
import { syncEntities, syncHeads } from "@db/sync-schema";
import { materialize, type EntityState } from "@contracts/sync";
import { getDb } from "../queries/connection";

type DatabaseClient = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];
type DatabaseExecutor = Pick<
  DatabaseClient | DatabaseTransaction,
  "select" | "insert" | "delete"
>;

export interface DigestSnapshot {
  contentHash: string;
  title: string;
  author: string;
  structure: string;
  overview: string | null;
}

/**
 * Persist a digest only while the active book store still owns its hash.
 * Lock the owner before the digest row, matching the deletion path: if AI
 * generation finishes after a deletion, it observes no owner and cannot
 * recreate an orphaned database cache.
 */
export async function saveDigestIfReferenced(
  database: DatabaseExecutor,
  digest: DigestSnapshot
): Promise<boolean> {
  if (!digest.contentHash) return false;
  if (process.env.SYNC_ENABLED === "true") {
    const workspace = process.env.SYNC_WORKSPACE_ID;
    if (!workspace) throw new Error("SYNC_WORKSPACE_ID is required");
    // SyncStore.accept takes this same lock before imports, updates and
    // tombstones. A delayed AI response must inspect the committed sync state,
    // never fall back to legacy rows left behind by the migration.
    const heads = await database
      .select({ workspace: syncHeads.workspace })
      .from(syncHeads)
      .where(eq(syncHeads.workspace, workspace))
      .limit(1)
      .for("update");
    if (heads.length === 0) return false;
    const books = await database
      .select({ state: syncEntities.state })
      .from(syncEntities)
      .where(
        and(
          eq(syncEntities.workspace, workspace),
          eq(syncEntities.kind, "books")
        )
      )
      .for("update");
    const referenced = books.some(row => {
      const book = materialize(JSON.parse(row.state) as EntityState);
      return book?.contentHash === digest.contentHash;
    });
    if (!referenced) return false;
  } else {
    const owners = await database
      .select({ extId: mirrorBooks.extId })
      .from(mirrorBooks)
      .where(eq(mirrorBooks.contentHash, digest.contentHash))
      .limit(1)
      .for("update");
    if (owners.length === 0) return false;
  }

  await database
    .select({ contentHash: bookDigests.contentHash })
    .from(bookDigests)
    .where(eq(bookDigests.contentHash, digest.contentHash))
    .limit(1)
    .for("update");
  await database
    .insert(bookDigests)
    .values(digest)
    .onDuplicateKeyUpdate({
      set: {
        title: digest.title,
        author: digest.author,
        structure: digest.structure,
        overview: digest.overview,
      },
    });
  return true;
}

/** Delete a digest only after locking it and proving no mirrored book uses it. */
export async function deleteDigestIfUnreferenced(
  database: DatabaseExecutor,
  contentHash: string
): Promise<boolean> {
  if (!contentHash) return false;
  // Callers already hold the affected book row. Serialize contenders through
  // the digest row; deadlocks across two final-book deletions are retried by
  // the enclosing mirror transaction.
  await database
    .select({ contentHash: bookDigests.contentHash })
    .from(bookDigests)
    .where(eq(bookDigests.contentHash, contentHash))
    .limit(1)
    .for("update");
  const remaining = await database
    .select({ extId: mirrorBooks.extId })
    .from(mirrorBooks)
    .where(eq(mirrorBooks.contentHash, contentHash))
    .limit(1)
    .for("update");
  if (remaining.length > 0) return false;
  await database
    .delete(bookDigests)
    .where(eq(bookDigests.contentHash, contentHash));
  return true;
}
