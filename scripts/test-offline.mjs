#!/usr/bin/env node
/**
 * Behaviour tests that need no network: a small stateful mock WHM, driven
 * through a real MCP client over stdio. They cover logic that the spec check
 * (verify-spec.mjs) can't, because its mock answers every call the same way:
 * zones whose line numbers shift, a restore queue that fills and empties,
 * packages WHM resets, oversized responses, and secrets in raw API output.
 *
 * Usage: npm run build && npm test
 * Set WHM_SERVER_ENTRY to test another build, e.g. the plugin bundle.
 * Needs the `openssl` CLI to create a throwaway certificate for the mock server.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(process.env.WHM_SERVER_ENTRY ?? join(ROOT, "dist", "index.js"));

// ---------------------------------------------------------------- mock WHM

const b64 = (s) => Buffer.from(s).toString("base64");
const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow-not-a-real-key\n-----END RSA PRIVATE KEY-----";

let state;
let calls;
/** WHM function name -> error reason; the next call to it fails once. */
let failNext;

function reset() {
  calls = [];
  failNext = {};
  state = {
    serial: 2025010101,
    // [line_index, name, ttl, type, data]
    zone: [
      [2, "example.com.", 86400, "SOA", ["ns1.example.com.", "admin.example.com.", "SERIAL", "3600", "1800", "1209600", "86400"]],
      [10, "example.com.", 14400, "A", ["192.0.2.10"]],
      [11, "www", 14400, "CNAME", ["example.com."]],
      [12, "old", 14400, "A", ["192.0.2.12"]],
      [13, "keep", 14400, "A", ["192.0.2.13"]],
      [14, "also-old", 14400, "A", ["192.0.2.14"]],
    ],
    restore: { pending: [], active: [] },
    pkg: { QUOTA: 1000, MAXSUB: 5, MAXPASSENGERAPPS: 10, FEATURELIST: "default", _PACKAGE_EXTENSIONS: "wp_toolkit", wp_toolkit_plan: "deluxe" },
    // When set, editpkg resets this getpkginfo key no matter what it was sent.
    pkgResets: null,
    mailQueue: [],
    accounts: [],
    phpSetCalls: 0,
  };
}

const HANDLERS = {
  parse_dns_zone: () => ({
    payload: state.zone.map(([line_index, name, ttl, type, data]) => ({
      type: "record",
      line_index,
      dname_b64: b64(name),
      ttl,
      record_type: type,
      data_b64: data.map((d) => b64(d === "SERIAL" ? String(state.serial) : d)),
    })),
  }),
  mass_edit_dns_zone: (p) => {
    if (Number(p.get("serial")) !== state.serial) throw new Error("The given serial number does not match the zone.");
    const removed = [...p.entries()].filter(([k]) => /^remove(-\d+)?$/.test(k)).map(([, v]) => Number(v));
    // Removing a record moves every later record up one line, as in a real zone file.
    state.zone = state.zone
      .filter(([line]) => !removed.includes(line))
      .map(([line, ...rest]) => [line - removed.filter((r) => r < line).length, ...rest]);
    for (const [k, v] of p.entries()) {
      if (/^add(-\d+)?$/.test(k)) {
        const r = JSON.parse(v);
        state.zone.push([Math.max(...state.zone.map(([line]) => line)) + 1, r.dname, r.ttl, r.record_type, r.data]);
      }
    }
    state.serial += 1;
    return { new_serial: state.serial };
  },
  restore_queue_state: () => ({ is_active: 0, pending: state.restore.pending, active: state.restore.active, completed: [] }),
  restore_queue_add_task: (p) => {
    state.restore.pending.push({ user: p.get("user"), restore_point: p.get("restore_point") });
    return { queue_id: `q${state.restore.pending.length}` };
  },
  restore_queue_activate: () => {
    state.restore.active.push(...state.restore.pending);
    state.restore.pending = [];
    return {};
  },
  getpkginfo: () => ({ pkg: state.pkg }),
  editpkg: (p) => {
    // Like WHM: settings are set by their lowercase names; a setting that isn't sent falls back to a default.
    const next = { FEATURELIST: "default", _PACKAGE_EXTENSIONS: p.get("_PACKAGE_EXTENSIONS") ?? "" };
    for (const key of ["QUOTA", "MAXSUB", "MAXPASSENGERAPPS"]) next[key] = p.get(key.toLowerCase()) ?? "DEFAULT";
    if (p.has("wp_toolkit_plan")) next.wp_toolkit_plan = p.get("wp_toolkit_plan");
    if (state.pkgResets) next[state.pkgResets] = "DEFAULT";
    for (const key of Object.keys(next)) if (/^\d+$/.test(next[key])) next[key] = Number(next[key]);
    state.pkg = next;
    return { pkg: p.get("name") };
  },
  backup_destination_list: () => ({
    destination_list: [{ id: "b2", name: "Backblaze", type: "Backblaze", application_key_id: "key-id", application_key: "secret-value" }],
  }),
  fetchsslinfo: () => ({ crt: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----", key: PRIVATE_KEY, statusmsg: "ok" }),
  api_token_create: () => ({ token: "NEWTOKEN123", name: "ci" }),
  fetch_mail_queue: () => ({ records: state.mailQueue }),
  listaccts: () => ({ acct: state.accounts }),
  php_get_vhost_versions: () => ({
    versions: [
      { vhost: "fpm.example.com", account: "a", version: "ea-php81", php_fpm: 1 },
      { vhost: "cgi.example.com", account: "b", version: "ea-php81", php_fpm: 0 },
    ],
  }),
  php_set_vhost_versions: () => {
    state.phpSetCalls += 1;
    return {};
  },
};

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "whm-mock-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" }
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mock = createServer(selfSignedCert(), (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "https://127.0.0.1");
    const fn = decodeURIComponent(url.pathname.replace(/^\/json-api\//, ""));
    const params = new URLSearchParams(url.search);
    if (req.method === "POST") new URLSearchParams(body).forEach((v, k) => params.append(k, v));
    calls.push({ fn, params });
    let payload;
    try {
      if (req.headers.authorization !== "whm root:test-token") throw new Error("bad Authorization header");
      if (failNext[fn]) {
        const reason = failNext[fn];
        delete failNext[fn];
        throw new Error(reason);
      }
      if (!HANDLERS[fn]) throw new Error(`mock has no handler for ${fn}`);
      payload = { metadata: { result: 1, reason: "OK", command: fn, version: 1 }, data: HANDLERS[fn](params) };
    } catch (e) {
      payload = { metadata: { result: 0, reason: e.message, command: fn, version: 1 } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));

// ---------------------------------------------------------------- harness

async function connect(env = {}) {
  const client = new Client({ name: "test-offline", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: {
        PATH: process.env.PATH,
        WHM_HOST: "127.0.0.1",
        WHM_PORT: String(mock.address().port),
        WHM_USER: "root",
        WHM_TOKEN: "test-token",
        WHM_INSECURE_TLS: "true",
        ...env,
      },
      stderr: "pipe",
    })
  );
  return client;
}

const failures = [];
let current = "";
let checks = 0;
function check(ok, message) {
  checks += 1;
  if (!ok) failures.push(`${current}: ${message}`);
}
const textOf = (result) => (result.content ?? []).map((c) => c.text ?? "").join("\n");
const callsTo = (fn) => calls.filter((c) => c.fn === fn);

const client = await connect();
const call = async (name, args = {}) => {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, text: textOf(result) };
  } catch (e) {
    // e.g. the tool doesn't exist in the build under test
    return { isError: true, content: [], text: `call to ${name} threw: ${e.message}` };
  }
};

async function scenario(name, run) {
  current = name;
  reset();
  try {
    await run();
  } catch (e) {
    failures.push(`${name}: threw ${e.stack ?? e}`);
  }
}

// ---------------------------------------------------------------- scenarios

await scenario("dns: a stale line_index is refused", async () => {
  const listing = await call("whm_get_dns_zone", { domain: "example.com", response_format: "json" });
  const serial = JSON.parse(listing.text).serial;
  check(serial === 2025010101, `listing should report the serial, got ${serial}`);

  const first = await call("whm_remove_dns_record", { domain: "example.com", line_index: 12, serial });
  check(!first.isError && /old 14400 A 192\.0\.2\.12/.test(first.text), `first removal should remove 'old': ${first.text}`);
  check(/whm_get_dns_zone again/.test(first.text), "the response should say line numbers changed");

  // Line 14 now holds nothing and line 13 holds 'also-old'; the old listing's numbers are wrong.
  const second = await call("whm_remove_dns_record", { domain: "example.com", line_index: 13, serial });
  check(second.isError && /has changed since that listing/.test(second.text), `a stale listing should be refused: ${second.text}`);
  check(callsTo("mass_edit_dns_zone").length === 1, "the refused removal must not reach WHM");
  check(state.zone.some(([, name]) => name === "keep"), "'keep' must survive");

  const stale = await call("whm_edit_dns_record", { domain: "example.com", line_index: 11, ttl: 60, serial });
  check(stale.isError && /has changed since that listing/.test(stale.text), `a stale edit should be refused: ${stale.text}`);

  const relisted = JSON.parse((await call("whm_get_dns_zone", { domain: "example.com", response_format: "json" })).text);
  const target = relisted.records.find((r) => r.name === "also-old");
  const third = await call("whm_remove_dns_record", { domain: "example.com", line_index: target.line_index, serial: relisted.serial });
  check(!third.isError && /also-old/.test(third.text), `removal with a fresh listing should work: ${third.text}`);
  check(state.zone.map(([, name]) => name).join(",") === "example.com.,example.com.,www,keep", `unexpected zone: ${state.zone.map(([, n]) => n)}`);
});

await scenario("dns: line_index tools need the listing's serial", async () => {
  const noSerial = await call("whm_remove_dns_record", { domain: "example.com", line_index: 12 });
  check(noSerial.isError && /serial/i.test(noSerial.text), `removal without a serial should be rejected: ${noSerial.text}`);
  const mass = await call("whm_mass_edit_dns_zone", { domain: "example.com", remove: [12, 14] });
  check(mass.isError && /serial/.test(mass.text), `mass removal without a serial should be rejected: ${mass.text}`);
  check(callsTo("mass_edit_dns_zone").length === 0, "nothing should reach WHM");

  const ok = await call("whm_mass_edit_dns_zone", { domain: "example.com", remove: [12, 14], serial: 2025010101 });
  check(!ok.isError && state.zone.length === 4, `mass removal from one listing should work: ${ok.text}`);
  const add = await call("whm_add_dns_record", { domain: "example.com", name: "new", type: "A", address: "192.0.2.50" });
  check(!add.isError && state.zone.some(([, name]) => name === "new"), `adding needs no serial: ${add.text}`);
});

await scenario("restore: a queued restore can be started", async () => {
  const queued = await call("whm_restore_account", { user: "bob", restore_point: "2025-01-31", activate: false });
  check(!queued.isError && /whm_start_restore_queue/.test(queued.text), `queuing should point at whm_start_restore_queue: ${queued.text}`);
  check(callsTo("restore_queue_activate").length === 0 && state.restore.pending.length === 1, "activate=false must only queue");

  const refused = await call("whm_restore_account", { user: "amy", restore_point: "2025-01-31" });
  check(refused.isError && /whm_start_restore_queue/.test(refused.text), `activation with other restores pending should be refused: ${refused.text}`);
  check(state.restore.pending.length === 1, "a refused restore must not be queued");

  const started = await call("whm_start_restore_queue");
  check(!started.isError && /bob from 2025-01-31/.test(started.text), `starting the queue should list what it runs: ${started.text}`);
  check(state.restore.pending.length === 0 && state.restore.active.length === 1, "the queue should now be running");

  const empty = await call("whm_start_restore_queue");
  check(empty.isError && /no pending/.test(empty.text), `an empty queue should not be started: ${empty.text}`);
});

await scenario("restore: a failed start does not invite a duplicate", async () => {
  failNext.restore_queue_activate = "Restore queue is locked";
  const result = await call("whm_restore_account", { user: "bob", restore_point: "2025-01-31" });
  check(result.isError && /Restore queue is locked/.test(result.text), `the WHM reason should be reported: ${result.text}`);
  check(/Do not queue it again/.test(result.text) && /whm_start_restore_queue/.test(result.text), "the error should say the restore is already queued");
  check(state.restore.pending.length === 1, "the restore stays queued once");
  const started = await call("whm_start_restore_queue");
  check(!started.isError && state.restore.active.length === 1, `the queued restore can still be started: ${started.text}`);
});

await scenario("packages: settings the tool doesn't know are kept", async () => {
  const result = await call("whm_edit_package", { name: "gold", quota: 4096 });
  const sent = callsTo("editpkg")[0]?.params;
  check(!result.isError && sent?.get("quota") === "4096", `the edit should go through: ${result.text}`);
  check(sent?.get("maxpassengerapps") === "10", "an unknown uppercase setting should be resent in lowercase");
  check(sent?.get("wp_toolkit_plan") === "deluxe" && sent?.get("_PACKAGE_EXTENSIONS") === "wp_toolkit", "extension variables should be resent");
  check(state.pkg.MAXPASSENGERAPPS === 10 && state.pkg.MAXSUB === 5, `other settings should be unchanged: ${JSON.stringify(state.pkg)}`);
  check(!/also changed/.test(result.text) && result.structuredContent?.unintended_changes?.length === 0, `no side effects expected: ${result.text}`);
});

await scenario("packages: a setting WHM resets is reported", async () => {
  state.pkgResets = "MAXSUB";
  const result = await call("whm_edit_package", { name: "gold", quota: 4096 });
  check(!result.isError && /also changed: MAXSUB \(5 → "DEFAULT"\)/.test(result.text), `the reset should be reported: ${result.text}`);
  check(!/QUOTA/.test(result.text.split("also changed")[1] ?? ""), "the requested change is not a side effect");
  check(result.structuredContent?.unintended_changes?.[0]?.setting === "MAXSUB", "the reset should be in the structured output");
});

await scenario("raw API: secrets are redacted unless asked for", async () => {
  for (const response_format of ["markdown", "json"]) {
    const dest = await call("whm_call_api", { function: "backup_destination_list", response_format });
    check(!dest.isError && !/secret-value/.test(dest.text) && /key-id|\[redacted\]/.test(dest.text), `[${response_format}] backup secrets should be redacted: ${dest.text.slice(0, 200)}`);
    check(!/secret-value/.test(JSON.stringify(dest.structuredContent ?? {})), `[${response_format}] structured output should be redacted too`);
    const ssl = await call("whm_call_api", { function: "fetchsslinfo", params: { domain: "example.com" }, response_format });
    check(!ssl.isError && !/MIIEow/.test(ssl.text + JSON.stringify(ssl.structuredContent ?? {})), `[${response_format}] private keys should be redacted`);
    check(/BEGIN CERTIFICATE/.test(ssl.text), `[${response_format}] the certificate itself should still be returned`);
  }
  const hidden = await call("whm_call_api", { function: "api_token_create", params: { token_name: "ci" } });
  check(!/NEWTOKEN123/.test(hidden.text), "a new token is redacted by default");
  const shown = await call("whm_call_api", { function: "api_token_create", params: { token_name: "ci" }, reveal_secrets: true });
  check(/NEWTOKEN123/.test(shown.text), "reveal_secrets returns the value");
});

await scenario("mail queue: very large queues are summarised", async () => {
  state.mailQueue = Array.from({ length: 300000 }, (_, i) => ({ time: 1700000000 + i }));
  state.mailQueue[1234].time = 1600000000;
  const result = await call("whm_get_mail_queue_summary", { response_format: "json" });
  check(!result.isError, `a 300,000-message queue should not fail: ${result.text.slice(0, 200)}`);
  const summary = result.isError ? {} : JSON.parse(result.text);
  check(summary.total === 300000 && summary.oldest_time === 1600000000, `wrong summary: ${result.text.slice(0, 200)}`);
});

await scenario("json output: oversized results stay valid JSON", async () => {
  state.accounts = Array.from({ length: 800 }, (_, i) => ({ user: `user${i}`, domain: `site-${i}.example.com`, note: 'quote " and \\ backslash' }));
  const result = await call("whm_call_api", { function: "listaccts", response_format: "json" });
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = undefined;
  }
  check(parsed !== undefined, `oversized JSON output should still parse: …${result.text.slice(-120)}`);
  check(parsed?.truncated === true && typeof parsed?.preview === "string" && parsed.preview.includes("user0"), "it should be a truncation envelope with a preview");
  check(result.text.length <= 25000, `the text should fit the limit, got ${result.text.length}`);
  const small = await call("whm_call_api", { function: "getpkginfo", params: { pkg: "gold" }, response_format: "json" });
  check(JSON.parse(small.text).data?.pkg?.QUOTA === 1000, "small results are returned as they are");
});

await scenario("php: a half-applied change is reported", async () => {
  const data = await call("whm_set_php_vhost_version", { vhosts: ["fpm.example.com", "cgi.example.com"], version: "ea-php83" });
  check(!data.isError && state.phpSetCalls === 2, `both groups should be applied: ${data.text}`);
  reset();
  // Fail the second of the two calls (one per PHP-FPM setting).
  const original = HANDLERS.php_set_vhost_versions;
  HANDLERS.php_set_vhost_versions = () => {
    state.phpSetCalls += 1;
    if (state.phpSetCalls === 2) throw new Error("PHP-FPM is not installed");
    return {};
  };
  const partial = await call("whm_set_php_vhost_version", { vhosts: ["fpm.example.com", "cgi.example.com"], version: "ea-php83" });
  HANDLERS.php_set_vhost_versions = original;
  check(partial.isError && /PHP-FPM is not installed/.test(partial.text), `the WHM reason should be reported: ${partial.text}`);
  check(/Partly applied: fpm\.example\.com already changed/.test(partial.text) && /cgi\.example\.com did not/.test(partial.text), `the error should say what changed: ${partial.text}`);
});

await client.close();

// ---------------------------------------------------------------- tool selection

current = "tool selection";
const toolNames = async (env) => {
  const c = await connect(env);
  try {
    return (await c.listTools()).tools;
  } catch {
    return []; // a server with no tools doesn't answer tools/list
  } finally {
    await c.close();
  }
};
const all = await toolNames({});
const writes = all.filter((t) => t.annotations?.readOnlyHint !== true);
check(all.length === 92, `expected 92 tools, got ${all.length}`);
check(all.some((t) => t.name === "whm_start_restore_queue"), "whm_start_restore_queue should be registered");
const readOnly = await toolNames({ WHM_READ_ONLY: "true" });
check(readOnly.length === all.length - writes.length && readOnly.every((t) => t.annotations?.readOnlyHint === true), `read-only mode should keep only read-only tools, got ${readOnly.length}`);
check(!readOnly.some((t) => /whm_call_api|whm_start_restore_queue|whm_remove_dns_record/.test(t.name)), "read-only mode must drop write tools");
check((await toolNames({ WHM_TOOLSETS: "all" })).length === all.length, "WHM_TOOLSETS=all should enable every toolset");
const dnsOnly = await toolNames({ WHM_TOOLSETS: "dns", WHM_READ_ONLY: "true" });
check(dnsOnly.length === 2 && dnsOnly.every((t) => /dns/.test(t.name)), `WHM_TOOLSETS=dns read-only should give the two DNS read tools, got ${dnsOnly.map((t) => t.name)}`);

// ---------------------------------------------------------------- plugin packaging

current = "plugin";
const readJson = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));
const manifest = readJson("plugin", ".claude-plugin", "plugin.json");
const pluginServer = readJson("plugin", ".mcp.json").mcpServers.whm;
const version = readJson("package.json").version;
check(manifest.version === version, `plugin.json version ${manifest.version} should match package.json ${version}`);

/** Start the plugin's server the way Claude Code does, with the given option values over the manifest defaults. */
async function startPlugin(options = {}) {
  const values = { whm_host: "127.0.0.1", whm_token: "test-token", ...options };
  const fill = (text) =>
    text
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", join(ROOT, "plugin"))
      .replace(/\$\{user_config\.(\w+)\}/g, (whole, key) => {
        check(key in manifest.userConfig, `.mcp.json uses ${whole}, which plugin.json doesn't declare`);
        return String(values[key] ?? manifest.userConfig[key]?.default ?? "");
      });
  const c = new Client({ name: "test-offline", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: pluginServer.command,
      args: pluginServer.args.map(fill),
      env: { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(pluginServer.env).map(([k, v]) => [k, fill(v)])) },
      stderr: "pipe",
    })
  );
  return c;
}

const plugin = await startPlugin({ whm_port: mock.address().port, insecure_tls: true });
check(plugin.getServerVersion()?.version === version, `the bundle reports version ${plugin.getServerVersion()?.version}, expected ${version}; run npm run bundle`);
const pluginTools = (await plugin.listTools()).tools;
check(pluginTools.length === readOnly.length && pluginTools.every((t) => t.annotations?.readOnlyHint === true), `the plugin should start read-only by default, got ${pluginTools.length} tools`);
reset();
const viaPlugin = await plugin.callTool({ name: "whm_get_dns_zone", arguments: { domain: "example.com" } });
check(!viaPlugin.isError && /serial 2025010101/.test(textOf(viaPlugin)), `the plugin should reach WHM with its configured host, port, and token: ${textOf(viaPlugin)}`);
await plugin.close();

const pluginWrites = await startPlugin({ read_only: false, toolsets: "dns" });
const dnsTools = (await pluginWrites.listTools()).tools;
check(dnsTools.some((t) => t.name === "whm_remove_dns_record") && dnsTools.every((t) => /dns/.test(t.name)), "read_only=false with toolsets=dns should expose the DNS write tools only");
await pluginWrites.close();

mock.close();

if (failures.length) {
  console.log(`${failures.length} problem(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`OK: ${checks} checks across DNS, restores, packages, raw API output, large results, PHP changes, tool selection, and the plugin (${ENTRY.replace(ROOT + "/", "")}).`);
