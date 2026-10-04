import "dotenv/config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLibraryMcpServer } from "./library-tools";

serveStdio(() =>
  createLibraryMcpServer({
    baseUrl:
      process.env.MCP_API_BASE_URL ||
      `http://127.0.0.1:${process.env.PORT || "3000"}`,
    apiKey: process.env.OPEN_API_KEY ?? "",
  })
);
