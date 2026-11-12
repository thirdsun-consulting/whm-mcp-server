# whm-mcp-server

MCP server exposing the [WHM API 1](https://api.docs.cpanel.net/whm/introduction) as tools for server-level cPanel administration. Pairs with `cpanel-mcp-server` (per-account ops) and complements it nicely.

Full guide: [docs/GUIDE.md](docs/GUIDE.md). Every tool is checked against cPanel's published OpenAPI specification (WHM API 11.138): see [Verifying against the WHM API docs](#verifying-against-the-whm-api-docs).

## What's covered

| Toolset | Tools |
|---------|-------|
| `accounts` | `list_accounts`, `get_account_summary`, `create_account`, `remove_account`, `suspend_account`, `unsuspend_account`, `list_suspended_accounts`, `modify_account`, `change_package`, `change_password`, `list_users`, `set_disk_quota`, `set_bandwidth_limit`, `create_user_session` |
| `domains` | `list_domains`, `get_domain_info`, `get_domain_owner` |
| `server` | `get_server_information`, `get_version`, `get_load_avg`, `get_disk_usage`, `get_account_disk_usage`, `get_bandwidth_usage`, `get_hostname`, `set_hostname`, `check_service_status`, `restart_service`, `configure_service`, `list_ips`, `reboot_server`, `get_tweak_setting`, `set_tweak_setting` |
| `dns` | `list_dns_zones`, `get_dns_zone`, `create_dns_zone`, `delete_dns_zone`, `add_dns_record`, `edit_dns_record`, `remove_dns_record`, `mass_edit_dns_zone`, `reset_dns_zone` |
| `email` | `get_mail_queue_summary`, `list_mail_queue`, `get_exim_stats`, `search_mail_delivery_log`, `manage_outgoing_email`, `list_pop_accounts_for_user`, `list_pop_accounts_with_disk`, `validate_mail_dns`, `enable_dkim`, `validate_exim_config` |
| `packages` | `list_packages`, `get_package`, `create_package`, `edit_package`, `delete_package` |
| `ssl` | `list_ssl_certs`, `get_ssl_info`, `install_ssl`, `start_autossl_check`, `get_autossl_problems`, `get_autossl_log` |
| `backups` | `get_backup_config`, `list_backup_destinations`, `list_backup_dates`, `list_backup_users`, `backup_account`, `get_account_backup_status`, `restore_account`, `get_restore_queue` |
| `resellers` | `list_resellers`, `get_reseller_stats`, `set_reseller_limits`, `setup_reseller`, `remove_reseller` |
| `security` | `get_cphulk_status`, `get_failed_logins`, `list_cphulk_records`, `add_cphulk_record`, `remove_cphulk_record`, `unblock_ips`, `get_security_advice` |
| `software` | `list_php_versions`, `get_php_vhost_versions`, `set_php_vhost_version`, `list_databases` |
| `logs` | `get_domain_error_log`, `get_modsec_log` |
| `api` | `list_api_functions`, `call_api`, `call_uapi` |

All tools are prefixed `whm_` (91 in total). Read-only tools are marked `readOnlyHint: true`. Tools that delete, overwrite, suspend, restart, or reboot are marked `destructiveHint: true`, and their descriptions ask the model to confirm with you first.

- Every tool accepts `response_format`: `markdown` (default) or `json`.
- List tools page with `limit`/`offset` and report `total`, `has_more`, and `next_offset`.
- For anything without a dedicated tool, `whm_call_api` calls any WHM API 1 function and `whm_call_uapi` runs any UAPI function as a cPanel user.

## Install

```bash
git clone <your-fork-url> whm-mcp-server
cd whm-mcp-server
npm install
npm run build
```

## Authentication

Generate an API token in WHM → Development → Manage API Tokens. Give it the ACLs you want this server to be able to use (read-only ACLs for monitoring, full root for ops).

```bash
export WHM_HOST="srv.example.com"
export WHM_USER="root"          # or another whm user
export WHM_TOKEN="your-token"
export WHM_PORT="2087"          # default
# If your WHM uses a self-signed cert:
# export WHM_INSECURE_TLS="true"
# For slow operations (account creation, restores):
# export WHM_TIMEOUT_MS="120000" # default 60000
```

Requests are sent as `Authorization: whm $WHM_USER:$WHM_TOKEN` to `https://$WHM_HOST:$WHM_PORT/json-api/`.

## Choosing which tools to expose

With every toolset enabled the tool list is large (~24k tokens of tool definitions). Trim it for your use case:

```bash
# Only these toolsets (comma-separated, from the table above):
export WHM_TOOLSETS="accounts,dns,email,logs"

# Only read-only tools — safe for monitoring and support lookups:
export WHM_READ_ONLY="true"
```

Read-only mode keeps 51 tools and drops everything that changes the server, including `whm_call_api` and `whm_call_uapi`. Any value other than empty, `0`, `false`, `no`, or `off` turns it on.

## Run

```bash
npm start
```

## Test interactively

```bash
npm run inspect
```

Launches the MCP Inspector UI for calling tools by hand.

## Wire to MCP client

```json
{
  "mcpServers": {
    "whm": {
      "command": "node",
      "args": ["/absolute/path/to/whm-mcp-server/dist/index.js"],
      "env": {
        "WHM_HOST": "srv.example.com",
        "WHM_USER": "root",
        "WHM_TOKEN": "your-token"
      }
    }
  }
}
```

## Remote connector (HTTP mode)

To use the server from claude.ai (custom connectors), the Claude API, or Claude Code over HTTP, run it in Streamable HTTP mode behind HTTPS:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"   # required, at least 32 characters
export MCP_HTTP_PORT=3000                          # default; binds 127.0.0.1 unless MCP_HTTP_HOST is set
npm start -- --http                                # or MCP_TRANSPORT=http
```

- Every request must send `Authorization: Bearer $MCP_AUTH_TOKEN`; anything else gets a 401.
- HTTP mode starts **read-only**. Set `WHM_READ_ONLY=false` to expose write tools.
- Put a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front of `http://127.0.0.1:3000/mcp`. claude.ai connects from `160.79.104.0/21`, so you can firewall everything else.
- **claude.ai:** Customize → Connectors → Add custom connector, URL `https://your-host/mcp`, choose **No sign-in**, and add a **Request header** `authorization` = `Bearer <token>`. Request headers are a beta available to some organizations; if the option is missing, claude.ai can't use this server yet (it would need OAuth).
- **Claude Code:** `claude mcp add --transport http whm https://your-host/mcp --header "Authorization: Bearer <token>"`

`npm run verify:http` checks auth, routing, and the read-only default.

## Verifying against the WHM API docs

```bash
npm run build
npm run verify:spec
```

`scripts/verify-spec.mjs` downloads cPanel's OpenAPI specs for WHM API 1 and UAPI (cached in `node_modules/.cache/whm-mcp-server`; set `WHM_SPEC_DIR` to use local copies). It then starts a mock WHM server that answers with the spec's example responses and calls every tool through a real MCP client. Each request is checked:

- the function exists
- every parameter is documented, and required ones are present
- values match the documented types and enums

Tool-specific cases also cover request-building logic (DNS edits, package merges, multi-value parameters) and error handling. Run it after cPanel releases a new version to catch API drift. It needs the `openssl` CLI for the mock server's throwaway certificate.

## Notes

- WHM API 1 responses use a `metadata.result` envelope. The server checks it (and UAPI's `status`/`errors` for `uapi_cpanel` calls) and turns failures into tool errors carrying WHM's reason.
- Parameters follow WHM's conventions: booleans are sent as `1`/`0`, and multi-valued parameters use `name`, `name-1`, `name-2`, ….
- DNS tools use `parse_dns_zone` and `mass_edit_dns_zone`, the replacements for the deprecated `dumpzone`. `whm_get_dns_zone` returns each record's `line_index` and the zone serial. Edits pass the serial so they fail instead of clobbering a zone that changed in the meantime.
- `whm_edit_package` resends the package's current settings along with your changes. `editpkg` would otherwise apply defaults to omitted values and drop package extensions.
- `whm_set_php_vhost_version` keeps each site's PHP-FPM setting unless you pass `php_fpm`.
- Backup destination credentials are redacted from tool output.
- Log tools use the sources WHM documents:
  - a domain's Apache error log (UAPI `Stats::get_site_errors`)
  - ModSecurity hits
  - mail delivery reports (`emailtrack_search`)
  - cPHulk login failures
  - AutoSSL run logs

  There is no WHM API for tailing arbitrary server log files.
- If you see TLS errors on a server with a self-signed cert, set `WHM_INSECURE_TLS=true`.

## Upgrading from 0.1

0.1 called several functions that don't exist in WHM API 1 and sent wrong parameter names to others. These tools changed:

| 0.1 tool | Now |
|----------|-----|
| `whm_tail_apache_error_log` | `whm_get_domain_error_log` (per domain; WHM has no global error-log API) |
| `whm_tail_exim_log` | `whm_search_mail_delivery_log` |
| `whm_get_login_history` | `whm_get_failed_logins` (cPHulk) |
| `whm_get_exim_config` | `whm_validate_exim_config` |
| `whm_purge_mail_queue` | removed (no WHM API); use `whm_manage_outgoing_email` to hold or suspend a sender |
| `whm_get_chkservd_log`, `whm_get_audit_log` | removed (no WHM API); use `whm_check_service_status` |

Changed inputs:

- `whm_create_package` and `whm_edit_package` take lowercase limit names (`quota`, `bwlimit`, `maxsub`, …), matching the API.
- `whm_edit_dns_record` and `whm_remove_dns_record` take `line_index` from `whm_get_dns_zone`.
- `whm_add_dns_record` accepts the same per-type fields as before, or a `data` array. CAA records use `caa_flag`/`caa_tag`/`caa_value`.
- `whm_create_account` takes `dedicated_ip` (boolean) and `customip` (a specific address) instead of `ip`.
- `whm_modify_account` takes `contactemail` in lowercase and no longer takes `BWLIMIT`, which WHM reads as bytes. Use `whm_set_bandwidth_limit` instead.

## License

MIT
