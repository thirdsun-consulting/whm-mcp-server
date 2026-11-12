import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ResponseFormat } from "../constants.js";

export const FormatSchema = {
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' for human-readable, 'json' for full data"),
};

export const PaginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Maximum items to return (1-${MAX_PAGE_SIZE})`),
  offset: z.number().int().min(0).default(0).describe("Items to skip, for paging through results"),
};

/** A WHM resource limit: a non-negative number, or 'unlimited'. */
export const LimitSchema = z.union([z.number().int().min(0), z.literal("unlimited")]);

/** Unix seconds or an ISO 8601 date/time string. */
export const TimeSchema = z.union([z.number(), z.string()]);
