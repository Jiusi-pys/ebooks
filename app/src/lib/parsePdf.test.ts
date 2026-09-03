import { beforeEach, describe, expect, it, vi } from "vitest";

import { openPdfDocument } from "./pdfjs";
import { parsePdf } from "./parsePdf";

vi.mock("./pdfjs", () => ({
  openPdfDocument: vi.fn(),
  pdfjs: {},
}));

function fakePdfFile(): File {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  return {
    name: "metadata-only.pdf",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as File;
}

describe("parsePdf", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
        toDataURL: () => "data:image/jpeg;base64,cover",
      }),
    });
  });

  it("skips outline and text extraction in original-layout mode", async () => {
    const streamTextContent = vi.fn();
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 400 * scale,
        height: 600 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      streamTextContent,
    };
    const doc = {
      numPages: 900,
      getMetadata: vi.fn(async () => ({
        info: { Title: "原版测试", Author: "作者" },
      })),
      getPage: vi.fn(async () => page),
      getOutline: vi.fn(),
    };
    const destroy = vi.fn(async () => undefined);
    vi.mocked(openPdfDocument).mockReturnValue({
      promise: Promise.resolve(doc),
      destroy,
    } as unknown as ReturnType<typeof openPdfDocument>);
    const progress = vi.fn();

    const parsed = await parsePdf(fakePdfFile(), progress, "original");

    expect(parsed).toEqual({
      title: "原版测试",
      author: "作者",
      cover: "data:image/jpeg;base64,cover",
      pageCount: 900,
      chapters: [],
    });
    expect(doc.getPage).toHaveBeenCalledOnce();
    expect(doc.getPage).toHaveBeenCalledWith(1);
    expect(doc.getOutline).not.toHaveBeenCalled();
    expect(streamTextContent).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith("完成原版 PDF 导入", 1);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
