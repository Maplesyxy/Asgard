import { z } from "zod";
export const Kind = z.enum([
  "folder",
  "rule",
  "fact",
  "decision",
  "plan",
  "session",
  "summary",
  "artifact",
]);
export const Path = z
  .string()
  .max(500)
  .regex(
    /^\/(?:[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)?$/u,
    "Use absolute tree paths containing letters, numbers, - or _.",
  );
export const WriteNode = z
  .object({
    path: Path,
    kind: Kind,
    title: z.string().min(1).max(200),
    content: z.string().max(500000),
    summary: z.string().trim().min(1).max(1500),
    pinned: z.boolean().optional(),
    private: z.boolean().optional(),
    importance: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type NodeWrite = z.infer<typeof WriteNode>;
export interface TreeNode {
  id: string;
  parent_id: string | null;
  path: string;
  kind: z.infer<typeof Kind>;
  title: string;
  content: string;
  summary: string;
  tokens: number;
  pinned: number;
  private: number;
  importance: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}
export type NodeSummary = Omit<TreeNode, "content">;
/**
 * A named subagent. Roles are data, not code: the orchestrator picks one by id
 * when it delegates, and every one of them is editable in Settings.
 *
 * `context` follows the two subagent context modes: `isolated` gives a fresh
 * window holding only the task (so a verifier or a brainstorm partner is never
 * anchored by the orchestrator's reasoning), `brief` adds the conversation's
 * compacted summary for continuation work. Neither ever receives the raw
 * transcript -- a subagent must not be able to inflate the parent's context.
 *
 * `tools` is deny-first: `none` is a pure text worker, `read` adds the
 * read-only memory tools. A role can never hold a capability the orchestrator
 * does not already have, and a role whose provider is not PRIVATE_SAFE is
 * unavailable in a private chat.
 */
export const RoleSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a lowercase id, e.g. verifier."),
    name: z.string().trim().min(1).max(60),
    purpose: z.string().trim().min(1).max(300),
    provider: z.enum(["claude", "chatgpt", "gemini", "deepseek"]),
    /** Empty means the provider's configured model (worker tier for Claude). */
    model: z.string().trim().max(150),
    effort: z.enum(["low", "medium", "high", "max"]),
    context: z.enum(["isolated", "brief"]),
    tools: z.enum(["none", "read"]),
    maxTokens: z.number().int().min(256).max(32000),
    /** Takes part in a council round when the orchestrator calls one. */
    council: z.boolean(),
  })
  .strict();
export type Role = z.infer<typeof RoleSchema>;
/**
 * Claude roles get 8192 output tokens: the worker tier is a thinking model
 * now, and adaptive thinking is drawn from the same budget as the answer.
 */
export const DEFAULT_ROLES: Role[] = [
  {
    id: "worker",
    name: "Worker",
    purpose:
      "Bulk reading, extraction, filtering and summarising over material the orchestrator supplies.",
    provider: "claude",
    model: "",
    effort: "medium",
    context: "isolated",
    tools: "none",
    maxTokens: 8192,
    council: false,
  },
  {
    id: "verifier",
    name: "Verifier",
    purpose:
      "Independently check a claim, result or answer. Runs with no knowledge of the orchestrator's reasoning so it cannot be anchored by it.",
    provider: "claude",
    model: "",
    effort: "high",
    context: "isolated",
    tools: "none",
    maxTokens: 8192,
    council: false,
  },
  {
    id: "critic",
    name: "Critic",
    purpose:
      "Adversarial second view in a council: argues the strongest case against the current direction.",
    provider: "claude",
    model: "",
    effort: "high",
    context: "isolated",
    tools: "read",
    maxTokens: 8192,
    council: true,
  },
  {
    id: "strategist",
    name: "Strategist",
    purpose:
      "A second opinion from a different vendor in a council: frames the problem independently before seeing anyone else's view.",
    provider: "chatgpt",
    model: "",
    effort: "high",
    context: "isolated",
    tools: "none",
    maxTokens: 4096,
    council: true,
  },
  {
    id: "analyst",
    name: "Analyst",
    purpose:
      "A third vendor in a council: reads the question literally and says what the evidence actually supports, without elaborating.",
    provider: "gemini",
    model: "",
    effort: "medium",
    context: "isolated",
    tools: "none",
    maxTokens: 4096,
    council: true,
  },
  {
    id: "contrarian",
    name: "Contrarian",
    purpose:
      "A fourth vendor in a council: argues the position the others are least likely to take, and names what would have to be true for it to win.",
    provider: "deepseek",
    model: "",
    effort: "high",
    context: "isolated",
    tools: "none",
    maxTokens: 4096,
    council: true,
  },
];
const Price = z
  .object({
    input: z.number().min(0).max(10000),
    cached: z.number().min(0).max(10000),
    cacheWrite: z.number().min(0).max(10000),
    output: z.number().min(0).max(10000),
  })
  .strict();
const endpoint = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    );
  }, "Use HTTPS (or HTTP on localhost), without credentials or query parameters.");
export const SettingsSchema = z
  .object({
    /** Orchestrator: deep research turns, escalation and final answers (Fable 5.1). */
    anthropicModel: z.string().trim().min(1).max(150),
    /** Quick tier: ordinary turns when deep research is off (Sonnet 5). */
    anthropicQuickModel: z.string().trim().min(1).max(150),
    /** Worker tier: delegated sub-tasks, digests and compaction (Opus 5). */
    anthropicWorkerModel: z.string().trim().min(1).max(150),
    anthropicBaseUrl: endpoint,
    openaiModel: z.string().trim().max(150),
    openaiBaseUrl: endpoint,
    deepseekModel: z.string().trim().max(150),
    deepseekBaseUrl: endpoint,
    geminiModel: z.string().trim().max(150),
    geminiBaseUrl: endpoint,
    easyMaxTokens: z.number().int().min(256).max(32000),
    hardMaxTokens: z.number().int().min(2048).max(64000),
    compactionThreshold: z.number().int().min(2000).max(200000),
    toolOutputTokens: z.number().int().min(256).max(8000),
    retrievalLimit: z.number().int().min(1).max(30),
    thinking: z.boolean(),
    effort: z.enum(["low", "medium", "high", "max"]),
    /** Sub-tasks one deep-research turn may delegate. 0 disables delegation. */
    delegationLimit: z.number().int().min(0).max(12),
    /** Named subagents the orchestrator may delegate to. */
    roles: z.array(RoleSchema).max(8),
    /** Exchange rounds in a council: 1 is independent views only. */
    councilRounds: z.number().int().min(1).max(3),
    /** How many participants a council seats. Seats go to distinct vendors first. */
    councilSeats: z.number().int().min(2).max(5),
    anthropicPrice: Price,
    anthropicQuickPrice: Price,
    anthropicWorkerPrice: Price,
    openaiPrice: Price,
    deepseekPrice: Price,
    geminiPrice: Price,
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
/**
 * Claude is the built-in reasoning layer: the model id, endpoint and published
 * per-million rates ship configured so a fresh install only needs a key. Every
 * value here stays editable in Settings.
 */
export const DEFAULT_SETTINGS: Settings = {
  // Fable 5.1 thinks and decides: deep research, escalation, final answers.
  // Sonnet 5 answers ordinary turns. Opus 5 does the bulk work the
  // orchestrator hands down -- delegated sub-tasks, digests, compaction.
  anthropicModel: "claude-fable-5-1",
  anthropicQuickModel: "claude-sonnet-5",
  anthropicWorkerModel: "claude-opus-5",
  anthropicBaseUrl: "https://api.anthropic.com",
  openaiModel: "gpt-4o",
  openaiBaseUrl: "https://api.openai.com/v1",
  deepseekModel: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  geminiModel: "gemini-2.5-flash",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  easyMaxTokens: 4096,
  // Adaptive thinking draws from the same output budget as the answer, so a
  // small ceiling makes Claude spend everything on reasoning and return no
  // text at all. Streaming means a large ceiling costs nothing up front.
  hardMaxTokens: 32000,
  compactionThreshold: 40000,
  toolOutputTokens: 2000,
  retrievalLimit: 8,
  thinking: true,
  effort: "medium",
  delegationLimit: 6,
  roles: DEFAULT_ROLES,
  councilRounds: 2,
  councilSeats: 3,
  // Published per-million rates: Fable 5.1, Sonnet 5 and Opus 5. Cache writes
  // are 1.25x input; cache reads are a tenth of input, except Fable 5.1 where
  // they are $0.25 (a fortieth).
  anthropicPrice: { input: 10, cached: 0.25, cacheWrite: 12.5, output: 50 },
  anthropicQuickPrice: { input: 2, cached: 0.2, cacheWrite: 2.5, output: 10 },
  anthropicWorkerPrice: { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  openaiPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
  deepseekPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
  geminiPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
};
/** Model ids that pre-date `claude-opus-5` in this app's own defaults. */
export const RETIRED_ANTHROPIC_MODELS = ["claude-opus-5-5"];
/**
 * Values this app shipped as defaults and has since replaced. A stored config
 * still holding one of them is carrying an old default rather than a choice,
 * so it is migrated on read; anything else the user set is left alone.
 */
export const RETIRED_DEFAULTS: Partial<Record<keyof Settings, unknown[]>> = {
  hardMaxTokens: [8192],
  easyMaxTokens: [2048],
  effort: ["high"],
  // Opus 5 used to orchestrate. A config still holding it is carrying the old
  // default, so the orchestrator moves to Fable 5.1 along with its price
  // table. The worker is deliberately not migrated: a stored Haiku worker is
  // cheaper than the new Opus default and may well be a choice.
  anthropicModel: ["claude-opus-5"],
  // The first release shipped an all-zero Anthropic price table, which made
  // every Claude call show as free on the dashboard; the next shipped Opus 5
  // rates for the orchestrator.
  anthropicPrice: [
    { input: 0, cached: 0, cacheWrite: 0, output: 0 },
    { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  ],
};
export type Provider = "claude" | "chatgpt" | "gemini" | "deepseek";
/**
 * Which Claude model a call runs on. `deep` orchestrates and writes final
 * answers, `quick` handles ordinary turns, `worker` runs delegated sub-tasks,
 * digests and compaction. All three are Anthropic, so the mesh keeps working
 * inside a private chat where no other provider is allowed.
 */
export type Tier = "deep" | "quick" | "worker";
export const TIER_LABEL: Record<Tier, string> = {
  deep: "Deep",
  quick: "Quick",
  worker: "Worker",
};
/** Claude models offered in Settings; any other id can be typed in. */
export const CLAUDE_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];
export const PROVIDERS: Provider[] = [
  "claude",
  "chatgpt",
  "gemini",
  "deepseek",
];
export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
};
/** Credential slot name in the encrypted settings envelope, per provider. */
export const CREDENTIAL: Record<
  Provider,
  "anthropic" | "openai" | "deepseek" | "gemini"
> = {
  claude: "anthropic",
  chatgpt: "openai",
  deepseek: "deepseek",
  gemini: "gemini",
};
/** Providers that may receive text from a session marked private. */
export const PRIVATE_SAFE: Provider[] = ["claude"];
/**
 * Providers auto routing is allowed to pick. ChatGPT and DeepSeek are reachable
 * only when the user explicitly selects them in the composer.
 */
export const AUTO_ROUTED: Provider[] = ["claude", "gemini"];
export const Checks = z
  .object({
    format: z.enum(["text", "json"]).default("text"),
    jsonSchema: z.record(z.unknown()).optional(),
    requiredText: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();
export type Checks = z.infer<typeof Checks>;
/**
 * A user-dropped file, folder entry or zip member after main has read and
 * decoded it. The extracted text never crosses to the renderer: the renderer
 * holds only these descriptors and echoes `id` back on send. `kind` tells the
 * interface whether it became text, an image or a PDF document block.
 */
export interface Attachment {
  id: string;
  name: string;
  label: string;
  bytes: number;
  kind: "text" | "image" | "pdf";
  included: boolean;
  reason?: string;
  truncated: boolean;
}
export const SendSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(150000),
  route: z.enum(["auto", "claude", "chatgpt", "gemini", "deepseek"]),
  /**
   * Deep research: the orchestrator model answers and may delegate sub-tasks
   * to the worker tier. Off, an ordinary turn runs on the quick tier alone.
   */
  deepResearch: z.boolean().default(false),
  highStakes: z.boolean(),
  checks: Checks,
  attachmentIds: z.array(z.string().uuid()).max(40).default([]),
});
/** Parsed request as main sees it, with schema defaults applied. */
export type SendRequest = z.infer<typeof SendSchema>;
/** Request as a caller supplies it; fields with schema defaults are optional. */
export type SendInput = z.input<typeof SendSchema>;
/**
 * Incremental progress for the request in flight. Emitted from main to the one
 * trusted renderer frame while `send` is pending; never stored.
 */
export type StreamEvent =
  | { sessionId: string; type: "text" | "thinking"; text: string }
  | { sessionId: string; type: "stage"; stage: string; provider?: Provider }
  | { sessionId: string; type: "tool"; name: string }
  | { sessionId: string; type: "delegated"; task: string; done: boolean }
  | {
      sessionId: string;
      type: "council";
      role: string;
      round: number;
      done: boolean;
    }
  | { sessionId: string; type: "done" };
export interface Message {
  role: "user" | "assistant";
  content: string;
  at: string;
  /**
   * Provider thinking/reasoning for the most recent reply, in memory only.
   * `Store.saveSession` strips this before writing the transcript, so it is
   * never persisted and never replayed back to a provider.
   */
  reasoning?: string;
  attachments?: Attachment[];
  meta?: {
    model: string;
    provider: Provider;
    tier?: Tier;
    /** Sub-tasks delegated to subagents for this answer. */
    delegated?: number;
    /** Roles that took part in a council for this answer. */
    council?: string[];
    tokens: number;
    cost: number;
    verified: boolean;
    issues: string[];
    reason: string;
    escalated: boolean;
  };
}
export interface Session {
  id: string;
  date: string;
  title: string;
  project: string;
  private: boolean;
  ended: boolean;
  messages: Message[];
  compacted: number;
  context: ContextEntry[];
}
export interface ContextEntry {
  path: string;
  mode: "full" | "summary";
  tokens: number;
  private: boolean;
  content: string;
}
export interface Proposal {
  id: string;
  action: string;
  payload: string;
  created_at: string;
}
export interface CallRecord {
  id?: string;
  timestamp?: string;
  session: string;
  model: string;
  provider: Provider;
  tier: string;
  reason: string;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number;
  latency: number;
  verification: string;
  escalated: number;
}
export interface Dashboard {
  calls: number;
  cost: number;
  input: number;
  cached: number;
  output: number;
  latency: number;
  escalationRate: number;
  cacheRate: number;
  routes: { provider: string; count: number }[];
  days: { day: string; cost: number; calls: number }[];
  recent: CallRecord[];
}
export interface State {
  nodes: NodeSummary[];
  sessions: Session[];
  proposals: Proposal[];
}
export type KeyPresence = Record<
  "anthropic" | "openai" | "deepseek" | "gemini",
  boolean
>;
export interface API {
  state(): Promise<State>;
  read(path: string): Promise<TreeNode>;
  search(query: string): Promise<NodeSummary[]>;
  write(node: NodeWrite): Promise<void>;
  move(path: string, parent: string): Promise<void>;
  archive(path: string): Promise<void>;
  settings(): Promise<{
    values: Settings;
    keys: KeyPresence;
    secureStorage: boolean;
  }>;
  saveSettings(
    values: Settings,
    keys: Partial<Record<keyof KeyPresence, string>>,
  ): Promise<void>;
  newSession(project: string, isPrivate: boolean): Promise<Session>;
  setPrivate(id: string, value: boolean): Promise<void>;
  send(req: SendInput): Promise<Session>;
  /** Abort the request in flight. Resolves whether or not one was running. */
  cancel(): Promise<void>;
  endSession(id: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  /** Branch a chat at a message index; returns the new session. */
  forkSession(id: string, upTo: number): Promise<Session>;
  decide(id: string, accept: boolean): Promise<void>;
  dashboard(): Promise<Dashboard>;
  testProvider(
    provider: Provider,
  ): Promise<{ text: string; cachedTokens: number }>;
  /** Resolve a dropped/pasted File to its absolute path (Electron webUtils). */
  pathForFile(file: File): string;
  /** Open the OS file picker and read whatever the user chooses. */
  pickFiles(): Promise<Attachment[]>;
  /** Read dropped paths in main; folders are walked and .zip members expanded. */
  attach(paths: string[]): Promise<Attachment[]>;
  releaseAttachments(ids: string[]): Promise<void>;
  /** Subscribe to streaming progress. Returns an unsubscribe function. */
  onStream(listener: (event: StreamEvent) => void): () => void;
}
declare global {
  interface Window {
    asgard: API;
  }
}
