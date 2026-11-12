import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { codeBlock, err, fmtTime, formatResponse, isTrue, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

// listcrts and fetch_ssl_vhosts return issuer fields as literal dotted keys.
function certIssuer(c: any): string {
  return (
    c?.["issuer.organizationName"] ??
    c?.["issuer.commonName"] ??
    c?.issuer?.organizationName ??
    c?.issuer?.commonName ??
    "n/a"
  );
}

function daysLeft(notAfter: unknown): number | undefined {
  const n = Number(notAfter);
  return n > 0 ? Math.floor((n - Date.now() / 1000) / 86400) : undefined;
}

function fmtDaysLeft(notAfter: unknown): string {
  const days = daysLeft(notAfter);
  if (days === undefined) return "expiry n/a";
  return days < 0 ? `EXPIRED ${-days} days ago` : `${days} days left`;
}

function fmtExpiry(notAfter: unknown): string {
  return daysLeft(notAfter) === undefined
    ? "expiry n/a"
    : `expires ${fmtTime(Number(notAfter)).slice(0, 10)} (${fmtDaysLeft(notAfter)})`;
}

function certCovers(certDomains: string[], domain: string): boolean {
  const d = domain.toLowerCase();
  return certDomains.some((c) => {
    const name = c.toLowerCase();
    return name === d || (name.startsWith("*.") && d.endsWith(name.slice(1)) && !d.slice(0, -name.length + 1).includes("."));
  });
}

export function registerSslTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_list_ssl_certs",
    {
      title: "List SSL Certificates",
      description:
        "List installed SSL certificates, soonest expiry first, with covered domains, issuer, validation type, and days until expiry. " +
        "Use expiring_within_days to find certificates that need attention.",
      inputSchema: {
        user: z.string().optional().describe("Only this cPanel account's certificates"),
        registered: z.boolean().optional().describe("Only certificates registered with a certificate authority"),
        expiring_within_days: z
          .number()
          .int()
          .optional()
          .describe("Only certificates expiring within this many days (includes already-expired ones)"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("listcrts", { user: params.user, registered: params.registered });
        let certs = (data.crt ?? []).map((c: any) => ({ ...c, issuer: certIssuer(c), days_left: daysLeft(c.not_after) }));
        if (params.expiring_within_days !== undefined) {
          certs = certs.filter((c: any) => c.days_left !== undefined && c.days_left <= params.expiring_within_days!);
        }
        certs.sort((a: any, b: any) => (Number(a.not_after) || Infinity) - (Number(b.not_after) || Infinity));
        const page = paginate<any>(certs, params.limit, params.offset);
        const md =
          [
            `# SSL certs (${page.total})`,
            ...page.items.map((c) => {
              const others = (c.domains ?? []).filter((d: string) => d !== c.domain);
              return `- **${c.domain}**${others.length ? ` (+${others.length}: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""})` : ""} — issuer ${
                c.issuer
              }${c.validation_type ? ` (${String(c.validation_type).toUpperCase()})` : ""}, ${fmtExpiry(c.not_after)}${
                isTrue(c.is_self_signed) ? " ⚠️ self-signed" : ""
              }`;
            }),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, certs: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_ssl_info",
    {
      title: "Get SSL Status for Domain",
      description:
        "Show the SSL certificate installed on a domain's website: issuer, validity dates, days left, covered domains, self-signed status, " +
        "and whether it actually covers the domain.",
      inputSchema: {
        domain: z.string(),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("fetch_ssl_vhosts");
        const domain = params.domain.toLowerCase();
        const vhosts = (data.vhosts ?? []).filter(
          (v: any) =>
            String(v.servername ?? "").toLowerCase() === domain ||
            (v.domains ?? []).some((d: string) => d.toLowerCase() === domain)
        );
        if (vhosts.length === 0) {
          return formatResponse(
            params.response_format,
            `No SSL virtual host found for ${params.domain} — no certificate is installed for it. Check AutoSSL with whm_get_autossl_problems.`,
            { domain: params.domain, installed: false, vhosts: [] }
          );
        }
        const result = vhosts.map((v: any) => {
          const c = v.crt ?? {};
          return {
            servername: v.servername,
            user: v.user,
            type: v.type,
            ip: v.ip,
            iptype: v.iptype,
            docroot: v.docroot,
            certificate: {
              id: c.id,
              issuer: certIssuer(c),
              validation_type: c.validation_type,
              is_self_signed: isTrue(c.is_self_signed),
              not_before: c.not_before,
              not_after: c.not_after,
              days_left: daysLeft(c.not_after),
              domains: c.domains ?? [],
              covers_domain: certCovers(c.domains ?? [], params.domain),
            },
          };
        });
        const md = [
          `# SSL for ${params.domain}`,
          ...result.flatMap((v: any) => [
            `## ${v.servername} (user ${v.user}, ${v.type})`,
            `- Issuer: ${v.certificate.issuer}${v.certificate.validation_type ? ` (${String(v.certificate.validation_type).toUpperCase()})` : ""}${
              v.certificate.is_self_signed ? " ⚠️ self-signed" : ""
            }`,
            `- Valid: ${fmtTime(v.certificate.not_before)} → ${fmtTime(v.certificate.not_after)} (${fmtDaysLeft(v.certificate.not_after)})`,
            `- Covers ${params.domain}: ${yesNo(v.certificate.covers_domain)}${v.certificate.covers_domain ? "" : " ⚠️ name mismatch"}`,
            `- Certificate domains: ${v.certificate.domains.join(", ") || "n/a"}`,
            `- IP: ${v.ip} (${v.iptype ?? "?"})`,
          ]),
        ].join("\n");
        return formatResponse(params.response_format, md, { domain: params.domain, installed: true, vhosts: result });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_install_ssl",
    {
      title: "Install SSL Certificate",
      description:
        "Install an SSL certificate for a domain. Requires PEM-encoded cert and key; the CA bundle is detected automatically if omitted.",
      inputSchema: {
        domain: z.string(),
        crt: z.string().describe("PEM-encoded certificate"),
        key: z.string().describe("PEM-encoded private key"),
        cab: z.string().optional().describe("CA bundle (chain) PEM"),
        ip: z.string().optional().describe("IP to install on (default: the domain's IP)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, ...rest } = params;
        const data: any = await whmCall("installssl", rest, "POST");
        if (data && data.status !== undefined && !isTrue(data.status)) {
          return err(`SSL installation failed: ${data.statusmsg ?? data.message ?? "unknown reason"}`);
        }
        const summary = {
          domain: data?.domain ?? params.domain,
          user: data?.user,
          ip: data?.ip,
          statusmsg: data?.statusmsg,
          working_domains: data?.working_domains ?? [],
          warning_domains: data?.warning_domains ?? [],
        };
        return formatResponse(
          response_format,
          `Installed SSL on ${summary.domain}.${summary.statusmsg ? ` ${summary.statusmsg}` : ""}${
            summary.warning_domains.length ? `\nDomains not covered by this certificate: ${summary.warning_domains.join(", ")}` : ""
          }`,
          summary
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_start_autossl_check",
    {
      title: "Start AutoSSL Check",
      description:
        "Start an AutoSSL run in the background — for one cPanel account, or for all accounts with AutoSSL enabled. " +
        "Follow it with whm_get_autossl_log; see failures with whm_get_autossl_problems.",
      inputSchema: {
        user: z.string().optional().describe("cPanel account to check (default: all accounts)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = params.user
          ? await whmCall("start_autossl_check_for_one_user", { username: params.user }, "POST")
          : await whmCall("start_autossl_check_for_all_users", {}, "POST");
        return formatResponse(
          params.response_format,
          `Started AutoSSL check for ${params.user ?? "all users"}${data?.pid ? ` (pid ${data.pid})` : ""}.`,
          { user: params.user ?? null, pid: data?.pid }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_autossl_problems",
    {
      title: "Get AutoSSL Problems",
      description:
        "Show the latest AutoSSL domain control validation (DCV) problems for a cPanel account or a single domain — why AutoSSL couldn't secure it.",
      inputSchema: {
        user: z.string().optional().describe("cPanel account (one of user/domain required)"),
        domain: z.string().optional().describe("Domain (one of user/domain required)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        if (!params.user && !params.domain) return err("Provide either 'user' or 'domain'.");
        const data: any = params.domain
          ? await whmCall("get_autossl_problems_for_domain", { domain: params.domain })
          : await whmCall("get_autossl_problems_for_user", { username: params.user });
        const problems = data.problems_by_domain ?? [];
        const md = [
          `# AutoSSL problems for ${params.domain ?? params.user} (${problems.length})`,
          ...(problems.length === 0 ? ["No DCV problems reported."] : []),
          ...problems.map((p: any) => `- **${p.domain}** (${p.time ?? "?"}) — ${p.problem}`),
        ].join("\n");
        return formatResponse(params.response_format, md, { problems });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_autossl_log",
    {
      title: "Get AutoSSL Log",
      description:
        "Read an AutoSSL run's log. Defaults to the most recent run (optionally the most recent for one account); filter to warnings/failures to see what went wrong.",
      inputSchema: {
        start_time: z.string().optional().describe("Log to read, as the start_time listed in recent_logs (default: most recent)"),
        user: z.string().optional().describe("When start_time is omitted, pick the most recent run for this account"),
        types: z
          .array(z.enum(["out", "warn", "success", "failure"]))
          .optional()
          .describe("Only these entry types, e.g. ['warn', 'failure']"),
        limit: z.number().int().min(1).max(2000).default(200).describe("Show the last N matching entries"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const catalog: any = await whmCall("get_autossl_logs_catalog");
        const logs = [...(catalog.payload ?? [])]
          .filter((l: any) => !params.user || l.username === params.user)
          .sort((a: any, b: any) => String(b.start_time).localeCompare(String(a.start_time)));
        const chosen = params.start_time ? logs.find((l: any) => l.start_time === params.start_time) : logs[0];
        const start = params.start_time ?? chosen?.start_time;
        if (!start) return err(`No AutoSSL logs found${params.user ? ` for ${params.user}` : ""}.`);
        const data: any = await whmCall("get_autossl_log", { start_time: start });
        const entries = (data.payload ?? []).filter((e: any) => !params.types || params.types.includes(e.type));
        const shown = entries.slice(-params.limit);
        const md = [
          `# AutoSSL log ${start}${
            chosen ? ` (provider ${chosen.provider ?? "?"}, ${chosen.username ?? "all users"}${isTrue(chosen.in_progress) ? ", in progress" : ""})` : ""
          }`,
          shown.length
            ? codeBlock(shown.map((e: any) => `${e.timestamp} [${e.type}] ${"  ".repeat(e.indent ?? 0)}${e.contents}`).join("\n"))
            : "No matching entries.",
          ...(logs.length > 1 ? [`Other recent runs: ${logs.slice(0, 6).map((l: any) => l.start_time).filter((t: string) => t !== start).join(", ")}`] : []),
        ].join("\n");
        return formatResponse(params.response_format, md, {
          start_time: start,
          log: chosen ?? null,
          total_entries: entries.length,
          entries: shown,
          recent_logs: logs.slice(0, 10),
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
