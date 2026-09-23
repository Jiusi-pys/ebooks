import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedBook } from "./parseBook";

const parserMocks = vi.hoisted(() => ({
  epub: vi.fn(),
  fb2: vi.fn(),
  mobi: vi.fn(),
  pdf: vi.fn(),
  txt: vi.fn(),
}));

vi.mock("./parseEpub", () => ({ parseEpub: parserMocks.epub }));
vi.mock("./parseFb2", () => ({ parseFb2: parserMocks.fb2 }));
vi.mock("./parseMobi", () => ({ parseMobi: parserMocks.mobi }));
vi.mock("./parsePdf", () => ({ parsePdf: parserMocks.pdf }));
vi.mock("./parseTxt", () => ({ parseTxt: parserMocks.txt }));

import { parseBookFile } from "./parseBook";

const parsedBook: ParsedBook = {
  title: "测试书籍",
  author: "测试作者",
  chapters: [],
};

describe("parseBookFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const parser of Object.values(parserMocks)) {
      parser.mockResolvedValue(parsedBook);
    }
  });

  it.each([
    ["pdf", "pdf"],
    ["epub", "epub"],
    ["mobi", "mobi"],
    ["azw3", "mobi"],
    ["fb2", "fb2"],
    ["txt", "txt"],
  ] as const)(
    "routes %s files through the %s parser",
    async (format, parser) => {
      const file = { name: `book.${format}` } as File;
      const onProgress = vi.fn();

      await expect(
        parseBookFile(file, format, onProgress, { pdfMode: "original" })
      ).resolves.toBe(parsedBook);

      expect(parserMocks[parser]).toHaveBeenCalledOnce();
      if (format === "pdf") {
        expect(parserMocks.pdf).toHaveBeenCalledWith(
          file,
          onProgress,
          "original"
        );
      } else if (format === "mobi" || format === "azw3") {
        expect(parserMocks.mobi).toHaveBeenCalledWith(file, format, onProgress);
      } else {
        expect(parserMocks[parser]).toHaveBeenCalledWith(file, onProgress);
      }
    }
  );
});
