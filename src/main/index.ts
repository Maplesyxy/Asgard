import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  dialog,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Path, SendSchema, SettingsSchema, WriteNode } from "../shared/types";
import { Store, within } from "./store";
import { SettingsStore } from "./settings";
import { Clients, ProviderError } from "./providers";
import { Engine } from "./engine";
const smoke = process.argv.includes("--smoke-test");
if (smoke) app.setPath("userData", join(process.cwd(), "work/smoke-profile"));
let store: Store,
  engine: Engine,
  win: BrowserWindow | null = null;
let quitting = false;
const devURL = !app.isPackaged ? process.env.ASGARD_DEV_URL : undefined;
const renderer = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1024,
    minHeight: 700,
    title: "Asgard",
    backgroundColor: "#101212",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 23 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (
      !quitting &&
      store.sessions().some((s) => !s.ended && s.messages.length > s.compacted)
    ) {
      e.preventDefault();
      win?.hide();
      void finishAndQuit();
    }
  });
  void win.loadURL(devURL ?? renderer);
  if (smoke)
    win.webContents.once("did-finish-load", async () => {
      try {
        const report = await win!.webContents.executeJavaScript(
          `({title:document.title,bridge:typeof window.asgard?.state==='function',nodeIntegration:typeof window.require!=='undefined',text:document.body.innerText})`,
        );
        // did-finish-load precedes the first composited frame; capturing here
        // yields a blank backgroundColor image. Settle fonts and two rAFs first.
        await win!.webContents.executeJavaScript(
          `new Promise(done => document.fonts.ready.then(
             () => requestAnimationFrame(() => requestAnimationFrame(done))))`,
        );
        await win!
          .capturePage()
          .then((img) =>
            writeFileSync(join(process.cwd(), "work/smoke.png"), img.toPNG()),
          );
        writeFileSync(
          join(process.cwd(), "work/smoke-report.json"),
          JSON.stringify(
            {
              ...report,
              db: store.all().length,
              secureStorage: safeStorage.isEncryptionAvailable(),
            },
            null,
            2,
          ),
        );
        quitting = true;
        app.quit();
      } catch {
        app.exit(1);
      }
    });
}
async function finishAndQuit() {
  if (engine.busy) {
    win?.show();
    dialog.showErrorBox(
      "Astro is working",
      "Wait for the current request to finish before quitting.",
    );
    return;
  }
  const pending = store
    .sessions()
    .filter((s) => !s.ended && s.messages.length > s.compacted);
  try {
    for (const s of pending) await engine.end(s.id);
    quitting = true;
    app.quit();
  } catch {
    win?.show();
    const result = await dialog.showMessageBox(win!, {
      type: "warning",
      title: "Transcript saved",
      message: "The session summary could not be created.",
      detail:
        "Your transcript is safely stored locally. You can return to configure the provider and retry, or quit and resume compaction later.",
      buttons: ["Return to Asgard", "Quit with transcript saved"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      quitting = true;
      app.quit();
    }
  }
}
app.whenReady().then(() => {
  const data = app.getPath("userData");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  store = new Store(join(data, "asgard.sqlite"));
  chmodSync(join(data, "asgard.sqlite"), 0o600);
  const settings = new SettingsStore(store, safeStorage);
  engine = new Engine(store, settings, new Clients(settings));
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const handler = (
    name: string,
    schema: z.ZodTypeAny,
    fn: (value: any) => unknown,
  ) =>
    ipcMain.handle("asgard:" + name, async (event, args) => {
      const url = event.senderFrame?.url;
      const trusted = devURL
        ? url === devURL + "/" || url === devURL
        : url === renderer;
      if (
        !trusted ||
        event.sender !== win?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted IPC sender.");
      try {
        return await fn(schema.parse(args));
      } catch (e) {
        if (e instanceof z.ZodError)
          throw new Error(
            "Invalid input: " +
              e.issues
                .map((i) => i.path.join(".") + " " + i.message)
                .join("; "),
          );
        if (e instanceof ProviderError) throw new Error(e.message);
        if (e instanceof Error && /SQLITE|SQL|constraint/i.test(e.message))
          throw new Error(
            "The local database operation could not be completed.",
          );
        throw new Error(e instanceof Error ? e.message : "Operation failed.");
      }
    });
  const idle = () => {
    if (engine.busy)
      throw new Error(
        "Wait for Astro to finish before editing memory or settings.",
      );
  };
  const editable = (path: string) => {
    if (path === "/" || within(path, "/sessions"))
      throw new Error("Session records are managed by Asgard.");
  };
  handler("state", z.undefined(), () => ({
    nodes: store.summaries(),
    sessions: store.sessions(),
    proposals: store.proposals(),
  }));
  handler("read", Path, (p) => store.read(p));
  handler("search", z.string().max(2000), (q) => store.search(q, "/", 60));
  handler("write", WriteNode, (n) => {
    idle();
    editable(n.path);
    engine.mutate("write", n);
  });
  handler("move", z.object({ path: Path, parent: Path }).strict(), (v) => {
    idle();
    editable(v.path);
    editable(v.parent);
    engine.mutate("move", v);
  });
  handler("archive", Path, (path) => {
    idle();
    editable(path);
    engine.mutate("archive", { path });
  });
  handler("settings", z.undefined(), () => settings.view());
  handler(
    "saveSettings",
    z
      .object({
        values: SettingsSchema,
        keys: z
          .object({
            anthropic: z.string().max(1000).optional(),
            deepseek: z.string().max(1000).optional(),
          })
          .strict(),
      })
      .strict(),
    (v) => {
      idle();
      settings.save(v.values, v.keys);
    },
  );
  handler(
    "newSession",
    z.object({ project: z.string().max(100), isPrivate: z.boolean() }).strict(),
    (v) => {
      idle();
      return store.newSession(v.project, v.isPrivate);
    },
  );
  handler(
    "setPrivate",
    z.object({ id: z.string().uuid(), value: z.boolean() }).strict(),
    (v) => {
      idle();
      const s = store.session(v.id);
      if (s.private && !v.value && s.messages.length)
        throw new Error(
          "A private conversation stays private. Start a new public session instead.",
        );
      s.private = v.value;
      store.saveSession(s);
    },
  );
  handler("send", SendSchema, (v) => engine.send(v));
  handler("endSession", z.string().uuid(), (id) => engine.end(id));
  handler(
    "decide",
    z.object({ id: z.string().uuid(), accept: z.boolean() }).strict(),
    (v) => {
      idle();
      engine.decide(v.id, v.accept);
    },
  );
  handler("dashboard", z.undefined(), () => store.dashboard());
  handler("testProvider", z.enum(["opus", "deepseek"]), (p) =>
    engine.testProvider(p),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});
app.on("before-quit", (e) => {
  if (
    !quitting &&
    store?.sessions().some((s) => !s.ended && s.messages.length > s.compacted)
  ) {
    e.preventDefault();
    void finishAndQuit();
  }
});
app.on("window-all-closed", () => {
  quitting = true;
  app.quit();
});
app.on("will-quit", () => store?.close());
