import { build } from "esbuild";
import { readFileSync } from "node:fs";
const required = JSON.parse(readFileSync("package.json", "utf8")).engines.node;
const min = required.replace(/^\D*/, "").split(".").map(Number);
const here = process.versions.node.split(".").map(Number);
const compare = (a, b) => a.findIndex((n, i) => n !== b[i]);
const at = compare(here, min);
if (at !== -1 && here[at] < min[at]) {
  console.error(
    `Node ${process.versions.node} is too old; this project needs ${required}.\n` +
      `electron-builder require()s ESM-only dependencies, which fails below Node 20.17/22.12\n` +
      `with a confusing ERR_REQUIRE_ESM from @noble/hashes. Run 'nvm use' to pick up .nvmrc.`,
  );
  process.exit(1);
}
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "better-sqlite3"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
