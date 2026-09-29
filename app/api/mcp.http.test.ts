import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("remote MCP endpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
