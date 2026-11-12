import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The part of McpServer that tool modules use. index.ts passes a wrapper that
 * can skip tools (read-only mode) instead of the server itself.
 */
export type ToolRegistrar = Pick<McpServer, "registerTool">;
