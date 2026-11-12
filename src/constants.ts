export const SERVER_VERSION = "0.2.0";
export const CHARACTER_LIMIT = 25000;
export const STRUCTURED_LIMIT = 100000; // serialized structuredContent above this is omitted
export const REQUEST_TIMEOUT_MS = 60000; // WHM operations can be slow; override with WHM_TIMEOUT_MS
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}
