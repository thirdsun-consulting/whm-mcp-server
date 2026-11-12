import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, fmtBytes, formatResponse, isTrue, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

/** resellerstats reports sizes in MB; 0 means unlimited for limits. */
function fmtMb(value: unknown, zeroIsUnlimited = false): string {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || isNaN(n)) return "n/a";
  if (zeroIsUnlimited && n === 0) return "unlimited";
  return fmtBytes(n * 1024 * 1024);
}

export function registerResellerTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_list_resellers",
    {
      title: "List Resellers",
      description: "List all reseller accounts on the server.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("listresellers");
        const resellers: string[] = data.reseller ?? [];
        const md = `# Resellers (${resellers.length})\n${resellers.map((r) => `- ${r}`).join("\n")}`;
        return formatResponse(params.response_format, md, { resellers });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_reseller_stats",
    {
      title: "Get Reseller Stats",
      description:
        "Get a reseller's usage: account counts vs. limit, disk and bandwidth used vs. allocated and quota, overselling settings, and each owned account's usage.",
      inputSchema: {
        user: z.string().describe("Reseller username"),
        month: z.number().int().min(1).max(12).optional().describe("Bandwidth month (default: current)"),
        year: z.number().int().min(2000).max(2100).optional(),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const [stats, counts] = await Promise.all([
          whmCall("resellerstats", { user: params.user, month: params.month, year: params.year, filter_deleted: true }),
          whmCall("acctcounts", { user: params.user }).catch(() => undefined),
        ]);
        const r = stats?.reseller ?? {};
        const c = counts?.reseller;
        const accounts = [...(r.acct ?? [])].sort((a: any, b: any) => Number(b.diskused) - Number(a.diskused));
        const page = paginate<any>(accounts, params.limit, params.offset);
        const md =
          [
            `# Reseller ${params.user} (${r.month ?? params.month ?? ""}/${r.year ?? params.year ?? ""})`,
            ...(c ? [`- Accounts: ${c.active} active, ${c.suspended} suspended (limit: ${c.limit || "unlimited"})`] : []),
            `- Disk: ${fmtMb(r.diskused)} used, ${fmtMb(r.totaldiskalloc)} allocated to accounts, quota ${fmtMb(r.diskquota, true)} (overselling: ${yesNo(
              r.diskoverselling
            )})`,
            `- Bandwidth: ${fmtMb(r.totalbwused)} used, ${fmtMb(r.totalbwalloc)} allocated, limit ${fmtMb(r.bandwidthlimit, true)} (overselling: ${yesNo(
              r.bwoverselling
            )})`,
            `## Accounts (${page.total})`,
            ...page.items.map(
              (a) =>
                `- **${a.user}** (${a.domain}) — package ${a.package}, disk ${fmtMb(a.diskused)} / ${fmtMb(a.diskquota, true)}, bandwidth ${fmtMb(
                  a.bandwidthused
                )} / ${fmtMb(a.bandwidthlimit, true)}${isTrue(a.suspended) ? " [suspended]" : ""}`
            ),
          ].join("\n") + pageNote(page);
        const { acct, ...totals } = r;
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, {
          ...totals,
          account_counts: c ?? null,
          ...meta,
          accounts: items,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_set_reseller_limits",
    {
      title: "Set Reseller Limits",
      description:
        "Set a reseller's account-count, disk, and bandwidth limits and overselling. WHM documents both enforcement flags as " +
        "defaulting to off when omitted, and no API reports their current state, so both are required: check the current limits " +
        "with whm_get_reseller_stats and confirm with the user first.",
      inputSchema: {
        user: z.string(),
        enable_account_limit: z.boolean().describe("Enforce a maximum number of accounts (false = no account limit)"),
        enable_resource_limits: z
          .boolean()
          .describe("Enforce the disk and bandwidth limits and overselling settings (false = no resource limits)"),
        account_limit: z.number().int().min(0).optional().describe("Max number of accounts"),
        bandwidth_limit: z.number().int().min(0).optional().describe("Total bandwidth limit, in MB"),
        diskspace_limit: z.number().int().min(0).optional().describe("Total disk space limit, in MB"),
        enable_overselling: z.boolean().optional().describe("Allow overselling"),
        enable_overselling_bandwidth: z.boolean().optional().describe("Allow overselling bandwidth"),
        enable_overselling_diskspace: z.boolean().optional().describe("Allow overselling disk space"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, user, ...request } = params;
        await whmCall("setresellerlimits", { user, ...request }, "POST");
        const applied = Object.entries(request).filter(([, v]) => v !== undefined);
        return formatResponse(
          response_format,
          `Updated limits for reseller ${user}: ${applied.map(([k, v]) => `${k}=${v}`).join(", ")}.`,
          { user, ...Object.fromEntries(applied) }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_setup_reseller",
    {
      title: "Make Account a Reseller",
      description: "Grant reseller privileges to an existing cPanel account.",
      inputSchema: {
        user: z.string(),
        makeowner: z.boolean().default(false).describe("Make the account own itself"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("setupreseller", { user: params.user, makeowner: params.makeowner }, "POST");
        return formatResponse(params.response_format, `${params.user} is now a reseller.`, {
          user: params.user,
          reseller: true,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_remove_reseller",
    {
      title: "Remove Reseller Privileges",
      description:
        "Revoke an account's reseller privileges. The account itself and the accounts it owns are kept. Confirm with user.",
      inputSchema: { user: z.string(), ...FormatSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("unsetupreseller", { user: params.user }, "POST");
        return formatResponse(params.response_format, `Removed reseller privileges from ${params.user}.`, {
          user: params.user,
          reseller: false,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
