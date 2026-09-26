import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.cwd();
const version = JSON.parse(
  readFileSync("node_modules/electron/package.json", "utf8"),
).version;
const env = {
  ...process.env,
  npm_config_cache: resolve(root, "work/npm-cache"),
  npm_config_devdir: resolve(root, "work/node-gyp"),
};
const cwd = resolve(root, "node_modules/better-sqlite3");
let r = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/prebuild-install/bin.js"),
    "--runtime=electron",
    `--target=${version}`,
    "--arch=" + process.arch,
  ],
  { cwd, env, stdio: "inherit" },
);
if (r.status !== 0)
  r = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/node-gyp/bin/node-gyp.js"),
      "rebuild",
      `--target=${version}`,
      "--arch=" + process.arch,
      "--dist-url=https://electronjs.org/headers",
      "--devdir=" + env.npm_config_devdir,
    ],
    { cwd, env, stdio: "inherit" },
  );
process.exit(r.status ?? 1);
