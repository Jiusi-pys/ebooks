import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLibraryMcpServer } from "./library-tools";

const server = createLibraryMcpServer({
  baseUrl:
    process.env.MCP_API_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || "3000"}`,
  apiKey: process.env.OPEN_API_KEY ?? "",
});

await server.connect(new StdioServerTransport());
