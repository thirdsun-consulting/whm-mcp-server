#!/usr/bin/env node
/**
 * Bundle the server and its dependencies into plugin/bundle.cjs, the single
 * file the Claude Code plugin runs. A plugin is installed by copying its
 * directory, with no `npm install`, so it has to carry everything it needs.
 *
 * Usage: npm run bundle            write plugin/bundle.cjs
 *        npm run bundle -- --check exit 1 if the committed bundle is out of date
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "plugin", "bundle.cjs");
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [join(ROOT, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: OUT,
  write: !check,
  legalComments: "none",
  logLevel: "warning",
});

if (check) {
  const built = result.outputFiles[0].text;
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    // reported below
  }
  if (built !== committed) {
    console.error("plugin/bundle.cjs is out of date. Run `npm run bundle` and commit the result.");
    process.exit(1);
  }
  console.log("OK: plugin/bundle.cjs matches the source.");
} else {
  console.log(`Wrote plugin/bundle.cjs (${(readFileSync(OUT).length / 1024).toFixed(0)} KB).`);
}
