/**
 * Validation runner used by `npm run check` (and the Windows installer).
 *  1. Syntax-checks every backend and frontend JavaScript file.
 *  2. Verifies wrangler.jsonc parses (after stripping comments).
 *  3. Runs the acceptance test suite.
 * Exits non-zero on any failure so deployments stop before shipping a bug.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

console.log("== Syntax checks ==");
const files = [
  ...listJsFiles(join(root, "src")),
  ...listJsFiles(join(root, "test")),
  join(root, "public", "app.js"),
];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ok  ${file.replace(root, ".")}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${file.replace(root, ".")}\n${error.stderr?.toString() || error.message}`);
  }
}

console.log("\n== wrangler.jsonc parse ==");
try {
  const raw = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  // Strip /* */ and // comments (JSONC → JSON) for a structural sanity check.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(stripped);
  const required = ["name", "main", "compatibility_date", "assets", "kv_namespaces", "triggers", "vars"];
  const missing = required.filter((key) => !(key in parsed));
  if (missing.length) throw new Error(`Missing keys: ${missing.join(", ")}`);
  console.log("  ok  wrangler.jsonc");
  if (parsed.kv_namespaces?.[0]?.id === "REPLACE_WITH_YOUR_KV_NAMESPACE_ID") {
    console.log("  note: KV namespace id is still the placeholder — set it before deploying.");
  }
} catch (error) {
  failed = true;
  console.error(`FAIL  wrangler.jsonc — ${error.message}`);
}

console.log("\n== Acceptance tests ==");
try {
  execFileSync(process.execPath, [join(root, "test", "run-tests.js")], {
    stdio: "inherit",
  });
} catch {
  failed = true;
}

if (failed) {
  console.error("\nValidation FAILED");
  process.exit(1);
}
console.log("\nValidation passed");
