import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url)
);

function readMigration(name: string): string {
  return readFileSync(`${migrationsDirectory}/${name}.sql`, "utf8");
}

function readMigrationJson(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(`${migrationsDirectory}/meta/${name}`, "utf8")
  ) as Record<string, unknown>;
}

function executableStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map(statement => statement.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

function expectBalancedPreparedStatements(sql: string): void {
  const count = (pattern: RegExp) => sql.match(pattern)?.length ?? 0;
  const guards = count(/SET @shufang_migration_sql = IF\(/g);

  expect(guards).toBeGreaterThan(0);
  expect(count(/^PREPARE shufang_migration_stmt/gm)).toBe(guards);
  expect(count(/^EXECUTE shufang_migration_stmt/gm)).toBe(guards);
  expect(count(/^DEALLOCATE PREPARE shufang_migration_stmt/gm)).toBe(guards);
}

function expectColumnGuard(sql: string, column: string): void {
  expect(sql).toMatch(
    new RegExp(
      String.raw`FROM \`information_schema\`\.\`COLUMNS\`[\s\S]*?AND \`COLUMN_NAME\` = '${column}'[\s\S]*?'SELECT 1',[\s\S]*?'ALTER TABLE \`mirror_highlights\` ADD \`${column}\``
    )
  );
}

function expectIndexGuard(sql: string, table: string, index: string): void {
  expect(sql).toMatch(
    new RegExp(
      String.raw`FROM \`information_schema\`\.\`STATISTICS\`[\s\S]*?AND \`TABLE_NAME\` = '${table}'[\s\S]*?AND \`INDEX_NAME\` = '${index}'[\s\S]*?'SELECT 1',[\s\S]*?'CREATE INDEX \`${index}\` ON \`${table}\``
    )
  );
}

describe("legacy db:push migration compatibility", () => {
  it("makes bootstrap table creation safe when the tables already exist", () => {
    for (const name of [
      "0000_highlight_citation_hierarchy",
      "0001_mirror_associations",
      "0003_many_solo",
      "0004_redundant_phil_sheldon",
      "0005_remarkable_piledriver",
      "0007_mushy_miss_america",
      "0008_funny_pandemic",
      "0009_lyrical_thena",
      "0010_reconcile_migration_drift",
      "0011_cleanup_false_note_quarantine",
    ]) {
      const createTableStatements = executableStatements(
        readMigration(name)
      ).filter(statement => /^CREATE TABLE\b/i.test(statement));

      expect(createTableStatements.length).toBeGreaterThan(0);
      for (const statement of createTableStatements) {
        expect(statement).toMatch(/^CREATE TABLE IF NOT EXISTS\b/i);
      }
    }
  });

  it("guards every citation column and index before executing its DDL", () => {
    const sql = readMigration("0000_highlight_citation_hierarchy");

    for (const column of [
      "citation_level",
      "chapter_id",
      "para_index",
      "start_offset",
      "end_offset",
      "pdf_anchor",
    ]) {
      expectColumnGuard(sql, column);
    }
    expectIndexGuard(sql, "mirror_highlights", "idx_mirror_hl_chapter");
    expectBalancedPreparedStatements(sql);
  });

  it("guards association and upload indexes created by legacy db:push", () => {
    const associationSql = readMigration("0001_mirror_associations");
    const uploadSql = readMigration("0003_many_solo");
    const receiptSql = readMigration("0004_redundant_phil_sheldon");

    expectIndexGuard(
      associationSql,
      "mirror_associations",
      "idx_mirror_assoc_source_book"
    );
    expectIndexGuard(
      associationSql,
      "mirror_associations",
      "idx_mirror_assoc_target_book"
    );
    expectIndexGuard(
      uploadSql,
      "mirror_book_upload_chunks",
      "idx_mirror_book_uploads_updated"
    );
    expectIndexGuard(
      receiptSql,
      "mirror_event_receipts",
      "idx_mirror_event_receipts_created"
    );
    expectBalancedPreparedStatements(associationSql);
    expectBalancedPreparedStatements(uploadSql);
    expectBalancedPreparedStatements(receiptSql);
  });

  it("contains no unguarded top-level ADD COLUMN or CREATE INDEX statement", () => {
    for (const name of [
      "0000_highlight_citation_hierarchy",
      "0001_mirror_associations",
      "0003_many_solo",
      "0004_redundant_phil_sheldon",
      "0005_remarkable_piledriver",
      "0006_worthless_the_hood",
      "0007_mushy_miss_america",
      "0008_funny_pandemic",
      "0009_lyrical_thena",
      "0010_reconcile_migration_drift",
      "0011_cleanup_false_note_quarantine",
      "0012_add_highlight_name",
    ]) {
      const statements = executableStatements(readMigration(name));

      expect(
        statements.filter(statement =>
          /^(?:ALTER TABLE\b[\s\S]*?\bADD\b|CREATE INDEX\b)/i.test(statement)
        )
      ).toEqual([]);
    }
  });
});

describe("mirror integrity migration", () => {
  it("widens digests and repairs note and digest references before adding the FK", () => {
    const sql = readMigration("0008_funny_pandemic");

    expect(sql).toMatch(
      /ALTER TABLE `book_digests` MODIFY COLUMN `overview` longtext/i
    );
    expect(sql).toMatch(
      /ALTER TABLE `mirror_highlights` MODIFY COLUMN `note_ext_id` varchar\(64\)/i
    );
    expect(sql).toMatch(
      /SET h\.`note_ext_id` = NULL WHERE h\.`note_ext_id` IS NOT NULL AND \(h\.`note_ext_id` = '' OR n\.`ext_id` IS NULL\)/i
    );
    expect(
      sql.match(
        /h\.`note_ext_id` IS NOT NULL AND \(h\.`note_ext_id` = '' OR n\.`ext_id` IS NULL\)/gi
      )
    ).toHaveLength(2);
    expect(sql).toMatch(
      /ALTER TABLE `mirror_notes` ADD `client_updated_at` bigint DEFAULT 0 NOT NULL/i
    );
    expect(sql).toMatch(
      /DELETE d FROM `book_digests` d LEFT JOIN `mirror_books` b[\s\S]*?WHERE b\.`ext_id` IS NULL/i
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(`note_ext_id`\) REFERENCES `mirror_notes`\(`ext_id`\) ON DELETE set null ON UPDATE cascade/i
    );
    expect(sql.indexOf("_migration_0008_invalid_note_highlights")).toBeLessThan(
      sql.indexOf("SET h.`note_ext_id` = NULL")
    );
    expect(sql.indexOf("_migration_0008_orphan_book_digests")).toBeLessThan(
      sql.indexOf("DELETE d FROM `book_digests`")
    );
    expectBalancedPreparedStatements(sql);
  });

  it("makes every new conditional DDL migration restartable", () => {
    for (const name of [
      "0006_worthless_the_hood",
      "0007_mushy_miss_america",
      "0008_funny_pandemic",
      "0012_add_highlight_name",
    ]) {
      expectBalancedPreparedStatements(readMigration(name));
    }

    const integritySql = readMigration("0007_mushy_miss_america");
    for (const table of [
      "mirror_highlights",
      "mirror_translations",
      "mirror_mindmaps",
      "mirror_associations",
    ]) {
      expect(integritySql).toContain(
        `_migration_0007_orphan_${table.replace("mirror_", "")}`
      );
    }
    expect(
      integritySql.indexOf("_migration_0007_orphan_highlights")
    ).toBeLessThan(integritySql.indexOf("DELETE h FROM `mirror_highlights`"));
  });

  it("reconciles already-applied 0005-0009 installations exactly once", () => {
    const sql = readMigration("0010_reconcile_migration_drift");
    const journal = readMigrationJson("_journal.json") as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const prior = journal.entries.find(entry => entry.idx === 9);
    const reconciliation = journal.entries.find(entry => entry.idx === 10);

    expect(prior?.tag).toBe("0009_lyrical_thena");
    expect(reconciliation?.tag).toBe("0010_reconcile_migration_drift");
    expect(reconciliation!.when).toBeGreaterThan(prior!.when);
    expect(
      journal.entries
        .filter(
          entry =>
            entry.when > prior!.when && entry.when <= reconciliation!.when
        )
        .map(entry => entry.tag)
    ).toEqual(["0010_reconcile_migration_drift"]);

    const previousSnapshot = readMigrationJson("0009_snapshot.json");
    const reconciliationSnapshot = readMigrationJson("0010_snapshot.json");
    expect(reconciliationSnapshot.prevId).toBe(previousSnapshot.id);

    for (const table of [
      "highlights",
      "translations",
      "mindmaps",
      "associations",
    ]) {
      const quarantine = `_migration_0007_orphan_${table}`;
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS \`${quarantine}\``);
      expect(sql.indexOf(`INSERT IGNORE INTO \`${quarantine}\``)).toBeLessThan(
        sql.indexOf(`DELETE ${table === "associations" ? "a" : table[0]}`)
      );
    }
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `app_users`");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS `mirror_book_tombstones`"
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS `mirror_note_tombstones`"
    );
    expect(sql).toContain(
      "h.`note_ext_id` IS NOT NULL AND (h.`note_ext_id` = '' OR n.`ext_id` IS NULL)"
    );
    const discardFalsePositive =
      "DELETE FROM `_migration_0008_invalid_note_highlights` WHERE `note_ext_id` IS NULL";
    const preserveRealOrphans =
      "INSERT IGNORE INTO `_migration_0008_invalid_note_highlights`";
    expect(sql).toContain(discardFalsePositive);
    expect(sql.indexOf(discardFalsePositive)).toBeLessThan(
      sql.indexOf(preserveRealOrphans)
    );
    expect(sql).not.toContain(
      "DELETE FROM `_migration_0008_invalid_note_highlights` WHERE `note_ext_id` = ''"
    );
    expectBalancedPreparedStatements(sql);
    expect(
      executableStatements(sql).filter(statement =>
        /^(?:ALTER TABLE\b[\s\S]*?\bADD\b|CREATE INDEX\b)/i.test(statement)
      )
    ).toEqual([]);
  });

  it("forward-cleans legacy NULL quarantine copies exactly once", () => {
    const sql = readMigration("0011_cleanup_false_note_quarantine");
    const journal = readMigrationJson("_journal.json") as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const reconciliation = journal.entries.find(entry => entry.idx === 10);
    const cleanup = journal.entries.find(entry => entry.idx === 11);

    expect(reconciliation?.tag).toBe("0010_reconcile_migration_drift");
    expect(cleanup?.tag).toBe("0011_cleanup_false_note_quarantine");
    expect(cleanup!.when).toBeGreaterThan(reconciliation!.when);
    expect(
      journal.entries
        .filter(
          entry =>
            entry.when > reconciliation!.when && entry.when <= cleanup!.when
        )
        .map(entry => entry.tag)
    ).toEqual(["0011_cleanup_false_note_quarantine"]);

    const previousSnapshot = readMigrationJson("0010_snapshot.json");
    const cleanupSnapshot = readMigrationJson("0011_snapshot.json");
    expect(cleanupSnapshot.prevId).toBe(previousSnapshot.id);

    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS `_migration_0008_invalid_note_highlights`"
    );
    expect(sql).toContain(
      "DELETE FROM `_migration_0008_invalid_note_highlights` WHERE `note_ext_id` IS NULL"
    );
    expect(sql).not.toMatch(
      /DELETE FROM `_migration_0008_invalid_note_highlights`[\s\S]*?`note_ext_id`\s*=\s*''/i
    );
    expect(sql).not.toMatch(
      /DELETE FROM `_migration_0008_invalid_note_highlights`[\s\S]*?`note_ext_id`\s+IS NOT NULL/i
    );
  });

  it("adds the nullable highlight name column exactly once", () => {
    const sql = readMigration("0012_add_highlight_name");
    const journal = readMigrationJson("_journal.json") as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const cleanup = journal.entries.find(entry => entry.idx === 11);
    const addition = journal.entries.find(entry => entry.idx === 12);

    expect(cleanup?.tag).toBe("0011_cleanup_false_note_quarantine");
    expect(addition?.tag).toBe("0012_add_highlight_name");
    expect(addition!.when).toBeGreaterThan(cleanup!.when);
    expect(
      journal.entries
        .filter(entry => entry.when > cleanup!.when)
        .map(entry => entry.tag)
    ).toEqual(["0012_add_highlight_name"]);
    expect(
      journal.entries.filter(entry => entry.when > addition!.when)
    ).toEqual([]);

    const previousSnapshot = readMigrationJson("0011_snapshot.json");
    const additionSnapshot = readMigrationJson("0012_snapshot.json") as {
      prevId: unknown;
      tables: {
        mirror_highlights: {
          columns: { name: { type: string; notNull: boolean } };
        };
      };
    };
    expect(additionSnapshot.prevId).toBe(previousSnapshot.id);
    expect(additionSnapshot.tables.mirror_highlights.columns.name).toEqual(
      expect.objectContaining({ type: "varchar(255)", notNull: false })
    );

    expectColumnGuard(sql, "name");
    expect(sql).toContain(
      "ALTER TABLE `mirror_highlights` ADD `name` varchar(255) NULL"
    );
    expectBalancedPreparedStatements(sql);
    expect(
      executableStatements(sql).filter(statement =>
        /^(?:ALTER TABLE\b[\s\S]*?\bADD\b|CREATE INDEX\b)/i.test(statement)
      )
    ).toEqual([]);
  });
});
