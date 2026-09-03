import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  closeDatabaseConnection,
  getAllBooks,
  SHUFANG_DB_VERSION,
  subscribeDatabaseConnectionIssue,
  type DatabaseConnectionIssue,
} from "./db";

function openRawDatabase(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("shufang", version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

describe("IndexedDB connection lifecycle", () => {
  it("closes this tab and surfaces an actionable issue when another tab upgrades", async () => {
    const observed: (DatabaseConnectionIssue | null)[] = [];
    const unsubscribe = subscribeDatabaseConnectionIssue(issue =>
      observed.push(issue)
    );
    await getAllBooks();

    const upgraded = await openRawDatabase(SHUFANG_DB_VERSION + 1);

    expect(observed).toContainEqual(
      expect.objectContaining({
        kind: "connection-closed",
        message: expect.stringContaining("重新加载"),
      })
    );
    upgraded.close();
    closeDatabaseConnection();
    unsubscribe();
  });
});
