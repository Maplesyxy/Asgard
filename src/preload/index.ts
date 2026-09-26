import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/types";
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
  endSession: (id) => call("endSession", id),
  decide: (id, accept) => call("decide", { id, accept }),
  dashboard: () => call("dashboard"),
  testProvider: (provider) => call("testProvider", provider),
};
contextBridge.exposeInMainWorld("asgard", api);
