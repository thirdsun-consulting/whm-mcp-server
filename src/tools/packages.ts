import { z } from "zod";
import { definedParams, handleWhmError, whmCall, WhmParams } from "../services/client.js";
import { err, fmtLimit, formatResponse, isTrue } from "../services/format.js";
import { FormatSchema, LimitSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

const PackageFieldsSchema = {
  featurelist: z.string().optional().describe("Feature list name"),
  quota: LimitSchema.optional().describe("Disk quota in MB (0 or 'unlimited' = unlimited)"),
  bwlimit: LimitSchema.optional().describe("Monthly bandwidth in MB (0 or 'unlimited' = unlimited)"),
  maxsub: LimitSchema.optional().describe("Max subdomains ('unlimited' for no limit)"),
  maxpark: LimitSchema.optional().describe("Max parked domains/aliases ('unlimited' for no limit)"),
  maxaddon: LimitSchema.optional().describe("Max addon domains ('unlimited' for no limit)"),
  maxftp: LimitSchema.optional().describe("Max FTP accounts ('unlimited' for no limit)"),
  maxsql: LimitSchema.optional().describe("Max databases of each type ('unlimited' for no limit)"),
  maxpop: LimitSchema.optional().describe("Max email accounts ('unlimited' for no limit)"),
  maxlst: LimitSchema.optional().describe("Max mailing lists ('unlimited' for no limit)"),
  max_emailacct_quota: LimitSchema.optional().describe("Max quota per email account, in MB"),
  max_email_per_hour: LimitSchema.optional().describe("Max outbound emails per hour ('unlimited' for no limit)"),
  max_defer_fail_percentage: LimitSchema.optional().describe(
    "Percentage of failed/deferred outbound mail per hour before sending is rate-limited"
  ),
  hasshell: z.boolean().optional().describe("Allow shell (SSH) access"),
  cgi: z.boolean().optional().describe("Allow CGI"),
  dedicated_ip: z.boolean().optional().describe("Give accounts a dedicated IP address"),
  cpmod: z.string().optional().describe("cPanel theme"),
  language: z.string().optional().describe("Default locale, e.g. 'en'"),
  digestauth: z.boolean().optional().describe("Enable Digest Authentication"),
};

type PackageFields = {
  [K in keyof typeof PackageFieldsSchema]?: z.infer<(typeof PackageFieldsSchema)[K]>;
};

/**
 * Map tool fields to addpkg/editpkg parameters. Both take lowercase names,
 * except that addpkg documents the two mail rate limits in uppercase.
 */
function packageParams(fields: PackageFields, uppercaseMailLimits: boolean): WhmParams {
  const { dedicated_ip, max_email_per_hour, max_defer_fail_percentage, ...rest } = fields;
  return definedParams({
    ...rest,
    ip: dedicated_ip === undefined ? undefined : dedicated_ip ? "y" : "n",
    [uppercaseMailLimits ? "MAX_EMAIL_PER_HOUR" : "max_email_per_hour"]: max_email_per_hour,
    [uppercaseMailLimits ? "MAX_DEFER_FAIL_PERCENTAGE" : "max_defer_fail_percentage"]: max_defer_fail_percentage,
  });
}

/** Settings getpkginfo reports under its own uppercase names; anything else is a package extension variable. */
const CORE_PACKAGE_KEYS = new Set([
  "BWLIMIT", "CGI", "CPMOD", "DIGESTAUTH", "FEATURELIST", "FRONTPAGE", "HASSHELL", "IP", "LANG",
  "MAXADDON", "MAXFTP", "MAXLST", "MAXPARK", "MAXPOP", "MAXSQL", "MAXSUB", "MAX_DEFER_FAIL_PERCENTAGE",
  "MAX_EMAILACCT_QUOTA", "MAX_EMAIL_PER_HOUR", "MAX_TEAM_USERS", "QUOTA", "_PACKAGE_EXTENSIONS", "name",
]);

/**
 * editpkg documents defaults for omitted parameters and drops package
 * extensions (and their variables) that aren't passed, so edits resend the
 * package's current values. getpkginfo reports them in uppercase, with null
 * meaning unlimited, and includes extension variables under their own names.
 */
function currentPackageParams(pkg: Record<string, any>): WhmParams {
  const limit = (key: string) =>
    !(key in pkg) ? undefined : pkg[key] === null || pkg[key] === "" ? "unlimited" : pkg[key];
  const flag = (key: string) => (pkg[key] === undefined || pkg[key] === null ? undefined : isTrue(pkg[key]));
  const extensionVariables = Object.fromEntries(
    Object.entries(pkg).filter(
      ([k, v]) => !CORE_PACKAGE_KEYS.has(k) && (typeof v === "string" || typeof v === "number")
    )
  );
  return definedParams({
    ...extensionVariables,
    featurelist: pkg.FEATURELIST,
    quota: limit("QUOTA"),
    bwlimit: limit("BWLIMIT"),
    maxsub: limit("MAXSUB"),
    maxpark: limit("MAXPARK"),
    maxaddon: limit("MAXADDON"),
    maxftp: limit("MAXFTP"),
    maxsql: limit("MAXSQL"),
    maxpop: limit("MAXPOP"),
    maxlst: limit("MAXLST"),
    max_emailacct_quota: limit("MAX_EMAILACCT_QUOTA"),
    max_email_per_hour: limit("MAX_EMAIL_PER_HOUR"),
    max_defer_fail_percentage: limit("MAX_DEFER_FAIL_PERCENTAGE"),
    max_team_users: pkg.MAX_TEAM_USERS,
    hasshell: flag("HASSHELL"),
    cgi: flag("CGI"),
    digestauth: flag("DIGESTAUTH"),
    ip: pkg.IP === undefined || pkg.IP === null ? undefined : isTrue(pkg.IP) ? "y" : "n",
    cpmod: pkg.CPMOD,
    language: pkg.LANG,
    _PACKAGE_EXTENSIONS: pkg._PACKAGE_EXTENSIONS,
  });
}

function changedFields(fields: PackageFields): string[] {
  return Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
}

export function registerPackageTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_list_packages",
    {
      title: "List Hosting Packages",
      description: "List hosting packages (plans) with their resource limits.",
      inputSchema: {
        want: z
          .enum(["all", "creatable", "editable", "viewable"])
          .optional()
          .describe("Which packages to list, by the token user's permissions (default: all)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("listpkgs", { want: params.want });
        const pkgs = data.pkg ?? [];
        const md = [
          `# Packages (${pkgs.length})`,
          ...pkgs.map(
            (p: any) =>
              `- **${p.name}** — quota ${fmtLimit(p.QUOTA, " MB")}, bw ${fmtLimit(p.BWLIMIT, " MB")}, subdomains ${fmtLimit(
                p.MAXSUB
              )}, parked ${fmtLimit(p.MAXPARK)}, addons ${fmtLimit(p.MAXADDON)}, sql ${fmtLimit(p.MAXSQL)}, email ${fmtLimit(
                p.MAXPOP
              )}, ftp ${fmtLimit(p.MAXFTP)}, shell ${p.HASSHELL ?? "n/a"}, feature list: ${p.FEATURELIST ?? "default"}`
          ),
        ].join("\n");
        return formatResponse(params.response_format, md, { packages: pkgs });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_package",
    {
      title: "Get Hosting Package",
      description: "Get all settings of one hosting package (plan).",
      inputSchema: { pkg: z.string().describe("Package name"), ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("getpkginfo", { pkg: params.pkg });
        const pkg = data.pkg ?? {};
        const md = [
          `# Package: ${params.pkg}`,
          ...Object.entries(pkg).map(([k, v]) => `- ${k}: ${v === null ? "unlimited" : v === "" ? "none" : v}`),
        ].join("\n");
        return formatResponse(params.response_format, md, { name: params.pkg, ...pkg });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_create_package",
    {
      title: "Create Hosting Package",
      description: "Create a new hosting package (plan). Omitted limits use WHM's defaults.",
      inputSchema: {
        name: z.string().describe("Package name (can't be changed later)"),
        ...PackageFieldsSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, name, ...fields } = params;
        const data: any = await whmCall("addpkg", { name, ...packageParams(fields, true) }, "POST");
        return formatResponse(response_format, `Created package ${data?.pkg ?? name}.`, {
          name: data?.pkg ?? name,
          created: true,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_edit_package",
    {
      title: "Edit Hosting Package",
      description:
        "Change settings of an existing hosting package. Only the fields you pass change; the rest keep their current values. " +
        "Applies to ALL accounts on the package — confirm with the user.",
      inputSchema: {
        name: z.string().describe("Package name"),
        ...PackageFieldsSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const { response_format, name, ...fields } = params;
        const changed = changedFields(fields);
        if (changed.length === 0) return err("Nothing to change: pass at least one setting to update.");
        // getpkginfo fails for unknown packages; editpkg would silently create one.
        const current: any = await whmCall("getpkginfo", { pkg: name });
        await whmCall(
          "editpkg",
          { name, ...currentPackageParams(current.pkg ?? {}), ...packageParams(fields, false) },
          "POST"
        );
        return formatResponse(response_format, `Edited package ${name}: ${changed.join(", ")}.`, {
          name,
          modified: changed,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_delete_package",
    {
      title: "Delete Hosting Package",
      description: "Delete a hosting package. WHM refuses if any account still uses it. Confirm with user.",
      inputSchema: { pkg: z.string().describe("Package name"), ...FormatSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await whmCall("killpkg", { pkgname: params.pkg }, "POST");
        return formatResponse(params.response_format, `Deleted package ${params.pkg}.`, {
          pkg: params.pkg,
          deleted: true,
        });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
