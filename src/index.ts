#!/usr/bin/env node
/**
 * WHM MCP Server
 *
 * Exposes the WHM (WebHost Manager) API 1 as MCP tools for server-level
 * cPanel administration: accounts, domains, DNS, email, packages, SSL,
 * backups, resellers, security, PHP/databases, logs, plus a raw API escape hatch.
 *
 * Auth (env vars):
 *   WHM_HOST     - server hostname or IP (e.g. 'srv.example.com')
 *   WHM_USER     - WHM username (default: 'root')
 *   WHM_TOKEN    - API token (WHM → Development → Manage API Tokens)
 *   WHM_PORT     - port (default: 2087)
 *   WHM_INSECURE_TLS - 'true' to skip TLS verification (self-signed certs)
 *   WHM_TIMEOUT_MS   - request timeout (default: 60000)
 *
 * Tool selection (env vars):
 *   WHM_READ_ONLY - register only read-only tools. Any value other than
 *                   empty/0/false/no/off turns it on; in HTTP mode it defaults on.
 *   WHM_TOOLSETS  - comma-separated toolsets to enable (default: all)
 *
 * Transport: stdio by default; `--http` or MCP_TRANSPORT=http serves
 * Streamable HTTP for remote connectors (see src/http.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_VERSION } from "./constants.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";
import { ToolRegistrar } from "./types.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerServerTools } from "./tools/server.js";
import { registerDnsTools } from "./tools/dns.js";
import { registerEmailTools } from "./tools/email.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerSslTools } from "./tools/ssl.js";
import { registerBackupTools } from "./tools/backups.js";
import { registerResellerTools } from "./tools/resellers.js";
import { registerSecurityTools } from "./tools/security.js";
import { registerSoftwareTools } from "./tools/software.js";
import { registerLogTools } from "./tools/logs.js";
import { registerApiTools } from "./tools/api.js";

const TOOLSETS: Record<string, (server: ToolRegistrar) => void> = {
  accounts: registerAccountTools,
  domains: registerDomainTools,
  server: registerServerTools,
  dns: registerDnsTools,
  email: registerEmailTools,
  packages: registerPackageTools,
  ssl: registerSslTools,
  backups: registerBackupTools,
  resellers: registerResellerTools,
  security: registerSecurityTools,
  software: registerSoftwareTools,
  logs: registerLogTools,
  api: registerApiTools,
};

/** Parse a boolean env var, failing closed: anything but empty or an explicit "off" value is on. */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return !["0", "false", "no", "off"].includes(v);
}

function selectToolsets(value: string | undefined): string[] {
  const requested = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((name) => !(name in TOOLSETS));
  if (unknown.length) {
    process.stderr.write(
      `whm-mcp-server: ignoring unknown toolsets: ${unknown.join(", ")} (available: ${Object.keys(TOOLSETS).join(", ")})\n`
    );
  }
  return Object.keys(TOOLSETS).filter((name) => requested.length === 0 || requested.includes(name));
}

function buildServer(readOnly: boolean, toolsets: string[]): { server: McpServer; toolCount: number } {
  const server = new McpServer({
    name: "whm-mcp-server",
    version: SERVER_VERSION,
  });
  let toolCount = 0;
  const registrar: ToolRegistrar = {
    registerTool: ((name: string, config: any, callback: any) => {
      if (readOnly && config?.annotations?.readOnlyHint !== true) return undefined;
      toolCount++;
      return server.registerTool(name, config, callback);
    }) as McpServer["registerTool"],
  };
  for (const name of toolsets) TOOLSETS[name](registrar);
  return { server, toolCount };
}

async function main() {
  const httpMode = process.argv.includes("--http") || (process.env.MCP_TRANSPORT ?? "").trim().toLowerCase() === "http";
  // A remote endpoint starts read-only unless WHM_READ_ONLY is explicitly off.
  const readOnly = envFlag(process.env.WHM_READ_ONLY, httpMode);
  const toolsets = selectToolsets(process.env.WHM_TOOLSETS);
  const { server, toolCount } = buildServer(readOnly, toolsets);
  const summary = `${toolCount} tools${readOnly ? ", read-only" : ""}; toolsets: ${toolsets.join(", ")}`;

  if (httpMode) {
    const opts = httpOptionsFromEnv();
    const http = await startHttpServer(() => buildServer(readOnly, toolsets).server, opts);
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : opts.port;
    process.stderr.write(`whm-mcp-server: listening on http://${opts.host}:${port}${opts.path} (${summary})\n`);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`whm-mcp-server: listening on stdio (${summary})\n`);
}

main().catch((err) => {
  process.stderr.write(`whm-mcp-server: fatal error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
