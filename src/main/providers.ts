import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  CREDENTIAL,
  PROVIDER_LABEL,
  Provider,
  Settings,
  Tier,
} from "../shared/types";
import { SettingsStore } from "./settings";
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}
/**
 * A non-text attachment carried on exactly one request. Transports translate it
 * into the provider's own content-block shape; it is never part of the stored
 * transcript and is never replayed on later turns.
 */
export interface MediaPart {
  kind: "image" | "pdf";
  mediaType: string;
  data: string;
  label: string;
}
/** A provider-neutral message. `media` is expanded by the transport. */
export interface WireMessage {
  role: string;
  content: any;
  media?: MediaPart[];
  /**
   * Put a cache breakpoint at the end of this message. It belongs on the last
   * block that stays byte-identical across requests -- the end of the settled
   * conversation -- never on anything regenerated per turn.
   */
  cache?: boolean;
  [key: string]: unknown;
}
export type Delta = { type: "text" | "thinking"; text: string };
export interface ModelRequest {
  provider: Provider;
  /** Which Claude model to use. Ignored by the other providers. */
  tier?: Tier;
  /** Exact model id, overriding the tier or the provider default. */
  model?: string;
  /** Reasoning effort for this one call, overriding the setting. */
  effort?: Settings["effort"];
  system: string;
  messages: WireMessage[];
  tools?: ToolDefinition[];
  maxTokens: number;
  thinking?: boolean;
  purpose: string;
  /** Called with incremental output. Its presence turns on streaming. */
  onDelta?: (d: Delta) => void;
  signal?: AbortSignal;
}
export interface ModelReply {
  text: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  wire: any;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  model: string;
  truncated?: boolean;
  /**
   * Set when the provider's safety classifier declined the request
   * (`stop_reason: "refusal"` on Fable 5.1 and Opus 5). The reply's text is a
   * notice saying so; callers must not retry, escalate or raise the budget.
   */
  refused?: string;
  /**
   * Provider thinking / reasoning text for this reply. Held in memory so the
   * interface can show it; never written to SQLite and never sent back to a
   * provider. See AGENTS.md ("Never persist provider thinking blocks").
   */
  reasoning?: string;
}
export interface Transport {
  complete(req: ModelRequest): Promise<ModelReply>;
}
export class ProviderError extends Error {
  constructor(public status: number) {
    super(
      status === 401 || status === 403
        ? "Provider rejected the credentials. Check Settings."
        : status === 404
          ? "Configured model or endpoint was not found. Check Settings."
          : status === 429
            ? "Provider rate limit reached. Try again shortly."
            : "Provider request failed. Check the endpoint, model and connection.",
    );
  }
}
export class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}
/** Model id and endpoint for the three OpenAI-compatible providers. */
export function openAICompatible(
  provider: "chatgpt" | "gemini" | "deepseek",
  s: Settings,
): { model: string; baseURL: string; label: string } {
  const table = {
    chatgpt: { model: s.openaiModel, baseURL: s.openaiBaseUrl },
    gemini: { model: s.geminiModel, baseURL: s.geminiBaseUrl },
    deepseek: { model: s.deepseekModel, baseURL: s.deepseekBaseUrl },
  } as const;
  return { ...table[provider], label: PROVIDER_LABEL[provider] };
}
/** The configured model id for a provider and, for Claude, a tier. */
export function modelFor(provider: Provider, s: Settings, tier: Tier = "deep") {
  if (provider !== "claude") return openAICompatible(provider, s).model;
  return tier === "quick"
    ? s.anthropicQuickModel
    : tier === "worker"
      ? s.anthropicWorkerModel
      : s.anthropicModel;
}
export function priceFor(provider: Provider, s: Settings, tier: Tier = "deep") {
  if (provider === "claude")
    return tier === "quick"
      ? s.anthropicQuickPrice
      : tier === "worker"
        ? s.anthropicWorkerPrice
        : s.anthropicPrice;
  return provider === "chatgpt"
    ? s.openaiPrice
    : provider === "gemini"
      ? s.geminiPrice
      : s.deepseekPrice;
}
/**
 * Price table for an explicit model id: a Claude model is matched back to the
 * tier it belongs to, so a role running on Haiku is never billed at Opus rates.
 */
export function priceForModel(provider: Provider, s: Settings, model: string) {
  if (provider !== "claude" || !model) return priceFor(provider, s);
  const tier: Tier =
    model === s.anthropicQuickModel
      ? "quick"
      : model === s.anthropicModel
        ? "deep"
        : "worker";
  return priceFor(provider, s, tier);
}
/**
 * Haiku 4.5 predates adaptive thinking and rejects `output_config.effort`, so
 * the worker tier sends neither. Sending them would 400 the whole sub-task.
 */
const takesAdaptiveThinking = (model: string) => !/haiku/i.test(model);
const dataUrl = (m: MediaPart) => `data:${m.mediaType};base64,${m.data}`;
/**
 * Mark the end of a message as a cache breakpoint by attaching cache_control
 * to its final content block, promoting a plain string to a block first.
 */
function withBreakpoint(m: Record<string, any>) {
  const blocks =
    typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : [...(m.content ?? [])];
  if (!blocks.length) return m;
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral" },
  };
  return { ...m, content: blocks };
}
/** Expand `media` into Anthropic image/document blocks ahead of the text. */
function anthropicMessages(messages: WireMessage[]) {
  return messages.map(({ media, cache, ...m }) => {
    const mark = (x: Record<string, any>) => (cache ? withBreakpoint(x) : x);
    if (!media?.length) return mark(m);
    const blocks: any[] = media.map((part) =>
      part.kind === "image"
        ? {
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType,
              data: part.data,
            },
          }
        : {
            type: "document",
            title: part.label.slice(0, 200),
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: part.data,
            },
          },
    );
    return mark({
      ...m,
      content: [
        ...blocks,
        ...(typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content ?? [])),
      ],
    });
  });
}
/**
 * Expand `media` into OpenAI-compatible content parts. Only ChatGPT accepts
 * PDF file parts; on the other OpenAI-compatible endpoints a PDF is named in
 * the text instead of being dropped silently.
 */
function openAIMessages(messages: WireMessage[], provider: Provider) {
  // The OpenAI-compatible endpoints cache automatically; the breakpoint flag
  // is Anthropic-only and is simply dropped here.
  return messages.map(({ media, cache: _cache, ...m }) => {
    if (!media?.length) return m;
    const parts: any[] = [];
    const notes: string[] = [];
    for (const part of media) {
      if (part.kind === "image")
        parts.push({ type: "image_url", image_url: { url: dataUrl(part) } });
      else if (provider === "chatgpt")
        parts.push({
          type: "file",
          file: {
            filename: part.label.slice(0, 200),
            file_data: dataUrl(part),
          },
        });
      else
        notes.push(
          `[PDF attachment "${part.label}" cannot be read by ${PROVIDER_LABEL[provider]}. Ask the user to switch to Claude.]`,
        );
    }
    const text = [
      ...(typeof m.content === "string" && m.content ? [m.content] : []),
      ...notes,
    ].join("\n");
    return {
      ...m,
      content: [...parts, ...(text ? [{ type: "text", text }] : [])],
    };
  });
}
export class Clients implements Transport {
  constructor(
    private settings: SettingsStore,
    private fetcher?: typeof fetch,
  ) {}
  async complete(r: ModelRequest): Promise<ModelReply> {
    const s = this.settings.get();
    try {
      if (r.provider === "claude") return await this.anthropic(r, s);
      return await this.openAI(r, s);
    } catch (e) {
      if (e instanceof ProviderError || e instanceof Stopped) throw e;
      if (r.signal?.aborted) throw new Stopped();
      if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError)
        throw new ProviderError(e.status ?? 0);
      if (
        e instanceof Error &&
        (e.message.startsWith("Enter ") || e.message.startsWith("Unlock "))
      )
        throw e;
      throw new ProviderError(0);
    }
  }
  /** Anthropic: the built-in reasoning layer. */
  private async anthropic(r: ModelRequest, s: Settings): Promise<ModelReply> {
    const client = new Anthropic({
      apiKey: this.settings.key("anthropic"),
      baseURL: s.anthropicBaseUrl,
      maxRetries: 0,
      fetch: this.fetcher,
      timeout: 600000,
    });
    const model = r.model?.trim() || modelFor("claude", s, r.tier);
    const modern = takesAdaptiveThinking(model);
    const params = {
      model,
      max_tokens: r.maxTokens,
      system: [
        { type: "text", text: r.system, cache_control: { type: "ephemeral" } },
      ],
      messages: anthropicMessages(r.messages),
      ...(modern ? { output_config: { effort: r.effort ?? s.effort } } : {}),
      tools: r.tools?.map((t, i) => ({
        ...t,
        ...(i === r.tools!.length - 1
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      })),
      // Adaptive thinking: Claude decides its own depth. `display:"summarized"`
      // is what makes the reasoning layer visible at all -- the default omits
      // it. Thinking off simply omits the parameter rather than disabling it.
      ...(r.thinking && modern
        ? { thinking: { type: "adaptive", display: "summarized" } }
        : {}),
    } as any;
    let result: Anthropic.Message;
    if (r.onDelta) {
      const stream = client.messages.stream(params, { signal: r.signal });
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta")
          r.onDelta({ type: "text", text: event.delta.text });
        else if (event.delta.type === "thinking_delta")
          r.onDelta({ type: "thinking", text: event.delta.thinking });
      }
      result = await stream.finalMessage();
    } else {
      result = await client.messages.create(params, { signal: r.signal });
    }
    const thinking = result.content
      .filter((b) => b.type === "thinking")
      .map((b) => (b as any).thinking as string)
      .filter((t) => typeof t === "string" && t.trim());
    const redacted = result.content.filter(
      (b) => b.type === "redacted_thinking",
    ).length;
    // Fable 5.1 and Opus 5 can decline a request outright: HTTP 200, no text,
    // stop_reason "refusal" and a stop_details category. Without this the
    // empty reply looks like a budget problem and the engine retries it with
    // three times the tokens, then escalates.
    const details = (result as any).stop_details as
      { category?: string | null; explanation?: string | null } | undefined;
    const refused =
      (result.stop_reason as string) === "refusal"
        ? [
            "Claude declined this request",
            details?.category ? ` (${details.category})` : "",
            ".",
            details?.explanation ? " " + details.explanation : "",
          ].join("")
        : undefined;
    const text =
      result.content
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text)
        .join("\n") ||
      refused ||
      "";
    return {
      ...(refused ? { refused } : {}),
      reasoning:
        [
          ...thinking,
          ...(redacted
            ? [
                `[${redacted} reasoning block(s) were encrypted by the provider and cannot be displayed.]`,
              ]
            : []),
        ]
          .join("\n\n")
          .trim() || undefined,
      text,
      toolCalls: result.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: (b as any).id,
          name: (b as any).name,
          input: (b as any).input,
        })),
      // An assistant message must carry content, so a refusal that produced
      // none is replayed as its notice.
      wire: {
        role: "assistant",
        content: result.content.length
          ? result.content
          : [{ type: "text", text }],
      },
      model: result.model,
      input:
        result.usage.input_tokens +
        (result.usage.cache_read_input_tokens ?? 0) +
        (result.usage.cache_creation_input_tokens ?? 0),
      cached: result.usage.cache_read_input_tokens ?? 0,
      cacheWrite: result.usage.cache_creation_input_tokens ?? 0,
      output: result.usage.output_tokens,
      truncated: result.stop_reason === "max_tokens",
    };
  }
  /** ChatGPT, Gemini and DeepSeek all speak the OpenAI chat-completions API. */
  private async openAI(r: ModelRequest, s: Settings): Promise<ModelReply> {
    const provider = r.provider as "chatgpt" | "gemini" | "deepseek";
    const cfg = openAICompatible(provider, s);
    if (r.model?.trim()) cfg.model = r.model.trim();
    if (!cfg.model)
      throw new Error(`Enter your ${cfg.label} model ID in Settings first.`);
    const client = new OpenAI({
      apiKey: this.settings.key(CREDENTIAL[r.provider]),
      baseURL: cfg.baseURL,
      maxRetries: 0,
      fetch: this.fetcher,
      timeout: 600000,
    });
    const tokenLimit =
      provider === "chatgpt"
        ? { max_completion_tokens: r.maxTokens }
        : { max_tokens: r.maxTokens };
    const params = {
      model: cfg.model,
      ...tokenLimit,
      messages: [
        { role: "system", content: r.system },
        ...openAIMessages(r.messages, provider),
      ],
      tools: r.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
    } as any;
    let message: any,
      usage: any,
      finish: string | null | undefined,
      model = cfg.model;
    if (r.onDelta) {
      const stream = await client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { signal: r.signal },
      );
      let content = "",
        reasoning = "";
      const calls = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      for await (const chunk of stream as any) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        if (typeof d.content === "string" && d.content) {
          content += d.content;
          r.onDelta({ type: "text", text: d.content });
        }
        const think = d.reasoning_content ?? d.reasoning;
        if (typeof think === "string" && think) {
          reasoning += think;
          r.onDelta({ type: "thinking", text: think });
        }
        for (const tc of d.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
      message = {
        content,
        reasoning_content: reasoning || undefined,
        tool_calls: [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, c]) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          })),
      };
      if (!message.tool_calls.length) delete message.tool_calls;
    } else {
      const result = await client.chat.completions.create(params, {
        signal: r.signal,
      });
      message = result.choices[0]?.message;
      if (!message) throw new ProviderError(502);
      usage = result.usage;
      finish = result.choices[0].finish_reason;
      model = result.model;
    }
    const reasoning = [message.reasoning_content, message.reasoning].find(
      (v) => typeof v === "string" && v.trim(),
    );
    return {
      reasoning: reasoning ? String(reasoning).trim() : undefined,
      text: message.content ?? "",
      toolCalls: (message.tool_calls ?? [])
        .filter((t: any) => t.type === "function")
        .map((t: any) => {
          let input: unknown;
          try {
            input = JSON.parse(t.function.arguments);
          } catch {
            input = null;
          }
          return { id: t.id, name: t.function.name, input };
        }),
      wire: {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls,
        ...(message.reasoning_content
          ? { reasoning_content: message.reasoning_content }
          : {}),
      },
      model,
      input: usage?.prompt_tokens ?? 0,
      cached:
        usage?.prompt_cache_hit_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        0,
      cacheWrite: 0,
      output: usage?.completion_tokens ?? 0,
      truncated: finish === "length",
    };
  }
}
export function estimateCost(
  r: ModelReply,
  provider: Provider,
  s: Settings,
  tier: Tier = "deep",
  model?: string,
) {
  const p = model
    ? priceForModel(provider, s, model)
    : priceFor(provider, s, tier);
  return (
    (Math.max(0, r.input - r.cached - r.cacheWrite) * p.input +
      r.cached * p.cached +
      r.cacheWrite * p.cacheWrite +
      r.output * p.output) /
    1e6
  );
}
