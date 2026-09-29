import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibraryMcpServer } from "../mcp/library-tools";

describe("library MCP tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes read-only tools backed by the configured server API", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/books"))
        return Response.json({
          books: [{ extId: "b1", title: "测试书", author: "作者" }],
        });
      if (url.pathname.endsWith("/state"))
        return Response.json({
          state: { progress: { chapterId: "c1", ratio: 0.4 } },
        });
      if (url.pathname.endsWith("/highlights"))
        return Response.json({
          highlights: [
            {
              extId: "h1",
              bookExtId: "b1",
              bookTitle: "测试书",
              chapterTitle: "第一章",
              text: "需要记住的内容",
              aiQa: [{ q: "private" }],
              note: "个人批注",
              createdAt: 1,
            },
          ],
        });
      throw new Error(`unexpected request: ${url}`);
    });
    const server = createLibraryMcpServer({
      baseUrl: "https://books.example.test",
      apiKey: "test-key",
      fetch: fetcher as typeof fetch,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        "list_books",
        "get_reading_progress",
        "search_highlights",
        "get_review_queue",
        "search_notes",
        "get_note",
      ])
    );
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(
      true
    );

    const result = await client.callTool({
      name: "get_reading_progress",
      arguments: { book_id: "b1" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('"ratio": 0.4'),
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://books.example.test/api/v1/books/b1/state",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "test-key" }),
      })
    );

    const highlights = await client.callTool({
      name: "search_highlights",
      arguments: { query: "记住", limit: 5 },
    });
    const highlightText = JSON.stringify(highlights.content);
    expect(highlightText).toContain("需要记住的内容");
    expect(highlightText).not.toContain("private");

    const invalid = await client.callTool({
      name: "search_highlights",
      arguments: { query: "" },
    });
    expect(invalid.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("rejects missing API credentials before making requests", async () => {
    const fetcher = vi.fn();
    expect(() =>
      createLibraryMcpServer({
        baseUrl: "http://127.0.0.1:3000",
        apiKey: "",
        fetch: fetcher as typeof fetch,
      })
    ).toThrow(/API key/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
