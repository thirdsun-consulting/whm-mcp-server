import { z } from "zod";
import { apiChunk, apiFilters, apiSort, handleWhmError, uapiCall, whmCall } from "../services/client.js";
import {
  codeBlock,
  err,
  fmtAge,
  fmtBytes,
  fmtTime,
  formatResponse,
  isTrue,
  matches,
  pageNote,
  paginate,
  toUnixSeconds,
} from "../services/format.js";
import { FormatSchema, PaginationSchema, TimeSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

function topCounts(values: string[], n = 10): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

const OUTGOING_EMAIL_FUNCTIONS = {
  hold: "hold_outgoing_email",
  release: "release_outgoing_email",
  suspend: "suspend_outgoing_email",
  unsuspend: "unsuspend_outgoing_email",
} as const;

const MAIL_DNS_CHECKS = {
  dkim: "validate_current_dkims",
  spf: "validate_current_spfs",
  dmarc: "validate_current_dmarcs",
  ptr: "validate_current_ptrs",
} as const;

export function registerEmailTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_get_mail_queue_summary",
    {
      title: "Get Mail Queue Summary",
      description:
        "Summarize the Exim mail queue: message count, frozen messages, total size, oldest message age, and the top senders, accounts, and recipient domains. " +
        "Critical for diagnosing mail delivery issues and outbound spam — large or old queues indicate problems.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("fetch_mail_queue");
        const records: any[] = data.records ?? [];
        const now = Math.floor(Date.now() / 1000);
        const times = records.map((r) => Number(r.time)).filter((t) => t > 0);
        const oldest = times.length ? Math.min(...times) : undefined;
        const summary = {
          total: records.length,
          frozen: records.filter((r) => isTrue(r.frozen)).length,
          total_size_bytes: records.reduce((sum, r) => sum + (Number(r.size) || 0), 0),
          oldest_time: oldest ?? null,
          oldest_age_seconds: oldest ? now - oldest : null,
          top_senders: topCounts(records.map((r) => r.sender)),
          top_accounts: topCounts(records.map((r) => r.user)),
          top_recipient_domains: topCounts(
            records.flatMap((r) => (r.recipients ?? []).map((rcpt: string) => rcpt.split("@").pop()?.toLowerCase() ?? ""))
          ),
        };
        const list = (title: string, items: { value: string; count: number }[]) =>
          items.length ? [`## ${title}`, ...items.map((i) => `- ${i.value} — ${i.count}`)] : [];
        const md = [
          `# Mail queue summary`,
          `- Messages in queue: ${summary.total} (${summary.frozen} frozen)`,
          `- Total size: ${fmtBytes(summary.total_size_bytes)}`,
          `- Oldest message: ${oldest ? `${fmtTime(oldest)} (${fmtAge(now - oldest)} ago)` : "n/a"}`,
          ...list("Top senders", summary.top_senders),
          ...list("Top accounts", summary.top_accounts),
          ...list("Top recipient domains", summary.top_recipient_domains),
        ].join("\n");
        return formatResponse(params.response_format, md, summary);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_mail_queue",
    {
      title: "List Mail Queue",
      description:
        "List messages in the Exim mail queue with sender, recipients, size, age, and frozen status. Filter by sender, recipient, account, or frozen state.",
      inputSchema: {
        sender: z.string().optional().describe("Substring of the sender address"),
        recipient: z.string().optional().describe("Substring of any recipient address"),
        user: z.string().optional().describe("Only messages owned by this cPanel account"),
        frozen_only: z.boolean().default(false).describe("Only frozen messages"),
        sort: z.enum(["oldest", "newest"]).default("oldest").describe("'oldest' surfaces stuck messages first"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("fetch_mail_queue");
        const now = Math.floor(Date.now() / 1000);
        const records = (data.records ?? [])
          .filter(
            (r: any) =>
              matches(r.sender, params.sender) &&
              (!params.recipient || (r.recipients ?? []).some((rcpt: string) => matches(rcpt, params.recipient))) &&
              (!params.user || r.user === params.user) &&
              (!params.frozen_only || isTrue(r.frozen))
          )
          .sort((a: any, b: any) => (params.sort === "oldest" ? a.time - b.time : b.time - a.time));
        const page = paginate<any>(records, params.limit, params.offset);
        const md =
          [
            `# Mail queue (${page.total} messages)`,
            ...page.items.map(
              (r) =>
                `- \`${r.msgid}\` ${fmtTime(r.time)} (${fmtAge(now - r.time)} old) — from ${r.sender || "<>"} to ${(r.recipients ?? []).join(", ")}, ${fmtBytes(
                  r.size
                )}${r.user ? ` [${r.user}]` : ""}${isTrue(r.frozen) ? " ❄️ frozen" : ""}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, messages: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_exim_stats",
    {
      title: "Get Email Sending Stats",
      description:
        "Per-account email statistics for a time window (default: last 24 hours): messages sent, delivered, failed, and deferred, and whether the account hit its hourly sending or defer/fail limits. " +
        "Use it to find spam sources and accounts with delivery problems.",
      inputSchema: {
        hours: z.number().min(1).max(24 * 90).default(24).describe("Look-back window in hours (ignored if starttime is set)"),
        starttime: TimeSchema.optional().describe("Window start: unix seconds or ISO date"),
        endtime: TimeSchema.optional().describe("Window end: unix seconds or ISO date (default: now)"),
        sender: z.string().optional().describe("Only messages from this sender address"),
        deliverytype: z.enum(["remote", "remote-or-faildefer", "local"]).optional().describe("Delivery type (default: all)"),
        sort_by: z.enum(["sent", "failed", "deferred"]).default("sent"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const end = toUnixSeconds(params.endtime) ?? Math.floor(Date.now() / 1000);
        const start = toUnixSeconds(params.starttime) ?? end - Math.round(params.hours * 3600);
        const data: any = await whmCall("emailtrack_user_stats", {
          starttime: start,
          endtime: end,
          sender: params.sender,
          deliverytype: params.deliverytype,
        });
        const key = { sent: "SENDCOUNT", failed: "FAILCOUNT", deferred: "DEFERCOUNT" }[params.sort_by];
        const records = [...(data.records ?? [])].sort((a: any, b: any) => (b[key] ?? 0) - (a[key] ?? 0));
        const sum = (k: string) => records.reduce((s: number, r: any) => s + (Number(r[k]) || 0), 0);
        const totals = { sent: sum("SENDCOUNT"), delivered: sum("SUCCESSCOUNT"), failed: sum("FAILCOUNT"), deferred: sum("DEFERCOUNT") };
        const page = paginate<any>(records, params.limit, params.offset);
        const md =
          [
            `# Email stats per account (${fmtTime(start)} → ${fmtTime(end)})`,
            `Totals: sent ${totals.sent}, delivered ${totals.delivered}, failed ${totals.failed}, deferred ${totals.deferred}`,
            ...page.items.map(
              (r) =>
                `- **${r.USER}** (${r.PRIMARY_DOMAIN ?? r.DOMAIN}) — sent ${r.SENDCOUNT ?? 0}, delivered ${r.SUCCESSCOUNT ?? 0}, failed ${
                  r.FAILCOUNT ?? 0
                }, deferred ${r.DEFERCOUNT ?? 0}${isTrue(r.REACHED_MAXEMAILS) ? " ⚠️ hit hourly send limit" : ""}${
                  isTrue(r.REACHED_MAXDEFERFAIL) ? " ⚠️ hit defer/fail limit" : ""
                }`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { starttime: start, endtime: end, totals, ...meta, accounts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_search_mail_delivery_log",
    {
      title: "Search Mail Delivery Log",
      description:
        "Search Exim delivery records (WHM's Mail Delivery Reports), newest first: successful deliveries, deferrals, failures, and in-progress messages, " +
        "with the remote server's response. Filter by sender, recipient, account, or message ID. Use it to answer \"why didn't this email arrive?\"",
      inputSchema: {
        sender: z.string().optional().describe("Substring of the sender address"),
        recipient: z.string().optional().describe("Substring of the recipient address"),
        user: z.string().optional().describe("Sender's cPanel account"),
        msgid: z.string().optional().describe("Exim message ID"),
        types: z
          .array(z.enum(["success", "defer", "failure", "inprogress"]))
          .min(1)
          .default(["success", "defer", "failure", "inprogress"])
          .describe("Delivery events to include"),
        hours: z.number().min(1).max(24 * 90).default(24).describe("Look-back window in hours"),
        deliverytype: z.enum(["all", "remote", "local"]).default("all"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const since = Math.floor(Date.now() / 1000) - Math.round(params.hours * 3600);
        const data: any = await whmCall("emailtrack_search", {
          success: params.types.includes("success"),
          defer: params.types.includes("defer"),
          failure: params.types.includes("failure"),
          inprogress: params.types.includes("inprogress"),
          deliverytype: params.deliverytype,
          // This log is large; WHM recommends filtering, sorting, and paging server-side.
          ...apiFilters([
            { field: "sendunixtime", type: "gt", arg0: since },
            { field: "sender", arg0: params.sender },
            { field: "recipient", arg0: params.recipient },
            { field: "user", type: "eq", arg0: params.user },
            { field: "msgid", type: "eq", arg0: params.msgid },
          ]),
          ...apiSort("sendunixtime", { method: "numeric", reverse: true }),
          ...apiChunk(params.limit, params.offset),
        });
        const records: any[] = data.records ?? [];
        const hasMore = records.length === params.limit;
        const md =
          [
            `# Mail delivery log — last ${params.hours}h (${records.length} records)`,
            ...records.map(
              (r) =>
                `- ${fmtTime(r.actionunixtime ?? r.sendunixtime)} **${r.type}** ${r.sender || "<>"} → ${r.recipient}${r.user ? ` [${r.user}]` : ""}${
                  r.host ? ` via ${r.host}${r.ip ? ` (${r.ip})` : ""}` : ""
                }${r.message ? ` — ${String(r.message).slice(0, 300)}` : ""}${r.msgid ? ` (\`${r.msgid}\`)` : ""}`
            ),
          ].join("\n") + (hasMore ? `\n\n_More records may exist. Use offset=${params.offset + records.length}._` : "");
        return formatResponse(params.response_format, md, {
          since,
          count: records.length,
          offset: params.offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + records.length } : {}),
          records,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_manage_outgoing_email",
    {
      title: "Hold/Suspend Outgoing Email",
      description:
        "Control a cPanel account's outbound email: 'hold' queues outgoing mail without delivering it (e.g. while investigating spam), " +
        "'release' delivers held mail, 'suspend' rejects and fails outgoing mail, 'unsuspend' restores normal sending. Confirm with user.",
      inputSchema: {
        user: z.string().describe("cPanel account (not root)"),
        action: z.enum(["hold", "release", "suspend", "unsuspend"]),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall(OUTGOING_EMAIL_FUNCTIONS[params.action], { user: params.user }, "POST");
        const summary = {
          hold: `Outgoing email for ${params.user} is now held in the queue.`,
          release: `Released held outgoing email for ${params.user}.`,
          suspend: `Outgoing email for ${params.user} is now suspended.`,
          unsuspend: `Outgoing email for ${params.user} is no longer suspended.`,
        }[params.action];
        return formatResponse(params.response_format, summary, { user: params.user, action: params.action });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_pop_accounts_for_user",
    {
      title: "List Email Accounts for User",
      description: "List all POP/IMAP email accounts under a cPanel user.",
      inputSchema: {
        user: z.string(),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("list_pops_for", { user: params.user });
        const accts: string[] = data.pops ?? [];
        const md = [
          `# Email accounts for ${params.user} (${accts.length})`,
          ...accts.map((a) => `- ${a}`),
        ].join("\n");
        return formatResponse(params.response_format, md, { accounts: accts });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_pop_accounts_with_disk",
    {
      title: "List Email Accounts with Disk Usage",
      description:
        "List a cPanel account's email addresses with disk usage, quota, and suspension/hold flags, largest first. " +
        "Useful for finding mailboxes near quota or consuming bulk storage.",
      inputSchema: {
        user: z.string().describe("cPanel account"),
        domain: z.string().optional().describe("Restrict to one domain"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const res = await uapiCall(params.user, "Email", "list_pops_with_disk", { domain: params.domain });
        const accts = [...((res.data as any[]) ?? [])].sort(
          (a: any, b: any) => (Number(b._diskused) || 0) - (Number(a._diskused) || 0)
        );
        const page = paginate<any>(accts, params.limit, params.offset);
        const flags = (a: any) =>
          [
            isTrue(a.suspended_login) && "login suspended",
            isTrue(a.suspended_incoming) && "incoming suspended",
            isTrue(a.suspended_outgoing) && "outgoing suspended",
            isTrue(a.hold_outgoing) && "outgoing held",
          ].filter(Boolean);
        const md =
          [
            `# Email accounts for ${params.user}${params.domain ? ` @${params.domain}` : ""} (${page.total})`,
            ...page.items.map((a) => {
              const quota = a.humandiskquota && a.humandiskquota !== "None" ? a.humandiskquota : "unlimited";
              const f = flags(a);
              return `- ${a.email} — ${a.humandiskused ?? fmtBytes(a._diskused)} / ${quota}${
                a.diskusedpercent ? ` (${a.diskusedpercent}%)` : ""
              }${f.length ? ` [${f.join(", ")}]` : ""}`;
            }),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, accounts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_validate_mail_dns",
    {
      title: "Validate Mail DNS (DKIM/SPF/DMARC/PTR)",
      description:
        "Check domains' email authentication and reverse DNS as seen from the server: DKIM, SPF, and DMARC records, and PTR (rDNS) for the IPs they send from. " +
        "Reports each record's state and the expected/suggested value when it is wrong or missing.",
      inputSchema: {
        domains: z.array(z.string()).min(1).max(100),
        checks: z
          .array(z.enum(["dkim", "spf", "dmarc", "ptr"]))
          .min(1)
          .default(["dkim", "spf", "dmarc", "ptr"]),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const checks = [...new Set(params.checks)];
        const settled = await Promise.allSettled(
          checks.map((c) => whmCall(MAIL_DNS_CHECKS[c], { domain: params.domains }))
        );
        const results: Record<string, any> = {};
        const errors: Record<string, string> = {};
        const md: string[] = [`# Mail DNS validation`];
        settled.forEach((s, i) => {
          const check = checks[i];
          md.push(`## ${check.toUpperCase()}`);
          if (s.status === "rejected") {
            errors[check] = handleWhmError(s.reason);
            md.push(`- _check failed: ${errors[check]}_`);
            return;
          }
          const payload: any[] = s.value?.payload ?? [];
          results[check] = payload;
          for (const p of payload) {
            const valid = p.state === "VALID";
            const hint =
              valid ? "" :
              check === "spf" && p.expected ? ` — expected: ${p.expected}` :
              check === "dmarc" && p.suggested ? ` — suggested: ${p.suggested}` :
              check === "dkim" && p.expected ? " — expected record is in the JSON output" : "";
            md.push(
              `- ${valid ? "✅" : "❌"} ${p.domain}${p.ip_address ? ` (${p.ip_address})` : ""}: ${p.state}${p.error ? ` — ${p.error}` : ""}${hint}`
            );
          }
        });
        if (Object.keys(results).length === 0) return err(Object.values(errors)[0]);
        return formatResponse(params.response_format, md.join("\n"), {
          ...results,
          ...(Object.keys(errors).length ? { errors } : {}),
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_enable_dkim",
    {
      title: "Enable DKIM",
      description: "Enable DKIM signing and publish DKIM records for one or more domains on the server's DNS.",
      inputSchema: {
        domains: z.array(z.string()).min(1).max(100),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("enable_dkim", { domain: params.domains }, "POST");
        const payload: any[] = data?.payload ?? [];
        const md = [
          `# Enable DKIM`,
          ...payload.map((p) => `- ${isTrue(p.status) ? "✅" : "❌"} ${p.domain}${p.msg ? ` — ${p.msg}` : ""}`),
        ].join("\n");
        return formatResponse(params.response_format, md, { results: payload });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_validate_exim_config",
    {
      title: "Validate Exim Configuration",
      description:
        "Validate the syntax of the server's current Exim configuration and report the failing line if it's broken, or the enabled mail features (DKIM, SPF, SRS, etc.) if it's valid.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("validate_exim_configuration_syntax");
        if (data?.error_msg || data?.error_line) {
          return formatResponse(
            params.response_format,
            `# Exim configuration: INVALID\n- Line ${data.error_line ?? "?"}: ${data.error_msg ?? "unknown error"}${
              data.broken_cfg_text ? `\n${codeBlock(String(data.broken_cfg_text))}` : ""
            }`,
            { valid: false, error_line: data.error_line, error_msg: data.error_msg, broken_cfg_text: data.broken_cfg_text }
          );
        }
        const caps = data?.exim_caps ?? {};
        const enabled = Object.entries(caps)
          .filter(([k, v]) => k !== "directives" && isTrue(v))
          .map(([k]) => k);
        return formatResponse(
          params.response_format,
          `# Exim configuration: valid\nEnabled capabilities: ${enabled.join(", ") || "n/a"}`,
          { valid: true, exim_caps: caps }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
