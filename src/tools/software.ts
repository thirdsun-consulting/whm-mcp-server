import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, formatResponse, isTrue, matches, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

export function registerSoftwareTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_list_php_versions",
    {
      title: "List PHP Versions",
      description: "List the PHP versions installed through EasyApache 4 (e.g. ea-php82) and the system default.",
      inputSchema: { ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const [installed, def] = await Promise.all([
          whmCall("php_get_installed_versions"),
          whmCall("php_get_system_default_version").catch(() => undefined),
        ]);
        const versions: string[] = installed?.versions ?? [];
        const md = [
          `# PHP versions (${versions.length})`,
          ...versions.map((v) => `- ${v}${v === def?.version ? " (system default)" : ""}`),
        ].join("\n");
        return formatResponse(params.response_format, md, { versions, system_default: def?.version ?? null });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_get_php_vhost_versions",
    {
      title: "Get PHP Version per Domain",
      description:
        "Show each virtual host's PHP version, whether it's inherited or the system default, and whether PHP-FPM is on. " +
        "Filter by account, domain, or version (e.g. find sites still on an end-of-life PHP).",
      inputSchema: {
        user: z.string().optional().describe("Only this cPanel account"),
        domain: z.string().optional().describe("Substring of the virtual host name"),
        version: z.string().optional().describe("Only vhosts on this version, e.g. 'ea-php74'"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("php_get_vhost_versions");
        const vhosts = (data.versions ?? []).filter(
          (v: any) =>
            (!params.user || v.account === params.user) &&
            matches(v.vhost, params.domain) &&
            (!params.version || v.version === params.version)
        );
        const page = paginate<any>(vhosts, params.limit, params.offset);
        const source = (v: any) => {
          const s = v.phpversion_source?.[0];
          if (!s) return "";
          return isTrue(s.system_default) ? " (system default)" : s.domain ? ` (inherited from ${s.domain})` : "";
        };
        const md =
          [
            `# PHP versions by vhost (${page.total})`,
            ...page.items.map(
              (v) =>
                `- **${v.vhost}** (${v.account}) — ${v.version}${source(v)}, PHP-FPM: ${yesNo(v.php_fpm)}${
                  isTrue(v.is_suspended) ? " [suspended]" : ""
                }`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, vhosts: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_set_php_vhost_version",
    {
      title: "Set PHP Version for Domains",
      description:
        "Change the PHP version of one or more virtual hosts (domains). Each vhost keeps its current PHP-FPM setting unless php_fpm is passed. " +
        "Changing PHP versions can break sites — confirm with the user.",
      inputSchema: {
        vhosts: z.array(z.string()).min(1).max(100).describe("Virtual host names (domains) from whm_get_php_vhost_versions"),
        version: z.string().describe("PHP package, e.g. 'ea-php83', or 'inherit' to use the parent/system default"),
        php_fpm: z.boolean().optional().describe("Turn PHP-FPM on or off for these vhosts (default: keep current)"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        // php_set_vhost_versions defaults php_fpm to 0, so always send each vhost's intended value.
        const groups = new Map<boolean, string[]>();
        if (params.php_fpm !== undefined) {
          groups.set(params.php_fpm, params.vhosts);
        } else {
          const data: any = await whmCall("php_get_vhost_versions");
          const fpm = new Map<string, boolean>(
            (data.versions ?? []).map((v: any) => [String(v.vhost).toLowerCase(), isTrue(v.php_fpm)])
          );
          const unknown = params.vhosts.filter((v) => !fpm.has(v.toLowerCase()));
          if (unknown.length) {
            return err(`Unknown virtual host(s): ${unknown.join(", ")}. List them with whm_get_php_vhost_versions.`);
          }
          for (const vhost of params.vhosts) {
            const on = fpm.get(vhost.toLowerCase())!;
            groups.set(on, [...(groups.get(on) ?? []), vhost]);
          }
        }
        for (const [on, vhosts] of groups) {
          await whmCall("php_set_vhost_versions", { version: params.version, vhost: vhosts, php_fpm: on }, "POST");
        }
        return formatResponse(
          params.response_format,
          `Set ${params.vhosts.join(", ")} to ${params.version}${
            params.php_fpm === undefined ? " (PHP-FPM settings kept)" : ` with PHP-FPM ${params.php_fpm ? "on" : "off"}`
          }.`,
          {
            version: params.version,
            vhosts: [...groups].flatMap(([on, vhosts]) => vhosts.map((vhost) => ({ vhost, php_fpm: on }))),
          }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_list_databases",
    {
      title: "List Databases",
      description: "List MySQL/MariaDB and PostgreSQL databases on the server with their owning cPanel account.",
      inputSchema: {
        user: z.string().optional().describe("Only databases owned by this cPanel account"),
        engine: z.enum(["mysql", "postgresql"]).optional(),
        search: z.string().optional().describe("Substring of the database name"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("list_databases");
        const dbs = (data.payload ?? []).filter(
          (d: any) =>
            (!params.user || d.cpuser === params.user) &&
            (!params.engine || d.engine === params.engine) &&
            matches(d.name, params.search)
        );
        const page = paginate<any>(dbs, params.limit, params.offset);
        const md =
          [
            `# Databases (${page.total})`,
            ...page.items.map((d) => `- ${d.name} (${d.engine}) — owner: ${d.cpuser}`),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, databases: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
