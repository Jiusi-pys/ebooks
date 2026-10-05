import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";

const suite = describe.skipIf(process.env.RUN_RUST_MYSQL_MIGRATIONS !== "1");
const source = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const journal = JSON.parse(
  readFileSync(join(source, "meta/_journal.json"), "utf8")
) as { entries: { idx: number; tag: string; when: number }[] };
async function fixture(last: number, fail = false) {
  const directory = await mkdtemp(join(tmpdir(), "shufang-rust-migration-"));
  await mkdir(join(directory, "meta"));
  const entries = journal.entries.filter(entry => entry.idx <= last);
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries })
  );
  for (const entry of entries)
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(directory, `${entry.tag}.sql`)
    );
  if (fail) {
    const entry = entries.find(entry => entry.idx === 15)!;
    const original = readFileSync(
      join(directory, `${entry.tag}.sql`),
      "utf8"
    ).split("--> statement-breakpoint");
    await writeFile(
      join(directory, `${entry.tag}.sql`),
      `${original[0]}
--> statement-breakpoint
SELECT * FROM deliberately_missing_migration_fixture_table;
--> statement-breakpoint
${original.slice(1).join("--> statement-breakpoint")}`
    );
  }
  return directory;
}
async function cleanup(directory: string) {
  if (
    resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
    resolve(directory).startsWith(resolve(tmpdir()) + "\\")
  ) {
    if (basename(directory).startsWith("shufang-rust-migration-")) {
      await rm(directory, { recursive: true });
      return;
    }
  }
  throw new Error("unsafe migration fixture cleanup");
}
for (const start of [-1, 11, 14]) {
  suite(`MySQL 0015 upgrade from ${start}`, () => {
    it("preserves data, applies every intermediate migration and is repeatable", async () => {
      const configured = new URL(process.env.DATABASE_URL ?? "");
      if (!configured.pathname.startsWith("/rust_acceptance_"))
        throw new Error("isolated rust_acceptance database is required");
      const name = `rust_acceptance_migration_${randomUUID().replaceAll("-", "")}`;
      const admin = await createConnection(configured.toString());
      const old = await fixture(start);
      const full = await fixture(15);
      const broken = await fixture(15, true);
      let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
      if (!/^rust_acceptance_migration_[a-f0-9]{32}$/.test(name)) {
        throw new Error("unsafe database cleanup");
      }
      try {
        await admin.query(
          `CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
        );
        configured.pathname = `/${name}`;
        connection = await createConnection(configured.toString());
        const database = drizzle(connection);
        if (start >= 0) {
          await migrate(database, { migrationsFolder: old });
          await connection.query(
            "INSERT INTO app_users(id,username_encrypted,password_hash) VALUES(1,'public-fixture-encrypted','public-fixture-hash')"
          );
        }
        if (start === 14) {
          await expect(
            migrate(database, { migrationsFolder: broken })
          ).rejects.toThrow();
          const [rows] = await connection.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM __drizzle_migrations"
          );
          expect(Number(rows[0].count)).toBe(15);
        }
        await migrate(database, { migrationsFolder: full });
        const [first] = await connection.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS count FROM __drizzle_migrations"
        );
        expect(Number(first[0].count)).toBe(16);
        await migrate(database, { migrationsFolder: full });
        const [repeated] = await connection.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS count FROM __drizzle_migrations"
        );
        expect(repeated).toEqual(first);
        const [tables] = await connection.query<RowDataPacket[]>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('rust_changes','rust_entity_revisions','rust_local_values')"
        );
        expect(tables).toHaveLength(3);
        if (start >= 0) {
          const [users] = await connection.query<RowDataPacket[]>(
            "SELECT username_encrypted,password_hash FROM app_users WHERE id=1"
          );
          expect(users[0]).toMatchObject({
            username_encrypted: "public-fixture-encrypted",
            password_hash: "public-fixture-hash",
          });
        }
      } finally {
        await connection?.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
        await cleanup(old);
        await cleanup(full);
        await cleanup(broken);
      }
    }, 240_000);
  });
}
