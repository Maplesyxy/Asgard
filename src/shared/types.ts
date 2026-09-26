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
    anthropicModel: z.string().trim().min(1).max(150),
    anthropicBaseUrl: endpoint,
    deepseekModel: z.string().trim().max(150),
    deepseekBaseUrl: endpoint,
    easyMaxTokens: z.number().int().min(256).max(32000),
    hardMaxTokens: z.number().int().min(2048).max(64000),
    compactionThreshold: z.number().int().min(2000).max(200000),
    toolOutputTokens: z.number().int().min(256).max(8000),
    retrievalLimit: z.number().int().min(1).max(30),
    thinking: z.boolean(),
    anthropicPrice: Price,
    deepseekPrice: Price,
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  anthropicModel: "claude-opus-5-5",
  anthropicBaseUrl: "https://api.anthropic.com",
  deepseekModel: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  easyMaxTokens: 2048,
  hardMaxTokens: 8192,
  compactionThreshold: 40000,
  toolOutputTokens: 2000,
  retrievalLimit: 8,
  thinking: false,
  anthropicPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
  deepseekPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
};
export type Provider = "deepseek" | "opus";
export const Checks = z
  .object({
    format: z.enum(["text", "json"]).default("text"),
    jsonSchema: z.record(z.unknown()).optional(),
    requiredText: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();
export type Checks = z.infer<typeof Checks>;
export const SendSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(150000),
  route: z.enum(["auto", "deepseek", "opus"]),
  highStakes: z.boolean(),
  checks: Checks,
});
export type SendRequest = z.infer<typeof SendSchema>;
export interface Message {
  role: "user" | "assistant";
  content: string;
  at: string;
  meta?: {
    model: string;
    provider: Provider;
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
export interface API {
  state(): Promise<State>;
  read(path: string): Promise<TreeNode>;
  search(query: string): Promise<NodeSummary[]>;
  write(node: NodeWrite): Promise<void>;
  move(path: string, parent: string): Promise<void>;
  archive(path: string): Promise<void>;
  settings(): Promise<{
    values: Settings;
    keys: { anthropic: boolean; deepseek: boolean };
    secureStorage: boolean;
  }>;
  saveSettings(
    values: Settings,
    keys: { anthropic?: string; deepseek?: string },
  ): Promise<void>;
  newSession(project: string, isPrivate: boolean): Promise<Session>;
  setPrivate(id: string, value: boolean): Promise<void>;
  send(req: SendRequest): Promise<Session>;
  endSession(id: string): Promise<Session>;
  decide(id: string, accept: boolean): Promise<void>;
  dashboard(): Promise<Dashboard>;
  testProvider(
    provider: Provider,
  ): Promise<{ text: string; cachedTokens: number }>;
}
declare global {
  interface Window {
    asgard: API;
  }
}
