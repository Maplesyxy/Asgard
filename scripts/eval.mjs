import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["evals/run.ts"],
  outfile: "work/evals-run.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
});
const result = spawnSync(
  "node_modules/.bin/electron",
  ["work/evals-run.cjs", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
process.exit(result.status ?? 1);
