import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface LibraryMcpOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  oauth?: boolean;
}

type JsonObject = Record<string, unknown>;

export function createLibraryMcpServer(options: LibraryMcpOptions) {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("MCP requires an OPEN_API_KEY API key");
  if (!baseUrl) throw new Error("MCP requires an API base URL");
  const fetcher = options.fetch ?? fetch;

  async function get<T extends JsonObject>(path: string): Promise<T> {
    const response = await fetcher(`${baseUrl}/api/v1${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error("未找到对应记录");
      if (response.status === 401 || response.status === 503)
        throw new Error("书房机器 API 认证失败或尚未启用");
      throw new Error(`书房 API 请求失败（HTTP ${response.status}）`);
    }
    return (await response.json()) as T;
  }

  const server = new McpServer({ name: "shufang-library", version: "1.0.0" });
  const readonly = { readOnlyHint: true, destructiveHint: false } as const;
  const authMetadata = options.oauth
    ? {
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["library:read"] }],
        },
      }
    : {};

  server.registerTool(
    "list_books",
    {
      title: "列出书籍",
      description:
        "列出服务端已同步的书目，可按书名或作者筛选。最多返回 100 本。",
      inputSchema: {
        query: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ query, limit }) => {
      const result = await get<{ books: JsonObject[] }>("/books");
      const search = query?.toLocaleLowerCase();
      const books = result.books
        .filter(book => {
          if (!search) return true;
          return `${book.title ?? ""} ${book.author ?? ""}`
            .toLocaleLowerCase()
            .includes(search);
        })
        .slice(0, limit)
        .map(book => ({
          id: book.extId,
          title: book.title,
          author: book.author,
          format: book.format,
          folder: book.folder,
          createdAt: book.createdAt,
        }));
      return textResult({ count: books.length, books });
    }
  );

  server.registerTool(
    "get_reading_progress",
    {
      title: "查询阅读进度",
      description: "读取一本书已同步到服务端的阅读进度和最近打开时间。",
      inputSchema: { book_id: z.string().trim().min(1).max(64) },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ book_id }) => {
      const result = await get<{ state: JsonObject }>(
        `/books/${encodeURIComponent(book_id)}/state`
      );
      const state = result.state ?? {};
      return textResult({
        bookId: book_id,
        progress: state.progress ?? null,
        lastOpenedAt: state.lastOpenedAt ?? null,
        synced: Boolean(state.progress || state.lastOpenedAt),
      });
    }
  );

  server.registerTool(
    "search_highlights",
    {
      title: "搜索书摘和批注",
      description: "按关键词查找服务端已同步的书摘、批注和卡片标签。",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        book_id: z.string().trim().max(64).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ query, book_id, limit }) => {
      const result = await get<{ highlights: JsonObject[] }>(
        `/highlights${book_id ? `?book=${encodeURIComponent(book_id)}` : ""}`
      );
      const search = query.toLocaleLowerCase();
      const highlights = result.highlights
        .filter(item =>
          [
            item.text,
            item.note,
            item.name,
            ...(Array.isArray(item.tags) ? item.tags : []),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(search)
        )
        .slice(0, limit)
        .map(highlightPreview);
      return textResult({ count: highlights.length, highlights });
    }
  );

  server.registerTool(
    "get_review_queue",
    {
      title: "查询复习队列",
      description: "查询已到期的复习卡；可选择包含所有复习卡。",
      inputSchema: {
        include_all: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ include_all, limit }) => {
      const result = await get<{
        now: number;
        count: number;
        cards: JsonObject[];
      }>(`/review/due${include_all ? "?all=1" : ""}`);
      return textResult({
        now: result.now,
        count: Math.min(result.count, limit),
        cards: result.cards.slice(0, limit).map(highlightPreview),
      });
    }
  );

  server.registerTool(
    "search_notes",
    {
      title: "搜索笔记",
      description: "搜索已同步笔记的标题和正文，最多扫描 100 条笔记。",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ query, limit }) => {
      const listing = await get<{ notes: JsonObject[] }>("/notes");
      const candidates = listing.notes.slice(0, 100);
      const notes = [] as JsonObject[];
      for (let index = 0; index < candidates.length; index += 5) {
        const batch = await Promise.all(
          candidates
            .slice(index, index + 5)
            .map(note =>
              get<JsonObject>(
                `/notes/${encodeURIComponent(String(note.extId))}`
              )
            )
        );
        notes.push(...batch);
      }
      const search = query.toLocaleLowerCase();
      const matches = notes
        .filter((note): note is JsonObject => note !== null)
        .filter(note =>
          `${note.title ?? ""} ${note.content ?? ""}`
            .toLocaleLowerCase()
            .includes(search)
        )
        .slice(0, limit)
        .map(note => ({
          extId: note.extId,
          title: note.title,
          content: truncate(String(note.content ?? ""), 2000),
          updatedAt: note.updatedAt,
        }));
      return textResult({ count: matches.length, notes: matches });
    }
  );

  server.registerTool(
    "get_note",
    {
      title: "读取笔记",
      description: "按 ID 读取一条已同步笔记。",
      inputSchema: { note_id: z.string().trim().min(1).max(64) },
      annotations: readonly,
      ...authMetadata,
    },
    async ({ note_id }) => {
      const note = await get<JsonObject>(
        `/notes/${encodeURIComponent(note_id)}`
      );
      return textResult({
        ...note,
        content: truncate(String(note.content ?? ""), 10_000),
      });
    }
  );

  return server;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}\n[内容已截断]`
    : value;
}

function highlightPreview(item: JsonObject) {
  return {
    id: item.extId,
    bookId: item.bookExtId,
    bookTitle: item.bookTitle,
    chapterTitle: item.chapterTitle,
    text: truncate(String(item.text ?? ""), 3000),
    note: truncate(String(item.note ?? ""), 2000),
    name: item.name,
    tags: item.tags,
    cloze: item.cloze,
    review: item.review,
    createdAt: item.createdAt,
  };
}
