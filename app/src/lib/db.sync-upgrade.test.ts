import "fake-indexeddb/auto";
import { openDB, deleteDB } from "idb";
import { expect, it } from "vitest";
import { closeDatabaseConnection, getAllNotes, syncDatabase, SHUFANG_DB_VERSION } from "./db";

it("upgrades a populated v7 database without replacing local records", async () => {
  const old = await openDB("shufang", 7, { upgrade(db) {
    for (const name of ["books", "notes", "files", "highlights", "translations", "mindMaps", "folders", "studySets"]) db.createObjectStore(name, { keyPath: "id" });
    db.createObjectStore("metadata", { keyPath: "key" });
    db.createObjectStore("associations", { keyPath: "id" }).createIndex("by-pair", "pairKey", { unique: true });
  } });
  const note = { id: "before-upgrade", title: "Local draft", content: "Unsent", createdAt: 1, updatedAt: 2 };
  await old.put("notes", note); old.close();
  expect(await getAllNotes()).toEqual([note]);
  const upgraded = await syncDatabase();
  expect(upgraded.version).toBe(SHUFANG_DB_VERSION);
  expect(upgraded.objectStoreNames.contains("syncOutbox")).toBe(true);
  expect(upgraded.transaction("associations").store.index("by-pair").unique).toBe(false);
  closeDatabaseConnection(); await deleteDB("shufang");
});
