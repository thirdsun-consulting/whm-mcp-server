#!/usr/bin/env node
/** Smoke-test the Streamable HTTP mode: auth, routing, read-only default, and a tool call. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "t".repeat(40);
const failures = [];
const check = (ok, msg) => ok || failures.push(msg);

function start(env) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js"), "--http"], {
    env: { ...process.env, WHM_HOST: "127.0.0.1", WHM_PORT: "1", WHM_TOKEN: "x", MCP_HTTP_PORT: "0", WHM_READ_ONLY: "", ...env },
  });
  return new Promise((resolve) => {
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/listening on (http:\/\/\S+) \((\d+) tools/);
      if (m) resolve({ child, url: m[1], tools: Number(m[2]), err });
    });
    child.on("exit", (code) => resolve({ child, code, err }));
  });
}

// Refuses to start without a strong token.
const noToken = await start({ MCP_AUTH_TOKEN: "short" });
check(noToken.code === 1 && /MCP_AUTH_TOKEN/.test(noToken.err), "HTTP mode should refuse a short/missing token");

const srv = await start({ MCP_AUTH_TOKEN: TOKEN });
check(srv.tools === 51, `HTTP mode should default to read-only (51 tools), got ${srv.tools}`);
const post = (headers, url = srv.url) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
check((await post({})).status === 401, "no token should get 401");
check((await post({ Authorization: "Bearer wrong" })).status === 401, "wrong token should get 401");
check((await fetch(srv.url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status === 405, "GET should get 405");
check((await post({ Authorization: `Bearer ${TOKEN}` }, srv.url.replace(/\/mcp$/, "/other"))).status === 404, "other paths should 404");

const client = new Client({ name: "verify-http", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
const { tools } = await client.listTools();
check(tools.length === 51 && tools.every((t) => t.annotations?.readOnlyHint), "tools/list over HTTP should return the read-only tools");
const res = await client.callTool({ name: "whm_get_version", arguments: {} });
check(res.isError && /connect|Error/.test(res.content[0].text), "tool calls should run (and report the unreachable WHM)");
await client.close();
srv.child.kill();

const rw = await start({ MCP_AUTH_TOKEN: TOKEN, WHM_READ_ONLY: "false" });
check(rw.tools === 91, `WHM_READ_ONLY=false should expose all tools, got ${rw.tools}`);
rw.child.kill();

if (failures.length) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
console.log("OK: HTTP transport auth, routing, read-only default, and tool calls");
