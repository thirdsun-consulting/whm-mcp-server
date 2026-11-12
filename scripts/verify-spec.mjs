#!/usr/bin/env node
/**
 * Verify the MCP tools against cPanel's published OpenAPI specifications.
 *
 * Starts a mock WHM server that answers every call with an example response
 * built from the spec, calls every tool through a real MCP client, and checks
 * each WHM request: the function exists, every parameter is documented (UAPI
 * parameters are checked against the cPanel spec), required parameters are
 * present, and values match documented enums/types. Tool-specific
 * expectations below cover request-building logic (DNS edits, package merges,
 * array encoding, …) and error handling.
 *
 * Usage: npm run build && npm run verify:spec
 *
 * Specs are downloaded from api.docs.cpanel.net and cached under
 * node_modules/.cache/whm-mcp-server (set WHM_SPEC_DIR to use local copies).
 * Needs the `openssl` CLI to create a throwaway certificate for the mock server.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_URL = "https://api.docs.cpanel.net/_spec/specifications";
const SPEC_DIR = process.env.WHM_SPEC_DIR ?? join(ROOT, "node_modules", ".cache", "whm-mcp-server");

// ---------------------------------------------------------------- specs

async function loadSpec(name) {
  const file = join(SPEC_DIR, `${name}.openapi.json`);
  if (!existsSync(file)) {
    const url = `${SPEC_URL}/${name}.openapi.json`;
    process.stdout.write(`Downloading ${url}\n`);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`Could not download ${url} (${e.cause?.message ?? e.message}). Download it to ${file} manually.`);
    }
    if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
    mkdirSync(SPEC_DIR, { recursive: true });
    writeFileSync(file, await res.text());
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

const WHM = await loadSpec("whm");
const UAPI = await loadSpec("cpanel");

function resolve(spec, node) {
  let n = node;
  for (let i = 0; n && n.$ref && i < 20; i++) {
    n = n.$ref.slice(2).split("/").reduce((o, k) => o[k], spec);
  }
  return n;
}

function operation(spec, path) {
  const item = spec.paths[path];
  return item && resolve(spec, item.get ?? item.post);
}

/** Documented parameter names/schemas, from query parameters and form bodies. */
function documentedParams(spec, op) {
  const schemas = new Map();
  const required = new Set();
  for (const raw of op.parameters ?? []) {
    const p = resolve(spec, raw);
    schemas.set(p.name, p.schema ?? {});
    if (p.required) required.add(p.name);
  }
  const collect = (node) => {
    const s = resolve(spec, node);
    if (!s || typeof s !== "object") return;
    for (const kw of ["allOf", "anyOf", "oneOf"]) (s[kw] ?? []).forEach(collect);
    for (const [k, v] of Object.entries(s.properties ?? {})) schemas.set(k, v);
  };
  for (const c of Object.values(op.requestBody?.content ?? {})) collect(c.schema);
  return { schemas, required };
}

function valueMatches(spec, schema, value) {
  const s = resolve(spec, schema) ?? {};
  const alts = s.oneOf ?? s.anyOf;
  if (alts) return alts.some((alt) => valueMatches(spec, alt, value));
  if (s.enum) return s.enum.map(String).includes(value);
  if (s.type === "integer") return /^-?\d+$/.test(value);
  if (s.type === "number") return value !== "" && !isNaN(Number(value));
  if (s.type === "boolean") return ["0", "1"].includes(value);
  if (s.type === "array") return valueMatches(spec, s.items ?? {}, value);
  return true;
}

const GENERIC_PARAM = /^api\.(version|filter\.|sort\.|chunk\.|columns\.)/;

/** Enums the spec itself says are not exhaustive. */
/** Package extension variables, which editpkg accepts in key=value form. */
const EXTENSION_PARAMS = { editpkg: new Set(["wp_toolkit_plan"]) };

const OPEN_ENUMS = new Set([
  "php_set_vhost_versions.version", // "This parameter also accepts any custom PHP package names."
]);

/** Check one recorded WHM request against the spec; returns a list of problems. */
function checkRequest(req) {
  const problems = [];
  const op = operation(WHM, `/${req.fn}`);
  if (!op) return [`${req.fn}: function is not in the WHM API spec`];
  if (req.params.get("api.version") !== "1") problems.push(`${req.fn}: api.version=1 missing`);

  let checks = [{ spec: WHM, op, label: req.fn, params: [...req.params.entries()] }];
  if (req.fn === "uapi_cpanel") {
    const module = req.params.get("cpanel.module");
    const func = req.params.get("cpanel.function");
    const uop = operation(UAPI, `/${module}/${func}`);
    const uapiParams = [...req.params.entries()].filter(([k]) => !k.startsWith("cpanel.") && !GENERIC_PARAM.test(k));
    checks = [{ spec: WHM, op, label: req.fn, params: [...req.params.entries()].filter(([k]) => k.startsWith("cpanel.")) }];
    if (!uop) problems.push(`uapi_cpanel: UAPI ${module}::${func} is not in the cPanel spec`);
    else checks.push({ spec: UAPI, op: uop, label: `UAPI ${module}::${func}`, params: uapiParams });
  }

  for (const { spec, op, label, params } of checks) {
    const { schemas, required } = documentedParams(spec, op);
    const wildcards = [...schemas.keys()].filter((k) => k.endsWith("*")).map((k) => k.slice(0, -1));
    const sent = new Set();
    for (const [key, value] of params) {
      if (GENERIC_PARAM.test(key)) continue;
      // Multi-valued parameters use WHM's param, param-1, param-2 convention.
      const base = schemas.has(key) ? key : key.replace(/-\d+$/, "");
      sent.add(base);
      if (schemas.has(base)) {
        if (!OPEN_ENUMS.has(`${req.fn}.${base}`) && !valueMatches(spec, schemas.get(base), value)) {
          problems.push(`${label}: ${key}=${JSON.stringify(value)} doesn't match the documented type/enum`);
        }
      } else if (!wildcards.some((w) => key.startsWith(w)) && !EXTENSION_PARAMS[req.fn]?.has(key)) {
        problems.push(`${label}: parameter '${key}' is not documented`);
      }
    }
    for (const name of required) {
      if (!sent.has(name)) problems.push(`${label}: required parameter '${name}' missing`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- example responses

function example(spec, node, depth = 0) {
  const s = resolve(spec, node);
  if (!s || depth > 12) return null;
  if (s.example !== undefined) return s.example;
  const alts = s.oneOf ?? s.anyOf;
  if (alts) return example(spec, alts[0], depth + 1);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((a) => example(spec, a, depth + 1)));
  if (s.type === "array") return [example(spec, s.items ?? {}, depth + 1)];
  if (s.type === "object" || s.properties || s.additionalProperties) {
    const out = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = example(spec, v, depth + 1);
    if (!s.properties && s.additionalProperties && typeof s.additionalProperties === "object") {
      out.example = example(spec, s.additionalProperties, depth + 1);
    }
    return out;
  }
  if (s.enum) return s.enum[0];
  if (s.type === "integer" || s.type === "number") return 1;
  if (s.type === "boolean") return 1;
  if (s.type === "string") return "example";
  return null;
}

function responseSchema(op) {
  return op?.responses?.["200"]?.content?.["application/json"]?.schema;
}

function whmExample(fn, params) {
  const metadata = { result: 1, reason: "OK", command: fn, version: 1 };
  if (fn === "uapi_cpanel") {
    const uop = operation(UAPI, `/${params.get("cpanel.module")}/${params.get("cpanel.function")}`);
    const result = resolve(UAPI, responseSchema(uop))?.properties?.result;
    const data = example(UAPI, resolve(UAPI, result)?.properties?.data ?? {});
    return { metadata, data: { uapi: { status: 1, errors: null, messages: null, warnings: null, metadata: {}, data } } };
  }
  const schema = resolve(WHM, responseSchema(operation(WHM, `/${fn}`)));
  if (!schema) return { metadata };
  const body = schema.properties?.data ? { data: example(WHM, schema.properties.data) } : example(WHM, schema) ?? {};
  return { ...body, metadata: { ...(body.metadata ?? {}), ...metadata } };
}

const b64 = (s) => Buffer.from(s).toString("base64");
const rr = (line_index, name, ttl, type, data) => ({
  type: "record",
  line_index,
  dname_b64: b64(name),
  ttl,
  record_type: type,
  data_b64: data.map(b64),
});

/** Responses where spec examples aren't enough to exercise the tool's logic. */
const FIXTURES = {
  parse_dns_zone: {
    data: {
      payload: [
        { type: "comment", line_index: 0, text_b64: b64("; zone for example.com") },
        { type: "control", line_index: 1, text_b64: b64("$TTL 14400") },
        rr(2, "example.com.", 86400, "SOA", ["ns1.example.com.", "admin.example.com.", "2025010101", "3600", "1800", "1209600", "86400"]),
        rr(10, "example.com.", 14400, "A", ["192.0.2.10"]),
        rr(11, "www", 14400, "CNAME", ["example.com."]),
        rr(12, "example.com.", 14400, "MX", ["0", "mail.example.com."]),
        rr(13, "example.com.", 14400, "TXT", ["v=spf1 +a +mx ~all"]),
        rr(15, "_sip._tcp", 14400, "SRV", ["10", "5", "5060", "sip.example.com."]),
        { type: "record", line_index: 16, dname_b64: b64("bin"), ttl: 300, record_type: "TXT", data_b64: [Buffer.from([0xff, 0xfe]).toString("base64")] },
      ],
    },
  },
  php_get_vhost_versions: {
    data: {
      versions: [
        { vhost: "fpm.example.com", account: "fpmuser", version: "ea-php81", php_fpm: 1, phpversion_source: [{ system_default: 1 }] },
        { vhost: "cgi.example.com", account: "cgiuser", version: "ea-php81", php_fpm: 0, phpversion_source: [{ domain: "example.com" }] },
      ],
    },
  },
  getdomainowner: { data: { user: "exampleuser" } },
  getpkginfo: {
    data: { pkg: { QUOTA: 1000, IP: 1, MAX_EMAIL_PER_HOUR: 500, MAX_DEFER_FAIL_PERCENTAGE: 30, MAXSUB: 5, FEATURELIST: "default", _PACKAGE_EXTENSIONS: "wp_toolkit", wp_toolkit_plan: "deluxe" } },
  },
  backup_destination_list: {
    data: {
      destination_list: [
        { id: "b2", name: "Backblaze", type: "Backblaze", disabled: 0, bucket_name: "backups", application_key_id: "key-id", application_key: "secret-value" },
        { id: "gd", name: "Drive", type: "GoogleDrive", disabled: 1, disable_reason: "token expired", client_id: "client", client_secret: "secret-value" },
      ],
    },
  },
};

// ---------------------------------------------------------------- mock WHM server

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

const requests = [];
let overrides = {};

const mock = createServer(selfSignedCert(), (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "https://127.0.0.1");
    const fn = decodeURIComponent(url.pathname.replace(/^\/json-api\//, ""));
    const params = new URLSearchParams(url.search);
    const problems = [];
    if (req.headers.authorization !== "whm root:test-token") problems.push(`${fn}: bad Authorization header`);
    if (req.method === "POST") {
      if (!String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded")) {
        problems.push(`${fn}: POST without a form-encoded body`);
      }
      new URLSearchParams(body).forEach((v, k) => params.append(k, v));
    }
    requests.push({ fn, method: req.method, params, problems });

    const override = overrides[fn];
    const status = override?.status ?? 200;
    const payload = override ? override.body : FIXTURES[fn] ? { metadata: { result: 1, command: fn }, ...FIXTURES[fn] } : whmExample(fn, params);
    res.writeHead(status, { "Content-Type": typeof payload === "string" ? "text/html" : "application/json" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));

// ---------------------------------------------------------------- test cases

/** Expectation helpers: exact string, RegExp, null (= absent), or predicate. */
const json = (expected) => (value) => isDeepStrictEqual(JSON.parse(value), expected);
const present = (value) => value !== undefined;

const LONG_TXT = "v=DKIM1; k=rsa; p=" + "A".repeat(400);

// [tool, arguments, expectations]; expectations map WHM functions to expected parameters.
const CASES = [
  // accounts
  ["whm_list_accounts", {}, { listaccts: {} }],
  ["whm_list_accounts", { searchtype: "user", search: "^bob$", searchmethod: "regex", limit: 1 }, { listaccts: { searchtype: "user", search: "^bob$" } }],
  ["whm_list_accounts", { search: "bob" }, { error: /searchtype/ }],
  ["whm_get_account_summary", { user: "bob" }, { accountsummary: { user: "bob" } }],
  ["whm_get_account_summary", {}, { error: /user.*domain/ }],
  ["whm_create_account", { username: "bob", domain: "bob.example", password: "Secret-123!", dedicated_ip: true, customip: "192.0.2.5", quota: 500, hasshell: false, bwlimit: "unlimited" },
    { createacct: { username: "bob", domain: "bob.example", ip: "y", customip: "192.0.2.5", quota: "500", hasshell: "0", bwlimit: "unlimited" } }],
  ["whm_remove_account", { user: "bob" }, { removeacct: { username: "bob", keepdns: "0", user: null } }],
  ["whm_suspend_account", { user: "bob", reason: "abuse", leave_ftp_accts_enabled: true }, { suspendacct: { user: "bob", reason: "abuse", "leave-ftp-accts-enabled": "1", disallowun: "0" } }],
  ["whm_unsuspend_account", { user: "bob" }, { unsuspendacct: { user: "bob" } }],
  ["whm_list_suspended_accounts", {}, { listsuspended: {} }],
  ["whm_modify_account", { user: "bob", contactemail: "a@b.example", QUOTA: 1000, HASSHELL: false, MAXADDON: "unlimited" },
    { modifyacct: { user: "bob", contactemail: "a@b.example", QUOTA: "1000", HASSHELL: "0", MAXADDON: "unlimited", CONTACTEMAIL: null } }],
  ["whm_modify_account", { user: "bob" }, { error: /Nothing to change/ }],
  ["whm_change_package", { user: "bob", pkg: "gold" }, { changepackage: { user: "bob", pkg: "gold" } }],
  ["whm_change_password", { user: "bob", password: "N3w-pass!" }, { passwd: { user: "bob", password: "N3w-pass!", db_pass_update: "1" } }],
  ["whm_list_users", { limit: 1 }, { list_users: {} }],
  ["whm_set_disk_quota", { user: "bob", quota: 2048 }, { editquota: { user: "bob", quota: "2048" } }],
  ["whm_set_bandwidth_limit", { user: "bob", bwlimit: "unlimited" }, { limitbw: { user: "bob", bwlimit: "unlimited" } }],
  ["whm_create_user_session", { user: "bob", app: "FileManager_Home" }, { create_user_session: { user: "bob", service: "cpaneld", app: "FileManager_Home" } }],
  // domains
  ["whm_list_domains", { domain_type: "addon" }, { get_domain_info: {} }],
  ["whm_get_domain_info", { domain: "example.com" }, { domainuserdata: { domain: "example.com" } }],
  ["whm_get_domain_owner", { domain: "example.com" }, { getdomainowner: { domain: "example.com" } }],
  // server
  ["whm_get_server_information", {}, { gethostname: {}, version: {}, systemloadavg: {}, system_needs_reboot: {}, listips: {}, get_current_users_count: {}, get_maximum_users: {}, current_mysql_version: {}, php_get_system_default_version: {} }],
  ["whm_get_version", {}, { version: {} }],
  ["whm_get_load_avg", {}, { systemloadavg: {} }],
  ["whm_get_disk_usage", {}, { getdiskusage: {} }],
  ["whm_get_account_disk_usage", { sort_by: "percent", cache_mode: "off" }, { get_disk_usage: { cache_mode: "off" } }],
  ["whm_get_bandwidth_usage", { month: 1, year: 2025, showres: "res" }, { showbw: { month: "1", year: "2025", showres: "res" } }],
  ["whm_get_hostname", {}, { gethostname: {} }],
  ["whm_set_hostname", { hostname: "srv2.example.com" }, { sethostname: { hostname: "srv2.example.com" } }],
  ["whm_check_service_status", { service: "httpd" }, { servicestatus: { service: "httpd" } }],
  ["whm_check_service_status", { problems_only: true }, { servicestatus: { service: null } }],
  ["whm_restart_service", { service: "httpd" }, { restartservice: { service: "httpd" } }],
  ["whm_configure_service", { service: "exim", monitored: true }, { configureservice: { service: "exim", monitored: "1", enabled: null } }],
  ["whm_configure_service", { service: "exim" }, { error: /enabled.*monitored/ }],
  ["whm_list_ips", {}, { listips: {} }],
  ["whm_reboot_server", {}, { reboot: { force: "0" } }],
  ["whm_get_tweak_setting", { key: "defaultmailaction" }, { get_tweaksetting: { key: "defaultmailaction" } }],
  ["whm_set_tweak_setting", { key: "proxysubdomains", value: false }, { set_tweaksetting: { key: "proxysubdomains", value: "0" } }],
  // dns
  ["whm_list_dns_zones", { search: "exa" }, { listzones: {} }],
  ["whm_get_dns_zone", { domain: "example.com", type: "mx" }, { parse_dns_zone: { zone: "example.com" }, text: /serial"?:? 2025010101[\s\S]*mail\.example\.com\./ }],
  ["whm_create_dns_zone", { domain: "new.example", ip: "192.0.2.20" }, { adddns: { domain: "new.example", ip: "192.0.2.20" } }],
  ["whm_delete_dns_zone", { domain: "old.example" }, { killdns: { domain: "old.example" } }],
  ["whm_add_dns_record", { domain: "example.com", name: "www2", type: "a", address: "192.0.2.30" },
    { mass_edit_dns_zone: { zone: "example.com", serial: "2025010101", add: json({ dname: "www2", ttl: 14400, record_type: "A", data: ["192.0.2.30"] }) } }],
  ["whm_add_dns_record", { domain: "example.com", name: "example.com", type: "MX", exchange: "mx2.example.com.", preference: 20 },
    { mass_edit_dns_zone: { add: json({ dname: "example.com.", ttl: 14400, record_type: "MX", data: ["20", "mx2.example.com."] }) } }],
  ["whm_add_dns_record", { domain: "example.com", name: "@", type: "MX", exchange: "mx3.example.com", preference: 30 },
    { mass_edit_dns_zone: { add: json({ dname: "example.com.", ttl: 14400, record_type: "MX", data: ["30", "mx3.example.com."] }) } }],
  ["whm_add_dns_record", { domain: "example.com", name: "default._domainkey", type: "TXT", txtdata: LONG_TXT },
    { mass_edit_dns_zone: { add: (v) => { const r = JSON.parse(v); return r.data.length === 2 && r.data.join("") === LONG_TXT && r.data[0].length === 255; } } }],
  ["whm_add_dns_record", { domain: "example.com", name: "@", type: "CAA", caa_tag: "issue", caa_value: "letsencrypt.org", serial: 42 },
    { mass_edit_dns_zone: { serial: "42", add: json({ dname: "example.com.", ttl: 14400, record_type: "CAA", data: ["0", "issue", "letsencrypt.org"] }) } }],
  ["whm_add_dns_record", { domain: "example.com", name: "x", type: "SRV", target: "sip.example.com." }, { error: /port/ }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 10, address: "192.0.2.99" },
    { mass_edit_dns_zone: { edit: json({ line_index: 10, dname: "example.com.", ttl: 14400, record_type: "A", data: ["192.0.2.99"] }) } }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 11, ttl: 300 },
    { mass_edit_dns_zone: { edit: json({ line_index: 11, dname: "www", ttl: 300, record_type: "CNAME", data: ["example.com."] }) } }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 99, address: "192.0.2.1" }, { error: /No record starts at line_index 99/ }],
  ["whm_remove_dns_record", { domain: "example.com", line_index: 13 }, { mass_edit_dns_zone: { remove: "13", serial: "2025010101" } }],
  ["whm_remove_dns_record", { domain: "example.com", line_index: 2 }, { error: /SOA/ }],
  ["whm_mass_edit_dns_zone", { domain: "example.com", add: [{ name: "a", type: "A", data: ["192.0.2.1"] }], remove: [11, 13] },
    { mass_edit_dns_zone: { remove: "11", "remove-1": "13", add: json({ dname: "a", ttl: 14400, record_type: "A", data: ["192.0.2.1"] }) } }],
  ["whm_mass_edit_dns_zone", { domain: "example.com" }, { error: /at least one/ }],
  ["whm_reset_dns_zone", { domain: "example.com" }, { resetzone: { domain: "example.com" } }],
  // email
  ["whm_get_mail_queue_summary", {}, { fetch_mail_queue: {} }],
  ["whm_list_mail_queue", { frozen_only: true }, { fetch_mail_queue: {} }],
  ["whm_get_exim_stats", { starttime: "2025-01-01T00:00:00Z", endtime: 1735776000 }, { emailtrack_user_stats: { starttime: "1735689600", endtime: "1735776000" } }],
  ["whm_get_exim_stats", { starttime: "not a date" }, { error: /Could not parse time/ }],
  ["whm_search_mail_delivery_log", { sender: "a@example.com", types: ["failure", "defer"], limit: 10, offset: 10 },
    { emailtrack_search: { success: "0", failure: "1", defer: "1", inprogress: "0", "api.filter.enable": "1", "api.filter.a.field": "sendunixtime", "api.filter.a.type": "gt", "api.filter.b.field": "sender", "api.filter.b.arg0": "a@example.com", "api.filter.c.field": null, "api.sort.a.field": "sendunixtime", "api.sort.a.method": "numeric", "api.sort.a.reverse": "1", "api.chunk.size": "10", "api.chunk.start": "11" } }],
  ["whm_manage_outgoing_email", { user: "bob", action: "hold" }, { hold_outgoing_email: { user: "bob" } }],
  ["whm_manage_outgoing_email", { user: "bob", action: "unsuspend" }, { unsuspend_outgoing_email: { user: "bob" } }],
  ["whm_list_pop_accounts_for_user", { user: "bob" }, { list_pops_for: { user: "bob" } }],
  ["whm_list_pop_accounts_with_disk", { user: "bob", domain: "bob.example" },
    { uapi_cpanel: { "cpanel.user": "bob", "cpanel.module": "Email", "cpanel.function": "list_pops_with_disk", domain: "bob.example" } }],
  ["whm_validate_mail_dns", { domains: ["a.example", "b.example"] },
    { validate_current_dkims: { domain: "a.example", "domain-1": "b.example" }, validate_current_spfs: {}, validate_current_dmarcs: {}, validate_current_ptrs: {} }],
  ["whm_enable_dkim", { domains: ["a.example"] }, { enable_dkim: { domain: "a.example" } }],
  ["whm_validate_exim_config", {}, { validate_exim_configuration_syntax: {} }],
  // packages
  ["whm_list_packages", { want: "creatable" }, { listpkgs: { want: "creatable" } }],
  ["whm_get_package", { pkg: "gold" }, { getpkginfo: { pkg: "gold" } }],
  ["whm_create_package", { name: "gold", quota: 1024, maxaddon: "unlimited", max_email_per_hour: 200, hasshell: true, dedicated_ip: false },
    { addpkg: { name: "gold", quota: "1024", maxaddon: "unlimited", MAX_EMAIL_PER_HOUR: "200", hasshell: "1", ip: "n", QUOTA: null } }],
  ["whm_edit_package", { name: "gold", quota: 4096 },
    { editpkg: { quota: "4096", ip: "y", max_email_per_hour: "500", max_defer_fail_percentage: "30", wp_toolkit_plan: "deluxe", _PACKAGE_EXTENSIONS: "wp_toolkit" } }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 12, preference: 20 },
    { mass_edit_dns_zone: { edit: json({ line_index: 12, dname: "example.com.", ttl: 14400, record_type: "MX", data: ["20", "mail.example.com."] }) } }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 15, port: 5061 },
    { mass_edit_dns_zone: { edit: json({ line_index: 15, dname: "_sip._tcp", ttl: 14400, record_type: "SRV", data: ["10", "5", "5061", "sip.example.com."] }) } }],
  ["whm_edit_dns_record", { domain: "example.com", line_index: 16, ttl: 60 }, { error: /binary data/ }],
  ["whm_add_dns_record", { domain: "example.com", name: "x", type: "CNAME", cname: "target.example.net" },
    { mass_edit_dns_zone: { add: json({ dname: "x", ttl: 14400, record_type: "CNAME", data: ["target.example.net."] }) } }],
  ["whm_mass_edit_dns_zone", { domain: "example.com", edit: [{ line_index: 11, ttl: 60 }], add: [{ name: "m", type: "MX", data: ["10", "mx.example.com"] }] },
    { mass_edit_dns_zone: { edit: json({ line_index: 11, dname: "www", ttl: 60, record_type: "CNAME", data: ["example.com."] }), add: json({ dname: "m", ttl: 14400, record_type: "MX", data: ["10", "mx.example.com."] }) } }],
  ["whm_configure_service", { service: "cpsrvd", enabled: false }, { error: /cpsrvd/ }],
  ["whm_edit_package", { name: "gold", quota: 4096, max_email_per_hour: 100 },
    { getpkginfo: { pkg: "gold" }, editpkg: { name: "gold", quota: "4096", max_email_per_hour: "100", maxsub: present, featurelist: present, _PACKAGE_EXTENSIONS: present } }],
  ["whm_edit_package", { name: "gold" }, { error: /Nothing to change/ }],
  ["whm_delete_package", { pkg: "gold" }, { killpkg: { pkgname: "gold", pkg: null } }],
  // ssl
  ["whm_list_ssl_certs", { expiring_within_days: 100000 }, { listcrts: {} }],
  ["whm_get_ssl_info", { domain: "example.com" }, { fetch_ssl_vhosts: {} }],
  ["whm_install_ssl", { domain: "example.com", crt: "-----BEGIN CERTIFICATE-----", key: "-----BEGIN PRIVATE KEY-----" }, { installssl: { domain: "example.com", crt: present, key: present } }],
  ["whm_start_autossl_check", { user: "bob" }, { start_autossl_check_for_one_user: { username: "bob" } }],
  ["whm_start_autossl_check", {}, { start_autossl_check_for_all_users: {} }],
  ["whm_get_autossl_problems", { domain: "example.com" }, { get_autossl_problems_for_domain: { domain: "example.com" } }],
  ["whm_get_autossl_problems", { user: "bob" }, { get_autossl_problems_for_user: { username: "bob" } }],
  ["whm_get_autossl_log", { types: ["warn", "failure"] }, { get_autossl_logs_catalog: {}, get_autossl_log: { start_time: present } }],
  // backups
  ["whm_get_backup_config", {}, { backup_config_get: {} }],
  ["whm_list_backup_destinations", {}, { backup_destination_list: {}, text: (t) => !/secret-value/.test(t) }],
  ["whm_list_backup_dates", {}, { backup_date_list: {} }],
  ["whm_list_backup_users", { restore_point: "2025-01-31" }, { backup_user_list: { restore_point: "2025-01-31" } }],
  ["whm_backup_account", { user: "bob", skiphomedir: true }, { start_background_pkgacct: { user: "bob", compressionsetting: "compress", skiphomedir: "1" } }],
  ["whm_get_account_backup_status", { session_id: "abc" }, { get_pkgacct_session_state: { session_id: "abc" } }],
  // The spec's example queue has a pending restore, so starting the queue must be refused.
  ["whm_restore_account", { user: "bob", restore_point: "2025-01-31" }, { error: /pending restore/ }],
  ["whm_restore_account", { user: "bob", restore_point: "2025-01-31", activate: false },
    { restore_queue_add_task: { user: "bob", restore_point: "2025-01-31", mysql: "1", mail_config: "1", subdomains: "1", give_ip: "0" } }],
  // backup_date_list reports ISO timestamps; restores take YYYY-MM-DD.
  ["whm_restore_account", { user: "bob", restore_point: "2025-01-31T00:00:00.000Z", activate: false },
    { restore_queue_add_task: { restore_point: "2025-01-31" }, calls: { restore_queue_activate: 0 } }],
  ["whm_get_restore_queue", {}, { restore_queue_state: {} }],
  // resellers
  ["whm_list_resellers", {}, { listresellers: {} }],
  ["whm_get_reseller_stats", { user: "res" }, { resellerstats: { user: "res", filter_deleted: "1" }, acctcounts: { user: "res" } }],
  ["whm_set_reseller_limits", { user: "res", account_limit: 10, diskspace_limit: 5000, enable_account_limit: true, enable_resource_limits: true },
    { setresellerlimits: { user: "res", account_limit: "10", enable_account_limit: "1", diskspace_limit: "5000", enable_resource_limits: "1" } }],
  ["whm_set_reseller_limits", { user: "res", enable_overselling: true, enable_account_limit: false, enable_resource_limits: true }, { setresellerlimits: { enable_overselling: "1", enable_account_limit: "0", enable_resource_limits: "1" } }],
  ["whm_set_reseller_limits", { user: "res", account_limit: 5 }, { error: /enable_resource_limits|Required/ }],
  ["whm_setup_reseller", { user: "bob" }, { setupreseller: { user: "bob", makeowner: "0" } }],
  ["whm_remove_reseller", { user: "bob" }, { unsetupreseller: { user: "bob" } }],
  // security
  ["whm_get_cphulk_status", {}, { cphulk_status: {} }],
  ["whm_get_failed_logins", {}, { get_cphulk_failed_logins: {} }],
  ["whm_get_failed_logins", { report: "excessive_brutes" }, { get_cphulk_excessive_brutes: {} }],
  ["whm_list_cphulk_records", { list_name: "white" }, { read_cphulk_records: { list_name: "white" } }],
  ["whm_add_cphulk_record", { list_name: "white", ips: ["192.0.2.1", "198.51.100.0/24"], comment: "office" },
    { create_cphulk_record: { list_name: "white", ip: "192.0.2.1", "ip-1": "198.51.100.0/24", comment: "office" } }],
  ["whm_remove_cphulk_record", { list_name: "black", ips: ["192.0.2.1"] }, { delete_cphulk_record: { list_name: "black", ip: "192.0.2.1" } }],
  ["whm_unblock_ips", { ips: ["192.0.2.1"] }, { flush_cphulk_login_history_for_ips: { ip: "192.0.2.1" } }],
  ["whm_get_security_advice", { levels: ["bad", "warn", "info", "good"] }, { fetch_security_advice: {} }],
  // software
  ["whm_list_php_versions", {}, { php_get_installed_versions: {}, php_get_system_default_version: {} }],
  ["whm_get_php_vhost_versions", { user: "fpmuser" }, { php_get_vhost_versions: {} }],
  ["whm_set_php_vhost_version", { vhosts: ["fpm.example.com", "cgi.example.com"], version: "ea-php83" },
    { php_get_vhost_versions: {}, php_set_vhost_versions: { version: "ea-php83", vhost: "fpm.example.com", php_fpm: "1" }, calls: { php_set_vhost_versions: 2 } }],
  ["whm_set_php_vhost_version", { vhosts: ["nope.example.com"], version: "ea-php83" }, { error: /Unknown virtual host/ }],
  ["whm_set_php_vhost_version", { vhosts: ["a.example", "b.example"], version: "inherit", php_fpm: true },
    { php_set_vhost_versions: { vhost: "a.example", "vhost-1": "b.example", php_fpm: "1" }, calls: { php_get_vhost_versions: 0 } }],
  ["whm_list_databases", { engine: "mysql" }, { list_databases: {} }],
  // logs
  ["whm_get_domain_error_log", { domain: "example.com" },
    { getdomainowner: { domain: "example.com" }, uapi_cpanel: { "cpanel.user": "exampleuser", "cpanel.module": "Stats", "cpanel.function": "get_site_errors", domain: "example.com", log: "error", maxlines: "200" } }],
  ["whm_get_modsec_log", { rule_id: 1 }, { modsec_get_log: {} }],
  // api
  ["whm_list_api_functions", { search: "dns" }, { applist: {} }],
  ["whm_call_api", { function: "listacls", params: {} }, { listacls: {} }],
  ["whm_call_uapi", { user: "bob", module: "Email", function: "list_pops", params: { regex: "info" } },
    { uapi_cpanel: { "cpanel.user": "bob", "cpanel.module": "Email", "cpanel.function": "list_pops", regex: "info" } }],
];

// Error handling: WHM failures must come back as tool errors with WHM's reason.
const ERROR_CASES = [
  ["WHM metadata.result=0", "whm_get_version", {}, { version: { body: { metadata: { result: 0, reason: "Access denied for token", command: "version" } } } }, /Access denied for token/],
  ["HTTP 401", "whm_get_version", {}, { version: { status: 401, body: { metadata: { reason: "Invalid token" } } } }, /authentication failed.*Invalid token/],
  ["non-JSON body", "whm_get_version", {}, { version: { body: "<html>login</html>" } }, /non-JSON/],
  ["UAPI status=0", "whm_call_uapi", { user: "bob", module: "Email", function: "list_pops" },
    { uapi_cpanel: { body: { metadata: { result: 1 }, data: { uapi: { status: 0, errors: ["You do not have the feature"] } } } } }, /You do not have the feature/],
  ["server info with every call failing", "whm_get_server_information", {},
    Object.fromEntries(["gethostname", "version", "systemloadavg", "system_needs_reboot", "listips", "get_current_users_count", "get_maximum_users", "current_mysql_version", "php_get_system_default_version"]
      .map((fn) => [fn, { status: 403, body: {} }])), /authentication failed/],
];

// ---------------------------------------------------------------- run

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: {
    ...process.env,
    WHM_HOST: "127.0.0.1",
    WHM_PORT: String(mock.address().port),
    WHM_USER: "root",
    WHM_TOKEN: "test-token",
    WHM_INSECURE_TLS: "true",
    WHM_READ_ONLY: "",
    WHM_TOOLSETS: "",
  },
  stderr: "pipe",
});
const client = new Client({ name: "verify-spec", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();

const failures = [];
const covered = new Set();
const textOf = (result) => (result.content ?? []).map((c) => c.text ?? "").join("\n");

function checkExpectations(label, expect, calls, result) {
  const text = textOf(result);
  if (expect.error) {
    if (!result.isError || !expect.error.test(text)) failures.push(`${label}: expected an error matching ${expect.error}, got: ${text.slice(0, 200)}`);
    return;
  }
  if (result.isError) failures.push(`${label}: unexpected error: ${text.slice(0, 300)}`);
  if (expect.text && !(typeof expect.text === "function" ? expect.text(text) : expect.text.test(text))) {
    failures.push(`${label}: output doesn't match ${expect.text}: ${text.slice(0, 200)}`);
  }
  for (const [fn, n] of Object.entries(expect.calls ?? {})) {
    const count = calls.filter((c) => c.fn === fn).length;
    if (count !== n) failures.push(`${label}: expected ${n} call(s) to ${fn}, got ${count}`);
  }
  for (const [fn, params] of Object.entries(expect)) {
    if (["error", "text", "calls"].includes(fn)) continue;
    const call = calls.find((c) => c.fn === fn);
    if (!call) {
      failures.push(`${label}: expected a call to ${fn}; got ${calls.map((c) => c.fn).join(", ") || "none"}`);
      continue;
    }
    for (const [key, want] of Object.entries(params)) {
      const got = call.params.has(key) ? call.params.get(key) : undefined;
      const okay =
        want === null ? got === undefined :
        typeof want === "function" ? got !== undefined && want(got) :
        want instanceof RegExp ? got !== undefined && want.test(got) :
        got === want;
      if (!okay) failures.push(`${label}: ${fn} ${key}: expected ${want === null ? "absent" : want}, got ${got === undefined ? "absent" : JSON.stringify(got)}`);
    }
  }
}

for (const [tool, args, expect] of CASES) {
  covered.add(tool);
  for (const response_format of ["markdown", "json"]) {
    const label = `${tool} ${JSON.stringify(args)}${response_format === "json" ? " [json]" : ""}`;
    requests.length = 0;
    overrides = {};
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: { ...args, response_format } });
    } catch (e) {
      failures.push(`${label}: call threw: ${e.message}`);
      continue;
    }
    const calls = [...requests];
    for (const call of calls) for (const p of [...call.problems, ...checkRequest(call)]) failures.push(`${label}: ${p}`);
    checkExpectations(label, expect, calls, result);
    if (!result.isError) {
      if (!textOf(result).trim()) failures.push(`${label}: empty text output`);
      const sc = result.structuredContent;
      if (sc !== undefined && (sc === null || typeof sc !== "object" || Array.isArray(sc))) failures.push(`${label}: structuredContent is not an object`);
      if (response_format === "json") {
        try {
          JSON.parse(textOf(result));
        } catch {
          failures.push(`${label}: JSON output does not parse`);
        }
      }
    }
  }
}

for (const [name, tool, args, mockOverrides, expected] of ERROR_CASES) {
  requests.length = 0;
  overrides = mockOverrides;
  const result = await client.callTool({ name: tool, arguments: args });
  const text = textOf(result);
  if (!result.isError || !expected.test(text)) failures.push(`error case '${name}': expected an error matching ${expected}, got: ${text.slice(0, 200)}`);
}
overrides = {};

for (const t of tools) {
  if (!covered.has(t.name)) failures.push(`${t.name}: no test case`);
  if (!t.annotations || typeof t.annotations.readOnlyHint !== "boolean") failures.push(`${t.name}: missing annotations`);
}

await client.close();
mock.close();

const functions = new Set(CASES.flatMap(([, , e]) => Object.keys(e).filter((k) => !["error", "text", "calls"].includes(k))));
if (failures.length) {
  console.log(`\n${failures.length} problem(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `OK: ${tools.length} tools, ${CASES.length} cases (x2 formats) and ${ERROR_CASES.length} error cases; ` +
    `${functions.size} WHM functions checked against WHM API ${WHM.info.version} and cPanel UAPI ${UAPI.info.version}.`
);
