import "dotenv/config";

import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import { describe, expect, it } from "vitest";

const runMysqlFixture = process.env.RUN_MYSQL_MIGRATION_FIXTURE === "1";
const suite = describe.skipIf(!runMysqlFixture);
const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url)
);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

function journalEntry(idx: number): JournalEntry {
  const journal = JSON.parse(
    readFileSync(`${migrationsDirectory}/meta/_journal.json`, "utf8")
  ) as MigrationJournal;
  const entry = journal.entries.find(candidate => candidate.idx === idx);
  if (!entry) throw new Error(`migration journal entry ${idx} is missing`);
  return entry;
}

async function removeFixtureDirectory(directory: string): Promise<void> {
  const resolvedTarget = resolve(directory);
  const resolvedTempRoot = resolve(tmpdir());
  const tempRelativePath = relative(resolvedTempRoot, resolvedTarget);
  const isFixtureDirectory =
    tempRelativePath.length > 0 &&
    !tempRelativePath.startsWith("..") &&
    !isAbsolute(tempRelativePath) &&
    basename(resolvedTarget).startsWith("shufang-migration-fixture-");
  if (!isFixtureDirectory) {
    throw new Error("refusing to remove an unsafe fixture path");
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

async function migrationsThrough0011(): Promise<string> {
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "shufang-migration-fixture-")
  );
  try {
    const metaDirectory = join(fixtureDirectory, "meta");
    await mkdir(metaDirectory);
    const journal = JSON.parse(
      readFileSync(`${migrationsDirectory}/meta/_journal.json`, "utf8")
    ) as MigrationJournal;
    const entries = journal.entries.filter(
      entry => entry.idx >= 10 && entry.idx <= 11
    );
    await writeFile(
      join(metaDirectory, "_journal.json"),
      JSON.stringify({ ...journal, entries }),
      "utf8"
    );
    await Promise.all(
      entries.map(entry =>
        copyFile(
          join(migrationsDirectory, `${entry.tag}.sql`),
          join(fixtureDirectory, `${entry.tag}.sql`)
        )
      )
    );
    return fixtureDirectory;
  } catch (error) {
    await removeFixtureDirectory(fixtureDirectory);
    throw error;
  }
}

async function persistentState(
  connection: Awaited<ReturnType<typeof createConnection>>
) {
  const [journalRows] = await connection.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS `count`, MAX(`created_at`) AS `latest` FROM `__drizzle_migrations`"
  );
  const [quarantineRows] = await connection.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS `count`, COALESCE(SUM(`note_ext_id` IS NULL), 0) AS `null_count`, COALESCE(SUM(`note_ext_id` = ''), 0) AS `empty_count` FROM `_migration_0008_invalid_note_highlights`"
  );
  return {
    journalCount: Number(journalRows[0]?.count),
    journalLatest: Number(journalRows[0]?.latest),
    quarantineCount: Number(quarantineRows[0]?.count),
    quarantineNullCount: Number(quarantineRows[0]?.null_count),
    quarantineEmptyCount: Number(quarantineRows[0]?.empty_count),
  };
}

suite("migration 0011 MySQL upgrade fixture", () => {
  it("removes only legacy NULL false positives and is a second-run no-op", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");

    const prior = journalEntry(10);
    const cleanup = journalEntry(11);
    const fixtureMigrationsDirectory = await migrationsThrough0011();
    let connection: Connection | undefined;
    try {
      connection = await createConnection(databaseUrl);
      const beforePersistent = await persistentState(connection);

      // Temporary tables shadow their persistent names for this connection.
      // This exercises the real MySQL migration without changing app data or
      // the persistent Drizzle journal.
      await connection.query(
        "CREATE TEMPORARY TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY, `hash` text NOT NULL, `created_at` bigint)"
      );
      await connection.query(
        "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        ["fixture-0010", prior.when]
      );
      await connection.query(
        "CREATE TEMPORARY TABLE `_migration_0008_invalid_note_highlights` LIKE `mirror_highlights`"
      );
      await connection.query(
        "INSERT INTO `_migration_0008_invalid_note_highlights` (`ext_id`, `book_ext_id`, `text`, `note_ext_id`) VALUES ('false-null', 'fixture-book', 'A', NULL), ('real-empty', 'fixture-book', 'B', ''), ('real-missing', 'fixture-book', 'C', 'missing-note')"
      );

      const database = drizzle(connection);
      await migrate(database, {
        migrationsFolder: fixtureMigrationsDirectory,
      });

      const [afterRows] = await connection.query<RowDataPacket[]>(
        "SELECT `ext_id`, `note_ext_id` FROM `_migration_0008_invalid_note_highlights` ORDER BY `ext_id`"
      );
      expect(afterRows.map(row => [row.ext_id, row.note_ext_id])).toEqual([
        ["real-empty", ""],
        ["real-missing", "missing-note"],
      ]);
      const [firstJournal] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS `count`, MAX(`created_at`) AS `latest` FROM `__drizzle_migrations`"
      );
      expect(Number(firstJournal[0]?.count)).toBe(2);
      expect(Number(firstJournal[0]?.latest)).toBe(cleanup.when);

      await migrate(database, {
        migrationsFolder: fixtureMigrationsDirectory,
      });
      const [secondJournal] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS `count`, MAX(`created_at`) AS `latest` FROM `__drizzle_migrations`"
      );
      expect(Number(secondJournal[0]?.count)).toBe(2);
      expect(Number(secondJournal[0]?.latest)).toBe(cleanup.when);

      await connection.query(
        "DROP TEMPORARY TABLE `_migration_0008_invalid_note_highlights`, `__drizzle_migrations`"
      );
      expect(await persistentState(connection)).toEqual(beforePersistent);
    } finally {
      await connection?.end().catch(() => undefined);
      await removeFixtureDirectory(fixtureMigrationsDirectory);
    }
  }, 60_000);
});
