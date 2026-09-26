import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["tests/core.test.ts"],
  outfile: "work/tests.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
});
const result = spawnSync(
  "node_modules/.bin/electron",
  ["--test", "work/tests.cjs"],
  { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
process.exit(result.status ?? 1);
