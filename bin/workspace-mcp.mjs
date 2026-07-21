#!/usr/bin/env node
import { runWorkspaceMcpServer } from "../src/mcp/workspace-server.ts";

runWorkspaceMcpServer().catch((error) => {
  process.stderr.write(`Workspace MCP failed: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`);
  process.exitCode = 1;
});
