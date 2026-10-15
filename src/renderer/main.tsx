import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Archive,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  Copy,
  FileText,
  FileType2,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Layers3,
  LockKeyhole,
  Monitor,
  Moon,
  Network,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Telescope,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import {
  CREDENTIAL,
  PROVIDERS,
  PROVIDER_LABEL,
  type Attachment,
  type ContextEntry,
  type Dashboard,
  type Message,
  type NodeSummary,
  type NodeWrite,
  type Provider,
  type Role,
  type Session,
  type Settings,
  type State,
  type StreamEvent,
} from "../shared/types";
import "./style.css";
const api = window.asgard;
type Theme = "light" | "dark" | "system";
/** The chosen theme, or light on a fresh install. Per device, so it lives here. */
function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("asgard:theme");
    if (stored === "light" || stored === "dark" || stored === "system")
      return stored;
  } catch {
    /* storage can be unavailable; light is a safe default */
  }
  return "light";
}
const money = (n: number) => "$" + n.toFixed(n > 0 && n < 0.01 ? 4 : 2);
const count = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : n.toString();
const initials = (p: string) => p.split("/").pop() ?? p;
const bytes = (n: number) =>
  n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : n >= 1024
      ? Math.round(n / 1024) + " KB"
      : n + " B";
/** Call records written before providers were renamed still say "opus". */
const providerLabel = (p: string) =>
  (PROVIDER_LABEL as Record<string, string>)[p] ??
  (p === "opus" ? "Claude" : p);
type Route = "auto" | Provider;
const ROUTES: { value: Route; label: string }[] = [
  { value: "auto", label: "Auto" },
  ...PROVIDERS.map((p) => ({ value: p as Route, label: PROVIDER_LABEL[p] })),
];
/** "claude-opus-5" reads as "Opus" in the interface. */
const shortModel = (id: string) =>
  /fable/i.test(id)
    ? "Fable"
    : /opus/i.test(id)
      ? "Opus"
      : /sonnet/i.test(id)
        ? "Sonnet"
        : /haiku/i.test(id)
          ? "Haiku"
          : id;
const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** Today / Yesterday / the date, for grouping the chat list. */
function dayLabel(date: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (date === iso(today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date === iso(yesterday)) return "Yesterday";
  return new Date(date + "T00:00:00").toLocaleDateString([], {
    month: "long",
    day: "numeric",
  });
}
/** Flatten a markdown child tree back to the text it was built from. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? textOf(props.children) : "";
}
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => setCopied(false));
  }, []);
  return [copied, copy] as const;
}
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language || "text"}</span>
        <button aria-label="Copy code" onClick={() => copy(code)}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
/**
 * Model output is untrusted, so the markdown layer is deliberately narrow:
 * raw HTML is skipped, links render inert (the renderer must never navigate,
 * and `setWindowOpenHandler` denies new windows anyway), and images are
 * replaced by a label -- the page CSP already limits img-src to self/data.
 */
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <span className="md-link" title={href ?? ""}>
      {children}
    </span>
  ),
  img: ({ alt, src }) => (
    <span className="md-image" title={typeof src === "string" ? src : ""}>
      [image: {alt || "untitled"}]
    </span>
  ),
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      (child as { props?: { className?: string } })?.props?.className ?? "";
    return (
      <CodeBlock
        language={/language-([\w+-]+)/.exec(className)?.[1] ?? ""}
        code={textOf(child).replace(/\n$/, "")}
      />
    );
  },
};
function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MD_COMPONENTS}
        disallowedElements={["script", "style", "iframe", "object", "embed"]}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
/**
 * The model's own thinking for a reply, collapsed by default and held in
 * renderer memory only: main strips reasoning before the transcript is saved,
 * so reopening Asgard shows the answer without it.
 */
function Thinking({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="thinking" open={live}>
      <summary>
        <Brain size={13} />
        <span>{live ? "Thinking…" : "Thought process"}</span>
        <ChevronRight size={13} className="caret" />
      </summary>
      <div className="thinking-body">
        <Markdown text={text} />
        <p className="footnote">
          Shown for this session only — reasoning is never written to memory.
        </p>
      </div>
    </details>
  );
}
const KIND_ICON = {
  image: ImageIcon,
  pdf: FileType2,
  text: Paperclip,
} as const;
function AttachmentChips({
  items,
  onRemove,
}: {
  items: Attachment[];
  onRemove?: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="chips">
      {items.map((a) => {
        const Icon = KIND_ICON[a.kind] ?? Paperclip;
        return (
          <span
            key={a.id}
            className={"chip" + (a.included ? "" : " skipped")}
            title={a.reason ?? a.label}
          >
            <Icon size={12} />
            <span className="chip-name">{a.label}</span>
            <span className="chip-size">
              {a.included
                ? bytes(a.bytes) + (a.truncated ? " · truncated" : "")
                : "skipped"}
            </span>
            {onRemove && (
              <button
                aria-label={"Remove " + a.label}
                onClick={() => onRemove(a.id)}
              >
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
function TurnActions({
  text,
  onRetry,
  onBranch,
}: {
  text: string;
  onRetry?: () => void;
  onBranch?: () => void;
}) {
  const [copied, copy] = useCopy();
  return (
    <div className="turn-actions">
      <button aria-label="Copy" title="Copy" onClick={() => copy(text)}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onRetry && (
        <button aria-label="Ask again" title="Ask again" onClick={onRetry}>
          <RefreshCw size={14} />
        </button>
      )}
      {onBranch && (
        <button
          aria-label="Branch from here"
          title="Branch from here into a new chat"
          onClick={onBranch}
        >
          <GitBranch size={14} />
        </button>
      )}
    </div>
  );
}
/** The verification line under an answer: quiet until you open it. */
function TurnMeta({ meta }: { meta: NonNullable<Message["meta"]> }) {
  return (
    <details className="turn-meta">
      <summary>
        <span className="pill">
          {meta.provider === "claude"
            ? shortModel(meta.model)
            : providerLabel(meta.provider)}
        </span>
        {meta.tier === "deep" && <span className="deep">deep research</span>}
        {!!meta.delegated && (
          <span>
            {meta.delegated} delegated sub-task{meta.delegated === 1 ? "" : "s"}
          </span>
        )}
        {!!meta.council?.length && (
          <span className="deep">council: {meta.council.join(" + ")}</span>
        )}
        <span>{count(meta.tokens)} tokens</span>
        <span>{money(meta.cost)}</span>
        <span className={meta.verified ? "ok" : "warn"}>
          {meta.verified ? "checks passed" : "check notes"}
        </span>
        {meta.escalated && <span>escalated</span>}
      </summary>
      <div>
        <p>
          <strong>{meta.model}</strong> — {meta.reason}
        </p>
        {meta.issues.map((issue, i) => (
          <p key={i}>{issue}</p>
        ))}
      </div>
    </details>
  );
}
interface Live {
  sessionId: string;
  text: string;
  thinking: string;
  stage: string;
  provider?: Provider;
  tools: string[];
  delegates: { task: string; done: boolean }[];
}
const EMPTY_LIVE = {
  text: "",
  thinking: "",
  stage: "Working",
  tools: [],
  delegates: [],
};
function LiveTurn({ live }: { live: Live }) {
  return (
    <article className="turn assistant">
      <div className="stage">
        <span className="pulse" />
        {live.stage}
        {live.provider ? " · " + PROVIDER_LABEL[live.provider] : ""}
      </div>
      {live.thinking && <Thinking text={live.thinking} live />}
      {live.delegates.length > 0 && (
        <div className="delegates">
          {live.delegates.map((d, i) => (
            <span key={i} className={d.done ? "done" : ""}>
              {d.done ? <Check size={11} /> : <span className="spinner" />}
              {d.task}
            </span>
          ))}
        </div>
      )}
      {live.tools.length > 0 && (
        <div className="tool-trail">
          {live.tools.map((name, i) => (
            <span key={i}>
              <Wrench size={11} /> {name}
            </span>
          ))}
        </div>
      )}
      {live.text ? (
        <Markdown text={live.text} />
      ) : (
        <div className="skeleton">
          <span />
          <span />
          <span />
        </div>
      )}
    </article>
  );
}
/**
 * The app mark: the same three interlocking triangles as the Dock icon, drawn
 * from the same geometry so the two cannot drift. The stroke is heavier than
 * the icon's because this renders at 22px.
 */
function Valknut() {
  return (
    <svg className="brandmark" viewBox="0 0 1024 1024" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="62"
        strokeLinejoin="round"
      >
        <path d="M 408 430 L 209 775 L 607 775 Z" />
        <path d="M 616 430 L 417 775 L 815 775 Z" />
        <path d="M 512 250 L 313 595 L 711 595 Z" />
      </g>
    </svg>
  );
}
function App() {
  const [state, setState] = useState<State>({
      nodes: [],
      sessions: [],
      proposals: [],
    }),
    [screen, setScreen] = useState<"chat" | "dashboard" | "settings">("chat"),
    [active, setActive] = useState(""),
    [chatQuery, setChatQuery] = useState(""),
    [memoryOpen, setMemoryOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [project, setProject] = useState(""),
    [privateNew, setPrivateNew] = useState(false),
    [newDialog, setNewDialog] = useState(false),
    [text, setText] = useState(""),
    [route, setRoute] = useState<Route>("auto"),
    [attached, setAttached] = useState<Attachment[]>([]),
    [dragging, setDragging] = useState(false),
    [live, setLive] = useState<Live | null>(null),
    [atBottom, setAtBottom] = useState(true),
    [renaming, setRenaming] = useState(""),
    [renameText, setRenameText] = useState(""),
    // Reasoning is not persisted, so it is kept here keyed by
    // "<sessionId>:<message.at>" and survives the post-send state refresh.
    [thoughts, setThoughts] = useState<Record<string, string>>({}),
    [deepResearch, setDeepResearch] = useState(false),
    [highStakes, setHighStakes] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [format, setFormat] = useState<"text" | "json">("text"),
    [jsonSchema, setJsonSchema] = useState(""),
    [required, setRequired] = useState(""),
    [config, setConfig] = useState<Awaited<
      ReturnType<typeof api.settings>
    > | null>(null),
    [dash, setDash] = useState<Dashboard | null>(null),
    [theme, setTheme] = useState<Theme>(readTheme);
  const chatEnd = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const session = state.sessions.find((s) => s.id === active);
  const liveRef = useRef<Live | null>(null);
  liveRef.current = live;
  async function refresh() {
    const data = await api.state();
    setState(data);
    setActive((a) =>
      data.sessions.some((s) => s.id === a) ? a : (data.sessions[0]?.id ?? ""),
    );
    return data;
  }
  async function run(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const message = (e as Error).message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      );
      if (message === "Stopped.") setNotice("Stopped.");
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  // System is resolved here rather than in a media query, so the stylesheet
  // defines each colour exactly once and the two token sets cannot drift.
  useEffect(() => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (prefersDark.matches ? "dark" : "light") : theme;
    };
    apply();
    try {
      localStorage.setItem("asgard:theme", theme);
    } catch {
      /* a theme that cannot be remembered still applies for this run */
    }
    if (theme !== "system") return;
    prefersDark.addEventListener("change", apply);
    return () => prefersDark.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    void run(async () => {
      await refresh();
      setConfig(await api.settings());
    });
  }, []);
  // Streaming progress for the request in flight. `done` only changes the
  // caption: `send` clears the live turn once the stored message has arrived.
  useEffect(
    () =>
      api.onStream((e: StreamEvent) => {
        setLive((prev) => {
          if (e.type === "done")
            return prev && { ...prev, stage: "Saving to memory" };
          const base: Live =
            prev && prev.sessionId === e.sessionId
              ? prev
              : { sessionId: e.sessionId, ...EMPTY_LIVE };
          if (e.type === "stage")
            return {
              ...base,
              ...EMPTY_LIVE,
              sessionId: base.sessionId,
              stage: e.stage,
              provider: e.provider ?? base.provider,
            };
          if (e.type === "tool")
            return { ...base, tools: [...base.tools, e.name].slice(-8) };
          if (e.type === "council") {
            const task = `${e.role} · round ${e.round}`;
            const delegates = base.delegates.some((d) => d.task === task)
              ? base.delegates.map((d) =>
                  d.task === task ? { ...d, done: d.done || e.done } : d,
                )
              : [...base.delegates, { task, done: e.done }];
            return { ...base, delegates: delegates.slice(-10) };
          }
          if (e.type === "delegated") {
            const delegates = base.delegates.some((d) => d.task === e.task)
              ? base.delegates.map((d) =>
                  d.task === e.task ? { ...d, done: d.done || e.done } : d,
                )
              : [...base.delegates, { task: e.task, done: e.done }];
            return { ...base, delegates: delegates.slice(-10) };
          }
          if (e.type === "thinking")
            return { ...base, thinking: base.thinking + e.text };
          return { ...base, text: base.text + e.text };
        });
      }),
    [],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewDialog(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMemoryOpen(true);
      }
      if (e.key === "Escape" && liveRef.current) void api.cancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // Follow the stream only while the reader is already at the bottom.
  useEffect(() => {
    if (!atBottom) return;
    const id = requestAnimationFrame(() =>
      chatEnd.current?.scrollIntoView({ block: "end" }),
    );
    return () => cancelAnimationFrame(id);
  }, [session?.messages.length, live?.text, live?.stage, atBottom]);
  useEffect(() => {
    if (screen === "dashboard")
      void run(async () => setDash(await api.dashboard()));
    if (screen === "settings")
      void run(async () => setConfig(await api.settings()));
  }, [screen]);
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text, screen, active]);
  async function newSession() {
    await run(async () => {
      if (session && !session.ended && session.messages.length)
        await api.endSession(session.id);
      const s = await api.newSession(project, privateNew);
      await refresh();
      setActive(s.id);
      setNewDialog(false);
      setScreen("chat");
      composer.current?.focus();
    });
  }
  async function send(override?: string) {
    const prompt = (override ?? text).trim();
    if (!prompt || busy) return;
    setAtBottom(true);
    await run(async () => {
      const schema = jsonSchema.trim() ? JSON.parse(jsonSchema) : undefined;
      let s = session;
      if (!s || s.ended) {
        s = await api.newSession(project, privateNew);
        setActive(s.id);
      }
      const ids = attached.filter((a) => a.included).map((a) => a.id);
      if (!override) setText("");
      setAttached([]);
      setLive({ sessionId: s.id, ...EMPTY_LIVE });
      try {
        const updated = await api.send({
          sessionId: s.id,
          text: prompt,
          route,
          deepResearch,
          highStakes,
          checks: {
            format,
            jsonSchema: schema,
            requiredText: required.split("\n").filter(Boolean),
          },
          attachmentIds: ids,
        });
        // The reply carries reasoning only on this one response object; stash
        // it before refresh() replaces the session with the stored copy.
        const reply = updated.messages.at(-1);
        if (reply?.role === "assistant" && reply.reasoning)
          setThoughts((t) => ({
            ...t,
            [updated.id + ":" + reply.at]: reply.reasoning as string,
          }));
      } finally {
        await refresh();
        setLive(null);
      }
    });
  }
  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const paths = files
      .map((f) => {
        try {
          return api.pathForFile(f);
        } catch {
          return "";
        }
      })
      .filter((p) => p.startsWith("/"));
    if (!paths.length) {
      setError(
        "Those items could not be read from disk. Drop files or folders from Finder.",
      );
      return;
    }
    await run(async () => accept(await api.attach(paths)));
  }
  function accept(added: Attachment[]) {
    setAttached((prev) => {
      const room = Math.max(0, 40 - prev.length);
      return [...prev, ...added.slice(0, room)];
    });
  }
  function removeAttachment(id: string) {
    setAttached((prev) => prev.filter((a) => a.id !== id));
    void api.releaseAttachments([id]).catch(() => {});
  }
  /** Branch the chat at one message into a new one, leaving this intact. */
  async function branch(index: number) {
    if (!session) return;
    await run(async () => {
      const forked = await api.forkSession(session.id, index);
      await refresh();
      setActive(forked.id);
      setNotice("Branched. The original chat is untouched.");
    });
  }
  /** The user turn that produced this assistant reply, for "Ask again". */
  function priorPrompt(index: number) {
    const messages = session?.messages ?? [];
    for (let i = index - 1; i >= 0; i--)
      if (messages[i].role === "user") return messages[i].content;
    return "";
  }
  const chats = useMemo(() => {
    const q = chatQuery.trim().toLowerCase();
    const matching = q
      ? state.sessions.filter((s) => s.title.toLowerCase().includes(q))
      : state.sessions;
    const groups: { label: string; items: Session[] }[] = [];
    for (const s of matching) {
      const label = dayLabel(s.date);
      const group = groups.find((g) => g.label === label);
      if (group) group.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  }, [state.sessions, chatQuery]);
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node))
        setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(false);
      void addFiles(e.dataTransfer.files);
    },
  };
  const composerBox = (
    <div className={"composer" + (dragging ? " dropping" : "")}>
      <AttachmentChips items={attached} onRemove={removeAttachment} />
      <textarea
        ref={composer}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="How can I help you today?"
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-left">
          <button
            className="ghost icon"
            aria-label="Attach files"
            title="Attach files or a folder"
            disabled={busy}
            onClick={() => void run(async () => accept(await api.pickFiles()))}
          >
            <Paperclip size={16} />
          </button>
          <select
            aria-label="Model"
            className="model-select"
            value={route}
            onChange={(e) => setRoute(e.target.value as Route)}
          >
            {ROUTES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            className={"ghost chipish" + (deepResearch ? " on" : "")}
            title="Deep research: the orchestrator answers and delegates bulk work to the worker model"
            onClick={() => setDeepResearch(!deepResearch)}
          >
            <Telescope size={14} /> Deep research
          </button>
          <button
            className={"ghost chipish" + (highStakes ? " on" : "")}
            title="Run an independent review before answering"
            onClick={() => setHighStakes(!highStakes)}
          >
            <ShieldCheck size={14} /> High stakes
          </button>
          <button
            className={"ghost chipish" + (advanced ? " on" : "")}
            title="Deterministic output checks"
            onClick={() => setAdvanced(!advanced)}
          >
            Checks
          </button>
        </div>
        {live ? (
          <button
            className="send stop"
            aria-label="Stop generating"
            title="Stop (Esc)"
            onClick={() => void api.cancel()}
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            className="send"
            aria-label="Send message"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
          >
            <ArrowUp size={17} />
          </button>
        )}
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
              placeholder={'{"type":"object","required":["result"]}'}
              value={jsonSchema}
              onChange={(e) => setJsonSchema(e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-top">
          <div className="brand">
            <Valknut />
            <strong>Asgard</strong>
          </div>
          <button
            className="new-chat"
            onClick={() => {
              setScreen("chat");
              setNewDialog(true);
            }}
          >
            <Plus size={15} /> New chat
          </button>
          <label className="rail-search">
            <Search size={13} />
            <input
              placeholder="Search chats"
              value={chatQuery}
              onChange={(e) => setChatQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="chats">
          {chats.map((group) => (
            <React.Fragment key={group.label}>
              <div className="chat-group">{group.label}</div>
              {group.items.map((s) => (
                <div
                  key={s.id}
                  className={
                    "chat-row " +
                    (active === s.id && screen === "chat" ? "current" : "")
                  }
                >
                  {renaming === s.id ? (
                    <input
                      autoFocus
                      className="rename"
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={() => setRenaming("")}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenaming("");
                        if (e.key === "Enter")
                          void run(async () => {
                            await api.renameSession(s.id, renameText);
                            setRenaming("");
                            await refresh();
                          });
                      }}
                    />
                  ) : (
                    <>
                      <button
                        className="chat-link"
                        onClick={() => {
                          setActive(s.id);
                          setScreen("chat");
                        }}
                        onDoubleClick={() => {
                          setRenaming(s.id);
                          setRenameText(s.title);
                        }}
                      >
                        {s.private && <LockKeyhole size={11} />}
                        <span>{s.title}</span>
                      </button>
                      <span className="chat-tools">
                        <button
                          aria-label="Rename chat"
                          title="Rename"
                          onClick={() => {
                            setRenaming(s.id);
                            setRenameText(s.title);
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          aria-label="Delete chat"
                          title="Delete chat and its transcript"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              if (
                                !window.confirm(
                                  `Delete “${s.title}” and its transcript? Memories it saved elsewhere are kept.`,
                                )
                              )
                                return;
                              await api.deleteSession(s.id);
                              await refresh();
                            })
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              ))}
            </React.Fragment>
          ))}
          {!state.sessions.length && (
            <p className="rail-empty">Your chats will appear here.</p>
          )}
        </div>
        <div className="rail-foot">
          <button onClick={() => setMemoryOpen(true)}>
            <Network size={15} /> Memory
            {!!state.proposals.length && (
              <span className="badge">{state.proposals.length}</span>
            )}
          </button>
          <button
            className={screen === "dashboard" ? "on" : ""}
            onClick={() => setScreen("dashboard")}
          >
            <BarChart3 size={15} /> Usage
          </button>
          <button
            className={screen === "settings" ? "on" : ""}
            onClick={() => setScreen("settings")}
          >
            <Settings2 size={15} /> Settings
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="title">
            {screen === "chat"
              ? (session?.title ?? "New chat")
              : screen === "settings"
                ? "Settings"
                : "Usage"}
            {screen === "chat" && session?.project && (
              <span className="project">{initials(session.project)}</span>
            )}
            {screen === "chat" && session?.private && (
              <span className="private-pill">
                <LockKeyhole size={11} /> Private · Claude only
              </span>
            )}
          </div>
          {screen === "chat" && (
            <div className="top-actions">
              {session && !session.ended && !!session.messages.length && (
                <button
                  className="ghost"
                  disabled={busy}
                  title="Summarise this chat into memory and close it"
                  onClick={() =>
                    void run(async () => {
                      await api.endSession(session.id);
                      await refresh();
                      setNotice(
                        "Chat compacted into memory. Decisions and rule proposals are ready.",
                      );
                    })
                  }
                >
                  <Layers3 size={15} /> Compact
                </button>
              )}
              <button
                className={"ghost" + (contextOpen ? " on" : "")}
                title="What went into the last request"
                onClick={() => setContextOpen(!contextOpen)}
              >
                <Layers3 size={15} /> Context
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="banner error">
            <TriangleAlert size={15} />
            <span>{error}</span>
            <button aria-label="Dismiss" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner">
            <Check size={15} />
            <span>{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {screen === "chat" ? (
          <div className="chat-area" {...dropHandlers}>
            {!session?.messages.length && !live ? (
              <div className="opening">
                <div className="greeting">
                  <Sparkles size={26} strokeWidth={1.4} />
                  <h1>How can I help you today?</h1>
                </div>
                <div className="opening-composer">{composerBox}</div>
                <div className="starters">
                  {[
                    ["Make a plan", "Help me make a plan for "],
                    [
                      "Search my memory",
                      "Search my memory and help me connect ",
                    ],
                    ["Remember this", "Remember this about me: "],
                  ].map(([label, prompt]) => (
                    <button
                      key={label}
                      onClick={() => {
                        setText(prompt);
                        composer.current?.focus();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {config && !config.keys.anthropic && (
                  <button
                    className="setup-link"
                    onClick={() => setScreen("settings")}
                  >
                    Add your Claude API key in Settings to begin
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  className="thread"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    setAtBottom(
                      el.scrollHeight - el.scrollTop - el.clientHeight < 90,
                    );
                  }}
                >
                  <div className="thread-inner">
                    {session?.compacted ? (
                      <div className="compaction-mark">
                        <span />
                        {session.compacted} earlier message
                        {session.compacted === 1 ? "" : "s"} compacted into
                        memory
                        <span />
                      </div>
                    ) : null}
                    {(session?.messages ?? []).map((m, i) =>
                      m.role === "user" ? (
                        <article key={i} className="turn user">
                          <div className="bubble">
                            <div className="text">{m.content}</div>
                            {m.attachments?.length ? (
                              <AttachmentChips items={m.attachments} />
                            ) : null}
                          </div>
                          <div className="turn-foot">
                            <time>{clock(m.at)}</time>
                            <TurnActions text={m.content} />
                          </div>
                        </article>
                      ) : (
                        <article key={i} className="turn assistant">
                          {(m.reasoning ??
                            thoughts[(session?.id ?? "") + ":" + m.at]) && (
                            <Thinking
                              text={
                                (m.reasoning ??
                                  thoughts[
                                    (session?.id ?? "") + ":" + m.at
                                  ]) as string
                              }
                            />
                          )}
                          <Markdown text={m.content} />
                          <div className="turn-foot">
                            {m.meta && <TurnMeta meta={m.meta} />}
                            <TurnActions
                              text={m.content}
                              onRetry={
                                busy
                                  ? undefined
                                  : () => void send(priorPrompt(i))
                              }
                              onBranch={busy ? undefined : () => void branch(i)}
                            />
                          </div>
                        </article>
                      ),
                    )}
                    {live && <LiveTurn live={live} />}
                    <div ref={chatEnd} />
                  </div>
                </div>
                {!atBottom && (
                  <button
                    className="scroll-bottom"
                    aria-label="Scroll to latest"
                    onClick={() => {
                      setAtBottom(true);
                      chatEnd.current?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    <ChevronsDown size={16} />
                  </button>
                )}
                <div className="dock">
                  <div className="dock-inner">
                    {!!state.proposals.length && (
                      <button
                        className="proposal-nudge"
                        onClick={() => setMemoryOpen(true)}
                      >
                        <Pin size={13} />
                        {state.proposals.length} memory rule
                        {state.proposals.length === 1 ? "" : "s"} awaiting your
                        approval
                        <ChevronRight size={13} />
                      </button>
                    )}
                    {composerBox}
                    <p className="dock-note">
                      {deepResearch
                        ? "Deep research — the orchestrator may delegate sub-tasks to the worker model."
                        : "Quick tier. Turn on deep research for the full mesh."}{" "}
                      · ↵ send · ⇧↵ newline · esc stop
                    </p>
                  </div>
                </div>
              </>
            )}
            {dragging && <div className="drop-veil">Drop to attach</div>}
          </div>
        ) : screen === "settings" ? (
          <SettingsView
            data={config}
            busy={busy}
            run={run}
            refresh={async () => setConfig(await api.settings())}
            notify={setNotice}
            theme={theme}
            setTheme={setTheme}
          />
        ) : (
          <DashboardView data={dash} config={config} />
        )}
      </main>
      {contextOpen && screen === "chat" && (
        <ContextDrawer
          session={session}
          nodes={state.nodes}
          onClose={() => setContextOpen(false)}
          onOpenMemory={() => {
            setContextOpen(false);
            setMemoryOpen(true);
          }}
        />
      )}
      {memoryOpen && (
        <MemoryModal
          state={state}
          busy={busy}
          run={run}
          refresh={refresh}
          notify={setNotice}
          onClose={() => setMemoryOpen(false)}
        />
      )}
      {newDialog && (
        <div className="modal-backdrop" onClick={() => setNewDialog(false)}>
          <section
            className="modal narrow"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <h2>New chat</h2>
              <button onClick={() => setNewDialog(false)} aria-label="Close">
                <X size={17} />
              </button>
            </div>
            <p className="muted">
              The current chat is compacted into memory before a new one starts.
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
              <LockKeyhole size={14} /> Private · Claude only
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void newSession()}
            >
              Start chat
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
/** The memory tree: Asgard's own reference surface, kept out of the chat. */
function MemoryModal({
  state,
  busy,
  run,
  refresh,
  notify,
  onClose,
}: {
  state: State;
  busy: boolean;
  run: (f: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<State>;
  notify: (s: string) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(new Set(["/", "/projects", "/rules"]));
  const [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<NodeWrite | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NodeSummary[]>([]);
  useEffect(() => {
    let current = true;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      api
        .search(query)
        .then((r) => current && setResults(r))
        .catch(() => undefined);
    }, 180);
    return () => {
      current = false;
      clearTimeout(id);
    };
  }, [query, state.nodes]);
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
              style={{ paddingLeft: 8 + depth * 15 }}
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
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )
                ) : (
                  <span className="tree-dot" />
                )}
              </span>
              {n.kind === "folder" ? (
                <Folder size={13} />
              ) : (
                <FileText size={12} />
              )}
              <span className="tree-title">{n.title}</span>
              {n.private ? (
                <LockKeyhole size={10} />
              ) : n.pinned ? (
                <Pin size={10} />
              ) : null}
              <small>{count(n.tokens)}</small>
            </button>
            {expanded && tree(nodes, n.path, depth + 1)}
          </React.Fragment>
        );
      });
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal memory" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <div>
            <h2>Memory</h2>
            <p className="muted">
              What Astro keeps and refers to. Chats write here automatically;
              rule changes wait for your approval.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        {!!state.proposals.length && (
          <div className="proposals">
            {state.proposals.map((p) => {
              const data = JSON.parse(p.payload);
              return (
                <div className="proposal" key={p.id}>
                  <div>
                    <strong>{data.title ?? p.action}</strong>
                    <small>{data.path}</small>
                    <p>{data.content ?? JSON.stringify(data)}</p>
                  </div>
                  <div className="proposal-actions">
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
          </div>
        )}
        <div className="memory-body">
          <div className="memory-tree">
            <label className="rail-search">
              <Search size={13} />
              <input
                placeholder="Search memories"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="tree">
              {query
                ? results.map((n) => (
                    <button
                      key={n.id}
                      className="tree-row"
                      onClick={() => void openNode(n.path)}
                    >
                      <FileText size={12} />
                      <span className="tree-title">{n.title}</span>
                      <small>{initials(n.path)}</small>
                    </button>
                  ))
                : tree(state.nodes, "/")}
            </div>
            <button
              className="ghost"
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
              <Plus size={14} /> New memory
            </button>
          </div>
          <div className="memory-editor">
            {!editor ? (
              <div className="memory-empty">
                <Network size={22} />
                <p>Pick a memory to read or edit it.</p>
                <small>
                  Rules load into every request. Everything else is retrieved
                  when it is relevant.
                </small>
              </div>
            ) : (
              <>
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
                  Summary <small>required · 1–5 lines</small>
                  <textarea
                    rows={2}
                    maxLength={1500}
                    value={editor.summary}
                    onChange={(e) =>
                      setEditor({ ...editor, summary: e.target.value })
                    }
                  />
                </label>
                <label className="grow">
                  Content
                  <textarea
                    value={editor.content}
                    onChange={(e) =>
                      setEditor({ ...editor, content: e.target.value })
                    }
                  />
                </label>
                <div className="editor-options">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={editor.pinned ?? false}
                      onChange={(e) =>
                        setEditor({ ...editor, pinned: e.target.checked })
                      }
                    />
                    <Pin size={12} /> Always load
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={editor.private ?? false}
                      onChange={(e) =>
                        setEditor({ ...editor, private: e.target.checked })
                      }
                    />
                    <LockKeyhole size={12} /> Private
                  </label>
                  <label>
                    Importance
                    <select
                      value={editor.importance ?? 1}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          importance: Number(e.target.value),
                        })
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
                          setSelected("");
                        })
                      }
                    >
                      <Archive size={13} /> Archive
                    </button>
                  )}
                  <span />
                  <button
                    className="primary"
                    disabled={busy || !editor.summary.trim()}
                    onClick={() =>
                      void run(async () => {
                        await api.write(editor);
                        await refresh();
                        notify(
                          editor.path.startsWith("/rules")
                            ? "Rule change proposed — approve it above."
                            : "Memory saved.",
                        );
                      })
                    }
                  >
                    Save memory
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
function ContextDrawer({
  session,
  nodes,
  onClose,
  onOpenMemory,
}: {
  session: Session | undefined;
  nodes: NodeSummary[];
  onClose: () => void;
  onOpenMemory: () => void;
}) {
  const [entry, setEntry] = useState<ContextEntry | null>(null);
  const total = session?.context.reduce((a, n) => a + n.tokens, 0) ?? 0;
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <strong>Context</strong>
        <button aria-label="Close context" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p className="drawer-note">
        What went into the last request. {count(total)} tokens across{" "}
        {session?.context.length ?? 0} memories.
      </p>
      {!session?.context.length && (
        <p className="drawer-empty">
          Send a message and the memories Astro loaded will be listed here.
        </p>
      )}
      {(["full", "summary"] as const).map((mode) => {
        const rows = session?.context.filter((n) => n.mode === mode) ?? [];
        if (!rows.length) return null;
        return (
          <React.Fragment key={mode}>
            <div className="drawer-label">
              {mode === "full" ? "Always loaded" : "Retrieved for this request"}
            </div>
            {rows.map((n) => (
              <button
                key={n.path}
                className="context-row"
                onClick={() => setEntry(entry?.path === n.path ? null : n)}
              >
                <FileText size={13} />
                <span>
                  {initials(n.path)}
                  <small>{n.path}</small>
                </span>
                <small>{count(n.tokens)}</small>
              </button>
            ))}
          </React.Fragment>
        );
      })}
      {entry && (
        <pre className="context-peek">{entry.content || "(empty node)"}</pre>
      )}
      {session?.project && (
        <>
          <div className="drawer-label">Project plan</div>
          <PlanView path={session.project + "/plan"} nodes={nodes} />
        </>
      )}
      <button className="ghost drawer-link" onClick={onOpenMemory}>
        <Network size={14} /> Open memory
      </button>
    </aside>
  );
}
function PlanView({ path, nodes }: { path: string; nodes: NodeSummary[] }) {
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
  if (!milestones.length)
    return <p className="drawer-empty">No milestones yet.</p>;
  return (
    <div className="plan-view">
      {milestones.map((m, i) => (
        <div className="milestone" key={i}>
          <span className={m.status === "complete" ? "done" : ""}>
            {m.status === "complete" ? <Check size={11} /> : i + 1}
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
    </div>
  );
}
/** One provider card in Settings. Claude is marked as the built-in default. */
const PROVIDER_CARDS = [
  {
    provider: "claude" as Provider,
    credential: "anthropic" as const,
    blurb: "Built in · every chat, and the only provider private chats may use",
    modelField: "anthropicModel" as const,
    models: [
      ["anthropicModel", "Deep research · thinks and decides"],
      ["anthropicQuickModel", "Quick · ordinary turns"],
      ["anthropicWorkerModel", "Worker · bulk sub-tasks, digests, compaction"],
    ] as [keyof Settings, string][],
    urlField: "anthropicBaseUrl" as const,
    priceField: "anthropicPrice" as const,
    prices: [
      ["anthropicPrice", "Deep"],
      ["anthropicQuickPrice", "Quick"],
      ["anthropicWorkerPrice", "Worker"],
    ] as [keyof Settings, string][],
    keyHint: "Enter Anthropic API key",
    note: "Quick (Sonnet) answers ordinary turns on its own. Switching on Deep research hands the turn to the orchestrator (Fable), which does the reasoning and decisions and pushes bulk reading, digests and compaction down to the worker (Opus). All three are Anthropic, so the mesh still runs inside a private chat.",
  },
  {
    provider: "chatgpt" as Provider,
    credential: "openai" as const,
    blurb: "The other chat · used when you pick it",
    modelField: "openaiModel" as const,
    urlField: "openaiBaseUrl" as const,
    priceField: "openaiPrice" as const,
    keyHint: "Enter OpenAI API key",
    note: "Auto never selects ChatGPT; choose it in the composer. Private chats stay on Claude.",
  },
  {
    provider: "gemini" as Provider,
    credential: "gemini" as const,
    blurb: "Optional cheap tier · routing & compaction",
    modelField: "geminiModel" as const,
    urlField: "geminiBaseUrl" as const,
    priceField: "geminiPrice" as const,
    keyHint: "Enter Google AI Studio API key",
    note: "With a key saved, easy turns and compaction may use Gemini. Leave it empty to keep everything on Claude.",
  },
  {
    provider: "deepseek" as Provider,
    credential: "deepseek" as const,
    blurb: "Optional · only used when you pick it",
    modelField: "deepseekModel" as const,
    urlField: "deepseekBaseUrl" as const,
    priceField: "deepseekPrice" as const,
    keyHint: "Enter DeepSeek API key",
    note: "Auto never selects DeepSeek, so you can leave it unconfigured.",
  },
];
function SettingsView({
  data,
  busy,
  run,
  refresh,
  notify,
  theme,
  setTheme,
}: {
  data: Awaited<ReturnType<typeof api.settings>> | null;
  busy: boolean;
  run: (f: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  const [values, setValues] = useState<Settings | null>(null),
    [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setValues(data.values);
  }, [data]);
  if (!values || !data) return <div className="page">Loading settings…</div>;
  // Which council seats are actually usable right now, mirroring the engine's
  // deny-first rule: a key must be saved and a model must resolve.
  const roleModel = (r: Role) =>
    r.model.trim() ||
    (r.provider === "claude"
      ? values.anthropicWorkerModel
      : r.provider === "chatgpt"
        ? values.openaiModel
        : r.provider === "gemini"
          ? values.geminiModel
          : values.deepseekModel);
  const seated = values.roles.filter(
    (r) =>
      r.council && data.keys[CREDENTIAL[r.provider]] && roleModel(r).trim(),
  );
  const vendors = [...new Set(seated.map((r) => r.provider))];
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
    <div className="page">
      <div className="page-inner">
        <h1>Settings</h1>
        <p className="page-intro">
          Claude is wired in as Astro’s reasoning layer. Add its key to begin,
          and connect the others whenever you want them. Keys are encrypted by
          your operating system and never returned to this screen.
        </p>
        <div className="settings-status">
          <ShieldCheck size={15} />
          {data.secureStorage
            ? "OS secure storage is available."
            : "OS secure storage is unavailable. Saving keys is disabled."}{" "}
          · Asgard build {__APP_VERSION__}
        </div>
        {PROVIDER_CARDS.map((card) => (
          <section className="card" key={card.provider}>
            <div className="card-heading">
              <h3>
                {PROVIDER_LABEL[card.provider]}
                {card.provider === "claude" && (
                  <em className="builtin">built in</em>
                )}
              </h3>
              <span className="connection">
                {data.keys[card.credential] ? "Key saved" : "Not connected"}
              </span>
            </div>
            <p className="muted">{card.blurb}</p>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={keys[card.credential] ?? ""}
                placeholder={
                  data.keys[card.credential]
                    ? "Saved securely · leave blank to keep"
                    : card.keyHint
                }
                onChange={(e) =>
                  setKeys({ ...keys, [card.credential]: e.target.value })
                }
              />
            </label>
            <div className="form-grid">
              {(card.models ?? [[card.modelField, "Model ID"]]).map(
                ([name, label]) => field(name as keyof Settings, label),
              )}
              {field(card.urlField, "API base URL")}
            </div>
            <p className="muted small">{card.note}</p>
            <button
              disabled={
                busy ||
                !data.keys[card.credential] ||
                !String(data.values[card.modelField]).trim()
              }
              onClick={() =>
                void run(async () => {
                  const r = await api.testProvider(card.provider);
                  notify(r.text + " Cached tokens: " + r.cachedTokens);
                })
              }
            >
              Test saved connection
            </button>
          </section>
        ))}
        <section className="card">
          <h3>Reasoning & budgets</h3>
          <p className="muted">
            Thinking is drawn from the same budget as the answer, so keep the
            output ceiling generous. Lower effort means faster, cheaper replies.
            Set delegated sub-tasks to 0 to turn the mesh off and let the
            orchestrator do everything itself.
          </p>
          <div className="form-grid">
            <label>
              Reasoning effort
              <select
                value={values.effort}
                onChange={(e) =>
                  setValues({ ...values, effort: e.target.value as any })
                }
              >
                {(["low", "medium", "high", "max"] as const).map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            {field("hardMaxTokens", "Claude max output tokens", "number")}
            {field(
              "delegationLimit",
              "Delegated sub-tasks per deep turn",
              "number",
            )}
            {field("easyMaxTokens", "Cheap-tier max output tokens", "number")}
            {field("compactionThreshold", "Compact chat at tokens", "number")}
            {field("toolOutputTokens", "Tool output token limit", "number")}
            {field("retrievalLimit", "Retrieved memories per turn", "number")}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={values.thinking}
              onChange={(e) =>
                setValues({ ...values, thinking: e.target.checked })
              }
            />{" "}
            Show the thought process (adaptive thinking, summarised)
          </label>
        </section>
        <section className="card">
          <h3>Appearance</h3>
          <p className="muted">
            Light is the default. System follows your operating system.
          </p>
          <div className="theme-picker">
            {(["light", "system", "dark"] as const).map((option) => (
              <button
                key={option}
                className={theme === option ? "on" : ""}
                onClick={() => setTheme(option)}
              >
                {option === "light" ? (
                  <Sun size={14} />
                ) : option === "dark" ? (
                  <Moon size={14} />
                ) : (
                  <Monitor size={14} />
                )}
                {option}
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>Subagents</h3>
          <p className="muted">
            Named roles the orchestrator can delegate to on a deep research
            turn. Each runs in a fresh context holding only the task it was
            given; a role marked for the council also takes part in a
            brainstorm. A role is offered only when its provider has a key, and
            a private chat drops every role that is not Claude.
          </p>
          <div
            className={"council-summary" + (vendors.length > 1 ? " ok" : "")}
          >
            {seated.length < 2 ? (
              <>
                <TriangleAlert size={14} />
                Not enough council seats are configured, so a council would seat
                the orchestrator against {seated[0]?.name ?? "itself"}. Add a
                key for another provider to get an independent view.
              </>
            ) : (
              <>
                {vendors.length > 1 ? (
                  <Check size={14} />
                ) : (
                  <TriangleAlert size={14} />
                )}
                Council seats:{" "}
                {seated
                  .slice(0, values.councilSeats)
                  .map((r) => `${r.name} (${PROVIDER_LABEL[r.provider]})`)
                  .join(" + ")}
                {vendors.length > 1
                  ? ` — ${vendors.length} vendors`
                  : " — one vendor only; agreement here is one model agreeing with itself"}
              </>
            )}
          </div>
          {values.roles.map((role, i) => (
            <div className="role-card" key={i}>
              <div className="role-head">
                <input
                  className="role-name"
                  value={role.name}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      roles: values.roles.map((r, j) =>
                        j === i ? { ...r, name: e.target.value } : r,
                      ),
                    })
                  }
                />
                <code>{role.id}</code>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={role.council}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        roles: values.roles.map((r, j) =>
                          j === i ? { ...r, council: e.target.checked } : r,
                        ),
                      })
                    }
                  />
                  Council
                </label>
                <button
                  aria-label={"Remove " + role.name}
                  title="Remove role"
                  onClick={() =>
                    setValues({
                      ...values,
                      roles: values.roles.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="form-grid">
                {(
                  [
                    ["provider", "Provider", PROVIDERS],
                    ["effort", "Effort", ["low", "medium", "high", "max"]],
                    ["context", "Context", ["isolated", "brief"]],
                    ["tools", "Tools", ["none", "read"]],
                  ] as const
                ).map(([field, label, options]) => (
                  <label key={field}>
                    {label}
                    <select
                      value={role[field]}
                      onChange={(e) =>
                        setValues({
                          ...values,
                          roles: values.roles.map((r, j) =>
                            j === i ? { ...r, [field]: e.target.value } : r,
                          ),
                        })
                      }
                    >
                      {options.map((o) => (
                        <option key={o} value={o}>
                          {field === "provider"
                            ? PROVIDER_LABEL[o as Provider]
                            : o}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  Model <small>blank = provider default</small>
                  <input
                    value={role.model}
                    placeholder={
                      role.provider === "claude"
                        ? values.anthropicWorkerModel
                        : "provider default"
                    }
                    onChange={(e) =>
                      setValues({
                        ...values,
                        roles: values.roles.map((r, j) =>
                          j === i ? { ...r, model: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Max output tokens
                  <input
                    type="number"
                    value={role.maxTokens}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        roles: values.roles.map((r, j) =>
                          j === i
                            ? { ...r, maxTokens: Number(e.target.value) }
                            : r,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Purpose <small>the orchestrator reads this when choosing</small>
                <textarea
                  rows={2}
                  value={role.purpose}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      roles: values.roles.map((r, j) =>
                        j === i ? { ...r, purpose: e.target.value } : r,
                      ),
                    })
                  }
                />
              </label>
            </div>
          ))}
          <div className="form-grid">
            {field("councilSeats", "Council seats", "number")}
            {field("councilRounds", "Council exchange rounds", "number")}
          </div>
          <button
            className="ghost"
            disabled={values.roles.length >= 8}
            onClick={() =>
              setValues({
                ...values,
                roles: [
                  ...values.roles,
                  {
                    id: "role-" + (values.roles.length + 1),
                    name: "New role",
                    purpose: "Describe when the orchestrator should use this.",
                    provider: "claude",
                    model: "",
                    effort: "medium",
                    context: "isolated",
                    tools: "none",
                    maxTokens: 4096,
                    council: false,
                  },
                ],
              })
            }
          >
            <Plus size={14} /> Add role
          </button>
        </section>
        <section className="card">
          <h3>Cost estimates</h3>
          <p className="muted">
            USD per million tokens. Claude ships with its published rates; enter
            your own for the rest. Zero means unconfigured, not free.
          </p>
          {PROVIDER_CARDS.flatMap((card) =>
            (
              card.prices ?? [[card.priceField, PROVIDER_LABEL[card.provider]]]
            ).map(([key, label]) => (
              <div key={key}>
                <h4>
                  {card.prices
                    ? PROVIDER_LABEL[card.provider] + " · " + label
                    : label}
                </h4>
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
                          value={(values[key as keyof Settings] as any)[name]}
                          onChange={(e) =>
                            setValues({
                              ...values,
                              [key]: {
                                ...(values[key as keyof Settings] as any),
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
            )),
          )}
        </section>
        <div className="save-settings">
          <p className="muted small">
            Requests go to the configured endpoints. Verify custom URLs before
            saving.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.saveSettings(values, {
                  anthropic: keys.anthropic || undefined,
                  openai: keys.openai || undefined,
                  deepseek: keys.deepseek || undefined,
                  gemini: keys.gemini || undefined,
                });
                setKeys({});
                await refresh();
                notify("Settings saved. Credentials stay encrypted here.");
              })
            }
          >
            Save settings <Check size={15} />
          </button>
        </div>
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
  const providers = useMemo(() => {
    const seen = new Set<string>(PROVIDERS);
    for (const r of data?.routes ?? []) seen.add(r.provider);
    return [...seen];
  }, [data]);
  if (!data) return <div className="page">Loading usage…</div>;
  const total = data.routes.reduce((s, r) => s + r.count, 0);
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Usage</h1>
        <p className="page-intro">
          Every model call Astro made, counted locally. Nothing is reported
          anywhere.
        </p>
        {config &&
          Object.values(config.values.anthropicPrice).every((v) => v === 0) && (
            <div className="banner">
              <TriangleAlert size={15} /> Configure provider prices in Settings
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
              "Answers needing escalation",
            ],
            [
              "Average latency",
              (data.latency / 1000).toFixed(1) + "s",
              "Across all calls",
            ],
          ].map(([label, value, sub]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{sub}</small>
            </div>
          ))}
        </div>
        <section className="card">
          <h3>Daily cost</h3>
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
                            130,
                        ),
                      }}
                    />
                    <span>{day.day.slice(5)}</span>
                  </div>
                ))
            ) : (
              <p className="muted">Your first call starts the story.</p>
            )}
          </div>
        </section>
        <section className="card">
          <h3>Model distribution</h3>
          {providers.map((p) => {
            const n = data.routes.find((r) => r.provider === p)?.count ?? 0;
            return (
              <div className="route-stat" key={p}>
                <div>
                  <span>{providerLabel(p)}</span>
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
        <section className="card">
          <h3>Recent calls</h3>
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
                    "Cost",
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
              <p className="muted">
                No calls yet. Add your Claude key in Settings and send a
                message.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
