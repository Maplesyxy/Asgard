import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Folder,
  GitBranch,
  Layers3,
  LockKeyhole,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  FileText,
  Pin,
  BarChart3,
  Check,
  AlertTriangle,
} from "lucide-react";
import type {
  ContextEntry,
  Dashboard,
  NodeSummary,
  NodeWrite,
  Session,
  Settings,
  State,
  TreeNode,
} from "../shared/types";
import "./style.css";
const api = window.asgard;
const money = (n: number) => "$" + n.toFixed(n > 0 && n < 0.01 ? 5 : 2);
const count = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : n.toString();
const initials = (p: string) => p.split("/").pop() ?? p;
function App() {
  const [state, setState] = useState<State>({
      nodes: [],
      sessions: [],
      proposals: [],
    }),
    [screen, setScreen] = useState<"chat" | "dashboard" | "settings">("chat"),
    [active, setActive] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<NodeSummary[]>([]),
    [open, setOpen] = useState(new Set(["/", "/projects", "/rules"])),
    [editor, setEditor] = useState<NodeWrite | null>(null),
    [selected, setSelected] = useState(""),
    [inspector, setInspector] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [newDialog, setNewDialog] = useState(false),
    [project, setProject] = useState(""),
    [privateNew, setPrivateNew] = useState(false),
    [text, setText] = useState(""),
    [route, setRoute] = useState<"auto" | "deepseek" | "opus">("auto"),
    [highStakes, setHighStakes] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [format, setFormat] = useState<"text" | "json">("text"),
    [jsonSchema, setJsonSchema] = useState(""),
    [required, setRequired] = useState(""),
    [config, setConfig] = useState<Awaited<
      ReturnType<typeof api.settings>
    > | null>(null),
    [dash, setDash] = useState<Dashboard | null>(null),
    [inspectNode, setInspectNode] = useState<ContextEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null),
    chatEnd = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const session = state.sessions.find((s) => s.id === active);
  async function refresh() {
    const data = await api.state();
    setState(data);
    setActive((a) => a || data.sessions[0]?.id || "");
    return data;
  }
  async function run(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      await refresh();
      setConfig(await api.settings());
    });
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewDialog(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let current = true;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          if (current) setResults(r);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(id);
    };
  }, [query, state.nodes]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, busy]);
  useEffect(() => {
    if (screen === "dashboard")
      void run(async () => setDash(await api.dashboard()));
    if (screen === "settings")
      void run(async () => setConfig(await api.settings()));
  }, [screen]);
  async function openNode(path: string) {
    await run(async () => {
      const n = await api.read(path);
      setSelected(path);
      setEditor({
        path: n.path,
        kind: n.kind,
        title: n.title,
        content: n.content,
        summary: n.summary,
        pinned: !!n.pinned,
        private: !!n.private,
        importance: n.importance,
      });
    });
  }
  async function newSession() {
    await run(async () => {
      if (session && !session.ended && session.messages.length)
        await api.endSession(session.id);
      const s = await api.newSession(project, privateNew);
      await refresh();
      setActive(s.id);
      setNewDialog(false);
      setScreen("chat");
      setNotice("New session ready.");
      composer.current?.focus();
    });
  }
  async function send() {
    if (!text.trim() || busy) return;
    await run(async () => {
      const schema = jsonSchema.trim() ? JSON.parse(jsonSchema) : undefined;
      let s = session;
      if (!s || s.ended) {
        s = await api.newSession(project, privateNew);
        setActive(s.id);
      }
      const prompt = text;
      setText("");
      try {
        await api.send({
          sessionId: s.id,
          text: prompt,
          route,
          highStakes,
          checks: {
            format,
            jsonSchema: schema,
            requiredText: required.split("\n").filter(Boolean),
          },
        });
      } finally {
        await refresh();
      }
    });
  }
  function toggle(path: string) {
    setOpen((v) => {
      const next = new Set(v);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }
  function tree(
    nodes: NodeSummary[],
    parent: string,
    depth = 0,
  ): React.ReactNode {
    return nodes
      .filter(
        (n) =>
          n.path !== "/" &&
          (n.path.substring(0, n.path.lastIndexOf("/")) || "/") === parent,
      )
      .map((n) => {
        const children = nodes.some((x) => x.parent_id === n.id),
          expanded = open.has(n.path);
        return (
          <React.Fragment key={n.id}>
            <button
              className={"tree-row " + (selected === n.path ? "selected" : "")}
              style={{ paddingLeft: 14 + depth * 16 }}
              draggable={!busy}
              onDragStart={(e) => e.dataTransfer.setData("text/plain", n.path)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const path = e.dataTransfer.getData("text/plain");
                if (path)
                  void run(async () => {
                    await api.move(path, n.path);
                    await refresh();
                  });
              }}
              onClick={() => void openNode(n.path)}
            >
              <span
                className="tree-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(n.path);
                }}
              >
                {children ? (
                  expanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )
                ) : (
                  <span className="tree-dot" />
                )}
              </span>
              {n.kind === "folder" ? (
                <Folder size={15} />
              ) : (
                <FileText size={14} />
              )}
              <span className="tree-title">{n.title}</span>
              {n.private ? (
                <LockKeyhole size={11} />
              ) : n.pinned ? (
                <Pin size={11} />
              ) : null}
              <small>{count(n.tokens)}</small>
            </button>
            {expanded && tree(nodes, n.path, depth + 1)}
          </React.Fragment>
        );
      });
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">ᚨ</div>
          <strong>
            asgard<span>LOCAL INTELLIGENCE</span>
          </strong>
          <span className="version">v1.0</span>
        </div>
        <nav>
          {(
            [
              ["chat", "Workspace", MessageSquare],
              ["dashboard", "Observability", BarChart3],
              ["settings", "Settings", Settings2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={screen === id ? "nav active" : "nav"}
              onClick={() => setScreen(id)}
            >
              <Icon size={17} />
              {label}
              {id === "chat" && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="section-label">
          MEMORY TREE
          <button
            title="Create memory node"
            onClick={() => {
              setSelected("");
              setEditor({
                path: "/knowledge/new-note",
                kind: "fact",
                title: "New memory",
                content: "",
                summary: "",
              });
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            ref={searchRef}
            placeholder="Search memories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="tree">
          {query
            ? results.map((n) => (
                <button
                  key={n.id}
                  className="search-result"
                  onClick={() => void openNode(n.path)}
                >
                  <FileText size={14} />
                  <div>
                    {n.title}
                    <small>{n.path}</small>
                  </div>
                </button>
              ))
            : tree(state.nodes, "/")}
        </div>
        <div className="section-label sessions-label">
          RECENT SESSIONS
          <button title="New session" onClick={() => setNewDialog(true)}>
            <Plus size={15} />
          </button>
        </div>
        <div className="sessions">
          {state.sessions.slice(0, 7).map((s) => (
            <button
              key={s.id}
              className={"session-link " + (active === s.id ? "current" : "")}
              onClick={() => {
                setActive(s.id);
                setScreen("chat");
              }}
            >
              <MessageSquare size={13} />
              <span>{s.title}</span>
              {s.private && <LockKeyhole size={11} />}
            </button>
          ))}
          {!state.sessions.length && (
            <p className="muted empty-small">
              Your conversations will live here.
            </p>
          )}
        </div>
        <div className="local-status">
          <span className="status-dot" />
          <div>
            Local by design<small>SQLite memory · no telemetry</small>
          </div>
          <ShieldCheck size={17} />
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Asgard <span>/</span>{" "}
            {screen === "chat"
              ? session?.project
                ? initials(session.project)
                : "Personal workspace"
              : screen === "settings"
                ? "Settings"
                : "Observability"}
          </div>
          <div className="top-actions">
            {session?.private && screen === "chat" && (
              <span className="privacy-pill">
                <LockKeyhole size={12} /> Anthropic only
              </span>
            )}
            <button onClick={() => setNewDialog(true)}>
              <Plus size={14} /> New session <kbd>⌘ N</kbd>
            </button>
            {screen === "chat" && (
              <button
                aria-label="Toggle context inspector"
                onClick={() => setInspector(!inspector)}
              >
                {inspector ? (
                  <PanelRightClose size={17} />
                ) : (
                  <PanelRightOpen size={17} />
                )}
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="banner error">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner">
            <CircleCheck size={15} />
            <span>{notice}</span>
            <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {screen === "chat" ? (
          <div className="workspace">
            <section className="chat">
              <div className="chat-heading">
                <div className="astro-avatar small">
                  <Sparkles size={19} />
                </div>
                <div>
                  <h2>
                    Astro <span>YOUR THINKING PARTNER</span>
                  </h2>
                  <p>One assistant. A memory that grows with you.</p>
                </div>
                <div className="chat-heading-actions">
                  {session && !session.ended && (
                    <>
                      <label title="Private sessions can only use Anthropic">
                        <input
                          type="checkbox"
                          checked={session.private}
                          disabled={
                            busy ||
                            (session.private && session.messages.length > 0)
                          }
                          onChange={(e) =>
                            void run(async () => {
                              await api.setPrivate(
                                session.id,
                                e.target.checked,
                              );
                              await refresh();
                            })
                          }
                        />
                        <LockKeyhole size={13} /> Private
                      </label>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.endSession(session.id);
                            await refresh();
                            setNotice(
                              "Session compacted. Decisions and rule proposals are ready.",
                            );
                          })
                        }
                      >
                        End session
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="messages">
                {!session?.messages.length ? (
                  <div className="welcome">
                    <div className="eyebrow">
                      <span /> A PLACE FOR YOUR THINKING
                    </div>
                    <div className="orb">
                      <Sparkles size={38} strokeWidth={1.2} />
                    </div>
                    <h1>
                      Good ideas deserve
                      <br />
                      <em>a lasting memory.</em>
                    </h1>
                    <p>
                      Think things through with Astro. Your plans, decisions,
                      <br />
                      and preferences find their place in a living memory tree.
                    </p>
                    <div className="suggestions">
                      {[
                        [
                          "Make a plan",
                          "Turn a goal into clear next steps.",
                          "Help me make a plan for ",
                        ],
                        [
                          "Connect the dots",
                          "Find what matters in your memory.",
                          "Search my memory and help me connect ",
                        ],
                        [
                          "Keep something",
                          "Give an important detail a home.",
                          "Remember this about me: ",
                        ],
                      ].map(([title, desc, prompt]) => (
                        <button
                          key={title}
                          onClick={() => {
                            setText(prompt);
                            composer.current?.focus();
                          }}
                        >
                          <GitBranch size={17} />
                          <strong>{title}</strong>
                          <span>{desc}</span>
                          <ArrowUp size={14} />
                        </button>
                      ))}
                    </div>
                    {(!config?.keys.anthropic ||
                      !config?.keys.deepseek ||
                      !config?.values.deepseekModel) && (
                      <button
                        className="setup-link"
                        onClick={() => setScreen("settings")}
                      >
                        <Settings2 size={14} /> Connect your models in Settings
                        to begin <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                ) : (
                  session.messages.map((m, i) => (
                    <article key={i} className={"message " + m.role}>
                      <div className={"message-avatar " + m.role}>
                        {m.role === "assistant" ? <Sparkles size={15} /> : "Y"}
                      </div>
                      <div className="message-body">
                        <div className="message-title">
                          {m.role === "assistant" ? "Astro" : "You"}
                          <time>
                            {new Date(m.at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <div className="message-text">{m.content}</div>
                        {m.meta && (
                          <>
                            <div className="message-meta">
                              <span
                                className={
                                  m.meta.provider === "opus"
                                    ? "model opus"
                                    : "model"
                                }
                              >
                                {m.meta.provider === "opus"
                                  ? "Opus"
                                  : "DeepSeek"}
                              </span>
                              <span>{count(m.meta.tokens)} tokens</span>
                              <span>{money(m.meta.cost)} est.</span>
                              <span
                                className={
                                  m.meta.verified ? "verified" : "unverified"
                                }
                              >
                                {m.meta.verified
                                  ? "✓ Checks passed"
                                  : "✗ Check notes"}
                              </span>
                              {m.meta.escalated && <span>Escalated</span>}
                            </div>
                            <details className="verification-details">
                              <summary>
                                {m.meta.model} · routing & checks
                              </summary>
                              <p>{m.meta.reason}</p>
                              {m.meta.issues.map((issue, i) => (
                                <p key={i}>{issue}</p>
                              ))}
                            </details>
                          </>
                        )}
                      </div>
                    </article>
                  ))
                )}
                {busy && (
                  <div className="working">
                    <span className="pulse" /> Astro is working
                    <span>
                      Memory, routing and checks stay in the main process.
                    </span>
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
              <div className="composer-wrap">
                <div className="composer">
                  <textarea
                    ref={composer}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="What’s on your mind?"
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-tools">
                    <div>
                      <select
                        aria-label="Model routing"
                        value={route}
                        onChange={(e) => setRoute(e.target.value as any)}
                      >
                        <option value="auto">✦ Auto route</option>
                        <option value="deepseek">Force DeepSeek</option>
                        <option value="opus">Force Opus</option>
                      </select>
                      <span className="divider" />
                      <label>
                        <input
                          type="checkbox"
                          checked={highStakes}
                          onChange={(e) => setHighStakes(e.target.checked)}
                        />
                        <ShieldCheck size={14} /> High stakes
                      </label>
                      <button
                        className={
                          advanced ? "text-button green" : "text-button"
                        }
                        onClick={() => setAdvanced(!advanced)}
                      >
                        Output checks
                      </button>
                    </div>
                    <button
                      className="send"
                      aria-label="Send message"
                      disabled={busy || !text.trim()}
                      onClick={() => void send()}
                    >
                      <ArrowUp size={19} />
                    </button>
                  </div>
                  {advanced && (
                    <div className="advanced">
                      <label>
                        Required format
                        <select
                          value={format}
                          onChange={(e) => setFormat(e.target.value as any)}
                        >
                          <option value="text">Text</option>
                          <option value="json">JSON</option>
                        </select>
                      </label>
                      <label>
                        Required text (one per line)
                        <textarea
                          value={required}
                          onChange={(e) => setRequired(e.target.value)}
                        />
                      </label>
                      <label>
                        JSON Schema (optional)
                        <textarea
                          placeholder={
                            '{"type":"object","required":["result"]}'
                          }
                          value={jsonSchema}
                          onChange={(e) => setJsonSchema(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                </div>
                <div className="composer-caption">
                  <span>
                    <span className="status-dot" /> Memory stays on this device.
                    Selected context goes to your provider.
                  </span>
                  <span>
                    ↵ Send <i>·</i> ⇧ ↵ New line
                  </span>
                </div>
              </div>
            </section>
            {inspector && (
              <aside className="inspector">
                <div className="inspector-heading">
                  <Layers3 size={15} />
                  <strong>Context inspector</strong>
                  <span>LIVE</span>
                </div>
                <p className="inspector-intro">
                  A clear view of what Astro brought into the conversation.
                </p>
                <div className="context-total">
                  <span>LAST REQUEST CONTEXT</span>
                  <strong>
                    {count(
                      session?.context.reduce((a, n) => a + n.tokens, 0) ?? 0,
                    )}{" "}
                    <small>tokens</small>
                  </strong>
                  <p>{session?.context.length ?? 0} memory nodes loaded</p>
                </div>
                <div className="section-label">
                  ALWAYS IN CONTEXT <Pin size={12} />
                </div>
                {session?.context
                  .filter((n) => n.mode === "full")
                  .map((n) => (
                    <ContextRow
                      key={n.path}
                      entry={n}
                      onClick={() => setInspectNode(n)}
                    />
                  ))}
                {!session?.context.length && (
                  <div className="context-placeholder">
                    <ShieldCheck size={18} />
                    <p>Standing rules & pinned memories</p>
                    <small>Loaded first, with a stable cache prefix.</small>
                  </div>
                )}
                <div className="section-label">RETRIEVED FOR THIS REQUEST</div>
                {session?.context
                  .filter((n) => n.mode === "summary")
                  .map((n) => (
                    <ContextRow
                      key={n.path}
                      entry={n}
                      onClick={() => setInspectNode(n)}
                    />
                  ))}
                {!session?.context.some((n) => n.mode === "summary") && (
                  <p className="empty-small muted">
                    Relevant summaries appear here when you send a message.
                  </p>
                )}
                <div className="inspector-divider" />
                <div className="section-label">
                  PROJECT PLAN
                  <GitBranch size={13} />
                </div>
                {session?.project ? (
                  <PlanView
                    path={session.project + "/plan"}
                    nodes={state.nodes}
                    onOpen={openNode}
                  />
                ) : (
                  <div className="context-placeholder">
                    <Folder size={19} />
                    <p>A little structure, a lot of clarity.</p>
                    <small>
                      Start a session with a project to keep its milestones
                      close.
                    </small>
                  </div>
                )}
                {!!state.proposals.length && (
                  <>
                    <div className="section-label">
                      AWAITING YOUR APPROVAL
                      <span className="count-pill">
                        {state.proposals.length}
                      </span>
                    </div>
                    {state.proposals.map((p) => {
                      const data = JSON.parse(p.payload);
                      return (
                        <div className="proposal" key={p.id}>
                          <strong>{data.title ?? p.action}</strong>
                          <small>{data.path}</small>
                          <p>{data.content ?? JSON.stringify(data)}</p>
                          <div>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api.decide(p.id, false);
                                  await refresh();
                                })
                              }
                            >
                              Dismiss
                            </button>
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api.decide(p.id, true);
                                  await refresh();
                                })
                              }
                            >
                              <Check size={12} /> Approve
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
                <div className="inspector-foot">
                  <LockKeyhole size={13} />
                  <span>Raw transcripts are never loaded automatically.</span>
                </div>
              </aside>
            )}
          </div>
        ) : screen === "settings" ? (
          <SettingsView
            data={config}
            busy={busy}
            run={run}
            refresh={async () => setConfig(await api.settings())}
            notify={setNotice}
          />
        ) : (
          <DashboardView data={dash} config={config} />
        )}
      </main>
      {newDialog && (
        <div className="modal-backdrop">
          <section className="modal narrow">
            <div className="modal-title">
              <h2>A fresh conversation</h2>
              <button onClick={() => setNewDialog(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <p className="muted">
              Your current session is compacted before starting a new one.
            </p>
            <label>
              Project (optional)
              <input
                autoFocus
                placeholder="e.g. Asgard"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={privateNew}
                onChange={(e) => setPrivateNew(e.target.checked)}
              />
              <LockKeyhole size={15} /> Private · Anthropic only
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void newSession()}
            >
              Create session
            </button>
          </section>
        </div>
      )}
      {editor && (
        <div className="modal-backdrop">
          <section className="modal editor">
            <div className="modal-title">
              <div>
                <span className="eyebrow">TREE MEMORY</span>
                <h2>{selected ? "Edit memory" : "Give a thought a home"}</h2>
              </div>
              <button onClick={() => setEditor(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="form-grid">
              <label>
                Path
                <input
                  value={editor.path}
                  disabled={!!selected}
                  onChange={(e) =>
                    setEditor({ ...editor, path: e.target.value })
                  }
                />
              </label>
              <label>
                Kind
                <select
                  value={editor.kind}
                  onChange={(e) =>
                    setEditor({ ...editor, kind: e.target.value as any })
                  }
                >
                  {[
                    "folder",
                    "rule",
                    "fact",
                    "decision",
                    "plan",
                    "session",
                    "summary",
                    "artifact",
                  ].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Title
              <input
                value={editor.title}
                onChange={(e) =>
                  setEditor({ ...editor, title: e.target.value })
                }
              />
            </label>
            <label>
              Short summary <small>Always required · 1–5 lines</small>
              <textarea
                rows={2}
                maxLength={1500}
                value={editor.summary}
                onChange={(e) =>
                  setEditor({ ...editor, summary: e.target.value })
                }
              />
            </label>
            <label>
              Full content
              <textarea
                className="content-editor"
                rows={10}
                value={editor.content}
                onChange={(e) =>
                  setEditor({ ...editor, content: e.target.value })
                }
              />
            </label>
            {editor.kind === "plan" && (
              <p className="hint">
                Use JSON with milestones: [&#123;title, status, verify&#125;].
                Checks may be a manual description or &#123;path,
                includes&#125;. Shell commands are never executed.
              </p>
            )}
            <div className="editor-options">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editor.pinned ?? false}
                  onChange={(e) =>
                    setEditor({ ...editor, pinned: e.target.checked })
                  }
                />
                <Pin size={13} /> Always load
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editor.private ?? false}
                  onChange={(e) =>
                    setEditor({ ...editor, private: e.target.checked })
                  }
                />
                <LockKeyhole size={13} /> Private
              </label>
              <label>
                Importance
                <select
                  value={editor.importance ?? 1}
                  onChange={(e) =>
                    setEditor({ ...editor, importance: Number(e.target.value) })
                  }
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="modal-footer">
              {selected && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.archive(editor.path);
                      await refresh();
                      setEditor(null);
                    })
                  }
                >
                  <Archive size={14} /> Archive
                </button>
              )}
              <span />
              {editor.path.startsWith("/rules") && (
                <small className="muted">
                  Requires approval in the context inspector.
                </small>
              )}
              <button
                className="primary"
                disabled={busy || !editor.summary.trim()}
                onClick={() =>
                  void run(async () => {
                    await api.write(editor);
                    await refresh();
                    setEditor(null);
                    setNotice(
                      editor.path.startsWith("/rules")
                        ? "Rule change proposed. Review it in the context inspector."
                        : "Memory saved.",
                    );
                  })
                }
              >
                Save memory
              </button>
            </div>
          </section>
        </div>
      )}
      {inspectNode && (
        <div className="modal-backdrop">
          <section className="modal">
            <div className="modal-title">
              <h2>Loaded context</h2>
              <button onClick={() => setInspectNode(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <code>{inspectNode.path}</code>
            <p className="muted">
              {inspectNode.mode} · {inspectNode.tokens} estimated tokens ·{" "}
              {inspectNode.private ? "private" : "public"}
            </p>
            <pre>{inspectNode.content || "(Empty node content)"}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
function ContextRow({
  entry,
  onClick,
}: {
  entry: ContextEntry;
  onClick: () => void;
}) {
  return (
    <button className="context-row" onClick={onClick}>
      <FileText size={14} />
      <span>
        {initials(entry.path)}
        <small>{entry.path}</small>
      </span>
      <small>{count(entry.tokens)}</small>
    </button>
  );
}
function PlanView({
  path,
  nodes,
  onOpen,
}: {
  path: string;
  nodes: NodeSummary[];
  onOpen: (p: string) => Promise<void>;
}) {
  const [milestones, setMilestones] = useState<any[]>([]);
  useEffect(() => {
    api
      .read(path)
      .then((n) => {
        try {
          setMilestones(JSON.parse(n.content).milestones ?? []);
        } catch {
          setMilestones([]);
        }
      })
      .catch(() => setMilestones([]));
  }, [path, nodes]);
  return (
    <div className="plan-view">
      {milestones.map((m, i) => (
        <div className="milestone" key={i}>
          <span className={m.status === "complete" ? "done" : ""}>
            {m.status === "complete" ? <Check size={12} /> : i + 1}
          </span>
          <div>
            {String(m.title ?? "Untitled milestone")}
            <small>
              {typeof m.verify === "string"
                ? m.verify
                : JSON.stringify(m.verify)}
            </small>
          </div>
        </div>
      ))}
      {!milestones.length && (
        <p className="muted empty-small">No milestones yet.</p>
      )}
      <button className="text-button green" onClick={() => void onOpen(path)}>
        Edit project plan <ChevronRight size={13} />
      </button>
    </div>
  );
}
function SettingsView({
  data,
  busy,
  run,
  refresh,
  notify,
}: {
  data: Awaited<ReturnType<typeof api.settings>> | null;
  busy: boolean;
  run: (f: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [values, setValues] = useState<Settings | null>(null),
    [anthropic, setAnthropic] = useState(""),
    [deepseek, setDeepseek] = useState("");
  useEffect(() => {
    if (data) setValues(data.values);
  }, [data]);
  if (!values || !data) return <div className="page">Loading settings…</div>;
  const field = (name: keyof Settings, label: string, type = "text") => (
    <label key={name}>
      {label}
      <input
        type={type}
        value={String(values[name])}
        onChange={(e) =>
          setValues({
            ...values,
            [name]: type === "number" ? Number(e.target.value) : e.target.value,
          })
        }
      />
    </label>
  );
  return (
    <div className="page settings-page">
      <div className="eyebrow">YOUR MODELS. YOUR MEMORY.</div>
      <h1>Make yourself at home.</h1>
      <p className="page-intro">
        Connect Astro to your providers. Keys are encrypted by your operating
        system and never returned to this screen.
      </p>
      <div className="settings-status">
        <ShieldCheck size={16} />
        {data.secureStorage
          ? "OS secure storage is available."
          : "OS secure storage is unavailable. Saving keys is disabled."}
      </div>
      <div className="settings-columns">
        <section className="card">
          <div className="card-heading">
            <span className="provider-icon">A</span>
            <div>
              <h3>Anthropic</h3>
              <p>Deep thinking, planning & private work</p>
            </div>
            <span className="connection">
              {data.keys.anthropic ? "Key saved" : "Not connected"}
            </span>
          </div>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={anthropic}
              placeholder={
                data.keys.anthropic
                  ? "Saved securely · leave blank to keep"
                  : "Enter Anthropic API key"
              }
              onChange={(e) => setAnthropic(e.target.value)}
            />
          </label>
          {field("anthropicModel", "Model ID")}
          {field("anthropicBaseUrl", "API base URL")}
          <button
            disabled={busy || !data.keys.anthropic}
            onClick={() =>
              void run(async () => {
                const r = await api.testProvider("opus");
                notify(r.text + " Cached tokens: " + r.cachedTokens);
              })
            }
          >
            Test saved connection
          </button>
        </section>
        <section className="card">
          <div className="card-heading">
            <span className="provider-icon blue">D</span>
            <div>
              <h3>DeepSeek</h3>
              <p>Everyday tasks & session compaction</p>
            </div>
            <span className="connection">
              {data.keys.deepseek ? "Key saved" : "Not connected"}
            </span>
          </div>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={deepseek}
              placeholder={
                data.keys.deepseek
                  ? "Saved securely · leave blank to keep"
                  : "Enter DeepSeek API key"
              }
              onChange={(e) => setDeepseek(e.target.value)}
            />
          </label>
          {field("deepseekModel", "Model ID · required, from your provider")}
          {field("deepseekBaseUrl", "API base URL")}
          <button
            disabled={busy || !data.keys.deepseek || !data.values.deepseekModel}
            onClick={() =>
              void run(async () => {
                const r = await api.testProvider("deepseek");
                notify(r.text + " Cached tokens: " + r.cachedTokens);
              })
            }
          >
            Test saved connection
          </button>
        </section>
      </div>
      <section className="card">
        <h3>Context & output budgets</h3>
        <p className="muted">
          Small by default. Full memory is read only when Astro needs it.
        </p>
        <div className="form-grid three">
          {field("easyMaxTokens", "DeepSeek max output tokens", "number")}
          {field("hardMaxTokens", "Opus max output tokens", "number")}
          {field("compactionThreshold", "Compact session at tokens", "number")}
          {field("toolOutputTokens", "Tool output token limit", "number")}
          {field("retrievalLimit", "Retrieved memory nodes", "number")}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={values.thinking}
            onChange={(e) =>
              setValues({ ...values, thinking: e.target.checked })
            }
          />{" "}
          Enable Opus extended thinking (model must support budget-based
          thinking)
        </label>
      </section>
      <section className="card">
        <h3>Cost estimates</h3>
        <p className="muted">
          USD per million tokens. Enter your actual rates; zero means
          unconfigured, not free.
        </p>
        {(["anthropicPrice", "deepseekPrice"] as const).map((key) => (
          <div key={key}>
            <h4>{key === "anthropicPrice" ? "Anthropic" : "DeepSeek"}</h4>
            <div className="form-grid four">
              {(["input", "cached", "cacheWrite", "output"] as const).map(
                (name) => (
                  <label key={name}>
                    {
                      {
                        input: "Input",
                        cached: "Cache read",
                        cacheWrite: "Cache write",
                        output: "Output",
                      }[name]
                    }
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={values[key][name]}
                      onChange={(e) =>
                        setValues({
                          ...values,
                          [key]: {
                            ...values[key],
                            [name]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                ),
              )}
            </div>
          </div>
        ))}
      </section>
      <div className="save-settings">
        <p>
          API requests go to the configured endpoints. Verify custom URLs before
          saving.
        </p>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.saveSettings(values, {
                anthropic: anthropic || undefined,
                deepseek: deepseek || undefined,
              });
              setAnthropic("");
              setDeepseek("");
              await refresh();
              notify(
                "Settings saved. Credentials remain encrypted on this device.",
              );
            })
          }
        >
          Save settings <Check size={15} />
        </button>
      </div>
    </div>
  );
}
function DashboardView({
  data,
  config,
}: {
  data: Dashboard | null;
  config: Awaited<ReturnType<typeof api.settings>> | null;
}) {
  if (!data) return <div className="page">Loading observability…</div>;
  const total = data.routes.reduce((s, r) => s + r.count, 0);
  return (
    <div className="page">
      <div className="eyebrow">EVERY CALL, ACCOUNTED FOR</div>
      <h1>A little more visibility.</h1>
      <p className="page-intro">
        Understand how Astro spends its time and tokens. All metrics are stored
        locally.
      </p>
      {config &&
        Object.values(config.values.anthropicPrice).every((v) => v === 0) && (
          <div className="banner">
            <AlertTriangle size={15} /> Configure provider prices in Settings
            for meaningful cost estimates.
          </div>
        )}
      <div className="metrics">
        {[
          ["Estimated spend", money(data.cost), data.calls + " model calls"],
          [
            "Cache hit rate",
            (data.cacheRate * 100).toFixed(1) + "%",
            count(data.cached) + " cached input tokens",
          ],
          [
            "Escalation rate",
            (data.escalationRate * 100).toFixed(1) + "%",
            "Answer calls requiring escalation",
          ],
          [
            "Average latency",
            (data.latency / 1000).toFixed(1) + "s",
            "Across all provider calls",
          ],
        ].map(([label, value, sub]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{sub}</small>
          </div>
        ))}
      </div>
      <div className="settings-columns">
        <section className="card">
          <h3>Daily cost</h3>
          <p className="muted">Last 30 active days · estimated USD</p>
          <div className="bar-chart">
            {data.days.length ? (
              data.days
                .slice()
                .reverse()
                .map((day) => (
                  <div
                    className="bar-column"
                    key={day.day}
                    title={day.day + " · " + money(day.cost)}
                  >
                    <small>{money(day.cost)}</small>
                    <div
                      style={{
                        height: Math.max(
                          3,
                          (day.cost /
                            Math.max(
                              0.000001,
                              ...data.days.map((d) => d.cost),
                            )) *
                            140,
                        ),
                      }}
                    />
                    <span>{day.day.slice(5)}</span>
                  </div>
                ))
            ) : (
              <div className="chart-empty">
                <BarChart3 size={25} />
                <p>Your first call starts the story.</p>
              </div>
            )}
          </div>
        </section>
        <section className="card">
          <h3>Model distribution</h3>
          <p className="muted">
            Answer calls by provider, including tool rounds
          </p>
          {["deepseek", "opus"].map((p) => {
            const n = data.routes.find((r) => r.provider === p)?.count ?? 0;
            return (
              <div className="route-stat" key={p}>
                <div>
                  <span>{p === "opus" ? "Anthropic · Opus" : "DeepSeek"}</span>
                  <strong>{total ? ((n / total) * 100).toFixed(0) : 0}%</strong>
                </div>
                <div className="route-track">
                  <span
                    style={{ width: (total ? (n / total) * 100 : 0) + "%" }}
                  />
                </div>
                <small>{n} calls</small>
              </div>
            );
          })}
        </section>
      </div>
      <section className="card">
        <h3>Recent model calls</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "Time",
                  "Model / purpose",
                  "Input",
                  "Cached",
                  "Output",
                  "Est. cost",
                  "Latency",
                  "Verification",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td>{new Date(r.timestamp!).toLocaleTimeString()}</td>
                  <td>
                    {r.model}
                    <small>{r.tier}</small>
                  </td>
                  <td>{count(r.input_tokens)}</td>
                  <td>{count(r.cached_tokens)}</td>
                  <td>{count(r.output_tokens)}</td>
                  <td>{money(r.cost)}</td>
                  <td>{(r.latency / 1000).toFixed(1)}s</td>
                  <td>{r.verification}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.calls && (
            <p className="empty-small muted">
              No calls yet. Configure your providers and send Astro a message.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
