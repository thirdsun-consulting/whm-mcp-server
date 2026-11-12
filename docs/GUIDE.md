# WHM MCP Server — Guide

This guide explains what the server is, how it works, how to connect it to Claude (or any MCP client), how to use it day to day, and everything it can do.

- [1. What it is](#1-what-it-is)
- [2. How it works](#2-how-it-works)
- [3. Setup](#3-setup)
- [4. Connecting it](#4-connecting-it)
- [5. Configuration reference](#5-configuration-reference)
- [6. Using it](#6-using-it)
- [7. Tool reference](#7-tool-reference)
- [8. Safety model](#8-safety-model)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Maintaining it](#10-maintaining-it)

---

## 1. What it is

`whm-mcp-server` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant such as Claude administer a cPanel & WHM server. It wraps the official [WHM API 1](https://api.docs.cpanel.net/whm/introduction) in 91 purpose-built tools: accounts, domains, DNS, email, packages, SSL, backups, resellers, login security, PHP, logs. Two escape-hatch tools reach any other WHM or UAPI function.

You ask in plain language ("why is mail from example.com bouncing?", "which accounts are over 90% of their quota?"), and Claude picks the tools, calls WHM, and explains the results.

It is **server-level** (root or reseller) administration. For per-account work inside cPanel, the companion `cpanel-mcp-server` is a better fit, though `whm_call_uapi` can run any cPanel UAPI function as any account.

## 2. How it works

```
 Claude / MCP client ──MCP (stdio or HTTP)──▶ whm-mcp-server ──HTTPS :2087──▶ WHM API 1 (json-api)
                                                    │
                                                    └─ uapi_cpanel ──▶ cPanel UAPI (as a given account)
```

1. **The MCP client** (Claude Desktop, Claude Code, claude.ai, the MCP Inspector) lists the server's tools and calls them with JSON arguments.
2. **The server** validates the arguments (zod schemas), turns them into WHM API calls, and formats the result.
3. **WHM** is called at `https://WHM_HOST:2087/json-api/<function>?api.version=1`. It authenticates with an API token: `Authorization: whm <user>:<token>`.

Details worth knowing:

- **Parameters follow WHM's conventions.** Booleans are sent as `1`/`0`. Multi-value parameters use `name`, `name-1`, `name-2`…. Reads use GET; changes use POST, so long values and secrets aren't put in URLs.
- **Errors are unwrapped.** WHM reports failures inside a `metadata.result = 0` envelope (UAPI uses `status`/`errors`). The server turns these into tool errors that carry WHM's own reason. Network, TLS, auth and timeout failures get specific messages.
- **Output.** Every tool returns readable markdown by default, or full JSON with `response_format: "json"`. Results also carry `structuredContent` for clients that use it. Large lists are paged with `limit`/`offset`, and responses are capped (~25k characters) to protect the model's context.
- **Multi-step tools.** Some tools make several calls to do the safe thing. For example:
  - `whm_edit_package` reads the plan first and resends its current settings.
  - DNS edits fetch the zone to find the record and the current serial.
  - `whm_get_server_information` combines 9 calls.
- **Transports.** By default the server talks MCP over **stdio**: the client launches it as a local process. With `--http` it serves **Streamable HTTP**, so it can be hosted and reached remotely.

## 3. Setup

Requirements: Node.js 18+, and network access from where the server runs to your WHM on port 2087.

```bash
git clone https://github.com/brnegash21/whm-mcp-server
cd whm-mcp-server
npm install
npm run build
```

### Create a WHM API token

1. In WHM, go to **Development → Manage API Tokens → Generate Token**.
2. Give it only the privileges (ACLs) you need:
   - **Monitoring/support:** list-accts, show-bandwidth, status, stats, mailcheck, and similar read privileges.
   - **Full administration:** `all`.
3. Optionally set an expiry, and restrict the token to the IP the server connects from.
4. Copy the token. WHM shows it only once.

A reseller's token works too. Tools are then limited to what that reseller may do.

## 4. Connecting it

### Claude Code (local, stdio)

```bash
claude mcp add --env WHM_HOST=srv.example.com --env WHM_TOKEN=YOUR_TOKEN \
  --env WHM_READ_ONLY=true --transport stdio whm -- node /absolute/path/whm-mcp-server/dist/index.js
```

Keep `--transport stdio` between the `--env` flags and the name. Check the server is connected with `claude mcp list`, or with `/mcp` inside Claude Code.

### Claude Desktop (local, stdio)

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "whm": {
      "command": "node",
      "args": ["/absolute/path/whm-mcp-server/dist/index.js"],
      "env": {
        "WHM_HOST": "srv.example.com",
        "WHM_USER": "root",
        "WHM_TOKEN": "YOUR_TOKEN",
        "WHM_READ_ONLY": "true"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the tools (🔌) menu.

### claude.ai, mobile, or any remote client (HTTP)

claude.ai connectors must be **remote**, public **HTTPS** servers; they can't launch local processes.

1. **Run the server in HTTP mode** on a host that can reach WHM (the WHM box itself or a small VPS):

   ```bash
   export WHM_HOST=srv.example.com WHM_TOKEN=YOUR_TOKEN
   export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"   # keep this secret
   node dist/index.js --http                          # listens on http://127.0.0.1:3000/mcp
   ```

   Run it under systemd or pm2 so it restarts.

2. **Put HTTPS in front.** For example, with Caddy (automatic certificates):

   ```
   mcp.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   A Cloudflare Tunnel or nginx works too. Optionally allow only Anthropic's range `160.79.104.0/21` at the firewall.

3. **Add the connector in claude.ai:** Customize → Connectors → **Add custom connector**.
   - URL: `https://mcp.example.com/mcp`
   - Authentication: **No sign-in**
   - **Request headers:** header `authorization`, value `Bearer <MCP_AUTH_TOKEN>`, including the word `Bearer` and the space.

   > Request headers are a beta that only some organizations have. If your dialog has no **Request headers** section, claude.ai can't authenticate to this server yet. Use Claude Code or Desktop, or ask for OAuth support to be added.

4. In a chat, enable the connector from the **+ → Connectors** menu. In the connector's settings you can set individual tools to *Always allow*, *Ask*, or *Blocked*.

**Claude Code against the remote server:**

```bash
claude mcp add --transport http whm https://mcp.example.com/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**HTTP mode starts read-only.** Set `WHM_READ_ONLY=false` on the server only when you want remote write access.

### MCP Inspector (manual testing)

```bash
WHM_HOST=... WHM_TOKEN=... npm run inspect
```

This opens a browser UI where you can call each tool by hand, which is useful to confirm the token works.

## 5. Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `WHM_HOST` | — (required) | WHM hostname or IP. A pasted URL like `https://srv:2087/` also works. |
| `WHM_TOKEN` | — (required) | WHM API token. |
| `WHM_USER` | `root` | User the token belongs to (root or a reseller). |
| `WHM_PORT` | `2087` | WHM port. |
| `WHM_INSECURE_TLS` | off | `true` skips certificate checks (self-signed certificates). Prefer connecting by the certificate's hostname. |
| `WHM_TIMEOUT_MS` | `60000` | Per-request timeout. Raise it for slow operations such as account creation. |
| `WHM_READ_ONLY` | off (stdio) / **on** (HTTP) | Register only read-only tools. Anything except empty/`0`/`false`/`no`/`off` means on. |
| `WHM_TOOLSETS` | all | Comma-separated toolsets to enable, e.g. `accounts,dns,email`. |
| `MCP_TRANSPORT` | `stdio` | `http` enables HTTP mode (same as `--http`). |
| `MCP_AUTH_TOKEN` | — | **Required in HTTP mode**, at least 32 characters. |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address. |
| `MCP_HTTP_PORT` | `3000` | HTTP port (`0` picks a free port). |
| `MCP_HTTP_PATH` | `/mcp` | HTTP endpoint path. |

**Toolsets:** `accounts`, `domains`, `server`, `dns`, `email`, `packages`, `ssl`, `backups`, `resellers`, `security`, `software`, `logs`, `api`.

All 91 tool definitions come to about 24k tokens of context. Trimming the toolsets makes the model faster and more accurate.

## 6. Using it

Talk to Claude normally; you don't need to name tools. Some examples, with what happens behind them:

| You ask | Tools Claude typically uses |
|---|---|
| "Give me a health check of the server." | `get_server_information`, `check_service_status` (problems only), `get_disk_usage` |
| "Which accounts are closest to their disk quota?" | `get_account_disk_usage` sorted by percent |
| "Why didn't bob@example.com get the email from alice@shop.com?" | `search_mail_delivery_log` by recipient/sender → the remote server's rejection message |
| "The mail queue is huge — what's going on?" | `get_mail_queue_summary` (top senders/accounts), then `manage_outgoing_email` hold on the spammer |
| "Is example.com's mail set up right?" | `validate_mail_dns` (DKIM, SPF, DMARC, PTR), then `enable_dkim` if missing |
| "Point www.example.com at 203.0.113.9." | `get_dns_zone` → `edit_dns_record` on that line (only the address changes) |
| "Why is example.com showing a 500 error?" | `get_domain_error_log` (Apache error_log for the domain) |
| "A customer says they're locked out." | `get_failed_logins` → `unblock_ips` |
| "Which SSL certificates expire this month? Why didn't AutoSSL renew shop.com?" | `list_ssl_certs expiring_within_days=30`, `get_autossl_problems`, `get_autossl_log` |
| "Back up bob's account, then move it to PHP 8.3." | `backup_account` → `get_account_backup_status` → `set_php_vhost_version` (PHP-FPM setting kept) |
| "Restore bob from last Tuesday's backup." | `list_backup_dates` → `restore_account` |
| "Give me a login link for bob's cPanel file manager." | `create_user_session app=FileManager_Home` |
| "Suspend the account for nonpayment." | `suspend_account` with a reason |

Tips:

- **Changes are confirmed.** Tools that change or delete things are flagged destructive, and their descriptions ask Claude to confirm with you. Most clients also show an approval prompt.
- **Start read-only.** `WHM_READ_ONLY=true` lets you explore safely. Switch it off when you trust the setup.
- **Page through large lists.** They come in pages, so ask for "the next page" or "show only suspended ones" (filters are cheaper than paging).
- **Ask for JSON** ("give me the raw JSON") when you want every field.
- **Anything not covered** is still reachable: Claude can use `whm_list_api_functions` and `whm_call_api` with any function from the [WHM API docs](https://api.docs.cpanel.net/whm/introduction).

## 7. Tool reference

All names are prefixed `whm_`. **R** = read-only. **W** = changes something but isn't destructive. **D** = destructive: it overwrites, deletes, suspends or restarts something, so confirm first. Every tool accepts `response_format` (`markdown`|`json`); list tools also take `limit` (1–200, default 50) and `offset`.

### accounts

| Tool | | What it does |
|---|---|---|
| `list_accounts` | R | Accounts with disk, package, owner, suspension, IP. Filter with `searchtype` + `search` (regex or exact). |
| `get_account_summary` | R | Full detail for one account (by user or domain). |
| `create_account` | W | Create an account (uses a license seat): package or quota/bandwidth, dedicated/custom IP, reseller flag, SPF/DKIM. |
| `remove_account` | D | Permanently delete an account (optionally keep DNS). |
| `suspend_account` / `unsuspend_account` | D / W | Suspend with a reason (optionally root-only unsuspend), or unsuspend. |
| `list_suspended_accounts` | R | Suspended accounts with reason and time. |
| `modify_account` | D | Rename, change domain/contact/owner, set limits, shell, CGI, hourly email limit. |
| `change_package` | D | Move an account to another package. |
| `change_password` | D | Change the password (and the MySQL password by default). |
| `list_users` | R | All account usernames. |
| `set_disk_quota` / `set_bandwidth_limit` | D | Quota or monthly bandwidth in MB (`0`/`unlimited` = unlimited). |
| `create_user_session` | W | One-time login URL for cPanel, WHM or Webmail, optionally opening a specific app. Treat it like a password. |

### domains

| Tool | | What it does |
|---|---|---|
| `list_domains` | R | Every domain with type, owner, docroot, IPs, PHP version. |
| `get_domain_info` | R | Web server config for one domain (docroot, aliases, logs…). |
| `get_domain_owner` | R | Which account owns a domain. |

### server

| Tool | | What it does |
|---|---|---|
| `get_server_information` | R | Hostname, version, load, pending reboot, main IP, account count vs. license, MySQL and PHP versions. |
| `get_version`, `get_load_avg`, `get_hostname` | R | Single facts. |
| `get_disk_usage` | R | Partitions: space and inodes, with ⚠️ at 90% or more. |
| `get_account_disk_usage` | R | Per-account usage vs. quota, sortable by space or percent. |
| `get_bandwidth_usage` | R | Monthly bandwidth per account, highest first. |
| `check_service_status` | R | Service states; `problems_only` shows enabled services that are down. |
| `restart_service` | D | Restart a service (brief outage). |
| `configure_service` | D | Enable/disable a service or its monitoring. Refuses to disable cpsrvd. |
| `list_ips` | R | Server IPv4 addresses and their status. |
| `set_hostname` | D | Change the server hostname. |
| `reboot_server` | D | Graceful or forced reboot. |
| `get_tweak_setting` / `set_tweak_setting` | R / D | Read or change a Tweak Settings key. |

### dns

| Tool | | What it does |
|---|---|---|
| `list_dns_zones` | R | Zones on the server. |
| `get_dns_zone` | R | Records with `line_index` and the zone serial; filter by type or name. |
| `create_dns_zone` / `delete_dns_zone` | W / D | Create or delete a zone. |
| `add_dns_record` | W | Add a record using per-type fields (`address`, `cname`, `exchange`+`preference`, `txtdata`, SRV fields, CAA fields) or a raw `data` array. |
| `edit_dns_record` | D | Change a record by `line_index`; only the fields you pass change. |
| `remove_dns_record` | D | Remove a record (won't remove the SOA). |
| `mass_edit_dns_zone` | D | Add, edit and remove many records in one atomic update. |
| `reset_dns_zone` | D | Reset a zone to defaults (keeps valid TXT records). |

DNS name rules:
- `@` means the zone apex.
- Dotless names like `www` are relative to the zone.
- Names containing a dot are treated as fully qualified; the trailing dot is added for you.
- Long TXT values (DKIM keys) are split automatically.
- Edits pass the zone serial, so they fail rather than overwrite concurrent changes.

### email

| Tool | | What it does |
|---|---|---|
| `get_mail_queue_summary` | R | Queue size, frozen count, oldest message, top senders, accounts and recipient domains. |
| `list_mail_queue` | R | Queued messages; filter by sender, recipient, account, frozen. |
| `get_exim_stats` | R | Per-account sent/delivered/failed/deferred over a time window, and whether hourly limits were hit. |
| `search_mail_delivery_log` | R | Delivery records (success/defer/failure/in progress) with the remote server's response. |
| `manage_outgoing_email` | D | Hold, release, suspend or unsuspend an account's outbound mail. |
| `list_pop_accounts_for_user` | R | An account's email addresses. |
| `list_pop_accounts_with_disk` | R | Mailboxes with usage, quota and suspension flags, largest first. |
| `validate_mail_dns` | R | DKIM, SPF, DMARC and PTR checks, with expected or suggested records. |
| `enable_dkim` | D | Enable DKIM and publish its records. |
| `validate_exim_config` | R | Exim config syntax check (failing line, or enabled features). |

### packages

| Tool | | What it does |
|---|---|---|
| `list_packages` / `get_package` | R | Plans and their limits. |
| `create_package` | W | New plan. Limits use lowercase names (`quota`, `maxsub`…). |
| `edit_package` | D | Change a plan; other settings and extensions are preserved. Affects every account on the plan. |
| `delete_package` | D | Delete an unused plan. |

### ssl

| Tool | | What it does |
|---|---|---|
| `list_ssl_certs` | R | Installed certificates, soonest expiry first; `expiring_within_days` filter. |
| `get_ssl_info` | R | The certificate actually serving a domain, and whether it covers it. |
| `install_ssl` | D | Install a PEM certificate and key (CA bundle auto-detected). |
| `start_autossl_check` | W | Run AutoSSL for one account or all accounts. |
| `get_autossl_problems` | R | Why domain validation failed for an account or domain. |
| `get_autossl_log` | R | An AutoSSL run's log (latest by default), filterable to warnings and failures. |

### backups

| Tool | | What it does |
|---|---|---|
| `get_backup_config` | R | Schedule, retention, what's included. |
| `list_backup_destinations` | R | Remote destinations (credentials redacted). |
| `list_backup_dates` / `list_backup_users` | R | Available backup dates, and the accounts in a given date's backup. |
| `backup_account` / `get_account_backup_status` | W / R | On-demand full backup (pkgacct) to the account's home directory, and its status. |
| `restore_account` | D | Restore from a backup date. Refuses to start the queue while other restores are pending. |
| `get_restore_queue` | R | Active, pending and completed restores. |

### resellers

| Tool | | What it does |
|---|---|---|
| `list_resellers` | R | Reseller usernames. |
| `get_reseller_stats` | R | Account counts vs. limit, disk and bandwidth used/allocated, each account's usage. |
| `set_reseller_limits` | D | Account/disk/bandwidth limits. Both enforcement flags are required. |
| `setup_reseller` / `remove_reseller` | W / D | Grant or revoke reseller privileges. |

### security

| Tool | | What it does |
|---|---|---|
| `get_cphulk_status` | R | Is brute-force protection on? |
| `get_failed_logins` | R | Failed logins, brute-force and excessive-brute blocks, and attacks by username. |
| `list_cphulk_records` | R | Whitelist or blacklist entries. |
| `add_cphulk_record` / `remove_cphulk_record` | D | Edit the whitelist or blacklist. |
| `unblock_ips` | D | Lift blocks for IPs (the usual "customer locked out" fix). |
| `get_security_advice` | R | Security Advisor findings with suggested fixes. |

### software

| Tool | | What it does |
|---|---|---|
| `list_php_versions` | R | Installed EasyApache PHP versions and the default. |
| `get_php_vhost_versions` | R | PHP version and FPM state per site; filter by account, domain or version. |
| `set_php_vhost_version` | D | Change PHP for sites, keeping each site's PHP-FPM setting. |
| `list_databases` | R | MySQL/PostgreSQL databases and their owners. |

### logs

| Tool | | What it does |
|---|---|---|
| `get_domain_error_log` | R | A domain's Apache error_log or suexec_log (owner looked up automatically). |
| `get_modsec_log` | R | ModSecurity hits (domain, IP, request, status, rule), newest first. |

### api

| Tool | | What it does |
|---|---|---|
| `list_api_functions` | R | WHM functions this token can call. |
| `call_api` | D | Call any WHM API 1 function with raw parameters (POST by default). |
| `call_uapi` | D | Run any cPanel UAPI function as a given account. |

## 8. Safety model

The server has several layers of protection:

1. **Token privileges (ACLs)** are the real limit: the server can't do anything the WHM token can't. Use a restricted token wherever possible.
2. **Read-only mode** (`WHM_READ_ONLY`) removes every changing tool, including the raw API tools. It fails safe on unrecognized values, and it is the default in HTTP mode.
3. **Toolsets** (`WHM_TOOLSETS`) remove whole areas you don't need.
4. **Annotations.** Every tool declares `readOnlyHint` and `destructiveHint`, so clients know which calls need approval. In claude.ai you can also block individual tools.
5. **Built-in guards:**
   - cpsrvd can't be disabled
   - the SOA record can't be removed
   - DNS edits use the zone serial
   - package and PHP edits preserve settings you didn't pass
   - restores refuse to run other people's queued restores
   - editing a missing package doesn't silently create one
6. **Secrets.** Backup destination credentials are redacted from output. Private keys aren't fetched. Changes are sent by POST, so they stay out of URLs and logs.
7. **HTTP mode:**
   - bearer token required, compared in constant time
   - binds to localhost; put TLS in front
   - request bodies limited to 1 MB
   - rejected requests are logged to stderr

Remember that a login URL from `create_user_session`, and the `MCP_AUTH_TOKEN`, are credentials. Anyone holding them has that access.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `WHM_HOST env var is not set` / `WHM_TOKEN…` | Set the env vars in the client config (not your shell, for Desktop). |
| `authentication failed` (401/403) | Wrong user/token pair, expired token, or the token lacks the ACL for that function. |
| `TLS certificate could not be verified` | Use the hostname on WHM's certificate, or set `WHM_INSECURE_TLS=true` for self-signed certificates. |
| `Could not connect … 2087` | Firewall/cPHulk blocking the MCP host, or wrong port. Test with `curl -H "Authorization: whm root:TOKEN" https://HOST:2087/json-api/version?api.version=1`. |
| `Request timed out` | The operation may still be running on WHM. Raise `WHM_TIMEOUT_MS`. |
| `WHM API error: … (function: X)` | WHM rejected the call; the message is WHM's own reason. |
| Tools missing | Read-only mode is on (always the default in HTTP mode), or `WHM_TOOLSETS` excludes them. The startup line on stderr shows the tool count and mode. |
| HTTP 401 from the connector | The header value must be `Bearer <token>` exactly. |
| claude.ai: "Couldn't reach the MCP server" | The URL must be public HTTPS ending in `/mcp`, reachable from `160.79.104.0/21`. |

## 10. Maintaining it

- `npm run build`: compile TypeScript to `dist/`.
- `npm run verify:spec`: download cPanel's official OpenAPI specs and run every tool against a mock WHM. Each request is checked against the docs: the function exists, parameters are documented, required ones are present, and values are valid. Run this after cPanel releases a new version to catch API drift.
- `npm run verify:http`: smoke-test HTTP mode (auth, routing, read-only default).
- Code layout:
  - `src/services/client.ts`: HTTP client, parameter encoding, errors
  - `src/services/format.ts`: output helpers
  - `src/tools/*.ts`: one file per toolset
  - `src/http.ts`: HTTP transport
  - `src/index.ts`: startup and tool filtering

**Limitations:**
- It hasn't yet been tested against a live WHM server; responses are verified against the spec's examples.
- WHM has no API for tailing arbitrary log files, purging the mail queue, or reading the audit log.
- claude.ai access depends on its Request-headers beta (or future OAuth support).
