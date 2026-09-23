import { beforeEach, describe, expect, it, vi } from "vitest";

import { openPdfDocument } from "./pdfjs";
import { extractPdfPackageFields, parsePdf } from "./parsePdf";

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
      metadata: {
        version: 1,
        contributors: [{ name: "作者", role: "author" }],
        publisher: undefined,
        publishedDate: undefined,
        languages: undefined,
        identifiers: undefined,
        subjects: undefined,
        description: undefined,
        rights: undefined,
        subtitle: undefined,
      },
    });
    expect(doc.getPage).toHaveBeenCalledOnce();
    expect(doc.getPage).toHaveBeenCalledWith(1);
    expect(doc.getOutline).not.toHaveBeenCalled();
    expect(streamTextContent).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith("完成原版 PDF 导入", 1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("maps bounded PDF Info and XMP Dublin Core fields", () => {
    const values: Record<string, unknown> = {
      "dc:creator": ["Alice", "Bob"],
      "dc:publisher": ["Example Press"],
      "dc:date": ["2023-07-04T00:00:00Z"],
      "dc:language": ["en_us"],
      "dc:identifier": ["urn:isbn:978-1-4028-9462-6"],
      "dc:subject": ["History"],
      "dc:description": "An example PDF.",
      "dc:rights": "Copyright holder",
    };

    expect(
      extractPdfPackageFields(
        "fallback",
        { Title: "PDF Title", Keywords: "Reference; Archive" },
        { get: name => values[name] }
      )
    ).toEqual({
      title: "PDF Title",
      author: "Alice、Bob",
      metadata: {
        version: 1,
        subtitle: undefined,
        contributors: [
          { name: "Alice", role: "author" },
          { name: "Bob", role: "author" },
        ],
        publisher: "Example Press",
        publishedDate: "2023-07-04",
        languages: ["en-US"],
        identifiers: [{ scheme: "ISBN", value: "978-1-4028-9462-6" }],
        subjects: ["History", "Reference", "Archive"],
        description: "An example PDF.",
        rights: "Copyright holder",
      },
    });
  });
});
