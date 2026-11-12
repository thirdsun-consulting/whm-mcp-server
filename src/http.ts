/**
 * Streamable HTTP transport, for hosting the server as a remote MCP connector
 * (claude.ai custom connectors, Claude Code `--transport http`, the Messages
 * API MCP connector). Every request must carry `Authorization: Bearer
 * $MCP_AUTH_TOKEN`.
 *
 * Stateless mode: each POST gets a fresh McpServer and transport, so nothing
 * is lost across restarts and several instances can sit behind one URL.
 *
 * Env vars:
 *   MCP_AUTH_TOKEN - required bearer token, at least 32 characters
 *   MCP_HTTP_HOST  - bind address (default 127.0.0.1; put a TLS proxy in front)
 *   MCP_HTTP_PORT  - port (default 3000; 0 picks a free port)
 *   MCP_HTTP_PATH  - endpoint path (default /mcp)
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  host: string;
  port: number;
  path: string;
  token: string;
}

export function httpOptionsFromEnv(): HttpOptions {
  const token = process.env.MCP_AUTH_TOKEN ?? "";
  if (token.length < 32) {
    throw new Error(
      "HTTP mode requires MCP_AUTH_TOKEN: a random secret of at least 32 characters (e.g. from `openssl rand -hex 32`)."
    );
  }
  const port = Number(process.env.MCP_HTTP_PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT '${process.env.MCP_HTTP_PORT}'.`);
  }
  const path = process.env.MCP_HTTP_PATH || "/mcp";
  return {
    host: process.env.MCP_HTTP_HOST || "127.0.0.1",
    port,
    path: path.startsWith("/") ? path : `/${path}`,
    token,
  };
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHttpServer(buildServer: () => McpServer, opts: HttpOptions): Promise<Server> {
  // Compare digests so the check takes the same time whatever the header's length.
  const expected = createHash("sha256").update(`Bearer ${opts.token}`).digest();
  const authorized = (req: IncomingMessage) =>
    timingSafeEqual(createHash("sha256").update(req.headers.authorization ?? "").digest(), expected);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== opts.path) return sendJson(res, 404, { error: "Not found" });
    if (!authorized(req)) {
      process.stderr.write(`whm-mcp-server: rejected request without a valid token from ${req.socket.remoteAddress}\n`);
      return sendRpcError(res, 401, -32001, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="whm-mcp-server"' });
    }
    if (req.method !== "POST") {
      return sendRpcError(res, 405, -32000, "Method not allowed.", { Allow: "POST" });
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return e instanceof BodyTooLargeError
        ? sendRpcError(res, 413, -32600, "Request body too large.")
        : sendRpcError(res, 400, -32700, "Parse error.");
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      process.stderr.write(`whm-mcp-server: error handling MCP request: ${e instanceof Error ? e.stack : e}\n`);
      if (!res.headersSent) sendRpcError(res, 500, -32603, "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => resolve(http));
  });
}
