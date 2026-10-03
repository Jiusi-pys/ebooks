import { sharedCore } from "./core-runtime";
import type { Folder, Note, StudySet } from "./domain";

type RecordTypes = { notes: Note; folders: Folder; studySets: StudySet };
/** Storage, IDs and clock are host ports; record rules run in application WASM. */
export function createCoreRecord<K extends keyof RecordTypes>(
  kind: K,
  id: string,
  name: string,
  createdAt: number,
  updatedAt = createdAt
): RecordTypes[K] {
  return JSON.parse(
    sharedCore().execute<string>("createLibraryRecord", {
      kind,
      id,
      nameJson: JSON.stringify(name),
      createdAt,
      updatedAt,
    })
  ) as RecordTypes[K];
}
export function normalizeCoreStudySet(value: StudySet, now: number): StudySet {
  return JSON.parse(
    sharedCore().execute<string>("normalizeStudySet", {
      recordJson: JSON.stringify(value),
      now,
    })
  ) as StudySet;
}
