import { z } from "zod";
import { handleWhmError, uapiCall, whmCall, whmRequest } from "../services/client.js";
import { codeBlock, err, formatResponse, matches } from "../services/format.js";
import { FormatSchema } from "../schemas/common.js";
import { ToolRegistrar } from "../types.js";

const ParamsSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
  .default({})
  .describe(
    "Function parameters. Booleans are sent as 1/0; arrays use WHM's param, param-1, param-2 convention. " +
      "WHM API 1 output controls also work, e.g. {'api.filter.enable': 1, 'api.filter.a.field': 'user', 'api.filter.a.arg0': 'bob'}, " +
      "api.sort.*, and api.chunk.* for paging."
  );

export function registerApiTools(server: ToolRegistrar) {
  server.registerTool(
    "whm_list_api_functions",
    {
      title: "List WHM API Functions",
      description:
        "List the WHM API 1 functions this API token's user can call (WHM applist). Use with whm_call_api for anything the dedicated tools don't cover; " +
        "function documentation is at https://api.docs.cpanel.net/whm/introduction.",
      inputSchema: {
        search: z.string().optional().describe("Substring of the function name, e.g. 'dns' or 'ssl'"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const data: any = await whmCall("applist");
        const apps: string[] = (data.app ?? []).filter((a: string) => matches(a, params.search)).sort();
        const md = `# WHM API 1 functions (${apps.length})\n${apps.join(", ")}`;
        return formatResponse(params.response_format, md, { functions: apps });
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_call_api",
    {
      title: "Call WHM API Function",
      description:
        "Call any WHM API 1 function by name with raw parameters and get its full response ({ metadata, data }). " +
        "For functions without a dedicated tool — look them up at https://api.docs.cpanel.net/whm/introduction. " +
        "Can change or delete anything the token allows: prefer the dedicated tools, and confirm any change with the user first.",
      inputSchema: {
        function: z
          .string()
          .regex(/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?$/)
          .describe("WHM API 1 function name, e.g. 'get_nameserver_config' or 'listacls'"),
        params: ParamsSchema,
        method: z
          .enum(["POST", "GET"])
          .default("POST")
          .describe("POST (default) keeps parameters such as passwords out of URLs and access logs"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const res = await whmRequest(params.function, params.params, params.method);
        const result = { metadata: res.metadata, data: res.data };
        return formatResponse(
          params.response_format,
          `# ${params.function}\n${codeBlock(JSON.stringify(result, null, 2))}`,
          result
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );

  server.registerTool(
    "whm_call_uapi",
    {
      title: "Call UAPI Function as User",
      description:
        "Run a cPanel UAPI function as a specific cPanel account through WHM (uapi_cpanel) — e.g. module 'Email' function 'list_forwarders', " +
        "or 'Mysql'/'list_databases'. UAPI docs: https://api.docs.cpanel.net/cpanel/introduction. " +
        "Can change or delete the account's data: confirm any change with the user first.",
      inputSchema: {
        user: z.string().describe("cPanel account to run as (lowercase)"),
        module: z.string().regex(/^[A-Za-z0-9_]+$/).describe("UAPI module, e.g. 'Email' (case-sensitive)"),
        function: z.string().regex(/^[A-Za-z0-9_]+$/).describe("UAPI function, e.g. 'list_pops' (case-sensitive)"),
        params: ParamsSchema,
        method: z
          .enum(["POST", "GET"])
          .default("POST")
          .describe("POST (default) keeps parameters such as passwords out of URLs and access logs"),
        ...FormatSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const res = await uapiCall(params.user, params.module, params.function, params.params, params.method);
        const result = {
          data: res.data,
          messages: res.messages ?? [],
          warnings: res.warnings ?? [],
          metadata: res.metadata ?? {},
        };
        return formatResponse(
          params.response_format,
          `# ${params.module}::${params.function} as ${params.user}\n${codeBlock(JSON.stringify(result, null, 2))}`,
          result
        );
      } catch (e) {
        return err(handleWhmError(e));
      }
    }
  );
}
