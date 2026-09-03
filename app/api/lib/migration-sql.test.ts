import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url)
);

function readMigration(name: string): string {
  return readFileSync(`${migrationsDirectory}/${name}.sql`, "utf8");
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
