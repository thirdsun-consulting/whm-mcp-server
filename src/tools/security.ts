import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, formatResponse, isTrue, matches, pageNote, paginate, stripHtml, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

const CPHULK_REPORTS = {
  failed_logins: { fn: "get_cphulk_failed_logins", key: "failed_logins" },
  brutes: { fn: "get_cphulk_brutes", key: "brutes" },
  excessive_brutes: { fn: "get_cphulk_excessive_brutes", key: "excessive_brutes" },
  user_brutes: { fn: "get_cphulk_user_brutes", key: "user_brutes" },
} as const;

const ADVICE_LEVELS = {
  ADVISE_BAD: "bad",
  ADVISE_WARN: "warn",
  ADVISE_INFO: "info",
  ADVISE_GOOD: "good",
} as const;

const IpListSchema = z.array(z.string()).min(1).max(100).describe("IP addresses or CIDR ranges");

export function registerSecurityTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_get_cphulk_status",
    {
      title: "Get cPHulk Status",
      description: "Check whether cPHulk brute-force login protection is enabled.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("cphulk_status");
        return formatResponse(params.response_format, `cPHulk is ${isTrue(data.is_enabled) ? "enabled" : "DISABLED"}.`, {
          enabled: isTrue(data.is_enabled),
          service: data.service,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_failed_logins",
    {
      title: "Get Failed Logins (cPHulk)",
      description:
        "Show cPHulk's record of failed logins and brute-force blocks across cPanel, WHM, Webmail, mail, FTP, and SSH: " +
        "'failed_logins' (individual failures), 'brutes' (IPs blocked for brute force), 'excessive_brutes' (IPs blocked longer), " +
        "'user_brutes' (attacks against specific usernames). Use whm_unblock_ips to lift a block.",
      inputSchema: {
        report: z.enum(["failed_logins", "brutes", "excessive_brutes", "user_brutes"]).default("failed_logins"),
        ip: z.string().optional().describe("Only this IP (substring match)"),
        user: z.string().optional().describe("Only this username (failed_logins/user_brutes)"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { fn, key } = CPHULK_REPORTS[params.report];
        const data: any = await whmCall(fn);
        const rows = (data[key] ?? []).filter(
          (r: any) => matches(r.ip, params.ip) && (!params.user || r.user === params.user)
        );
        const page = paginate<any>(rows, params.limit, params.offset);
        const md =
          [
            `# cPHulk ${params.report.replace(/_/g, " ")} (${page.total})`,
            ...page.items.map(
              (r) =>
                `- ${r.logintime ?? "?"} — ${r.user ? `${r.user}@` : ""}${r.ip}${r.service ? ` via ${r.service}` : ""}${
                  r.authservice && r.authservice !== r.service ? ` (${r.authservice})` : ""
                }${r.timeleft !== undefined ? `, ${r.timeleft} min left` : ""}${r.notes ? ` — ${r.notes}` : ""}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { report: params.report, ...meta, entries: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_cphulk_records",
    {
      title: "List cPHulk Whitelist/Blacklist",
      description: "List the IP addresses on cPHulk's whitelist (never blocked) or blacklist (always blocked), with comments.",
      inputSchema: {
        list_name: z.enum(["white", "black"]),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("read_cphulk_records", { list_name: params.list_name });
        const records = Object.entries(data.ips_in_list ?? {}).map(([ip, comment]) => ({ ip, comment }));
        const md = [
          `# cPHulk ${params.list_name}list (${records.length})`,
          ...records.map((r) => `- ${r.ip}${r.comment ? ` — ${r.comment}` : ""}`),
          ...(data.requester_ip
            ? [`\nYour IP ${data.requester_ip} is whitelisted: ${yesNo(data.requester_ip_is_whitelisted)}`]
            : []),
          ...(data.warning_ip ? [`⚠️ ${data.warning_ip}`] : []),
        ].join("\n");
        return formatResponse(params.response_format, md, {
          list_name: params.list_name,
          records,
          requester_ip: data.requester_ip,
          requester_ip_is_whitelisted: data.requester_ip_is_whitelisted,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_add_cphulk_record",
    {
      title: "Add to cPHulk Whitelist/Blacklist",
      description:
        "Add IPs or CIDR ranges to cPHulk's whitelist (never blocked; also clears existing blocks) or blacklist (always blocked). Confirm blacklist additions with the user.",
      inputSchema: {
        list_name: z.enum(["white", "black"]),
        ips: IpListSchema,
        comment: z.string().optional(),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall(
          "create_cphulk_record",
          { list_name: params.list_name, ip: params.ips, comment: params.comment },
          "POST"
        );
        const failed = Object.entries(data?.ips_failed ?? {});
        const md = [
          `Added to the ${params.list_name}list: ${(data?.ips_added ?? []).join(", ") || "none"}.`,
          ...failed.map(([ip, reason]) => `- ❌ ${ip}: ${reason}`),
          ...(data?.ip_blocks_removed || data?.iptable_bans_removed
            ? [`Removed ${data.ip_blocks_removed ?? 0} login blocks and ${data.iptable_bans_removed ?? 0} firewall bans.`]
            : []),
        ].join("\n");
        return formatResponse(params.response_format, md, data);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_remove_cphulk_record",
    {
      title: "Remove from cPHulk Whitelist/Blacklist",
      description: "Remove IPs or CIDR ranges from cPHulk's whitelist or blacklist.",
      inputSchema: {
        list_name: z.enum(["white", "black"]),
        ips: IpListSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall(
          "delete_cphulk_record",
          { list_name: params.list_name, ip: params.ips },
          "POST"
        );
        const failed = Object.entries(data?.ips_failed ?? {});
        const md = [
          `Removed from the ${params.list_name}list: ${(data?.ips_removed ?? []).join(", ") || "none"}.`,
          ...failed.map(([ip, reason]) => `- ❌ ${ip}: ${reason}`),
        ].join("\n");
        return formatResponse(params.response_format, md, data);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_unblock_ips",
    {
      title: "Unblock IPs (cPHulk)",
      description:
        "Lift cPHulk brute-force blocks for IP addresses by clearing their failed-login history — the usual fix when a customer is locked out.",
      inputSchema: { ips: IpListSchema, ...FormatSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("flush_cphulk_login_history_for_ips", { ip: params.ips }, "POST");
        return formatResponse(
          params.response_format,
          `Unblocked ${params.ips.join(", ")}: removed ${data?.records_removed ?? 0} login records and ${
            data?.iptable_bans_removed ?? 0
          } firewall bans.`,
          { ips: params.ips, ...data }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_security_advice",
    {
      title: "Get Security Advisor Results",
      description:
        "Run cPanel's Security Advisor and return its findings with suggested fixes. Defaults to problems only (bad and warn).",
      inputSchema: {
        levels: z
          .array(z.enum(["bad", "warn", "info", "good"]))
          .min(1)
          .default(["bad", "warn"])
          .describe("Severity levels to include"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("fetch_security_advice");
        const payload: any[] = data.payload ?? [];
        const advice = payload
          .filter((p) => p.type === "mod_advice" && p.advice)
          .map((p) => ({
            module: p.module,
            level: ADVICE_LEVELS[p.advice.type as keyof typeof ADVICE_LEVELS] ?? String(p.advice.type).toLowerCase(),
            key: p.advice.key,
            summary: stripHtml(p.advice.summary),
            suggestion: stripHtml(p.advice.suggestion),
          }))
          .filter((a) => (params.levels as string[]).includes(a.level));
        const order = ["bad", "warn", "info", "good"];
        advice.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
        const moduleErrors = payload
          .filter((p) => p.type !== "mod_advice" && p.message)
          .map((p) => ({ module: p.module, message: stripHtml(p.message) }));
        const md = [
          `# Security Advisor (${advice.length} findings)`,
          ...advice.map((a) => `- **[${a.level.toUpperCase()}]** ${a.summary}${a.suggestion ? ` — ${a.suggestion}` : ""}`),
          ...moduleErrors.map((m) => `- _${m.module} could not run: ${m.message}_`),
        ].join("\n");
        return formatResponse(params.response_format, md, { findings: advice, module_errors: moduleErrors });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
