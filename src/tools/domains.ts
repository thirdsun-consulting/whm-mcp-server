import { z } from "zod";
import { handleWhmError, whmCall } from "../services/client.js";
import { err, formatResponse, matches, pageNote, paginate, yesNo } from "../services/format.js";
import { FormatSchema, PaginationSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

export function registerDomainTools(server: ToolRegistrar) {
  // ---- get_domain_info ----
  server.registerTool(
    "whm_list_domains",
    {
      title: "List Domains",
      description:
        "List every domain on the server (main, addon, subdomain, parked/alias) with its owning account, document root, IPs, and PHP version. " +
        "Filter by account, type, or a substring of the domain name.",
      inputSchema: {
        user: z.string().optional().describe("Only domains of this cPanel account"),
        domain_type: z
          .enum(["main", "addon", "sub", "parked"])
          .optional()
          .describe("Only this domain type"),
        search: z.string().optional().describe("Case-insensitive substring of the domain name"),
        ...PaginationSchema,
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("get_domain_info");
        const domains = (data.domains ?? []).filter(
          (d: any) =>
            (!params.user || d.user === params.user) &&
            (!params.domain_type || d.domain_type === params.domain_type) &&
            matches(d.domain, params.search)
        );
        const page = paginate<any>(domains, params.limit, params.offset);
        const md =
          [
            `# Domains (${page.total})`,
            ...page.items.map(
              (d) =>
                `- **${d.domain}** (${d.domain_type}${d.parent_domain && d.parent_domain !== d.domain ? ` of ${d.parent_domain}` : ""}) — user: ${d.user}, docroot: ${d.docroot}, ip: ${d.ipv4}${
                  d.ipv6 ? `, ipv6: ${d.ipv6}` : ""
                }, php: ${d.php_version ?? "n/a"}`
            ),
          ].join("\n") + pageNote(page);
        const { items, ...meta } = page;
        return formatResponse(params.response_format, md, { ...meta, domains: items });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- domainuserdata ----
  server.registerTool(
    "whm_get_domain_info",
    {
      title: "Get Domain Info",
      description:
        "Get a domain's web server configuration: owning user, document root, home directory, IP, port, aliases, CGI and open_basedir settings, and log locations.",
      inputSchema: { domain: z.string(), ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("domainuserdata", { domain: params.domain });
        const u = data.userdata ?? {};
        const md = [
          `# Domain: ${params.domain}`,
          `- User: ${u.user} (owner: ${u.owner})`,
          `- Server name: ${u.servername}`,
          `- Aliases: ${u.serveralias || "none"}`,
          `- Document root: ${u.documentroot}`,
          `- Home directory: ${u.homedir}`,
          `- IP: ${u.ip}, port: ${u.port}`,
          `- Server admin: ${u.serveradmin}`,
          `- CGI: ${yesNo(u.hascgi)}, PHP open_basedir protection: ${yesNo(u.phpopenbasedirprotect)}`,
          ...(u.customlog ?? []).map((l: any) => `- Log: ${l.target} (${l.format})`),
        ].join("\n");
        return formatResponse(params.response_format, md, { domain: params.domain, ...u });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  // ---- getdomainowner ----
  server.registerTool(
    "whm_get_domain_owner",
    {
      title: "Get Domain Owner",
      description: "Find which cPanel account owns a domain (main, addon, sub, or parked).",
      inputSchema: { domain: z.string(), ...FormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("getdomainowner", { domain: params.domain });
        const user = data?.user ?? null;
        return formatResponse(
          params.response_format,
          user ? `${params.domain} is owned by cPanel account **${user}**.` : `No cPanel account owns ${params.domain}.`,
          { domain: params.domain, user }
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
