import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  CallRecord,
  ContextEntry,
  Dashboard,
  Message,
  NodeSummary,
  NodeWrite,
  Path,
  Proposal,
  Session,
  TreeNode,
  WriteNode,
} from "../shared/types";
export const tokens = (s: string) =>
  Math.ceil(Buffer.byteLength(s, "utf8") / 3);
export const within = (p: string, root: string) =>
  root === "/" || p === root || p.startsWith(root + "/");
export const isRaw = (p: string) => /^\/sessions\/[^/]+\/[^/]+\/raw$/.test(p);
const now = () => new Date().toISOString();
export class Store {
  db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES nodes(id),path TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,summary TEXT NOT NULL,tokens INTEGER NOT NULL,pinned INTEGER DEFAULT 0,private INTEGER DEFAULT 0,importance INTEGER DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_used_at TEXT);
  CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(title,summary,content,content='nodes',content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN INSERT INTO nodes_fts(rowid,title,summary,content) VALUES(new.rowid,new.title,new.summary,new.content); END;
  CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN INSERT INTO nodes_fts(nodes_fts,rowid,title,summary,content) VALUES('delete',old.rowid,old.title,old.summary,old.content); END;
  CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN INSERT INTO nodes_fts(nodes_fts,rowid,title,summary,content) VALUES('delete',old.rowid,old.title,old.summary,old.content); INSERT INTO nodes_fts(rowid,title,summary,content) VALUES(new.rowid,new.title,new.summary,new.content); END;
  CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,date TEXT NOT NULL,title TEXT NOT NULL,project TEXT NOT NULL,private INTEGER DEFAULT 0,ended INTEGER DEFAULT 0,compacted INTEGER DEFAULT 0,context TEXT DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,action TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,timestamp TEXT NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,tier TEXT NOT NULL,reason TEXT NOT NULL,input_tokens INTEGER,cached_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,cost REAL,latency REAL,verification TEXT,escalated INTEGER);
  PRAGMA user_version = 1;`);
    if (!this.get("/")) {
      this.write({
        path: "/",
        kind: "folder",
        title: "Memory",
        content: "",
        summary: "Astro’s local memory tree.",
      });
      for (const [path, title, summary] of [
        [
          "/rules",
          "Standing rules",
          "Approved instructions, kept first in context.",
        ],
        [
          "/profile",
          "Your profile",
          "Goals, preferences and personal context.",
        ],
        ["/projects", "Projects", "Plans, decisions and notes for your work."],
        ["/sessions", "Sessions", "Transcripts and compact summaries."],
        ["/knowledge", "Knowledge", "Reusable facts, references and snippets."],
        ["/archive", "Archive", "Retired memories, preserved locally."],
      ])
        this.write({
          path,
          kind: "folder",
          title,
          content: "",
          summary,
          pinned: path === "/rules",
        });
    }
  }
  get(path: string) {
    return this.db
      .prepare("SELECT * FROM nodes WHERE path=?")
      .get(Path.parse(path)) as TreeNode | undefined;
  }
  read(path: string) {
    const n = this.get(path);
    if (!n) throw new Error("Memory node not found.");
    this.db
      .prepare("UPDATE nodes SET last_used_at=? WHERE id=?")
      .run(now(), n.id);
    return n;
  }
  all() {
    return this.db
      .prepare("SELECT * FROM nodes ORDER BY path")
      .all() as TreeNode[];
  }
  summaries() {
    return this.all().map((n) => this.summary(n));
  }
  summary(n: TreeNode): NodeSummary {
    const { content, ...rest } = n;
    return { ...rest, private: Number(this.isPrivate(n.path)) };
  }
  isPrivate(path: string) {
    let p = path;
    while (true) {
      if (this.get(p)?.private) return true;
      if (p === "/") return false;
      p = p.substring(0, p.lastIndexOf("/")) || "/";
    }
  }
  write(input: NodeWrite) {
    const v = WriteNode.parse(input);
    const old = this.get(v.path);
    const parent =
      v.path === "/"
        ? null
        : this.get(v.path.substring(0, v.path.lastIndexOf("/")) || "/");
    if (v.path !== "/" && !parent)
      throw new Error("Parent folder does not exist.");
    const t = now();
    this.db
      .prepare(
        `INSERT INTO nodes(id,parent_id,path,kind,title,content,summary,tokens,pinned,private,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,summary=excluded.summary,tokens=excluded.tokens,pinned=excluded.pinned,private=excluded.private,importance=excluded.importance,updated_at=excluded.updated_at`,
      )
      .run(
        old?.id ?? randomUUID(),
        parent?.id ?? null,
        v.path,
        v.kind,
        v.title,
        v.content,
        v.summary,
        tokens(v.content),
        v.pinned === undefined ? (old?.pinned ?? 0) : Number(v.pinned),
        v.private === undefined ? (old?.private ?? 0) : Number(v.private),
        v.importance ?? old?.importance ?? 1,
        old?.created_at ?? t,
        t,
      );
    return this.read(v.path);
  }
  ensureFolder(path: string, title?: string, isPrivate = false) {
    Path.parse(path);
    if (path === "/") return this.read("/");
    let part = "";
    for (const slug of path.split("/").filter(Boolean)) {
      part += "/" + slug;
      if (!this.get(part))
        this.write({
          path: part,
          kind: "folder",
          title: part === path && title ? title : slug,
          summary: part === path && title ? title : slug,
          content: "",
          private: part === path && isPrivate,
        });
    }
    return this.read(path);
  }
  ls(path: string, depth = 1) {
    Path.parse(path);
    if (!this.get(path)) throw new Error("Memory node not found.");
    const base = path === "/" ? 0 : path.split("/").length - 1;
    return this.all()
      .filter(
        (n) =>
          n.path !== path &&
          within(n.path, path) &&
          n.path.split("/").length - 1 <= base + depth,
      )
      .map((n) => this.summary(n));
  }
  search(query: string, under = "/", limit = 8, includePrivate = true) {
    Path.parse(under);
    const words = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 24);
    if (!words?.length) return [];
    const q = words.map((w) => '"' + w + '"').join(" OR ");
    return (
      this.db
        .prepare(
          `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid=f.rowid WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts,5,3,1),n.importance DESC`,
        )
        .all(q) as TreeNode[]
    )
      .filter(
        (n) =>
          within(n.path, under) && (includePrivate || !this.isPrivate(n.path)),
      )
      .slice(0, limit)
      .map((n) => this.summary(n));
  }
  move(path: string, parentPath: string) {
    Path.parse(path);
    Path.parse(parentPath);
    if (
      [
        "/",
        "/rules",
        "/profile",
        "/projects",
        "/sessions",
        "/knowledge",
        "/archive",
        "/research",
      ].includes(path)
    )
      throw new Error("Top-level structure cannot be moved.");
    const node = this.read(path),
      parent = this.read(parentPath);
    if (within(parentPath, path))
      throw new Error("Cannot move a node inside itself.");
    const destination =
      (parentPath === "/" ? "" : parentPath) + "/" + path.split("/").pop();
    if (this.get(destination)) throw new Error("Destination already exists.");
    const priv = this.isPrivate(path);
    this.db.transaction(() => {
      const descendants = this.all().filter((n) => within(n.path, path));
      for (const n of descendants)
        this.db
          .prepare("UPDATE nodes SET path=?,updated_at=? WHERE id=?")
          .run(destination + n.path.slice(path.length), now(), n.id);
      this.db
        .prepare("UPDATE nodes SET parent_id=?,private=? WHERE id=?")
        .run(parent.id, Number(priv), node.id);
    })();
    return destination;
  }
  archive(path: string) {
    const bucket = "/archive/" + randomUUID();
    this.ensureFolder(bucket, "Archived " + now().slice(0, 10));
    try {
      return this.move(path, bucket);
    } catch (e) {
      this.db.prepare("DELETE FROM nodes WHERE path=?").run(bucket);
      throw e;
    }
  }
  project(name: string) {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    if (!slug) return "";
    const base = "/projects/" + slug;
    this.ensureFolder(base, name);
    this.ensureFolder(base + "/decisions", "Decisions");
    this.ensureFolder(base + "/notes", "Notes");
    if (!this.get(base + "/plan"))
      this.write({
        path: base + "/plan",
        kind: "plan",
        title: "Project plan",
        content: JSON.stringify({ milestones: [] }, null, 2),
        summary:
          "No milestones yet. Add milestones with title, status, and verify checks.",
      });
    return base;
  }
  newSession(project: string, isPrivate: boolean) {
    const id = randomUUID(),
      date = now().slice(0, 10),
      base = "/sessions/" + date + "/" + id;
    const p = project ? this.project(project) : "";
    this.ensureFolder("/sessions/" + date);
    this.write({
      path: base,
      kind: "session",
      title: "New session",
      content: "",
      summary: "An active conversation with Astro.",
      private: isPrivate,
    });
    this.write({
      path: base + "/raw",
      kind: "artifact",
      title: "Full transcript",
      content: "[]",
      summary: "Raw transcript. Never loaded automatically.",
      private: isPrivate,
    });
    this.db
      .prepare(
        "INSERT INTO sessions(id,date,title,project,private) VALUES(?,?,?,?,?)",
      )
      .run(id, date, "New session", p, Number(isPrivate));
    return this.session(id);
  }
  session(id: string): Session {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as any;
    if (!row) throw new Error("Session not found.");
    return {
      ...row,
      private: !!row.private,
      ended: !!row.ended,
      context: JSON.parse(row.context),
      messages: JSON.parse(
        this.read("/sessions/" + row.date + "/" + id + "/raw").content,
      ),
    };
  }
  sessions() {
    return (
      this.db
        .prepare("SELECT id FROM sessions ORDER BY rowid DESC LIMIT 50")
        .all() as { id: string }[]
    ).map((r) => this.session(r.id));
  }
  /**
   * Branch a conversation: a new session seeded with everything up to and
   * including one message. The original is untouched, so a direction can be
   * tried without losing the thread it came from.
   */
  forkSession(id: string, upTo: number) {
    const source = this.session(id);
    const take = source.messages.slice(0, Math.max(1, upTo + 1));
    if (!take.length) throw new Error("Nothing to branch from.");
    // `project` is already a tree path; newSession slugifies a *name*, so the
    // path is carried over directly instead of being slugified a second time.
    const forked = this.newSession("", source.private);
    this.db
      .prepare("UPDATE sessions SET project=? WHERE id=?")
      .run(source.project, forked.id);
    forked.project = source.project;
    forked.title = ("⑂ " + source.title).slice(0, 200);
    forked.messages = take;
    forked.context = source.context;
    forked.compacted = 0;
    this.saveSession(forked);
    return this.session(forked.id);
  }
  /** Rename a conversation. The session node title follows it. */
  renameSession(id: string, title: string) {
    const s = this.session(id);
    s.title = title.trim().slice(0, 200) || "Untitled session";
    this.saveSession(s);
    return s;
  }
  /**
   * Permanently remove a conversation: its sessions row and the whole
   * /sessions/<date>/<id> subtree, deepest path first so parent references go
   * last. Memory the conversation wrote elsewhere in the tree is untouched.
   */
  deleteSession(id: string) {
    const row = this.db
      .prepare("SELECT date FROM sessions WHERE id=?")
      .get(id) as { date: string } | undefined;
    if (!row) throw new Error("Session not found.");
    const base = "/sessions/" + row.date + "/" + id;
    this.db.transaction(() => {
      const doomed = this.all()
        .filter((n) => within(n.path, base))
        .sort((a, b) => b.path.length - a.path.length);
      for (const n of doomed)
        this.db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    })();
  }
  saveSession(s: Session) {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sessions SET title=?,private=?,ended=?,compacted=?,context=? WHERE id=?",
        )
        .run(
          s.title,
          Number(s.private),
          Number(s.ended),
          s.compacted,
          JSON.stringify(s.context),
          s.id,
        );
      const base = "/sessions/" + s.date + "/" + s.id;
      const root = this.read(base);
      this.write({
        path: root.path,
        kind: root.kind,
        content: root.content,
        summary: root.summary,
        importance: root.importance,
        private: s.private,
        pinned: !!root.pinned,
        title: s.title,
      });
      this.write({
        path: base + "/raw",
        kind: "artifact",
        title: "Full transcript",
        // Provider thinking/reasoning is display-only and must never reach
        // disk. Stripping here (rather than at the call site) means no caller
        // can persist it by accident. See AGENTS.md.
        content: JSON.stringify(
          s.messages.map(({ reasoning: _reasoning, ...m }) => m),
        ),
        summary: "Full user/assistant transcript. Never loaded automatically.",
        private: s.private,
      });
    })();
  }
  propose(action: string, payload: unknown) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO proposals VALUES(?,?,?,?)")
      .run(id, action, JSON.stringify(payload), now());
    return id;
  }
  proposals() {
    return this.db
      .prepare("SELECT * FROM proposals ORDER BY created_at")
      .all() as Proposal[];
  }
  log(c: CallRecord) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO calls VALUES(@id,@timestamp,@session,@model,@provider,@tier,@reason,@input_tokens,@cached_tokens,@cache_write_tokens,@output_tokens,@cost,@latency,@verification,@escalated)",
      )
      .run({ ...c, id, timestamp: now() });
    return id;
  }
  dashboard(): Dashboard {
    const r = this.db
      .prepare(
        "SELECT count(*) calls,coalesce(sum(cost),0) cost,coalesce(sum(input_tokens),0) input,coalesce(sum(cached_tokens),0) cached,coalesce(sum(output_tokens),0) output,coalesce(avg(latency),0) latency FROM calls",
      )
      .get() as any;
    const answer = this.db
      .prepare(
        "SELECT count(*) total,coalesce(sum(escalated),0) escalated FROM calls WHERE tier='answer'",
      )
      .get() as any;
    return {
      ...r,
      escalationRate: answer.total ? answer.escalated / answer.total : 0,
      cacheRate: r.input ? r.cached / r.input : 0,
      routes: this.db
        .prepare(
          "SELECT provider,count(*) count FROM calls WHERE tier='answer' GROUP BY provider",
        )
        .all(),
      days: this.db
        .prepare(
          "SELECT substr(timestamp,1,10) day,sum(cost) cost,count(*) calls FROM calls GROUP BY day ORDER BY day DESC LIMIT 30",
        )
        .all(),
      recent: this.db
        .prepare("SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50")
        .all(),
    } as Dashboard;
  }
  close() {
    this.db.close();
  }
}
