import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Provider, Settings } from "../shared/types";
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
export interface ModelRequest {
  provider: Provider;
  system: string;
  messages: any[];
  tools?: ToolDefinition[];
  maxTokens: number;
  thinking?: boolean;
  purpose: string;
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
export class Clients implements Transport {
  constructor(
    private settings: SettingsStore,
    private fetcher?: typeof fetch,
  ) {}
  async complete(r: ModelRequest): Promise<ModelReply> {
    const s = this.settings.get();
    try {
      if (r.provider === "opus") {
        const client = new Anthropic({
          apiKey: this.settings.key("anthropic"),
          baseURL: s.anthropicBaseUrl,
          maxRetries: 0,
          fetch: this.fetcher,
          timeout: 120000,
        });
        const result = await client.messages.create({
          model: s.anthropicModel,
          max_tokens: r.maxTokens,
          system: [
            {
              type: "text",
              text: r.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: r.messages,
          tools: r.tools?.map((t, i) => ({
            ...t,
            ...(i === r.tools!.length - 1
              ? { cache_control: { type: "ephemeral" as const } }
              : {}),
          })),
          ...(r.thinking
            ? {
                thinking: {
                  type: "enabled" as const,
                  budget_tokens: Math.min(4096, r.maxTokens - 1024),
                },
              }
            : {}),
        });
        return {
          text: result.content
            .filter((b) => b.type === "text")
            .map((b) => (b as any).text)
            .join("\n"),
          toolCalls: result.content
            .filter((b) => b.type === "tool_use")
            .map((b) => ({
              id: (b as any).id,
              name: (b as any).name,
              input: (b as any).input,
            })),
          wire: { role: "assistant", content: result.content },
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
      if (!s.deepseekModel)
        throw new Error("Enter your DeepSeek model ID in Settings first.");
      const client = new OpenAI({
        apiKey: this.settings.key("deepseek"),
        baseURL: s.deepseekBaseUrl,
        maxRetries: 0,
        fetch: this.fetcher,
        timeout: 120000,
      });
      const result = await client.chat.completions.create({
        model: s.deepseekModel,
        max_tokens: r.maxTokens,
        messages: [{ role: "system", content: r.system }, ...r.messages],
        tools: r.tools?.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
      });
      const m = result.choices[0]?.message;
      if (!m) throw new ProviderError(502);
      const u = result.usage as any;
      return {
        text: m.content ?? "",
        toolCalls: (m.tool_calls ?? [])
          .filter((t) => t.type === "function")
          .map((t) => {
            let input: unknown;
            try {
              input = JSON.parse((t as any).function.arguments);
            } catch {
              input = null;
            }
            return { id: t.id, name: (t as any).function.name, input };
          }),
        wire: {
          role: "assistant",
          content: m.content,
          tool_calls: m.tool_calls,
          ...((m as any).reasoning_content
            ? { reasoning_content: (m as any).reasoning_content }
            : {}),
        },
        model: result.model,
        input: u?.prompt_tokens ?? 0,
        cached:
          u?.prompt_cache_hit_tokens ??
          u?.prompt_tokens_details?.cached_tokens ??
          0,
        cacheWrite: 0,
        output: u?.completion_tokens ?? 0,
        truncated: result.choices[0].finish_reason === "length",
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
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
}
export function estimateCost(r: ModelReply, provider: Provider, s: Settings) {
  const p = provider === "opus" ? s.anthropicPrice : s.deepseekPrice;
  return (
    (Math.max(0, r.input - r.cached - r.cacheWrite) * p.input +
      r.cached * p.cached +
      r.cacheWrite * p.cacheWrite +
      r.output * p.output) /
    1e6
  );
}
