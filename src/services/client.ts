import axios, { AxiosError, AxiosInstance } from "axios";
import * as https from "node:https";
import { REQUEST_TIMEOUT_MS } from "../constants.js";

let cachedClient: AxiosInstance | null = null;

interface WhmConfig {
  host: string;
  port: number;
  user: string;
  token: string;
  insecureTls: boolean;
  timeoutMs: number;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function readConfig(): WhmConfig {
  const rawHost = process.env.WHM_HOST;
  const user = process.env.WHM_USER || "root";
  const token = process.env.WHM_TOKEN;
  const insecureTls = isTruthy(process.env.WHM_INSECURE_TLS);
  const timeoutMs = parseInt(process.env.WHM_TIMEOUT_MS || "", 10) || REQUEST_TIMEOUT_MS;

  if (!rawHost) throw new Error("WHM_HOST env var is not set (e.g. 'server.example.com').");
  if (!token) {
    throw new Error(
      "WHM_TOKEN env var is not set. Create one in WHM → Development → Manage API Tokens."
    );
  }
  // Accept pasted URLs like "https://srv.example.com:2087/" as well as bare hostnames.
  const cleaned = rawHost.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const hostPort = cleaned.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  const host = hostPort ? hostPort[1] : cleaned;
  const port = parseInt(process.env.WHM_PORT || hostPort?.[2] || "2087", 10);
  return { host, port, user, token, insecureTls, timeoutMs };
}

export function getClient(): AxiosInstance {
  if (cachedClient) return cachedClient;
  const cfg = readConfig();
  cachedClient = axios.create({
    baseURL: `https://${cfg.host}:${cfg.port}/json-api`,
    timeout: cfg.timeoutMs,
    headers: {
      Authorization: `whm ${cfg.user}:${cfg.token}`,
      Accept: "application/json",
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.insecureTls }),
  });
  return cachedClient;
}

export type WhmParam = string | number | boolean | null | undefined | Array<string | number>;
export type WhmParams = Record<string, WhmParam>;

/** Drop undefined entries, so spreading one param set over another can't erase values. */
export function definedParams(params: WhmParams): WhmParams {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

/**
 * Encode parameters the way WHM API 1 expects them. Booleans become `1`/`0`
 * (WHM rejects `true`/`false`), undefined/null values are dropped, and arrays
 * use WHM's documented "increment the parameter name" convention:
 * `domain=a&domain-1=b&domain-2=c`.
 */
export function encodeParams(params: WhmParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => out.append(i === 0 ? key : `${key}-${i}`, String(v)));
    } else if (typeof value === "boolean") {
      out.append(key, value ? "1" : "0");
    } else {
      out.append(key, String(value));
    }
  }
  return out;
}

export interface WhmMetadata {
  result?: number;
  reason?: string;
  command?: string;
  version?: number;
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WhmResponse<T = any> {
  data: T;
  metadata: WhmMetadata;
}

/**
 * Call a WHM API 1 function and return the whole response envelope
 * (`{ metadata, data }`). Reads use GET; mutating calls use POST so that long
 * values (certificates, zone edits) are not limited by URL length.
 * `api.version=1` always goes in the query string, as in the documented URL format.
 */
export async function whmRequest<T = any>(
  fn: string,
  params: WhmParams = {},
  method: "GET" | "POST" = "GET"
): Promise<WhmResponse<T>> {
  const encoded = encodeParams(params);
  const query = new URLSearchParams({ "api.version": "1" });
  if (method === "GET") encoded.forEach((value, key) => query.append(key, value));

  const res = await getClient().request<unknown>({
    method,
    url: `/${fn}?${query.toString()}`,
    ...(method === "POST"
      ? {
          data: encoded.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      : {}),
  });
  const body = res.data as any;
  if (!body || typeof body !== "object") {
    const snippet = typeof body === "string" ? body.trim().slice(0, 200) : "";
    throw new WhmApiError(
      `Unexpected non-JSON response from WHM${snippet ? `: ${snippet}` : ""}`,
      { command: fn }
    );
  }

  // WHM v1 envelope: { metadata: { result, command, reason, version }, data: {...} }
  const metadata: WhmMetadata = body.metadata ?? {};
  if (metadata.result !== undefined && Number(metadata.result) === 0) {
    const reason = metadata.reason || "WHM API call failed";
    throw new WhmApiError(reason, { ...metadata, command: metadata.command ?? fn });
  }
  return { data: (body.data ?? body) as T, metadata };
}

/** Call a WHM API 1 function and return its `data` payload. */
export async function whmCall<T = any>(
  fn: string,
  params: WhmParams = {},
  method: "GET" | "POST" = "GET"
): Promise<T> {
  return (await whmRequest<T>(fn, params, method)).data;
}

export interface UapiResult<T = any> {
  status: number;
  data: T;
  errors?: string[] | null;
  messages?: string[] | null;
  warnings?: string[] | null;
  metadata?: Record<string, unknown>;
}

/**
 * Run a cPanel UAPI function as a cPanel user through WHM API 1's `uapi_cpanel`.
 * UAPI reports failures inside `data.uapi`, not in the WHM envelope, so check both.
 */
export async function uapiCall<T = any>(
  user: string,
  module: string,
  func: string,
  params: WhmParams = {},
  method: "GET" | "POST" = "GET"
): Promise<UapiResult<T>> {
  const data: any = await whmCall(
    "uapi_cpanel",
    { ...params, "cpanel.user": user, "cpanel.module": module, "cpanel.function": func },
    method
  );
  const result: UapiResult<T> | undefined = data?.uapi;
  if (!result || Number(result.status) === 0) {
    const reason = result?.errors?.filter(Boolean).join("; ") || `UAPI ${module}::${func} failed`;
    throw new WhmApiError(reason, { command: `uapi_cpanel ${module}::${func}` });
  }
  return result;
}

export type ApiFilterType =
  | "contains"
  | "eq"
  | "begins"
  | "=="
  | "lt"
  | "lt_equal"
  | "gt"
  | "gt_equal"
  | "lt_handle_unlimited"
  | "gt_handle_unlimited";

export interface ApiFilter {
  field: string;
  arg0: string | number | undefined;
  type?: ApiFilterType;
}

/** Server-side output filters (`api.filter.a.field=…`). Filters with no value are skipped. */
export function apiFilters(filters: ApiFilter[]): WhmParams {
  const active = filters.filter((f) => f.arg0 !== undefined && f.arg0 !== "");
  if (active.length === 0) return {};
  const params: WhmParams = { "api.filter.enable": 1 };
  active.forEach((f, i) => {
    const id = String.fromCharCode(97 + i); // a, b, c…
    params[`api.filter.${id}.field`] = f.field;
    params[`api.filter.${id}.arg0`] = f.arg0;
    params[`api.filter.${id}.type`] = f.type ?? "contains";
  });
  return params;
}

/** Server-side output sorting (`api.sort.a.field=…`). Numeric fields need method=numeric. */
export function apiSort(
  field: string,
  opts: { method?: "numeric" | "lexicographic" | "ipv4" | "numeric_zero_as_max"; reverse?: boolean } = {}
): WhmParams {
  return {
    "api.sort.enable": 1,
    "api.sort.a.field": field,
    "api.sort.a.method": opts.method,
    "api.sort.a.reverse": opts.reverse,
  };
}

/** Server-side pagination (`api.chunk.*`). `api.chunk.start` is 1-based. */
export function apiChunk(size: number, offset = 0): WhmParams {
  return { "api.chunk.enable": 1, "api.chunk.size": size, "api.chunk.start": offset + 1 };
}

export class WhmApiError extends Error {
  metadata: any;
  constructor(message: string, metadata: any) {
    super(message);
    this.name = "WhmApiError";
    this.metadata = metadata;
  }
}

/** A problem with the tool arguments that WHM would reject or misinterpret. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function handleWhmError(error: unknown): string {
  if (error instanceof ToolInputError) {
    return `Error: ${error.message}`;
  }
  if (error instanceof WhmApiError) {
    return `WHM API error: ${error.message}${
      error.metadata?.command ? ` (function: ${error.metadata.command})` : ""
    }`;
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const reason = (error.response?.data as any)?.metadata?.reason;
    if (status === 401 || status === 403) {
      return `Error ${status}: WHM authentication failed${reason ? ` (${reason})` : ""}. Check WHM_USER and WHM_TOKEN, and that the token has the required ACLs.`;
    }
    if (status === 404) {
      return "Error 404: WHM endpoint not found. Verify the function name and that WHM_PORT points at WHM (usually 2087), not cPanel.";
    }
    if (error.code === "ECONNREFUSED") {
      return `Error: Could not connect to ${process.env.WHM_HOST}:${process.env.WHM_PORT || 2087}. Verify host/port and that WHM is running.`;
    }
    if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
      return `Error: Could not resolve WHM host '${process.env.WHM_HOST}'. Check WHM_HOST.`;
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return "Error: Request timed out. WHM operation may still be running on the server (raise WHM_TIMEOUT_MS for slow operations).";
    }
    if (error.code && TLS_ERROR_CODES.has(error.code)) {
      return `Error: TLS certificate could not be verified (${error.code}). Connect using the hostname on WHM's certificate, or, if you trust this host, set WHM_INSECURE_TLS=true.`;
    }
    return `Error ${status ?? "?"}: ${reason ?? error.message}`;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
