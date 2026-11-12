import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, formatResponse, isTrue, pageNote, paginate, redactSecrets, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdays(value: unknown): string {
  const days = String(value ?? "")
    .split(",")
    .map((d) => WEEKDAYS[Number(d.trim())])
    .filter(Boolean);
  return days.length ? days.join(", ") : "none";
}

// WHM lists backup dates as ISO timestamps but restore_queue_add_task wants YYYY-MM-DD.
const toDate = (value: string) => value.slice(0, 10);

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .transform(toDate)
  .describe("Backup date, YYYY-MM-DD (from whm_list_backup_dates)");

export function registerBackupTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_get_backup_config",
    {
      title: "Get Backup Configuration",
      description:
        "Get the WHM backup configuration: whether backups are enabled, type, daily/weekly/monthly schedule and retention, what's included, and the local backup directory.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("backup_config_get");
        const c = data.backup_config ?? {};
        const md = [
          `# Backup configuration`,
          `- Backups enabled: ${yesNo(c.backupenable)} (type: ${c.backuptype ?? "n/a"})`,
          `- Daily: ${isTrue(c.backup_daily_enable) ? `on ${weekdays(c.backupdays)}, keep ${c.backup_daily_retention}` : "off"}`,
          `- Weekly: ${isTrue(c.backup_weekly_enable) ? `on ${weekdays(c.backup_weekly_day)}, keep ${c.backup_weekly_retention}` : "off"}`,
          `- Monthly: ${isTrue(c.backup_monthly_enable) ? `on day(s) ${c.backup_monthly_dates}, keep ${c.backup_monthly_retention}` : "off"}`,
          `- Includes: accounts ${yesNo(c.backupaccts)}, suspended accounts ${yesNo(c.backupsuspendedaccounts)}, system files ${yesNo(
            c.backupfiles
          )}, logs ${yesNo(c.backuplogs)}, bandwidth data ${yesNo(c.backupbwdata)}`,
          `- MySQL backup method: ${c.mysqlbackup ?? "n/a"}, PostgreSQL: ${yesNo(c.psqlbackup)}`,
          `- Local directory: ${c.backupdir ?? "n/a"} (keep local copies: ${yesNo(c.keeplocal)})`,
          `- Free space check: ${isTrue(c.check_min_free_space) ? `min ${c.min_free_space} ${c.min_free_space_unit}` : "off"}`,
        ].join("\n");
        return formatResponse(params.response_format, md, redactSecrets(c));
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_backup_destinations",
    {
      title: "List Backup Destinations",
      description: "List configured additional backup destinations (S3, SFTP, FTP, Google Drive, etc.) and whether each is enabled. Credentials are redacted.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("backup_destination_list");
        const dests = redactSecrets(data.destination_list ?? []);
        const md = [
          `# Backup destinations (${dests.length})`,
          ...dests.map(
            (d: any) =>
              `- **${d.name}** (${d.type}, id ${d.id}) — ${
                isTrue(d.disabled) ? `DISABLED${d.disable_reason ? `: ${d.disable_reason}` : ""}` : "enabled"
              }${d.host ? `, host: ${d.host}` : ""}${d.bucket ?? d.bucket_name ? `, bucket: ${d.bucket ?? d.bucket_name}` : ""}${
                d.path ?? d.folder ? `, path: ${d.path ?? d.folder}` : ""
              }`
          ),
        ].join("\n");
        return formatResponse(params.response_format, md, { destinations: dests });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_backup_dates",
    {
      title: "List Backup Dates",
      description: "List the dates that have backups available (local, or on remote destinations when local backups are off), newest first.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("backup_date_list");
        const dates = [...new Set<string>((data.backup_set ?? []).map((d: string) => toDate(String(d))))].sort().reverse();
        const md = `# Backup dates (${dates.length})\n${dates.map((d: string) => `- ${d}`).join("\n")}`;
        return formatResponse(params.response_format, md, { dates });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_backup_users",
    {
      title: "List Accounts in a Backup",
      description: "List the accounts that have a backup on a given date, with each account's backup status.",
      inputSchema: {
        restore_point: DateSchema,
        user: z.string().optional().describe("Only this account"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("backup_user_list", { restore_point: params.restore_point });
        const users = (data.user ?? []).filter((u: any) => !params.user || u.username === params.user);
        const page = paginate<any>(users, params.limit, params.offset);
        const md =
          [
            `# Backups on ${params.restore_point} (${page.total} accounts)`,
            ...page.items.map((u) => `- ${u.username} — ${u.status}`),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { restore_point: params.restore_point, ...meta, users: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_backup_account",
    {
      title: "Back Up Account Now",
      description:
        "Create a full cpmove backup archive of one cPanel account in the background (pkgacct), e.g. before a risky change. " +
        "The archive is written to the account's home directory, so it uses disk space. Returns a session_id for whm_get_account_backup_status.",
      inputSchema: {
        user: z.string(),
        compress: z.boolean().default(true).describe("gzip the archive"),
        skiphomedir: z.boolean().optional().describe("Leave out the home directory's files"),
        skipacctdb: z.boolean().optional().describe("Leave out the account's databases"),
        skiplogs: z.boolean().optional().describe("Leave out log files"),
        skipbwdata: z.boolean().optional().describe("Leave out bandwidth data"),
        incremental: z.boolean().optional().describe("Update an existing uncompressed archive in place"),
        low_priority: z.boolean().optional().describe("Run at reduced priority to limit load"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, compress, ...rest } = params;
        const data: any = await whmCall(
          "start_background_pkgacct",
          { ...rest, compressionsetting: compress ? "compress" : undefined },
          "POST"
        );
        return formatResponse(
          response_format,
          `Started backup of ${params.user} (session ${data?.session_id ?? "n/a"}). Check progress with whm_get_account_backup_status.`,
          { user: params.user, session_id: data?.session_id, complete_master_log: data?.complete_master_log }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_account_backup_status",
    {
      title: "Get Account Backup Status",
      description: "Check a whm_backup_account session: RUNNING, COMPLETED, or FAILED.",
      inputSchema: { session_id: z.string(), ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("get_pkgacct_session_state", { session_id: params.session_id });
        return formatResponse(params.response_format, `Backup session ${params.session_id}: ${data?.state ?? "unknown"}`, {
          session_id: params.session_id,
          state: data?.state,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_restore_account",
    {
      title: "Restore Account from Backup",
      description:
        "Restore a cPanel account from a backup date. OVERWRITES the account's current files (and databases, mail config, and subdomains if selected). " +
        "Always confirm with the user. Queues the restore and starts the restore queue; follow it with whm_get_restore_queue. " +
        "Starting the queue runs every pending restore, so this refuses to start it while other restores are pending.",
      inputSchema: {
        user: z.string(),
        restore_point: DateSchema,
        destid: z.string().optional().describe("Backup destination ID to restore from (default: local backups)"),
        mysql: z.boolean().default(true).describe("Restore MySQL databases"),
        mail_config: z.boolean().default(true).describe("Restore email configuration"),
        subdomains: z.boolean().default(true).describe("Restore subdomains"),
        give_ip: z.boolean().default(false).describe("Assign a dedicated IP instead of the shared IP"),
        activate: z.boolean().default(true).describe("Start the restore queue now"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        if (params.activate) {
          // restore_queue_activate restores every queued account, not just this one.
          const queue: any = await whmCall("restore_queue_state");
          const pending: any[] = queue?.pending ?? [];
          if (pending.length > 0) {
            return err(
              `The restore queue already has ${pending.length} pending restore(s) (${pending
                .map((t) => `${t.user} from ${t.restore_point}`)
                .join(", ")}); starting it would run those too. ` +
                "Review them with whm_get_restore_queue, or pass activate=false to only queue this restore."
            );
          }
        }
        const task: any = await whmCall(
          "restore_queue_add_task",
          {
            user: params.user,
            restore_point: params.restore_point,
            destid: params.destid,
            mysql: params.mysql,
            mail_config: params.mail_config,
            subdomains: params.subdomains,
            give_ip: params.give_ip,
          },
          "POST"
        );
        if (params.activate) await whmCall("restore_queue_activate", {}, "POST");
        return formatResponse(
          params.response_format,
          `Queued restore of ${params.user} from ${params.restore_point} (queue id ${task?.queue_id ?? "n/a"})${
            params.activate ? "; restore queue started" : "; start it later with activate=true"
          }. Track it with whm_get_restore_queue.`,
          { user: params.user, restore_point: params.restore_point, queue_id: task?.queue_id, activated: params.activate }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_restore_queue",
    {
      title: "Get Restore Queue",
      description: "Show account restorations that are active, pending, and completed.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("restore_queue_state");
        const section = (title: string, items: any[] = []) => [
          `## ${title} (${items.length})`,
          ...items.map((t) => `- ${t.user} from ${t.restore_point}`),
        ];
        const md = [
          `# Restore queue — ${isTrue(data.is_active) ? "processing" : "idle"}`,
          ...section("Active", data.active),
          ...section("Pending", data.pending),
          ...section("Completed", data.completed),
        ].join("\n");
        return formatResponse(params.response_format, md, data);
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
