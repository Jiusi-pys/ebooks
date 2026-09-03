import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Association, TextPassageAnchor } from "@/types";
import { associationPairKey } from "./associations";
import {
  addAssociationIfAbsent,
  deleteAssociation,
  getAllAssociations,
} from "./db";

const source: TextPassageAnchor = {
  kind: "text",
  bookId: "source-book",
  chapterId: "source-chapter",
  chapterTitle: "Source",
  text: "source passage",
  paraIndex: 1,
  start: 0,
  end: 6,
};

const target: TextPassageAnchor = {
  kind: "text",
  bookId: "target-book",
  chapterId: "target-chapter",
  chapterTitle: "Target",
  text: "target passage",
  paraIndex: 2,
  start: 3,
  end: 9,
};

function candidate(id: string, timestamp: number): Association {
  return {
    id,
    source,
    target,
    direction: "bidirectional",
    label: `candidate ${id}`,
    pairKey: associationPairKey(source, target),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("atomic association creation", () => {
  beforeEach(async () => {
    const stored = await getAllAssociations();
    await Promise.all(stored.map(item => deleteAssociation(item.id)));
  });

  it("returns the persisted canonical record for an existing pair", async () => {
    const first = await addAssociationIfAbsent(candidate("canonical", 1));
    const duplicate = await addAssociationIfAbsent(candidate("duplicate", 2));

    expect(first).toEqual({
      association: candidate("canonical", 1),
      created: true,
    });
    expect(duplicate).toEqual({
      association: candidate("canonical", 1),
      created: false,
    });
    expect(await getAllAssociations()).toEqual([candidate("canonical", 1)]);
  });

  it("converges concurrent callers on one stored record", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        addAssociationIfAbsent(candidate(`candidate-${index}`, index + 1))
      )
    );

    const created = results.filter(result => result.created);
    expect(created).toHaveLength(1);
    expect(
      results.every(
        result => result.association.id === created[0].association.id
      )
    ).toBe(true);
    expect(await getAllAssociations()).toEqual([created[0].association]);
  });
});
