import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

describe("remote MCP endpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("requires the API key and speaks Streamable HTTP", async () => {
    vi.stubEnv("OPEN_API_KEY", "remote-test-key");
    vi.stubEnv("MCP_API_KEY", "separate-mcp-key");
    const { mcp } = await import("./mcp");
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/"),
      {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set("X-API-Key", "separate-mcp-key");
          return mcp.request(new Request(url, { ...init, headers }));
        },
      }
    );
    const client = new Client({ name: "http-test", version: "1.0.0" });

    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toContain("get_reading_progress");

    const unauthorized = await mcp.request("http://localhost/");
    expect(unauthorized.status).toBe(401);
    await client.close();
  });

  it("rejects cross-origin browser requests before handling MCP", async () => {
    vi.stubEnv("OPEN_API_KEY", "remote-test-key");
    vi.stubEnv("MCP_API_KEY", "separate-mcp-key");
    vi.stubEnv("MCP_PUBLIC_ORIGIN", "https://library.example");
    const { mcp } = await import("./mcp");
    for (const origin of [
      "https://untrusted.example",
      "null",
      "not-an-origin",
    ]) {
      const response = await mcp.request(
        new Request("https://library.example/", {
          method: "POST",
          headers: {
            Origin: origin,
            "X-API-Key": "separate-mcp-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        })
      );
      expect(response.status).toBe(403);
    }
    const allowed = await mcp.request(
      new Request("https://library.example/", {
        method: "POST",
        headers: {
          Origin: "https://library.example",
          "X-API-Key": "separate-mcp-key",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      })
    );
    expect(allowed.status).toBe(200);
  });

  it("advertises the 2026-07-28 protocol and keeps legacy clients working", async () => {
    vi.stubEnv("OPEN_API_KEY", "remote-test-key");
    vi.stubEnv("MCP_API_KEY", "separate-mcp-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ books: [{ extId: "b1", title: "Test book" }] })
      )
    );
    const { mcp } = await import("./mcp");
    const requests: Request[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/"),
      {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set("X-API-Key", "separate-mcp-key");
          const request = new Request(url, { ...init, headers });
          requests.push(request.clone());
          return mcp.request(request);
        },
      }
    );
    const client = new Client(
      { name: "modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getServerVersion()).toEqual({
      name: "shufang-library",
      version: "1.0.0",
    });
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toContain("get_note");
    const books = await client.callTool({ name: "list_books", arguments: {} });
    expect(JSON.stringify(books.content)).toContain("Test book");
    expect(requests.every(request => !request.headers.has("Mcp-Session-Id"))).toBe(true);
    expect(requests.at(-1)?.headers.get("Mcp-Method")).toBe("tools/call");
    expect(requests.at(-1)?.headers.get("Mcp-Name")).toBe("list_books");
    await client.close();
  });
});
