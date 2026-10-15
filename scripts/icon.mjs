// Render assets/icon.svg to the macOS iconset and icns. Electron does the
// rasterising so the build needs no image toolchain beyond the OS's own.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const svg = readFileSync(join(root, "assets/icon.svg"), "utf8");
const iconset = join(root, "work/asgard.iconset");
const sizes = [16, 32, 64, 128, 256, 512, 1024];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  win.webContents.setBackgroundThrottling(false);
  await win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;background:transparent">${svg}</body>`,
      ),
  );
  await win.webContents.executeJavaScript(
    "new Promise(d => requestAnimationFrame(() => requestAnimationFrame(() => d(1))))",
  );
  const full = await win.capturePage();
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  writeFileSync(join(root, "assets/asgard.png"), full.toPNG());
  for (const size of sizes) {
    const png = full.resize({ width: size, height: size, quality: "best" });
    const names = [];
    if (size <= 512) names.push(`icon_${size}x${size}.png`);
    if (size >= 32) names.push(`icon_${size / 2}x${size / 2}@2x.png`);
    for (const name of names)
      writeFileSync(join(iconset, name), png.toPNG());
  }
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(root, "assets/asgard.icns"),
  ]);
  console.log("wrote assets/asgard.icns and assets/asgard.png");
  app.quit();
});
