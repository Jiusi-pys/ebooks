import { beforeEach, expect, it, vi } from "vitest";
import type { Book } from "@/types";
const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  openPdfDocument: vi.fn(),
}));
vi.mock("./db", () => ({ getFile: mocks.getFile }));
vi.mock("./pdfjs", () => ({ openPdfDocument: mocks.openPdfDocument }));
import { searchPdfPages } from "./searchPdf";

beforeEach(() => vi.resetAllMocks());
const book = { id: "pdf" } as Book;
it("joins split Chinese text and releases pages and worker", async () => {
  mocks.getFile.mockResolvedValue({ data: new ArrayBuffer(1) });
  const cleanup = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  mocks.openPdfDocument.mockReturnValue({
    destroy,
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        cleanup,
        getTextContent: async () => ({
          items: [
            { str: "全局", hasEOL: false },
            { str: "搜索", hasEOL: true },
          ],
        }),
      }),
    }),
  });
  const pages = [];
  for await (const page of searchPdfPages(book)) pages.push(page);
  expect(pages).toEqual([{ page: 1, text: "全局搜索\n" }]);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
});
it("reports missing files", async () => {
  mocks.getFile.mockResolvedValue(undefined);
  await expect(searchPdfPages(book).next()).rejects.toThrow("原始 PDF");
});
it("releases the worker when text extraction fails", async () => {
  mocks.getFile.mockResolvedValue({ data: new ArrayBuffer(1) });
  const destroy = vi.fn().mockResolvedValue(undefined);
  const cleanup = vi.fn();
  mocks.openPdfDocument.mockReturnValue({
    destroy,
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        cleanup,
        getTextContent: async () => {
          throw new Error("bad page");
        },
      }),
    }),
  });
  await expect(searchPdfPages(book).next()).rejects.toThrow("bad page");
  expect(cleanup).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
});
