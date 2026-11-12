import { z } from "zod";
import { handleWhmError, whmCall, whmRequest } from "../services/client.js";
import { codeBlock, err, fmtBytes, formatResponse, isTrue, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

export function registerServerTools(server: ToolRegistrar) {
  // ---- server overview (several read-only calls) ----
  server.registerTool(
    "whm_get_server_information",
    {
      title: "Get Server Information",
      description:
        "Server overview in one call: hostname, cPanel & WHM version, load average, whether a reboot is pending (and why), main IP, " +
        "account count vs. license limit, MySQL/MariaDB version, and default PHP version.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const calls: Record<string, Promise<any>> = {
          hostname: whmCall("gethostname"),
          version: whmCall("version"),
          load: whmCall("systemloadavg"),
          reboot: whmCall("system_needs_reboot"),
          ips: whmCall("listips"),
          accounts: whmCall("get_current_users_count"),
          license: whmCall("get_maximum_users"),
          mysql: whmCall("current_mysql_version"),
          php: whmCall("php_get_system_default_version"),
        };
        const names = Object.keys(calls);
        const settled = await Promise.allSettled(Object.values(calls));
        const r: Record<string, any> = {};
        const errors: Record<string, string> = {};
        settled.forEach((s, i) => {
          if (s.status === "fulfilled") r[names[i]] = s.value;
          else errors[names[i]] = handleWhmError(s.reason);
        });
        if (Object.keys(r).length === 0) return err(Object.values(errors)[0]);

        const rebootReasons = r.reboot?.details ? Object.keys(r.reboot.details) : [];
        const info = {
          hostname: r.hostname?.hostname,
          version: r.version?.version,
          load_average: r.load ? { one: r.load.one, five: r.load.five, fifteen: r.load.fifteen } : undefined,
          needs_reboot: r.reboot ? isTrue(r.reboot.needs_reboot) : undefined,
          reboot_details: r.reboot?.details,
          main_ip: r.ips?.ip?.find((i: any) => isTrue(i.mainaddr))?.ip,
          ip_count: r.ips?.ip?.length,
          accounts: r.accounts?.users,
          // get_maximum_users reports 0 for an unlimited license.
          license_max_accounts: r.license ? (Number(r.license.users) === 0 ? "unlimited" : r.license.users) : undefined,
          database: r.mysql ? `${r.mysql.server} ${r.mysql.version}` : undefined,
          default_php: r.php?.version,
          ...(Object.keys(errors).length ? { errors } : {}),
        };
        const md = [
          `# Server`,
          `- Hostname: ${info.hostname ?? "n/a"}`,
          `- cPanel & WHM version: ${info.version ?? "n/a"}`,
          `- Load average: ${info.load_average ? `${info.load_average.one} / ${info.load_average.five} / ${info.load_average.fifteen} (1/5/15 min)` : "n/a"}`,
          `- Needs reboot: ${info.needs_reboot === undefined ? "n/a" : info.needs_reboot ? `YES (${rebootReasons.join(", ") || "see details"})` : "no"}`,
          `- Main IP: ${info.main_ip ?? "n/a"} (${info.ip_count ?? "?"} IPs configured)`,
          `- Accounts: ${info.accounts ?? "n/a"} (license limit: ${info.license_max_accounts ?? "n/a"})`,
          `- Database server: ${info.database ?? "n/a"}`,
          `- Default PHP: ${info.default_php ?? "n/a"}`,
          ...Object.entries(errors).map(([k, v]) => `- _${k} unavailable: ${v}_`),
        ].join("\n");
        return formatResponse(params.response_format, md, info);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- version ----
  server.registerTool(
    "whm_get_version",
    {
      title: "Get WHM Version",
      description: "Get the running cPanel & WHM version.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("version");
        return formatResponse(
          params.response_format,
          `cPanel & WHM version: ${data.version}`,
          data
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- systemloadavg ----
  server.registerTool(
    "whm_get_load_avg",
    {
      title: "Get Load Average",
      description: "Get current 1, 5, 15-minute system load averages.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("systemloadavg");
        const md = `# Load average\n- 1 min: ${data.one}\n- 5 min: ${data.five}\n- 15 min: ${data.fifteen}`;
        return formatResponse(params.response_format, md, data);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- getdiskusage ----
  server.registerTool(
    "whm_get_disk_usage",
    {
      title: "Get Disk Usage",
      description:
        "Get disk space and inode usage for each mounted partition. Use whm_get_account_disk_usage for per-account usage.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("getdiskusage");
        const partitions = data.partition ?? [];
        const md: string[] = [`# Disk usage`];
        for (const p of partitions) {
          md.push(
            `- **${p.mount}** (${p.filesystem}) — ${p.percentage}% used: ${fmtBytes((p.used ?? 0) * 1024)} of ${fmtBytes(
              (p.total ?? 0) * 1024
            )}, ${fmtBytes((p.available ?? 0) * 1024)} free; inodes ${p.inodes_ipercentage ?? "?"}% used${
              p.percentage >= 90 || p.inodes_ipercentage >= 90 ? " ⚠️" : ""
            }`
          );
        }
        return formatResponse(params.response_format, md.join("\n"), { partitions });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- get_disk_usage ----
  server.registerTool(
    "whm_get_account_disk_usage",
    {
      title: "Get Account Disk Usage",
      description:
        "Get disk and inode usage per cPanel account against its quota — find accounts that are near or over quota or using the most space.",
      inputSchema: {
        user: z.string().optional().describe("Only this cPanel account"),
        sort_by: z
          .enum(["used", "percent", "user"])
          .default("used")
          .describe("'used' = most space first, 'percent' = closest to quota first, 'user' = alphabetical"),
        cache_mode: z
          .enum(["on", "off"])
          .optional()
          .describe("'off' forces a fresh (slow) quota scan instead of WHM's cached values"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("get_disk_usage", { cache_mode: params.cache_mode });
        const percent = (a: any) => (a.blocks_limit ? (a.blocks_used / a.blocks_limit) * 100 : 0);
        const accounts = (data.accounts ?? [])
          .filter((a: any) => !params.user || a.user === params.user)
          .map((a: any) => ({ ...a, percent_used: a.blocks_limit ? Math.round(percent(a) * 10) / 10 : null }));
        accounts.sort((a: any, b: any) =>
          params.sort_by === "user"
            ? String(a.user).localeCompare(String(b.user))
            : params.sort_by === "percent"
              ? percent(b) - percent(a)
              : (b.blocks_used ?? 0) - (a.blocks_used ?? 0)
        );
        const page = paginate<any>(accounts, params.limit, params.offset);
        const md =
          [
            `# Account disk usage (${page.total})`,
            ...page.items.map(
              (a) =>
                `- **${a.user}** — ${fmtBytes((a.blocks_used ?? 0) * 1024)} / ${
                  a.blocks_limit ? fmtBytes(a.blocks_limit * 1024) : "unlimited"
                }${a.percent_used !== null ? ` (${a.percent_used}%)` : ""}, inodes: ${a.inodes_used ?? "?"} / ${
                  a.inodes_limit ?? "unlimited"
                }${a.percent_used !== null && a.percent_used >= 90 ? " ⚠️" : ""}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, accounts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- showbw ----
  server.registerTool(
    "whm_get_bandwidth_usage",
    {
      title: "Get Bandwidth Usage",
      description:
        "Get bandwidth usage per account for a month (default: current month), highest usage first. Optionally filter by account field or reseller.",
      inputSchema: {
        month: z.number().int().min(1).max(12).optional(),
        year: z.number().int().min(2000).max(2100).optional(),
        searchtype: z.enum(["domain", "owner", "user", "ip", "package"]).optional().describe("Field to filter on"),
        search: z.string().optional().describe("PCRE regex matched against searchtype"),
        showres: z.string().optional().describe("Only accounts owned by this reseller"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("showbw", {
          month: params.month,
          year: params.year,
          searchtype: params.searchtype,
          search: params.search,
          showres: params.showres,
        });
        const limitOf = (a: any) => {
          const n = Number(a.limit);
          return a.limit === "unlimited" || isNaN(n) || n <= 0 ? null : n;
        };
        const accts = [...(data.acct ?? [])].sort((a: any, b: any) => (b.totalbytes ?? 0) - (a.totalbytes ?? 0));
        const page = paginate<any>(accts, params.limit, params.offset);
        const md =
          [
            `# Bandwidth ${data.month ?? params.month ?? ""}/${data.year ?? params.year ?? ""} — total ${fmtBytes(data.totalused)}`,
            ...page.items.map((a) => {
              const limit = limitOf(a);
              return `- **${a.user}** (${a.maindomain}) — ${fmtBytes(a.totalbytes)} / ${limit ? fmtBytes(limit) : "unlimited"}${
                limit && a.totalbytes / limit >= 0.9 ? " ⚠️" : ""
              }${isTrue(a.deleted) ? " [deleted]" : ""}`;
            }),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, {
          month: data.month,
          year: data.year,
          totalused: data.totalused,
          ...meta,
          accounts: items,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- gethostname ----
  server.registerTool(
    "whm_get_hostname",
    {
      title: "Get Hostname",
      description: "Get the server's hostname.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("gethostname");
        return formatResponse(params.response_format, `Hostname: ${data.hostname}`, data);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- sethostname ----
  server.registerTool(
    "whm_set_hostname",
    {
      title: "Set Hostname",
      description:
        "Change the server's hostname. Must be an FQDN with at least two dots (e.g. 'srv2.example.com') that no cPanel account uses. " +
        "Affects mail, SSL, and licensing — confirm with user.",
      inputSchema: {
        hostname: z.string().describe("New FQDN, e.g. 'srv2.example.com'"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const res = await whmRequest("sethostname", { hostname: params.hostname }, "POST");
        const output: any = res.metadata.output ?? {};
        const notes = [output.messages, output.warnings].flat().filter(Boolean);
        return formatResponse(
          params.response_format,
          `Hostname set to ${params.hostname}.${notes.length ? `\n${notes.map((n) => `- ${n}`).join("\n")}` : ""}`,
          { hostname: params.hostname, messages: output.messages, warnings: output.warnings }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- servicestatus ----
  server.registerTool(
    "whm_check_service_status",
    {
      title: "Check Service Status",
      description:
        "Check whether system services (httpd, exim, mysql, named, dovecot, ftpd, cpsrvd, etc.) are installed, enabled, monitored, and running. " +
        "Without 'service', returns all services. Use problems_only to see only enabled services that are down.",
      inputSchema: {
        service: z.string().optional().describe("Specific service name, e.g. 'httpd', 'mysql', 'exim'"),
        problems_only: z.boolean().default(false).describe("Only enabled services that are not running"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("servicestatus", { service: params.service });
        let services = data.service ?? [];
        if (params.problems_only) {
          services = services.filter((s: any) => isTrue(s.enabled) && !isTrue(s.running));
        }
        const md = [
          `# Services${params.service ? ` (${params.service})` : ""}${params.problems_only ? " — problems only" : ""}`,
          ...(services.length === 0 && params.problems_only ? ["All enabled services are running."] : []),
          ...services.map(
            (s: any) =>
              `- **${s.display_name ?? s.name}** (${s.name}) — ${isTrue(s.running) ? "✅ running" : "❌ not running"}, enabled: ${yesNo(
                s.enabled
              )}, monitored: ${yesNo(s.monitored)}, installed: ${yesNo(s.installed)}`
          ),
        ].join("\n");
        return formatResponse(params.response_format, md, { services });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- restartservice ----
  server.registerTool(
    "whm_restart_service",
    {
      title: "Restart Service",
      description:
        "Restart a system service (httpd, exim, mysql, named, dovecot, etc.). DESTRUCTIVE — causes a brief outage. Confirm with user.",
      inputSchema: {
        service: z.string().describe("Service name, e.g. 'httpd', 'mysql', 'exim', 'named'"),
        queue_task: z.boolean().optional().describe("Queue the restart instead of running it immediately"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall(
          "restartservice",
          { service: params.service, queue_task: params.queue_task },
          "POST"
        );
        const output = typeof data?.output === "string" ? data.output.trim() : "";
        return formatResponse(
          params.response_format,
          `${params.queue_task ? "Queued restart" : "Restarted"} ${data?.service ?? params.service}.${
            output ? `\n${codeBlock(output.slice(-3000))}` : ""
          }`,
          data
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- configureservice (enable/disable monitoring) ----
  server.registerTool(
    "whm_configure_service",
    {
      title: "Configure Service",
      description:
        "Enable/disable a service and/or its chkservd monitoring. enabled=false stops the service (disabling sshd cuts off SSH access). " +
        "Omitted settings are left unchanged. Refuses to disable cpsrvd, which runs WHM itself. Confirm with user.",
      inputSchema: {
        service: z.string().describe("Service name, e.g. 'httpd', 'exim', 'cphulkd', 'spamd'"),
        enabled: z.boolean().optional().describe("Whether the service should be enabled (running)"),
        monitored: z.boolean().optional().describe("Whether chkservd should monitor it"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (params.enabled === undefined && params.monitored === undefined) {
          return err("Pass 'enabled' and/or 'monitored'.");
        }
        if (params.service === "cpsrvd" && params.enabled === false) {
          return err(
            "Refusing to disable cpsrvd: WHM's docs warn against it, and it would take down WHM, cPanel, and this server's own API access."
          );
        }
        const data: any = await whmCall(
          "configureservice",
          {
            service: params.service,
            enabled: params.enabled,
            monitored: params.monitored,
          },
          "POST"
        );
        return formatResponse(
          params.response_format,
          `Configured ${params.service}:${params.enabled !== undefined ? ` enabled=${params.enabled}` : ""}${
            params.monitored !== undefined ? ` monitored=${params.monitored}` : ""
          }.`,
          { service: params.service, enabled: params.enabled, monitored: params.monitored, ...data }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- listips ----
  server.registerTool(
    "whm_list_ips",
    {
      title: "List Server IPs",
      description: "List the server's IPv4 addresses: interface, main/dedicated/in-use status, and NAT public IP.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("listips");
        const ips = data.ip ?? [];
        const md = [
          `# Server IPs (${ips.length})`,
          ...ips.map(
            (i: any) =>
              `- ${i.ip} (${i.if ?? "?"}) — main: ${yesNo(i.mainaddr)}, dedicated: ${yesNo(i.dedicated)}, in use: ${yesNo(
                i.used
              )}, active: ${yesNo(i.active)}${i.public_ip && i.public_ip !== i.ip ? `, public: ${i.public_ip}` : ""}`
          ),
        ].join("\n");
        return formatResponse(params.response_format, md, { ips });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- reboot ----
  server.registerTool(
    "whm_reboot_server",
    {
      title: "Reboot Server",
      description:
        "Reboot the entire server. EXTREMELY DESTRUCTIVE — causes downtime for ALL hosted accounts. Always confirm explicitly with the user.",
      inputSchema: {
        force: z.boolean().default(false).describe("Forceful reboot without graceful shutdown (risk of data loss)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("reboot", { force: params.force }, "POST");
        return formatResponse(
          params.response_format,
          `Reboot issued (${params.force ? "forced" : "graceful"}). Server going down.`,
          { rebooting: true, force: params.force, ...data }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- get_tweaksetting ----
  server.registerTool(
    "whm_get_tweak_setting",
    {
      title: "Get Tweak Setting",
      description:
        "Read a WHM Tweak Settings option (a key in /var/cpanel/cpanel.config or the Exim configuration), e.g. 'defaultmailaction' or 'proxysubdomains'.",
      inputSchema: {
        key: z.string().describe("Tweak Settings key"),
        module: z
          .enum(["Main", "Basic", "Mail", "Apache"])
          .optional()
          .describe("Tweak Settings module (default 'Main'; use 'Mail' for Exim settings)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("get_tweaksetting", { key: params.key, module: params.module });
        const t = data.tweaksetting ?? {};
        return formatResponse(
          params.response_format,
          `${t.key ?? params.key} = ${t.value === undefined || t.value === null ? "(unset)" : JSON.stringify(t.value)}`,
          { key: t.key ?? params.key, value: t.value ?? null }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- set_tweaksetting ----
  server.registerTool(
    "whm_set_tweak_setting",
    {
      title: "Set Tweak Setting",
      description:
        "Change a WHM Tweak Settings option. Server-wide effect — read the current value with whm_get_tweak_setting and confirm with the user first.",
      inputSchema: {
        key: z.string().describe("Tweak Settings key"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("New value (booleans are sent as 1/0)"),
        module: z
          .enum(["Main", "Basic", "Mail", "Apache"])
          .optional()
          .describe("Tweak Settings module (default 'Main'; use 'Mail' for Exim settings)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall(
          "set_tweaksetting",
          { key: params.key, value: params.value, module: params.module },
          "POST"
        );
        return formatResponse(
          params.response_format,
          `Set ${params.key} = ${JSON.stringify(params.value)}.`,
          { key: params.key, value: params.value }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
