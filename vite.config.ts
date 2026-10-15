import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Builds are versioned by date (package.json "version", e.g. 2026.10.15) and
// the renderer shows it in Settings so an installed copy can be told apart.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  build: { outDir: "dist/renderer" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
