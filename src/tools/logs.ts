import { z } from "zod";
import { handleWhmError, uapiCall, whmCall } from "../services/client.js";
import { codeBlock, err, fmtTime, formatResponse, matches, pageNote, paginate } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

/**
 * Log reading for error monitoring. WHM API 1 has no generic log tail; these
 * tools use the documented sources: a domain's Apache error log (UAPI
 * Stats::get_site_errors, run as the owning account) and the ModSecurity hit
 * log. Mail delivery logs are in whm_search_mail_delivery_log, login failures
 * in whm_get_failed_logins, and AutoSSL runs in whm_get_autossl_log.
 */
export function registerLogTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_get_domain_error_log",
    {
      title: "Get Domain Error Log",
      description:
        "Read recent Apache error_log (or suexec_log) entries for a domain — the first stop for 500 errors, PHP fatals, and permission problems. " +
        "The owning cPanel account is looked up automatically.",
      inputSchema: {
        domain: z.string(),
        user: z.string().optional().describe("cPanel account that owns the domain (looked up if omitted)"),
        log: z.enum(["error", "suexec"]).default("error"),
        maxlines: z.number().int().min(1).max(1000).default(200).describe("Log lines to retrieve"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const user = params.user ?? (await whmCall("getdomainowner", { domain: params.domain }))?.user;
        if (!user) return err(`Couldn't find the cPanel account that owns ${params.domain}; pass 'user'.`);
        const res = await uapiCall(user, "Stats", "get_site_errors", {
          domain: params.domain,
          log: params.log,
          maxlines: params.maxlines,
        });
        const entries: any[] = res.data ?? [];
        const text = entries.map((e) => `[${fmtTime(e.date)}] ${e.entry}`).join("\n");
        return formatResponse(
          params.response_format,
          `# ${params.log}_log for ${params.domain} (${entries.length} entries)\n${entries.length ? codeBlock(text) : "No entries."}`,
          { domain: params.domain, user, log: params.log, entries }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_modsec_log",
    {
      title: "Get ModSecurity Log",
      description:
        "List recent ModSecurity (web application firewall) hits, newest first: domain, client IP, request, HTTP status, and the rule that fired. " +
        "Use it to explain unexpected 403s or to find the rule ID to whitelist.",
      inputSchema: {
        host: z.string().optional().describe("Substring of the domain (vhost)"),
        ip: z.string().optional().describe("Client IP (substring match)"),
        rule_id: z.number().int().optional().describe("Only hits from this rule ID"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("modsec_get_log");
        const hits = (Array.isArray(data) ? data : [])
          .filter(
            (h: any) =>
              matches(h.host, params.host) &&
              matches(h.ip, params.ip) &&
              (params.rule_id === undefined || Number(h.meta_id) === params.rule_id)
          )
          .sort((a: any, b: any) => (Number(b.id) || 0) - (Number(a.id) || 0));
        const page = paginate<any>(hits, params.limit, params.offset);
        const md =
          [
            `# ModSecurity hits (${page.total})`,
            ...page.items.map(
              (h) =>
                `- ${h.timestamp} ${h.host} ${h.ip} ${h.http_method ?? ""} ${h.meta_uri || h.path || ""} → ${h.http_status ?? "?"} — rule ${
                  h.meta_id ?? "?"
                }: ${h.meta_msg ?? "n/a"}${h.meta_severity ? ` [${h.meta_severity}]` : ""}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, hits: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
