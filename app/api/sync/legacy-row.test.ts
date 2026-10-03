import { expect, it } from "vitest";
import { camelLegacyRow } from "./legacy-row";

it("maps all four association offsets to the stored anchor contract", () => {
  expect(
    camelLegacyRow({
      source_start_offset: 1,
      source_end_offset: 3,
      target_start_offset: 2,
      target_end_offset: 4,
      source_para_index: 0,
    })
  ).toEqual({
    sourceStart: 1,
    sourceEnd: 3,
    targetStart: 2,
    targetEnd: 4,
    sourceParaIndex: 0,
  });
});
