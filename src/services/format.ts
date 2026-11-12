import { CHARACTER_LIMIT, ResponseFormat, STRUCTURED_LIMIT } from "../constants.js";
import { ToolInputError } from "./client.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: any;
  isError?: boolean;
}

export function ok(text: string, structured?: any): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

export function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function formatResponse(
  format: ResponseFormat,
  markdown: string,
  structured: any
): ToolResult {
  // MCP structuredContent must be a JSON object.
  const payload =
    Array.isArray(structured) ? { items: structured } : structured !== null && typeof structured === "object" ? structured : undefined;
  let text =
    format === ResponseFormat.JSON ? JSON.stringify(payload ?? structured ?? null, null, 2) : markdown;
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT - 200) +
      `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Add filters, lower 'limit', or page with 'offset'.]`;
  }
  // Clients may pass structuredContent to the model as-is, so bound it too.
  const size = payload === undefined ? 0 : JSON.stringify(payload).length;
  if (size > STRUCTURED_LIMIT) {
    text += `\n\n[Structured data omitted: ${size} characters is over the ${STRUCTURED_LIMIT}-character limit. Add filters or lower 'limit'.]`;
    return ok(text);
  }
  return ok(text, payload);
}

export function fmtBytes(bytes: number | string | undefined | null): string {
  const n = typeof bytes === "string" ? parseFloat(bytes) : bytes;
  if (n === undefined || n === null || isNaN(n)) return "n/a";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

/** Format a WHM limit that may be a number, "unlimited", or null (unlimited). */
export function fmtLimit(value: unknown, unit = ""): string {
  if (value === null || value === undefined || value === "" || value === "unlimited") return "unlimited";
  return `${value}${unit}`;
}

/** WHM booleans arrive as 1/0, "1"/"0", "y"/"n", or true/false. */
export function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "y" || value === "yes";
}

export function yesNo(value: unknown): string {
  return isTrue(value) ? "yes" : "no";
}

/** Unix seconds → "YYYY-MM-DD HH:MM:SS UTC". */
export function fmtTime(unix: number | string | undefined | null): string {
  const n = typeof unix === "string" ? parseInt(unix, 10) : unix;
  if (n === undefined || n === null || isNaN(n) || n <= 0) return "n/a";
  return new Date(n * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function fmtAge(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "n/a";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Accept unix seconds, unix milliseconds, or any Date-parsable string
 * (e.g. "2025-01-31" or "2025-01-31T12:00:00Z") and return unix seconds.
 */
export function toUnixSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!isNaN(n)) return Math.floor(n > 1e12 ? n / 1000 : n);
  const parsed = Date.parse(String(value));
  if (isNaN(parsed)) throw new ToolInputError(`Could not parse time '${value}'. Use unix seconds or an ISO 8601 date.`);
  return Math.floor(parsed / 1000);
}

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  items: T[];
}

/** Client-side paging so large WHM lists stay within the response size limit. */
export function paginate<T>(items: T[], limit: number, offset: number): Page<T> {
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    total: items.length,
    count: page.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + page.length } : {}),
    items: page,
  };
}

export function pageNote(page: Page<unknown>): string {
  if (page.total === 0) return "";
  const range = page.count ? `${page.offset + 1}–${page.offset + page.count}` : "none";
  return `\n\n_Showing ${range} of ${page.total}.${page.has_more ? ` Use offset=${page.next_offset} for more.` : ""}_`;
}

/** Case-insensitive substring match; an empty needle matches everything. */
export function matches(haystack: unknown, needle: string | undefined): boolean {
  if (!needle) return true;
  return String(haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

const SECRET_KEY = /(secret|passw|application_key|private_?key|token|api_key)/i;

/** Mask credential-like fields (backup destination secrets, etc.) before they reach the model. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== "" && typeof v !== "object" ? "[redacted]" : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

export function stripHtml(text: string | undefined | null): string {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function codeBlock(text: string): string {
  return "```\n" + text.replace(/```/g, "`​``") + "\n```";
}
