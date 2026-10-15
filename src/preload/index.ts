import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { API, StreamEvent } from "../shared/types";
const call = (name: string, arg?: unknown) =>
  ipcRenderer.invoke("asgard:" + name, arg);
const api: API = {
  state: () => call("state"),
  read: (p) => call("read", p),
  search: (q) => call("search", q),
  write: (n) => call("write", n),
  move: (path, parent) => call("move", { path, parent }),
  archive: (p) => call("archive", p),
  settings: () => call("settings"),
  saveSettings: (values, keys) => call("saveSettings", { values, keys }),
  newSession: (project, isPrivate) =>
    call("newSession", { project, isPrivate }),
  setPrivate: (id, value) => call("setPrivate", { id, value }),
  send: (r) => call("send", r),
  cancel: () => call("cancel"),
  endSession: (id) => call("endSession", id),
  deleteSession: (id) => call("deleteSession", id),
  renameSession: (id, title) => call("renameSession", { id, title }),
  forkSession: (id, upTo) => call("forkSession", { id, upTo }),
  decide: (id, accept) => call("decide", { id, accept }),
  dashboard: () => call("dashboard"),
  testProvider: (provider) => call("testProvider", provider),
  // Electron 32 removed File.path; webUtils is the only way a sandboxed
  // renderer can learn a dropped file's location, and it stays in preload.
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: () => call("pickFiles"),
  attach: (paths) => call("attach", paths),
  releaseAttachments: (ids) => call("releaseAttachments", ids),
  // Streaming progress for the request in flight. The payload is re-shaped
  // here so the renderer never receives the raw IpcRendererEvent.
  onStream: (listener: (event: StreamEvent) => void) => {
    const wrapped = (_e: unknown, payload: StreamEvent) => listener(payload);
    ipcRenderer.on("asgard:stream", wrapped);
    return () => ipcRenderer.removeListener("asgard:stream", wrapped);
  },
};
contextBridge.exposeInMainWorld("asgard", api);
