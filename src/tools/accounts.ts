import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, fmtLimit, fmtTime, formatResponse, isTrue, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, LimitSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

export function registerAccountTools(server: ToolRegistrar) {
  // ---- listaccts ----
  server.registerTool(
    "whm_list_accounts",
    {
      title: "List cPanel Accounts",
      description:
        "List cPanel accounts on the server. Optionally filter by user, domain, owner (reseller), package, or IP. " +
        "Returns disk usage, suspension status, package, owner, contact email, and IP. Paged with limit/offset.",
      inputSchema: {
        searchtype: z
          .enum(["domain", "owner", "user", "ip", "package"])
          .optional()
          .describe("Field to filter on (required with 'search')"),
        search: z
          .string()
          .optional()
          .describe("Value to match against searchtype: a PCRE regex, or an exact value with searchmethod='exact'"),
        searchmethod: z
          .enum(["regex", "exact"])
          .optional()
          .describe("'regex' (default) matches values containing the pattern; 'exact' requires an identical value"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (params.search && !params.searchtype) {
          return err("Provide 'searchtype' (domain, owner, user, ip, or package) together with 'search'.");
        }
        const data: any = await whmCall("listaccts", {
          searchtype: params.searchtype,
          search: params.search,
          searchmethod: params.searchmethod,
        });
        const page = paginate<any>(data.acct ?? [], params.limit, params.offset);
        const md =
          [
            `# cPanel accounts (${page.total})`,
            ...page.items.map(
              (a) =>
                `- **${a.user}** (${a.domain}) — owner: ${a.owner}, package: ${a.plan}, suspended: ${yesNo(a.suspended)}${
                  isTrue(a.suspended) && a.suspendreason ? ` (${a.suspendreason})` : ""
                }, disk: ${a.diskused}/${fmtLimit(a.disklimit)}, email: ${a.email}, ip: ${a.ip}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, accounts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- accountsummary ----
  server.registerTool(
    "whm_get_account_summary",
    {
      title: "Get Account Summary",
      description:
        "Get a detailed summary for a single cPanel account: disk and inode usage, package, suspension/lock status, IPs, contact, partition, mail limits, and resource limits.",
      inputSchema: {
        user: z.string().optional().describe("cPanel username (one of user/domain required)"),
        domain: z.string().optional().describe("Primary domain (one of user/domain required)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (!params.user && !params.domain) {
          return err("Provide either 'user' or 'domain'.");
        }
        const data: any = await whmCall("accountsummary", {
          user: params.user,
          domain: params.domain,
        });
        const a = data.acct?.[0];
        if (!a) return err(`No account found for ${params.user ?? params.domain}.`);
        const md = [
          `# Account: ${a.user} (${a.domain})`,
          `- Owner: ${a.owner}`,
          `- Package: ${a.plan}`,
          `- Suspended: ${yesNo(a.suspended)}${isTrue(a.suspended) && a.suspendreason ? ` (${a.suspendreason})` : ""}${
            isTrue(a.suspended) && a.suspendtime ? ` since ${fmtTime(a.suspendtime)}` : ""
          }${isTrue(a.is_locked) ? " — LOCKED" : ""}`,
          `- Contact email: ${a.email}`,
          `- IPv4: ${a.ip}${a.ipv6?.length ? `, IPv6: ${a.ipv6.join(", ")}` : ""}`,
          `- Disk used: ${a.diskused} / ${fmtLimit(a.disklimit)}`,
          `- Inodes used: ${a.inodesused} / ${fmtLimit(a.inodeslimit)}`,
          `- Partition: ${a.partition}`,
          `- Theme: ${a.theme}, shell: ${a.shell}`,
          `- Created: ${a.startdate}`,
          `- Mailbox format: ${a.mailbox_format ?? "n/a"}, max emails/hour: ${fmtLimit(a.max_email_per_hour)}`,
          `- Outgoing mail held: ${yesNo(a.outgoing_mail_hold)}, outgoing mail suspended: ${yesNo(a.outgoing_mail_suspended)}`,
          `- Backups enabled: ${yesNo(a.backup)}`,
          `- Max addons: ${fmtLimit(a.maxaddons)}, parked: ${fmtLimit(a.maxparked)}, subdomains: ${fmtLimit(a.maxsub)}, sql: ${fmtLimit(a.maxsql)}`,
          `- Max ftp: ${fmtLimit(a.maxftp)}, email accounts: ${fmtLimit(a.maxpop)}, mailing lists: ${fmtLimit(a.maxlst)}`,
        ].join("\n");
        return formatResponse(params.response_format, md, a);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- createacct ----
  server.registerTool(
    "whm_create_account",
    {
      title: "Create cPanel Account",
      description:
        "Create a new cPanel account. BILLABLE — uses a license seat. Confirm with user. " +
        "Returns the assigned IP, package, and nameservers.",
      inputSchema: {
        username: z
          .string()
          .min(1)
          .max(16)
          .describe("New cPanel username: lowercase letters and digits, starting with a letter, at most 16 characters"),
        domain: z.string().describe("Primary domain"),
        password: z.string().min(8).describe("Account password (must meet the server's password strength setting)"),
        plan: z
          .string()
          .optional()
          .describe("Hosting package name. When set, the package supplies the limits — don't also pass quota/bwlimit"),
        contactemail: z.string().email().optional(),
        quota: z.number().int().min(0).optional().describe("Disk quota in MB (0 = unlimited)"),
        bwlimit: LimitSchema.optional().describe("Monthly bandwidth limit in MB (0 or 'unlimited' = unlimited)"),
        owner: z.string().optional().describe("Reseller (or 'root') that will own the account"),
        dedicated_ip: z.boolean().optional().describe("Assign a dedicated IP address instead of the shared IP"),
        customip: z.string().optional().describe("Specific IP address to assign"),
        reseller: z.boolean().optional().describe("Also grant reseller privileges"),
        featurelist: z.string().optional().describe("Feature list name"),
        hasshell: z.boolean().optional().describe("Enable shell (SSH) access"),
        cgi: z.boolean().optional().describe("Enable CGI access"),
        language: z.string().optional().describe("Default locale, e.g. 'en'"),
        mxcheck: z
          .enum(["local", "secondary", "remote", "auto"])
          .optional()
          .describe("Mail exchanger type for the domain (default: local)"),
        spf: z.boolean().optional().describe("Create an SPF record for the domain"),
        dkim: z.boolean().optional().describe("Create DKIM records for the domain"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, dedicated_ip, ...rest } = params;
        const data: any = await whmCall(
          "createacct",
          { ...rest, ip: dedicated_ip === undefined ? undefined : dedicated_ip ? "y" : "n" },
          "POST"
        );
        const nameservers = [data.nameserver, data.nameserver2, data.nameserver3, data.nameserver4].filter(Boolean);
        return formatResponse(
          response_format,
          `Created account ${params.username} (${params.domain}). IP: ${data.ip ?? "n/a"}, package: ${
            data.package ?? params.plan ?? "default"
          }${nameservers.length ? `, nameservers: ${nameservers.join(", ")}` : ""}.`,
          data
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- removeacct ----
  server.registerTool(
    "whm_remove_account",
    {
      title: "Remove cPanel Account",
      description:
        "PERMANENTLY DELETE a cPanel account. All files, databases, mail, and DNS for the user are erased. Always confirm with the user. Optionally keep DNS via keepdns=true.",
      inputSchema: {
        user: z.string().describe("cPanel username to delete"),
        keepdns: z.boolean().default(false).describe("Keep the account's DNS zones after removal"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("removeacct", { username: params.user, keepdns: params.keepdns }, "POST");
        return formatResponse(
          params.response_format,
          `Removed account ${params.user}${params.keepdns ? " (DNS preserved)" : ""}.`,
          { user: params.user, removed: true, keepdns: params.keepdns }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- suspendacct ----
  server.registerTool(
    "whm_suspend_account",
    {
      title: "Suspend Account",
      description:
        "Suspend a cPanel account. Its sites, mail, and logins stop working until unsuspended. Confirm with user.",
      inputSchema: {
        user: z.string(),
        reason: z.string().optional().describe("Reason for suspension (strongly recommended; shown in WHM)"),
        disallowun: z
          .boolean()
          .default(false)
          .describe("Allow only root to unsuspend (the owning reseller can't)"),
        leave_ftp_accts_enabled: z.boolean().default(false).describe("Leave the account's FTP accounts enabled"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall(
          "suspendacct",
          {
            user: params.user,
            reason: params.reason,
            disallowun: params.disallowun,
            "leave-ftp-accts-enabled": params.leave_ftp_accts_enabled,
          },
          "POST"
        );
        return formatResponse(
          params.response_format,
          `Suspended ${params.user}${params.reason ? `: ${params.reason}` : ""}.`,
          { user: params.user, suspended: true }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- unsuspendacct ----
  server.registerTool(
    "whm_unsuspend_account",
    {
      title: "Unsuspend Account",
      description: "Unsuspend a previously-suspended cPanel account.",
      inputSchema: { user: z.string(), ...FormatSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("unsuspendacct", { user: params.user }, "POST");
        return formatResponse(params.response_format, `Unsuspended ${params.user}.`, {
          user: params.user,
          suspended: false,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- listsuspended ----
  server.registerTool(
    "whm_list_suspended_accounts",
    {
      title: "List Suspended Accounts",
      description: "List suspended cPanel accounts with owner, suspension reason, time, and lock status.",
      inputSchema: { ...PaginationSchema, ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("listsuspended");
        const page = paginate<any>(data.account ?? [], params.limit, params.offset);
        const md =
          [
            `# Suspended accounts (${page.total})`,
            ...page.items.map(
              (a) =>
                `- **${a.user}** (owner: ${a.owner}) — since ${a.time ?? fmtTime(a.unixtime)}: ${a.reason || "no reason given"}${
                  isTrue(a.is_locked) ? " [locked]" : ""
                }`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, accounts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- modifyacct ----
  server.registerTool(
    "whm_modify_account",
    {
      title: "Modify Account",
      description:
        "Update a cPanel account: rename it, change its primary domain, contact email, or owner, and set per-account limits. " +
        "If the account uses a package, later package edits overwrite custom limits. " +
        "Use whm_set_bandwidth_limit for bandwidth and whm_change_package to switch packages.",
      inputSchema: {
        user: z.string().describe("Current cPanel username"),
        newuser: z.string().optional().describe("Rename the account to this username"),
        domain: z.string().optional().describe("New primary domain"),
        contactemail: z.string().email().optional().describe("New contact email address"),
        owner: z.string().optional().describe("Transfer ownership to this reseller (or 'root')"),
        QUOTA: LimitSchema.optional().describe("Disk quota in MB (0 or 'unlimited' = unlimited)"),
        MAXSUB: LimitSchema.optional().describe("Max subdomains"),
        MAXPARK: LimitSchema.optional().describe("Max parked domains (aliases)"),
        MAXADDON: LimitSchema.optional().describe("Max addon domains"),
        MAXFTP: LimitSchema.optional().describe("Max FTP accounts"),
        MAXSQL: LimitSchema.optional().describe("Max databases of each type"),
        MAXPOP: LimitSchema.optional().describe("Max email accounts"),
        MAXLST: LimitSchema.optional().describe("Max mailing lists"),
        MAX_EMAIL_PER_HOUR: LimitSchema.optional().describe("Max outbound emails per hour"),
        HASSHELL: z.boolean().optional().describe("Enable shell (SSH) access"),
        HASCGI: z.boolean().optional().describe("Enable CGI access"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, user, ...changes } = params;
        const changed = Object.keys(changes).filter((k) => (changes as Record<string, unknown>)[k] !== undefined);
        if (changed.length === 0) return err("Nothing to change: pass at least one setting to update.");
        const data: any = await whmCall("modifyacct", { user, ...changes }, "POST");
        return formatResponse(
          response_format,
          `Modified account ${data?.user ?? params.newuser ?? user}: ${changed.join(", ")}.`,
          { user: data?.user ?? params.newuser ?? user, modified: changed, domain: data?.domain }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- changepackage ----
  server.registerTool(
    "whm_change_package",
    {
      title: "Change Account Package",
      description: "Move a cPanel account to a different hosting package (plan). The package's limits replace the account's.",
      inputSchema: {
        user: z.string(),
        pkg: z.string().describe("Target package name"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("changepackage", { user: params.user, pkg: params.pkg }, "POST");
        return formatResponse(
          params.response_format,
          `Moved ${params.user} to package ${params.pkg}.`,
          { user: params.user, package: params.pkg }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- passwd ----
  server.registerTool(
    "whm_change_password",
    {
      title: "Change Account Password",
      description:
        "Change a cPanel or reseller account's password. By default also sets the account's MySQL password to match (db_pass_update).",
      inputSchema: {
        user: z.string(),
        password: z.string().min(5),
        db_pass_update: z
          .boolean()
          .default(true)
          .describe("Also change the account's MySQL password to the new password"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall(
          "passwd",
          {
            user: params.user,
            password: params.password,
            db_pass_update: params.db_pass_update,
          },
          "POST"
        );
        const services: string[] = data?.app ?? [];
        return formatResponse(
          params.response_format,
          `Changed password for ${params.user}${services.length ? ` (services: ${services.join(", ")})` : ""}.`,
          { user: params.user, password_changed: true, services }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- list_users ----
  server.registerTool(
    "whm_list_users",
    {
      title: "List Server Users",
      description: "List the cPanel account usernames on the server, plus root.",
      inputSchema: { ...PaginationSchema, ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("list_users");
        const page = paginate<string>(data.users ?? [], params.limit, params.offset);
        const md = `# Users (${page.total})\n${page.items.map((u) => `- ${u}`).join("\n")}` + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, users: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- editquota ----
  server.registerTool(
    "whm_set_disk_quota",
    {
      title: "Set Disk Quota",
      description: "Set a cPanel account's disk quota.",
      inputSchema: {
        user: z.string(),
        quota: LimitSchema.describe("Disk quota in MB (0 or 'unlimited' = unlimited)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("editquota", { user: params.user, quota: params.quota }, "POST");
        return formatResponse(
          params.response_format,
          `Set disk quota for ${params.user} to ${params.quota === 0 ? "unlimited" : fmtLimit(params.quota, " MB")}.`,
          { user: params.user, quota: params.quota }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- limitbw ----
  server.registerTool(
    "whm_set_bandwidth_limit",
    {
      title: "Set Bandwidth Limit",
      description: "Set a cPanel account's monthly bandwidth limit.",
      inputSchema: {
        user: z.string(),
        bwlimit: LimitSchema.describe("Monthly bandwidth limit in MB (0 or 'unlimited' = unlimited)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("limitbw", { user: params.user, bwlimit: params.bwlimit }, "POST");
        const bw = data?.bwlimits?.[0] ?? {};
        return formatResponse(
          params.response_format,
          `Bandwidth limit for ${params.user}: ${bw.human_bwlimit ?? fmtLimit(params.bwlimit, " MB")}${
            bw.human_bwused ? ` (used this month: ${bw.human_bwused})` : ""
          }.`,
          { user: params.user, bwlimit: params.bwlimit, ...bw }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- create_user_session ----
  server.registerTool(
    "whm_create_user_session",
    {
      title: "Create Login Session URL",
      description:
        "Create a temporary login URL for cPanel, WHM, or Webmail as a user, without their password — useful for support. " +
        "The URL grants full access to the account, so share it only with people allowed to have it. Sessions expire after 15 minutes of inactivity.",
      inputSchema: {
        user: z.string().describe("cPanel username (or an email address, for webmaild)"),
        service: z
          .enum(["cpaneld", "whostmgrd", "webmaild"])
          .default("cpaneld")
          .describe("'cpaneld' = cPanel, 'whostmgrd' = WHM (root/resellers), 'webmaild' = Webmail"),
        app: z
          .string()
          .optional()
          .describe("Land on a specific app, e.g. 'FileManager_Home', 'Email_Accounts', 'Database_phpMyAdmin', 'Backups_Home'"),
        preferred_domain: z
          .string()
          .optional()
          .describe("Hostname or IP to use in the URL (defaults to the server hostname)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall(
          "create_user_session",
          {
            user: params.user,
            service: params.service,
            app: params.app,
            preferred_domain: params.preferred_domain,
          },
          "POST"
        );
        return formatResponse(
          params.response_format,
          `Login URL for ${params.user} (${params.service}): ${data.url}\nToken expires: ${fmtTime(data.expires)}.`,
          { user: params.user, service: data.service ?? params.service, url: data.url, expires: data.expires }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
