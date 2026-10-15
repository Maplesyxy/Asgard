import { Clients, modelFor } from "../src/main/providers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, isRaw } from "../src/main/store";
import { SettingsStore } from "../src/main/settings";
import { Engine, verify, TOOLS } from "../src/main/engine";
import {
  ModelReply,
  ModelRequest,
  Stopped,
  Transport,
} from "../src/main/providers";
import {
  DEFAULT_SETTINGS,
  Provider,
  Role,
  SendRequest,
} from "../src/shared/types";
import { Attachments, LIMITS, unzipSync } from "../src/main/attachments";
import { grade, summarise } from "../evals/run";
import { TASKS } from "../evals/tasks";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
function fixture(
  responses: (
    Partial<ModelReply> | ((r: ModelRequest) => Partial<ModelReply>)
  )[] = [],
) {
  const store = new Store(":memory:");
  const secure = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")),
    decryptString: (b: Buffer) => b.toString().split("").reverse().join(""),
  };
  const settings = new SettingsStore(store, secure);
  settings.save(
    { ...DEFAULT_SETTINGS, deepseekModel: "user-selected-model" },
    {
      anthropic: "fixture-key",
      openai: "fixture-key",
      deepseek: "fixture-key",
      gemini: "fixture-key",
    },
  );
  const requests: ModelRequest[] = [];
  const transport: Transport = {
    async complete(req) {
      // Callbacks and the abort signal are live objects, so they are kept by
      // reference while the rest of the request is snapshotted.
      const { onDelta, signal, ...rest } = req;
      requests.push({
        ...structuredClone(rest),
        onDelta,
        signal,
      } as ModelRequest);
      const next = responses.shift();
      if (!next) throw new Error("No mock response");
      const r = typeof next === "function" ? next(req) : next;
      return {
        text: "Done.",
        toolCalls: [],
        wire: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        input: 100,
        cached: 0,
        cacheWrite: 0,
        output: 20,
        // Report the model the request resolved to, as the real transport
        // does: cost is matched back to a tier by model id.
        model:
          req.provider === "claude"
            ? req.model || modelFor("claude", settings.get(), req.tier)
            : "user-selected-model",
        ...r,
      };
    },
  };
  const engine = new Engine(store, settings, transport);
  return { store, settings, requests, engine, secure };
}
const easy = {
  text: '{"tier":"easy","confidence":0.9,"reason":"Simple question"}',
};
const req = (id: string, extra: Partial<SendRequest> = {}): SendRequest => ({
  sessionId: id,
  text: "Hello",
  route: "auto",
  deepResearch: false,
  highStakes: false,
  checks: { format: "text", requiredText: [] },
  attachmentIds: [],
  ...extra,
});
const put = (
  s: Store,
  path: string,
  content = "A durable memory",
  priv = false,
) =>
  s.write({
    path,
    kind: "fact",
    title: path.split("/").pop()!,
    content,
    summary: content.slice(0, 1000) || "Empty content.",
    private: priv,
  });
test("SQLite has FTS5, defaults, one root, and mandatory summaries", () => {
  const { store } = fixture();
  assert.equal(store.all().length, 7);
  assert.equal(store.all().filter((n) => n.parent_id === null).length, 1);
  assert.equal(store.get("/rules")?.pinned, 1);
  assert.throws(() =>
    store.write({
      path: "/knowledge/nope",
      kind: "fact",
      title: "No",
      content: "",
      summary: "",
    }),
  );
  assert.throws(() => put(store, "/missing/child"));
  assert.throws(() => put(store, "/knowledge/../bad"));
  store.close();
});
test("tree_write upserts without duplicate IDs and FTS updates atomically", () => {
  const { store } = fixture();
  const a = put(store, "/knowledge/fact", "albatross");
  const b = put(store, "/knowledge/fact", "nightingale");
  assert.equal(a.id, b.id);
  assert.equal(store.search("albatross").length, 0);
  assert.equal(store.search("nightingale")[0].path, b.path);
  assert.equal(store.search('" OR * (').length, 0);
  assert.equal(store.search("nightingale", "/profile").length, 0);
  store.close();
});
test("tree_ls and tree_read expose correct depth and full content", () => {
  const { store, engine } = fixture();
  store.ensureFolder("/knowledge/nest");
  put(store, "/knowledge/nest/leaf", "full content");
  const s = store.newSession("", false);
  const ls = engine.tool(s, "claude", "tree_ls", {
    path: "/knowledge",
  }) as any[];
  assert.equal(ls.length, 1);
  assert.equal(ls[0].content, undefined);
  assert.equal(
    (
      engine.tool(s, "claude", "tree_ls", {
        path: "/knowledge",
        depth: 2,
      }) as any[]
    ).length,
    2,
  );
  assert.equal(
    (
      engine.tool(s, "claude", "tree_read", {
        path: "/knowledge/nest/leaf",
      }) as any
    ).content,
    "full content",
  );
  assert.equal(
    (engine.tool(s, "claude", "tree_search", { query: "content" }) as any[])
      .length,
    1,
  );
  store.close();
});
test("tree_move preserves descendants and rejects collisions and cycles", () => {
  const { store, engine } = fixture();
  store.ensureFolder("/knowledge/nest");
  put(store, "/knowledge/nest/leaf");
  const s = store.newSession("", false);
  assert.throws(() => store.move("/knowledge/nest", "/knowledge/nest/leaf"));
  engine.tool(s, "claude", "tree_move", {
    path: "/knowledge/nest",
    new_parent_path: "/profile",
  });
  assert.ok(store.get("/profile/nest/leaf"));
  assert.equal(store.get("/knowledge/nest/leaf"), undefined);
  store.ensureFolder("/knowledge/nest");
  assert.throws(() => store.move("/knowledge/nest", "/profile"));
  assert.throws(() => store.move("/rules", "/profile"));
  store.close();
});
test("tree_archive preserves content and FTS path", () => {
  const { store, engine } = fixture();
  put(store, "/knowledge/albatross");
  const p = engine.tool(store.newSession("", false), "claude", "tree_archive", {
    path: "/knowledge/albatross",
  }) as string;
  assert.match(p, /^\/archive\//);
  assert.equal(store.read(p).content, "A durable memory");
  assert.equal(store.search("albatross")[0].path, p);
  store.close();
});
test("private inheritance survives moving out of a private folder", () => {
  const { store } = fixture();
  store.write({
    path: "/profile",
    kind: "folder",
    title: "Profile",
    content: "",
    summary: "Private",
    private: true,
  });
  put(store, "/profile/secret");
  assert.equal(store.isPrivate("/profile/secret"), true);
  store.move("/profile/secret", "/knowledge");
  assert.equal(store.isPrivate("/knowledge/secret"), true);
  store.close();
});
test("all non-Claude read tools block private data and filtered searches omit it", () => {
  const { store, engine } = fixture();
  put(store, "/knowledge/secret", "sensitive-hummingbird", true);
  const s = store.newSession("", false);
  assert.throws(
    () =>
      engine.tool(s, "deepseek", "tree_read", { path: "/knowledge/secret" }),
    /Private/,
  );
  assert.throws(
    () => engine.tool(s, "deepseek", "tree_ls", { path: "/knowledge/secret" }),
    /Private/,
  );
  assert.deepEqual(
    engine.tool(s, "deepseek", "tree_search", {
      query: "sensitive-hummingbird",
    }),
    [],
  );
  assert.ok(
    !(
      engine.tool(s, "deepseek", "tree_ls", { path: "/knowledge" }) as any[]
    ).some((n) => n.path.endsWith("secret")),
  );
  assert.throws(() =>
    engine.tool(s, "deepseek", "tree_write", {
      path: "/knowledge/secret",
      kind: "fact",
      title: "overwrite",
      content: "x",
      summary: "x",
    }),
  );
  store.close();
});
test("rules writes, moves and archives require persisted approval", () => {
  const { store, engine } = fixture();
  const s = store.newSession("", false);
  engine.tool(s, "claude", "tree_write", {
    path: "/rules/tone",
    kind: "rule",
    title: "Tone",
    content: "Concise",
    summary: "Concise",
  });
  assert.equal(store.get("/rules/tone"), undefined);
  engine.decide(store.proposals()[0].id, true);
  assert.equal(store.get("/rules/tone")?.content, "Concise");
  engine.tool(s, "claude", "tree_archive", { path: "/rules/tone" });
  assert.ok(store.get("/rules/tone"));
  engine.decide(store.proposals()[0].id, false);
  assert.ok(store.get("/rules/tone"));
  put(store, "/knowledge/rule");
  engine.tool(s, "claude", "tree_move", {
    path: "/knowledge/rule",
    new_parent_path: "/rules",
  });
  assert.equal(store.get("/rules/rule"), undefined);
  assert.equal(store.proposals().length, 1);
  store.close();
});
test("context is byte-stable for pinned memory; raw is never automatically loaded even when pinned", () => {
  const { store, engine } = fixture();
  const s = store.newSession("Asgard", false);
  const raw = store.read("/sessions/" + s.date + "/" + s.id + "/raw");
  store.write({
    path: raw.path,
    kind: raw.kind,
    title: raw.title,
    summary: raw.summary,
    private: false,
    pinned: true,
    content: "raw unicorn transcript",
  });
  put(store, "/rules/style", "Use clear language");
  const one = engine.context(s, "unicorn"),
    two = engine.context(s, "unicorn");
  assert.deepEqual(one, two);
  assert.ok(!one.some((n) => isRaw(n.path)));
  assert.equal(one[0].path, "/rules");
  assert.ok(one.find((n) => n.path === "/projects/asgard/plan"));
  store.close();
});
test("an ordinary turn is one quick-tier call, with no classifier", async () => {
  const { store, engine, requests } = fixture([{ text: "Hello!" }]);
  const s = await engine.send(req(store.newSession("", false).id));
  assert.deepEqual(
    requests.map((r) => `${r.provider}:${r.tier}`),
    ["claude:quick"],
  );
  // The quick tier answers alone: no delegate tool is offered to it.
  assert.ok(!requests[0].tools?.some((t) => t.name === "delegate"));
  assert.equal(s.messages.at(-1)!.meta!.tier, "quick");
  store.close();
});
test("auto routing never selects DeepSeek or ChatGPT, at either tier", async () => {
  for (const deepResearch of [false, true]) {
    const { store, engine, requests } = fixture([{ text: "Answer" }]);
    await engine.send(req(store.newSession("", false).id, { deepResearch }));
    assert.ok(
      requests.every((r) => r.provider === "claude"),
      `auto routing left Claude with deepResearch=${deepResearch}`,
    );
    store.close();
  }
});
test("Force DeepSeek still reaches DeepSeek on a public session", async () => {
  const { store, engine, requests } = fixture([{ text: "Answer" }]);
  await engine.send(req(store.newSession("", false).id, { route: "deepseek" }));
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["deepseek"],
  );
  store.close();
});
test("deep research runs the orchestrator tier and offers delegation", async () => {
  const { store, engine, requests } = fixture([{ text: "Answer" }]);
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.deepEqual(
    requests.map((r) => `${r.provider}:${r.tier}`),
    ["claude:deep"],
  );
  assert.ok(requests[0].tools?.some((t) => t.name === "delegate"));
  assert.equal(s.messages.at(-1)!.meta!.tier, "deep");
  store.close();
});
test("a high-stakes turn uses the orchestrator even without deep research", async () => {
  const { store, engine, requests } = fixture([
    { text: "Answer" },
    { text: '{"ok":true,"issues":[]}' },
  ]);
  await engine.send(req(store.newSession("", false).id, { highStakes: true }));
  // The review runs on another vendor: a model reviewing its own answer
  // agrees with itself far too readily.
  assert.equal(requests[0].tier, "deep");
  assert.equal(requests[0].provider, "claude");
  assert.equal(requests[1].purpose, "review");
  assert.notEqual(requests[1].provider, requests[0].provider);
  store.close();
});
test("private conversation bypasses classifier and overrides Force DeepSeek", async () => {
  const { store, engine, requests } = fixture([{ text: "Private answer" }]);
  await engine.send(
    req(store.newSession("", true).id, {
      route: "deepseek",
      text: "private request",
    }),
  );
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["claude"],
  );
  store.close();
});
test("private retrieved context taints session before classifier", async () => {
  const { store, engine, requests } = fixture([{ text: "Answer" }]);
  put(store, "/profile/secret", "hummingbird secret", true);
  const s = await engine.send(
    req(store.newSession("", false).id, { text: "hummingbird" }),
  );
  assert.equal(s.private, true);
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["claude"],
  );
  store.close();
});
test("private Claude tool read taints subsequent turns and derived writes", async () => {
  const { store, engine } = fixture();
  put(store, "/profile/secret", "private", true);
  const s = store.newSession("", false);
  engine.tool(s, "claude", "tree_read", { path: "/profile/secret" });
  engine.tool(s, "claude", "tree_write", {
    path: "/knowledge/derived",
    kind: "fact",
    title: "Derived",
    content: "result",
    summary: "result",
  });
  assert.equal(store.session(s.id).private, true);
  assert.equal(store.isPrivate("/knowledge/derived"), true);
  store.close();
});
test("failed JSON schema escalates once to Claude", async () => {
  const { store, engine, requests } = fixture([
    { text: '{"wrong":1}' },
    { text: '{"result":42}' },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, {
      route: "deepseek",
      checks: {
        format: "json",
        requiredText: [],
        jsonSchema: {
          type: "object",
          required: ["result"],
          properties: { result: { type: "number" } },
        },
      },
    }),
  );
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["deepseek", "claude"],
  );
  assert.equal(s.messages[1].meta?.escalated, true);
  assert.equal(s.messages[1].meta?.verified, true);
  store.close();
});
test("a failed check escalates the quick tier to the orchestrator, never to DeepSeek", async () => {
  const { store, engine, requests } = fixture([
    { text: "no json" },
    { text: "still no json" },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, {
      route: "claude",
      checks: { format: "json", requiredText: [] },
    }),
  );
  assert.equal(s.messages[1].meta?.verified, false);
  assert.deepEqual(
    requests.map((r) => `${r.provider}:${r.tier}`),
    ["claude:quick", "claude:deep"],
  );
  assert.equal(s.messages[1].meta?.escalated, true);
  assert.equal(s.messages[1].meta?.tier, "deep");
  store.close();
});
test("high-stakes fresh context only includes request and answer, then revises once", async () => {
  const { store, engine, requests } = fixture([
    { text: "initial" },
    { text: '{"ok":false,"issues":["Missing a caveat"]}' },
    { text: "revised with caveat" },
  ]);
  put(store, "/rules/tone", "PRIVATE_CONTEXT_SENTINEL");
  const s = await engine.send(
    req(store.newSession("", true).id, { highStakes: true }),
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[1].purpose, "review");
  assert.ok(!JSON.stringify(requests[1]).includes("PRIVATE_CONTEXT_SENTINEL"));
  assert.deepEqual(JSON.parse(requests[1].messages[0].content), {
    request: "Hello",
    answer: "initial",
  });
  assert.equal(s.messages[1].content, "revised with caveat");
  assert.equal(s.messages[1].meta?.verified, false);
  store.close();
});
test("valid high-stakes review passes", async () => {
  const { store, engine } = fixture([
    { text: "answer" },
    { text: '{"ok":true,"issues":[]}' },
  ]);
  const s = await engine.send(
    req(store.newSession("", true).id, { highStakes: true }),
  );
  assert.equal(s.messages[1].meta?.verified, true);
  store.close();
});
test("thinking blocks survive Anthropic tool loop, but are never persisted", async () => {
  const thinking = {
    type: "thinking",
    thinking: "TRANSIENT_SECRET_REASONING",
    signature: "signature",
  };
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "t1", name: "tree_ls", input: { path: "/knowledge" } }],
      wire: {
        role: "assistant",
        content: [
          thinking,
          {
            type: "tool_use",
            id: "t1",
            name: "tree_ls",
            input: { path: "/knowledge" },
          },
        ],
      },
    },
    { text: "final" },
  ]);
  const s = await engine.send(req(store.newSession("", true).id));
  assert.ok(
    JSON.stringify(requests[1].messages).includes("TRANSIENT_SECRET_REASONING"),
  );
  assert.ok(
    !JSON.stringify(store.all()).includes("TRANSIENT_SECRET_REASONING"),
  );
  assert.ok(!JSON.stringify(s).includes("TRANSIENT_SECRET_REASONING"));
  store.close();
});
test("compaction writes summary and project decisions, proposes rules, and excludes raw from next context", async () => {
  const { store, engine, requests } = fixture([
    {
      text: JSON.stringify({
        summary:
          "Prefers brief answers. Decided on SQLite. Open: release date.",
        decisions: [
          {
            title: "Use SQLite",
            decision: "Store local memory in SQLite",
            reason: "Local and searchable",
          },
        ],
        preferences: [
          {
            title: "Brief",
            content: "Keep answers brief",
            summary: "Prefer brief answers",
          },
        ],
      }),
    },
  ]);
  const s = store.newSession("asgard", false);
  s.messages = [
    {
      role: "user",
      content: "Use SQLite, keep it brief",
      at: new Date().toISOString(),
    },
    { role: "assistant", content: "Agreed.", at: new Date().toISOString() },
  ];
  store.saveSession(s);
  await engine.end(s.id);
  assert.equal(requests[0].provider, "claude");
  assert.equal(requests[0].tier, "worker");
  assert.ok(store.get("/sessions/" + s.date + "/" + s.id + "/summary"));
  assert.equal(store.ls("/projects/asgard/decisions").length, 1);
  assert.equal(store.proposals().length, 1);
  assert.equal(store.ls("/rules").length, 0);
  const ctx = engine.context(store.newSession("asgard", false), "SQLite");
  assert.ok(ctx.some((n) => n.path.endsWith("/summary")));
  assert.ok(!ctx.some((n) => isRaw(n.path)));
  assert.ok(store.session(s.id).ended);
  store.close();
});
test("private compaction uses only Claude and marks summaries and decisions private", async () => {
  const { store, engine, requests } = fixture([
    {
      text: JSON.stringify({
        summary: "Private decision",
        decisions: [
          {
            title: "Private",
            decision: "sensitive",
            reason: "private rationale",
          },
        ],
        preferences: [],
      }),
    },
  ]);
  const s = store.newSession("private", true);
  s.messages = [
    { role: "user", content: "sensitive", at: new Date().toISOString() },
  ];
  store.saveSession(s);
  await engine.end(s.id);
  assert.equal(requests[0].provider, "claude");
  assert.equal(store.ls("/projects/private/decisions")[0].private, 1);
  assert.ok(store.isPrivate("/sessions/" + s.date + "/" + s.id + "/summary"));
  store.close();
});
test("compaction failure preserves transcript and leaves session retryable", async () => {
  const { store, engine } = fixture([{ text: "bad JSON" }]);
  const s = store.newSession("", false);
  s.messages = [
    { role: "user", content: "Keep me", at: new Date().toISOString() },
  ];
  store.saveSession(s);
  await assert.rejects(engine.end(s.id));
  assert.equal(store.session(s.id).messages[0].content, "Keep me");
  assert.equal(store.session(s.id).compacted, 0);
  assert.equal(store.session(s.id).ended, false);
  store.close();
});
test("tool trimming stores full result in tree and supports pagination", () => {
  const { store, engine } = fixture();
  const s = store.newSession("", true);
  const value = "x".repeat(30000);
  const trimmed = JSON.parse(engine.trim(s, { value }));
  assert.equal(trimmed.truncated, true);
  assert.deepEqual(JSON.parse(store.read(trimmed.fullResultPath).content), {
    value,
  });
  assert.ok(store.isPrivate(trimmed.fullResultPath));
  const read = engine.tool(s, "claude", "tree_read", {
    path: trimmed.fullResultPath,
    offset: 100,
    length: 100,
  }) as any;
  assert.equal(read.content.length, 100);
  assert.equal(read.nextOffset, 200);
  assert.ok(
    !engine
      .context(s, "Tool result")
      .some((n) => n.path === trimmed.fullResultPath),
  );
  store.close();
});
test("safeStorage envelope stores ciphertext and never returns saved key", () => {
  const { store, settings } = fixture();
  const secret = "test-secret-not-a-real-key";
  settings.save(DEFAULT_SETTINGS, { anthropic: secret });
  assert.ok(
    !JSON.stringify(store.db.prepare("SELECT * FROM settings").all()).includes(
      secret,
    ),
  );
  assert.ok(!JSON.stringify(settings.view()).includes(secret));
  assert.equal(settings.key("anthropic"), secret);
  assert.equal(settings.view().keys.anthropic, true);
  store.close();
});
test("credential persistence fails closed without safe encryption", () => {
  const { store, settings, secure } = fixture();
  settings.forget("anthropic");
  secure.isEncryptionAvailable = () => false;
  assert.throws(
    () => settings.save(DEFAULT_SETTINGS, { anthropic: "secret" }),
    /unavailable/,
  );
  assert.equal(settings.has("anthropic"), false);
  store.close();
});
test("dashboard totals, cached inputs, routes and escalation rate match seed", () => {
  const { store } = fixture();
  const base = {
    session: "seed",
    model: "test",
    provider: "deepseek" as const,
    tier: "answer",
    reason: "test",
    input_tokens: 100,
    cached_tokens: 20,
    cache_write_tokens: 0,
    output_tokens: 10,
    cost: 0.01,
    latency: 200,
    verification: "passed",
    escalated: 0,
  };
  store.log(base);
  store.log({
    ...base,
    provider: "claude",
    input_tokens: 200,
    cached_tokens: 100,
    cost: 0.04,
    latency: 400,
    escalated: 1,
  });
  const d = store.dashboard();
  assert.equal(d.calls, 2);
  assert.equal(d.cost, 0.05);
  assert.equal(d.input, 300);
  assert.equal(d.cached, 120);
  assert.equal(d.cacheRate, 0.4);
  assert.equal(d.escalationRate, 0.5);
  assert.equal(d.latency, 300);
  assert.equal(d.days[0].cost, 0.05);
  assert.deepEqual(
    [...d.routes].sort((a, b) => a.provider.localeCompare(b.provider)),
    [
      { provider: "claude", count: 1 },
      { provider: "deepseek", count: 1 },
    ],
  );
  store.close();
});
test("required format and text checks reject incomplete answers", () => {
  assert.equal(
    verify("abc", { format: "text", requiredText: ["xyz"] }).length,
    1,
  );
  assert.equal(verify("{}", { format: "json", requiredText: [] }).length, 0);
});

test("stored milestone checks validate memory artifacts without shell execution", () => {
  const { store, engine } = fixture();
  const s = store.newSession("checks", false);
  put(store, "/knowledge/result", "SUCCESS");
  store.write({
    path: s.project + "/plan",
    kind: "plan",
    title: "Plan",
    summary: "One milestone",
    content: JSON.stringify({
      milestones: [
        {
          title: "Produced result",
          status: "complete",
          verify: { path: "/knowledge/result", includes: "SUCCESS" },
        },
      ],
    }),
  });
  assert.deepEqual(engine.planIssues(s), []);
  put(store, "/knowledge/result", "FAILED");
  assert.match(engine.planIssues(s)[0], /failed/);
  store.write({
    path: s.project + "/plan",
    kind: "plan",
    title: "Plan",
    summary: "Manual check",
    content: JSON.stringify({
      milestones: [
        { title: "Run test", status: "complete", verify: "npm test" },
      ],
    }),
  });
  assert.match(engine.planIssues(s)[0], /Manual/);
  store.close();
});
test("automatic compaction drops old turns from subsequent provider context", async () => {
  const { store, engine, settings, requests } = fixture([
    { text: "Answer one" },
    { text: '{"summary":"Compact result","decisions":[],"preferences":[]}' },
    { text: "Answer two" },
  ]);
  settings.save({ ...settings.get(), compactionThreshold: 2000 }, {});
  const s = store.newSession("", true);
  await engine.send(
    req(s.id, { text: "OLD_TRANSCRIPT_SENTINEL " + "x".repeat(6100) }),
  );
  assert.equal(store.session(s.id).compacted, 2);
  await engine.send(req(s.id, { text: "Continue" }));
  assert.equal(requests[1].purpose, "compaction");
  assert.ok(
    !JSON.stringify(requests[2].messages).includes("OLD_TRANSCRIPT_SENTINEL"),
  );
  assert.ok(JSON.stringify(requests[2].messages).includes("Compact result"));
  assert.equal(store.session(s.id).messages.length, 4);
  store.close();
});
test("tool truncation respects configured token budget for Unicode content", () => {
  const { store, engine, settings } = fixture();
  settings.save({ ...settings.get(), toolOutputTokens: 256 }, {});
  const result = engine.trim(store.newSession("", false), {
    text: "記憶🌳".repeat(5000),
  });
  assert.ok(Math.ceil(Buffer.byteLength(result) / 3) <= 256);
  store.close();
});

test("real Anthropic SDK emits stable cache breakpoints and retains signed thinking", async () => {
  const { store, settings } = fixture();
  settings.save(DEFAULT_SETTINGS, { anthropic: "fake-test-key" });
  const bodies: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    bodies.push(body);
    return new Response(
      JSON.stringify({
        id: "test",
        type: "message",
        role: "assistant",
        model: "test-opus",
        content: [
          { type: "thinking", thinking: "transient", signature: "signed" },
          { type: "text", text: "Hello" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 10,
          output_tokens: 5,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const clients = new Clients(settings, fetcher);
  const request: ModelRequest = {
    provider: "claude",
    system: "Stable Astro rules",
    messages: [{ role: "user", content: "Hello" }],
    tools: TOOLS,
    maxTokens: 8192,
    thinking: true,
    purpose: "test",
  };
  const r = await clients.complete(request);
  await clients.complete({
    ...request,
    messages: [{ role: "user", content: "Second request" }],
  });
  assert.equal(bodies[0].system[0].cache_control.type, "ephemeral");
  assert.equal(bodies[0].tools.at(-1).cache_control.type, "ephemeral");
  assert.deepEqual(bodies[0].tools, bodies[1].tools);
  assert.deepEqual(bodies[0].system, bodies[1].system);
  assert.equal(r.input, 230);
  assert.equal(r.cached, 200);
  assert.equal(r.text, "Hello");
  assert.equal(r.wire.content[0].signature, "signed");
  store.close();
});
test("real OpenAI-compatible SDK uses configured model and parses tool calls", async () => {
  const { store, settings } = fixture();
  settings.save(
    { ...DEFAULT_SETTINGS, deepseekModel: "chosen-by-user" },
    { deepseek: "fake-test-key" },
  );
  let body: any;
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/chat/completions"));
    body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        id: "chat-test",
        object: "chat.completion",
        created: 1,
        model: "chosen-by-user",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "transient",
              tool_calls: [
                {
                  id: "call1",
                  type: "function",
                  function: { name: "tree_ls", arguments: '{"path":"/"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 30,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const result = await new Clients(settings, fetcher).complete({
    provider: "deepseek",
    system: "Astro",
    messages: [{ role: "user", content: "Search" }],
    tools: TOOLS,
    maxTokens: 2048,
    purpose: "test",
  });
  assert.equal(body.model, "chosen-by-user");
  assert.equal(body.tools[0].type, "function");
  assert.deepEqual(result.toolCalls[0].input, { path: "/" });
  assert.equal(result.cached, 30);
  assert.equal(result.wire.reasoning_content, "transient");
  store.close();
});
test("SDK failures redact provider error bodies before reaching the renderer", async () => {
  const { store, settings } = fixture();
  settings.save(DEFAULT_SETTINGS, { anthropic: "fake-test-secret" });
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "echo fake-test-secret and request contents",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    new Clients(settings, fetcher).complete({
      provider: "claude",
      system: "Astro",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 256,
      purpose: "test",
    }),
    (e) =>
      e instanceof Error &&
      !e.message.includes("fake-test-secret") &&
      e.message.includes("credentials"),
  );
  store.close();
});

// ---------------------------------------------------------------------------
// Reasoning display, Gemini routing and user attachments
// ---------------------------------------------------------------------------
test("reasoning reaches the renderer once but is never written to disk", async () => {
  const { store, engine } = fixture([
    { text: "Answer.", reasoning: "STEP_ONE_REASONING" },
  ]);
  const s = await engine.send(req(store.newSession("", false).id));
  const reply = s.messages.at(-1)!;
  assert.equal(reply.role, "assistant");
  assert.equal(reply.reasoning, "STEP_ONE_REASONING");
  // Nothing in the tree, and re-reading the session drops it.
  assert.ok(!JSON.stringify(store.all()).includes("STEP_ONE_REASONING"));
  const reloaded = store.session(s.id);
  assert.equal(reloaded.messages.at(-1)!.reasoning, undefined);
  store.close();
});
test("reasoning is accumulated across tool rounds, not replayed to the model", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      reasoning: "ROUND_ONE",
      toolCalls: [{ id: "t1", name: "tree_ls", input: { path: "/knowledge" } }],
    },
    { text: "Final.", reasoning: "ROUND_TWO" },
  ]);
  const s = await engine.send(
    req(store.newSession("", true).id, { route: "claude" }),
  );
  const reasoning = s.messages.at(-1)!.reasoning ?? "";
  assert.ok(reasoning.includes("ROUND_ONE"), "first round missing");
  assert.ok(reasoning.includes("ROUND_TWO"), "second round missing");
  // The reasoning strings are display-only; they must not be fed back.
  assert.ok(!JSON.stringify(requests[1].messages).includes("ROUND_ONE"));
  assert.ok(!JSON.stringify(store.all()).includes("ROUND_ONE"));
  store.close();
});
test("private sessions refuse Gemini as well as DeepSeek", async () => {
  for (const route of ["gemini", "deepseek"] as const) {
    const { store, engine, requests } = fixture([{ text: "Answer" }]);
    const id = store.newSession("", true).id;
    await engine.send(req(id, { route }));
    assert.deepEqual(
      requests.map((r) => r.provider),
      ["claude"],
      `private session routed to ${route}`,
    );
    store.close();
  }
});
test("cheap tier uses the Gemini model id and its own price table", async () => {
  const { store, settings, engine, requests } = fixture([{ text: "Hi." }]);
  settings.save(
    {
      ...DEFAULT_SETTINGS,
      geminiModel: "gemini-test-model",
      geminiPrice: { input: 1, cached: 0, cacheWrite: 0, output: 2 },
    },
    {},
  );
  const s = await engine.send(
    req(store.newSession("", false).id, { route: "gemini" }),
  );
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["gemini"],
  );
  assert.equal(
    requests[0].maxTokens,
    DEFAULT_SETTINGS.easyMaxTokens,
    "cheap tier answer should use the easy token budget",
  );
  assert.equal(requests[0].purpose, "answer");
  // Priced from geminiPrice, not the zeroed Anthropic/DeepSeek tables.
  assert.ok(
    s.messages.at(-1)!.meta!.cost > 0,
    "gemini pricing was not applied",
  );
  store.close();
});

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), "asgard-attach-"));
  mkdirSync(join(dir, "pkg", "src"), { recursive: true });
  mkdirSync(join(dir, "pkg", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "pkg", "README.md"), "# Readme\nHELLO_FROM_README\n");
  writeFileSync(join(dir, "pkg", "src", "app.ts"), "export const APP = 1;\n");
  writeFileSync(join(dir, "pkg", "node_modules", "junk.js"), "IGNORED_DEP\n");
  writeFileSync(join(dir, "pkg", "logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
  writeFileSync(join(dir, "pkg", "blob.bin"), Buffer.from([0, 1, 2, 3]));
  return dir;
}
/** Minimal deflate zip writer; CRCs are zero because the reader ignores them. */
function makeZip(entries: { name: string; body: Buffer | string }[]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body, "utf8");
    const comp = deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
test("dropping a folder walks it, keeping images and skipping binaries", () => {
  const dir = tempTree();
  const descriptors = new Attachments().read([join(dir, "pkg")]);
  const labels = descriptors.map((d) => d.label);
  assert.ok(
    labels.some((l) => l.endsWith("README.md")),
    "README not attached",
  );
  assert.ok(
    labels.some((l) => l.endsWith("src/app.ts")),
    "nested source not attached",
  );
  assert.ok(
    !labels.some((l) => l.includes("node_modules")),
    "node_modules must be skipped",
  );
  // Images become provider content blocks rather than being skipped.
  const png = descriptors.find((d) => d.label.endsWith("logo.png"));
  assert.equal(png?.included, true);
  assert.equal(png?.kind, "image");
  const bin = descriptors.find((d) => d.label.endsWith("blob.bin"));
  assert.equal(bin?.included, false);
  assert.match(bin!.reason!, /binary/i);
  // The renderer must not receive file contents, image bytes included.
  assert.ok(!JSON.stringify(descriptors).includes("HELLO_FROM_README"));
  assert.ok(!JSON.stringify(descriptors).includes("iVBO"));
  rmSync(dir, { recursive: true, force: true });
});
test("zip members are expanded; ignored and binary entries never inflate", () => {
  const dir = mkdtempSync(join(tmpdir(), "asgard-zip-"));
  const zip = join(dir, "bundle.zip");
  writeFileSync(
    zip,
    makeZip([
      { name: "notes.txt", body: "ZIP_TEXT_BODY" },
      { name: "src/lib.ts", body: "export const L = 2;\n" },
      { name: "node_modules/x.js", body: "ZIP_IGNORED_DEP" },
      { name: "image.png", body: Buffer.from([0x89, 0x50, 0, 1]) },
    ]),
  );
  const raw = readFileSync(zip);
  assert.deepEqual(
    unzipSync(raw).map((e) => e.name),
    ["notes.txt", "src/lib.ts", "node_modules/x.js", "image.png"],
    "unfiltered reader should see every entry",
  );
  const attachments = new Attachments();
  const descriptors = attachments.read([zip]);
  const labels = descriptors.map((d) => d.label);
  assert.deepEqual(labels, ["bundle.zip/notes.txt", "bundle.zip/src/lib.ts"]);
  const taken = attachments.take(descriptors.map((d) => d.id));
  assert.equal(taken[0].text, "ZIP_TEXT_BODY");
  rmSync(dir, { recursive: true, force: true });
});
test("attachments are inlined once, stored as artifacts, and consumed", async () => {
  const dir = tempTree();
  const { store, engine, requests } = fixture([{ text: "Read it." }]);
  const descriptors = engine.attachments.read([join(dir, "pkg", "README.md")]);
  assert.equal(descriptors.length, 1);
  assert.equal(engine.attachments.size, 1);
  const session = store.newSession("", false);
  const s = await engine.send(
    req(session.id, { attachmentIds: descriptors.map((d) => d.id) }),
  );
  // Inlined into the request that was actually sent.
  assert.ok(
    JSON.stringify(requests[0].messages).includes("HELLO_FROM_README"),
    "attachment text missing from the provider request",
  );
  // Persisted as an artifact node under the session.
  const node = store
    .all()
    .find((n) => n.path.startsWith(`/sessions/`) && n.path.includes("/files/"));
  assert.ok(node, "no artifact node written for the attachment");
  assert.ok(store.read(node!.path).content.includes("HELLO_FROM_README"));
  assert.equal(node!.kind, "artifact");
  // Descriptor recorded on the user turn, and the pending entry consumed.
  const user = s.messages.find((m) => m.role === "user")!;
  assert.equal(user.attachments?.length, 1);
  assert.equal(engine.attachments.size, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("attachments in a private session inherit the private flag", async () => {
  const dir = tempTree();
  const { store, engine } = fixture([{ text: "Read it." }]);
  const ids = engine.attachments
    .read([join(dir, "pkg", "README.md")])
    .map((d) => d.id);
  const session = store.newSession("", true);
  await engine.send(req(session.id, { route: "claude", attachmentIds: ids }));
  const node = store.all().find((n) => n.path.includes("/files/"));
  assert.ok(node, "no artifact node written");
  assert.equal(node!.private, 1, "attachment node must be private");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("a total text budget caps a large multi-file drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "asgard-big-"));
  const chunk = "x".repeat(LIMITS.textPerFile);
  for (let i = 0; i < 20; i++)
    writeFileSync(join(dir, `f${i}.txt`), chunk, "utf8");
  const attachments = new Attachments();
  const descriptors = attachments.read(
    Array.from({ length: 20 }, (_, i) => join(dir, `f${i}.txt`)),
  );
  const total = attachments
    .take(descriptors.map((d) => d.id))
    .reduce((n, a) => n + a.text.length, 0);
  assert.ok(
    total <= LIMITS.totalText,
    `total extracted text ${total} exceeded the ${LIMITS.totalText} budget`,
  );
  assert.ok(
    descriptors.some((d) => d.truncated || !d.included),
    "expected the budget to truncate or skip something",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claude as the built-in provider, ChatGPT, streaming, stopping and media
test("Claude is the built-in default and auto routing never reaches ChatGPT", async () => {
  const { store, engine, requests } = fixture([
    { text: "Done." },
    { text: "Done." },
  ]);
  await engine.send(req(store.newSession("", false).id));
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.deepEqual(
    requests.map((r) => `${r.provider}:${r.tier}`),
    ["claude:quick", "claude:deep"],
  );
  assert.ok(
    !requests.some((r) => r.provider === "chatgpt"),
    "auto routing reached ChatGPT",
  );
  assert.ok(
    requests.some((r) => r.provider === "claude"),
    "Claude was never used",
  );
  store.close();
});
test("the quick tier answers with no second vendor configured", async () => {
  const { store, engine, requests, settings } = fixture([{ text: "Done." }]);
  settings.forget("gemini");
  settings.forget("openai");
  settings.forget("deepseek");
  const s = await engine.send(req(store.newSession("", false).id));
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["claude"],
  );
  assert.match(s.messages.at(-1)!.meta!.reason, /Quick tier/);
  store.close();
});
test("choosing ChatGPT routes the turn to it and keeps private work on Claude", async () => {
  const { store, engine, requests } = fixture([{ text: "Hi." }]);
  await engine.send(req(store.newSession("", false).id, { route: "chatgpt" }));
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["chatgpt"],
  );
  const { store: s2, engine: e2, requests: r2 } = fixture([{ text: "Hi." }]);
  await e2.send(req(s2.newSession("", true).id, { route: "chatgpt" }));
  assert.deepEqual(
    r2.map((r) => r.provider),
    ["claude"],
    "a private session must stay on Claude even when ChatGPT is chosen",
  );
  store.close();
  s2.close();
});
test("Gemini is refused private memory just like DeepSeek", () => {
  const { store, engine } = fixture();
  const s = store.newSession("", false);
  store.write({
    path: "/knowledge/secret",
    kind: "fact",
    title: "Secret",
    content: "classified",
    summary: "classified",
    private: true,
  });
  for (const provider of ["gemini", "chatgpt", "deepseek"] as const)
    assert.throws(
      () =>
        engine.tool(s, provider, "tree_read", { path: "/knowledge/secret" }),
      /Private memory is unavailable/,
    );
  assert.ok(
    engine.tool(s, "claude", "tree_read", { path: "/knowledge/secret" }),
  );
  store.close();
});
test("streaming deltas reach the interface and are never persisted", async () => {
  const { store, engine } = fixture([
    (r: ModelRequest) => {
      r.onDelta?.({ type: "thinking", text: "weighing it up" });
      r.onDelta?.({ type: "text", text: "Hello " });
      r.onDelta?.({ type: "text", text: "world." });
      return { text: "Hello world.", reasoning: "weighing it up" };
    },
  ]);
  const events: string[] = [];
  const session = store.newSession("", false);
  const saved = await engine.send(req(session.id), (e) => {
    events.push(e.type === "stage" ? "stage:" + e.stage : e.type);
  });
  assert.ok(events.includes("text"), "no text deltas were emitted");
  assert.ok(events.includes("thinking"), "no thinking deltas were emitted");
  assert.equal(events.at(-1), "done");
  assert.ok(events.some((e) => e.startsWith("stage:")));
  // The reply carries reasoning once; the transcript on disk never does.
  assert.equal(saved.messages.at(-1)!.reasoning, "weighing it up");
  const raw = store.read(
    "/sessions/" + saved.date + "/" + saved.id + "/raw",
  ).content;
  assert.ok(!raw.includes("weighing it up"));
  store.close();
});
test("stopping aborts the request in flight", async () => {
  const { store, engine } = fixture();
  (engine as any).transport = {
    complete: (r: ModelRequest) =>
      new Promise((_resolve, reject) => {
        r.signal?.addEventListener("abort", () => reject(new Stopped()));
      }),
  } as Transport;
  const pending = engine.send(req(store.newSession("", false).id));
  await new Promise((r) => setTimeout(r, 10));
  engine.cancel();
  await assert.rejects(pending, /Stopped/);
  assert.equal(engine.busy, false);
  store.close();
});
test("images and PDFs ride on one request and never enter the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asgard-media-"));
  writeFileSync(
    join(dir, "shot.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]),
  );
  writeFileSync(
    join(dir, "paper.pdf"),
    Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([1, 2, 3])]),
  );
  const { store, engine, requests } = fixture([{ text: "Seen." }]);
  const descriptors = engine.attachments.read([
    join(dir, "shot.png"),
    join(dir, "paper.pdf"),
  ]);
  assert.deepEqual(
    descriptors.map((d) => d.kind),
    ["paper.pdf".length ? "image" : "image", "pdf"],
  );
  assert.ok(descriptors.every((d) => d.included));
  // Base64 must not reach the renderer through the descriptors.
  assert.ok(!JSON.stringify(descriptors).includes("iVBORw"));
  const session = store.newSession("", false);
  const saved = await engine.send(
    req(session.id, { attachmentIds: descriptors.map((d) => d.id) }),
  );
  const media = (requests[0].messages.at(-1) as any).media;
  assert.equal(media.length, 2);
  assert.deepEqual(
    media.map((m: any) => m.kind),
    ["image", "pdf"],
  );
  assert.equal(media[0].mediaType, "image/png");
  // Nothing binary is stored: the artifact node holds a note, not the bytes.
  const node = store.all().find((n) => n.path.includes("/files/shot"));
  assert.ok(node);
  assert.match(store.read(node!.path).content, /supplied to the model/);
  assert.ok(!JSON.stringify(saved.messages).includes(media[0].data));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("the Anthropic transport sends adaptive thinking, effort and media blocks", async () => {
  const { store, settings } = fixture();
  settings.save(DEFAULT_SETTINGS, { anthropic: "fake-test-key" });
  let body: any;
  const fetcher: typeof fetch = async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        id: "test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Seen." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  await new Clients(settings, fetcher).complete({
    provider: "claude",
    system: "Astro",
    messages: [
      {
        role: "user",
        content: "What is this?",
        media: [
          {
            kind: "image",
            mediaType: "image/png",
            data: "AAA",
            label: "a.png",
          },
          {
            kind: "pdf",
            mediaType: "application/pdf",
            data: "BBB",
            label: "b.pdf",
          },
        ],
      },
    ],
    maxTokens: 4096,
    thinking: true,
    purpose: "test",
  });
  assert.equal(body.model, DEFAULT_SETTINGS.anthropicModel);
  assert.equal(body.thinking.type, "adaptive");
  assert.equal(body.thinking.display, "summarized");
  assert.equal(body.output_config.effort, DEFAULT_SETTINGS.effort);
  assert.equal(body.messages[0].content[0].type, "image");
  assert.equal(body.messages[0].content[0].source.media_type, "image/png");
  assert.equal(body.messages[0].content[1].type, "document");
  assert.equal(body.messages[0].content[2].text, "What is this?");
  assert.ok(!("media" in body.messages[0]));
  store.close();
});
test("the ChatGPT transport uses its own key, token field and image parts", async () => {
  const { store, settings } = fixture();
  settings.save(
    { ...DEFAULT_SETTINGS, openaiModel: "chosen-by-user" },
    { openai: "fake-openai-key" },
  );
  let body: any,
    auth: string | null = null,
    url = "";
  const fetcher: typeof fetch = async (u, init) => {
    url = String(u);
    auth = new Headers(init!.headers).get("authorization");
    body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        id: "chat",
        object: "chat.completion",
        created: 1,
        model: "chosen-by-user",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Seen." },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const r = await new Clients(settings, fetcher).complete({
    provider: "chatgpt",
    system: "Astro",
    messages: [
      {
        role: "user",
        content: "What is this?",
        media: [
          {
            kind: "image",
            mediaType: "image/png",
            data: "AAA",
            label: "a.png",
          },
        ],
      },
    ],
    maxTokens: 2048,
    purpose: "test",
  });
  assert.ok(url.startsWith(DEFAULT_SETTINGS.openaiBaseUrl));
  assert.equal(auth, "Bearer fake-openai-key");
  assert.equal(body.model, "chosen-by-user");
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages[1].content[0].type, "image_url");
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/png/);
  assert.equal(r.text, "Seen.");
  store.close();
});
test("a config written by an older build gains the new defaults", () => {
  const store = new Store(":memory:");
  const secure = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  };
  // Exactly the shape the previous release persisted: no OpenAI fields, no
  // effort, and the model id this app shipped before claude-opus-5 existed.
  store.db.prepare("INSERT INTO settings VALUES('config',?)").run(
    JSON.stringify({
      anthropicModel: "claude-opus-5-5",
      anthropicBaseUrl: "https://api.anthropic.com",
      deepseekModel: "",
      deepseekBaseUrl: "https://api.deepseek.com",
      geminiModel: "gemini-2.5-flash",
      geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      easyMaxTokens: 2048,
      hardMaxTokens: 8192,
      compactionThreshold: 40000,
      toolOutputTokens: 2000,
      retrievalLimit: 8,
      thinking: false,
      anthropicPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
      deepseekPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
      geminiPrice: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
    }),
  );
  const values = new SettingsStore(store, secure).get();
  assert.equal(values.anthropicModel, DEFAULT_SETTINGS.anthropicModel);
  // The all-zero price table that release shipped billed every Claude call
  // as free; it is an old default, not a choice, so it moves forward too.
  assert.deepEqual(values.anthropicPrice, DEFAULT_SETTINGS.anthropicPrice);
  // 8192 with thinking on is what made answers come back empty.
  assert.equal(values.hardMaxTokens, DEFAULT_SETTINGS.hardMaxTokens);
  assert.equal(values.effort, DEFAULT_SETTINGS.effort);
  assert.equal(values.openaiModel, DEFAULT_SETTINGS.openaiModel);
  assert.equal(values.effort, DEFAULT_SETTINGS.effort);
  assert.deepEqual(values.openaiPrice, DEFAULT_SETTINGS.openaiPrice);
  // User choices survive the merge.
  assert.equal(values.thinking, false);
  assert.equal(values.geminiModel, "gemini-2.5-flash");
  store.close();
});
test("the Opus orchestrator default moves to Fable, worker and chosen models stay", () => {
  const secure = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  };
  const stored = (over: Record<string, unknown>) => {
    const store = new Store(":memory:");
    store.db
      .prepare("INSERT INTO settings VALUES('config',?)")
      .run(JSON.stringify({ ...DEFAULT_SETTINGS, ...over }));
    const values = new SettingsStore(store, secure).get();
    store.close();
    return values;
  };
  // The previous release's orchestrator default and its price table.
  const previous = stored({
    anthropicModel: "claude-opus-5",
    anthropicWorkerModel: "claude-haiku-4-5",
    anthropicPrice: { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
    anthropicWorkerPrice: {
      input: 1,
      cached: 0.1,
      cacheWrite: 1.25,
      output: 5,
    },
  });
  assert.equal(previous.anthropicModel, "claude-fable-5-1");
  assert.equal(previous.anthropicQuickModel, "claude-sonnet-5");
  assert.deepEqual(previous.anthropicPrice, DEFAULT_SETTINGS.anthropicPrice);
  // A stored Haiku worker is cheaper than the new Opus default; it is kept,
  // and so is its price table.
  assert.equal(previous.anthropicWorkerModel, "claude-haiku-4-5");
  assert.deepEqual(previous.anthropicWorkerPrice, {
    input: 1,
    cached: 0.1,
    cacheWrite: 1.25,
    output: 5,
  });
  // Anything the user typed themselves is left alone.
  const chosen = stored({
    anthropicModel: "claude-opus-4-8",
    anthropicWorkerModel: "claude-sonnet-5",
    anthropicPrice: { input: 1, cached: 1, cacheWrite: 1, output: 1 },
  });
  assert.equal(chosen.anthropicModel, "claude-opus-4-8");
  assert.equal(chosen.anthropicWorkerModel, "claude-sonnet-5");
  assert.deepEqual(chosen.anthropicPrice, {
    input: 1,
    cached: 1,
    cacheWrite: 1,
    output: 1,
  });
});
test("a refusal comes back as a notice, not an empty reply", async () => {
  const { store, settings } = fixture();
  settings.save(DEFAULT_SETTINGS, { anthropic: "fake-test-key" });
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        id: "test",
        type: "message",
        role: "assistant",
        model: "claude-fable-5-1",
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "This request matched a safety policy.",
        },
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const r = await new Clients(settings, fetcher).complete({
    provider: "claude",
    tier: "deep",
    system: "Astro",
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4096,
    thinking: true,
    purpose: "test",
  });
  assert.equal(calls, 1);
  assert.ok(r.refused, "refused should be set");
  assert.match(r.text, /declined this request \(cyber\)/);
  assert.match(r.text, /safety policy/);
  // Not a truncation: the engine must not retry with a bigger budget.
  assert.equal(r.truncated, false);
  // The replayed assistant turn carries the notice rather than empty content.
  assert.equal(r.wire.content[0].text, r.text);
  store.close();
});
test("renaming and deleting a chat removes its transcript only", async () => {
  const { store, engine } = fixture([{ text: "Done." }]);
  const session = store.newSession("asgard", false);
  await engine.send(req(session.id));
  store.renameSession(session.id, "Weekend plan");
  assert.equal(store.session(session.id).title, "Weekend plan");
  const base = "/sessions/" + session.date + "/" + session.id;
  assert.ok(store.get(base + "/raw"));
  store.deleteSession(session.id);
  assert.equal(store.get(base), undefined);
  assert.equal(store.get(base + "/raw"), undefined);
  assert.equal(store.sessions().length, 0);
  // Project structure the conversation created is untouched.
  assert.ok(store.get("/projects/asgard"));
  store.close();
});

test("an answer that spent its budget thinking is retried with more room", async () => {
  const budgets: number[] = [];
  const { store, engine } = fixture([
    (r: ModelRequest) => {
      budgets.push(r.maxTokens);
      // Thinking consumed everything: no text, stopped at the ceiling.
      return { text: "", truncated: true, reasoning: "long deliberation" };
    },
    (r: ModelRequest) => {
      budgets.push(r.maxTokens);
      return { text: "Here is the answer." };
    },
  ]);
  const stages: string[] = [];
  const s = await engine.send(
    req(store.newSession("", false).id, {
      route: "claude",
      deepResearch: true,
    }),
    (e) => {
      if (e.type === "stage") stages.push(e.stage);
    },
  );
  assert.equal(budgets.length, 2);
  assert.ok(
    budgets[1] > budgets[0],
    "the retry should raise the output budget",
  );
  assert.ok(stages.some((x) => /more room/.test(x)));
  const reply = s.messages.at(-1)!;
  assert.equal(reply.content, "Here is the answer.");
  assert.deepEqual(reply.meta!.issues, []);
  store.close();
});
test("a truncated empty answer explains the budget instead of a bare limit", async () => {
  const { store, engine } = fixture([
    { text: "", truncated: true },
    { text: "", truncated: true },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, {
      route: "claude",
      deepResearch: true,
    }),
  );
  const issues = s.messages.at(-1)!.meta!.issues;
  assert.ok(
    issues.some((i) => /whole output budget on reasoning/.test(i)),
    "issues were: " + issues.join("; "),
  );
  store.close();
});

// ---------------------------------------------------------------------------
// Meshed reasoning: the orchestrator delegating to the worker tier
const delegateCall = (id: string, input: unknown) => ({
  id,
  name: "delegate",
  input,
});
test("deep research delegates sub-tasks to the worker tier in one parallel batch", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", {
          task: "Summarise part one",
          input: "AAA",
          label: "part one",
        }),
        delegateCall("d2", {
          task: "Summarise part two",
          input: "BBB",
          label: "part two",
        }),
      ],
    },
    { text: "one is about A" },
    { text: "two is about B" },
    { text: "Both parts covered." },
  ]);
  const events: string[] = [];
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
    (e) => {
      if (e.type === "delegated") events.push(`${e.task}:${e.done}`);
    },
  );
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["claude", "claude", "claude", "claude"],
  );
  // The two sub-tasks ran on the worker model, not the orchestrator's.
  assert.deepEqual(
    [requests[1].model, requests[2].model],
    [
      DEFAULT_SETTINGS.anthropicWorkerModel,
      DEFAULT_SETTINGS.anthropicWorkerModel,
    ],
  );
  assert.deepEqual([requests[0].tier, requests[3].tier], ["deep", "deep"]);
  // Workers run in a fresh context: the conversation never reaches them.
  const worker = JSON.stringify(requests[1].messages);
  assert.ok(worker.includes("AAA"));
  assert.ok(!worker.includes("Hello"), "the worker saw the conversation");
  assert.ok(!requests[1].tools, "workers must have no tools");
  // Both results come back to the orchestrator on its next turn.
  const back = JSON.stringify(requests[3].messages);
  assert.ok(back.includes("one is about A") && back.includes("two is about B"));
  assert.deepEqual(events, [
    "part one:false",
    "part two:false",
    "part one:true",
    "part two:true",
  ]);
  assert.equal(s.messages.at(-1)!.meta!.delegated, 2);
  store.close();
});
test("a delegated sub-task is schema-checked and corrected once", async () => {
  const schema = {
    type: "object",
    required: ["items"],
    properties: { items: { type: "array" } },
  };
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", {
          role: "worker",
          task: "Extract",
          input: "x",
          schema,
        }),
      ],
    },
    { text: "not json at all" },
    { text: '{"items":["a","b"]}' },
    { text: "Found two items." },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.equal(requests.length, 4, "one correction pass, not more");
  assert.match(
    JSON.stringify(requests[2].messages),
    /Rejected: /,
    "the repair pass should tell the subagent what was wrong",
  );
  // The corrected result reaches the orchestrator as a parsed object.
  const handback = JSON.stringify(requests[3].messages);
  assert.ok(handback.includes("items") && handback.includes("a"));
  assert.ok(!handback.includes("not json at all"));
  assert.equal(s.messages.at(-1)!.content, "Found two items.");
  store.close();
});
test("delegation is capped per turn and the cap is reported to the model", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", { role: "worker", task: "one", input: "a" }),
        delegateCall("d2", { role: "worker", task: "two", input: "b" }),
      ],
    },
    { text: "first result" },
    { text: "Done with what I could." },
  ]);
  settings.save({ ...settings.get(), delegationLimit: 1 }, {});
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.deepEqual(
    requests.map((r) => r.tier ?? "role"),
    ["deep", "role", "deep"],
    "only one sub-task should have been delegated",
  );
  assert.match(JSON.stringify(requests[2].messages), /Delegation limit/);
  store.close();
});
test("delegation is unavailable to the quick tier", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", { role: "worker", task: "one", input: "a" }),
      ],
    },
    { text: "Answered myself." },
  ]);
  await engine.send(req(store.newSession("", false).id));
  assert.deepEqual(
    requests.map((r) => r.tier),
    ["quick", "quick"],
  );
  assert.match(JSON.stringify(requests[1].messages), /not available/);
  store.close();
});
test("a private chat still delegates, and only ever to Claude", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", {
          role: "worker",
          task: "Read the note",
          paths: ["/knowledge/secret"],
        }),
      ],
    },
    { text: "the note says classified" },
    { text: "Summarised." },
  ]);
  store.write({
    path: "/knowledge/secret",
    kind: "fact",
    title: "Secret",
    content: "SENSITIVE_BODY",
    summary: "classified",
    private: true,
  });
  await engine.send(req(store.newSession("", true).id, { deepResearch: true }));
  assert.ok(
    requests.every((r) => r.provider === "claude"),
    "a private chat must never leave Anthropic, delegation included",
  );
  assert.match(JSON.stringify(requests[1].messages), /SENSITIVE_BODY/);
  store.close();
});
test("a Haiku worker is sent without adaptive thinking or effort", async () => {
  const { store, settings } = fixture();
  settings.save(
    { ...DEFAULT_SETTINGS, anthropicWorkerModel: "claude-haiku-4-5" },
    { anthropic: "fake-test-key" },
  );
  const bodies: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return new Response(
      JSON.stringify({
        id: "test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const clients = new Clients(settings, fetcher);
  const base = {
    provider: "claude" as const,
    system: "Worker",
    messages: [{ role: "user", content: "task" }],
    maxTokens: 1024,
    thinking: true,
    purpose: "test",
  };
  await clients.complete({ ...base, tier: "worker" });
  await clients.complete({ ...base, tier: "quick" });
  // Haiku 4.5 rejects output_config.effort and adaptive thinking.
  assert.equal(bodies[0].model, "claude-haiku-4-5");
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[0].output_config, undefined);
  // The quick tier is a current model and keeps both.
  assert.equal(bodies[1].model, DEFAULT_SETTINGS.anthropicQuickModel);
  assert.equal(bodies[1].thinking.type, "adaptive");
  assert.equal(bodies[1].output_config.effort, DEFAULT_SETTINGS.effort);
  store.close();
});
test("each tier is priced from its own table", async () => {
  const { store, engine } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", { role: "worker", task: "one", input: "a" }),
      ],
    },
    { text: "worker result" },
    { text: "Done." },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  const calls = store.dashboard().recent;
  const worker = calls.find((c) => c.tier === "delegate")!;
  const answer = calls.find((c) => c.tier === "answer")!;
  // Same token counts from the fake transport, so a cheaper worker table must
  // produce a strictly smaller cost than the orchestrator's.
  assert.ok(worker.cost > 0 && answer.cost > 0);
  assert.ok(
    worker.cost < answer.cost,
    `worker ${worker.cost} should cost less than orchestrator ${answer.cost}`,
  );
  assert.ok(s.messages.at(-1)!.meta!.cost > 0);
  store.close();
});

// ---------------------------------------------------------------------------
// Named roles and the council
const note = (stance: string) =>
  JSON.stringify({ stance, moves: [], assumptions: [], uncertainties: [] });
const reply = (revised: string) =>
  JSON.stringify({ agrees: [], challenges: [], builds: [], revised });
test("a role runs on its own provider, model and effort", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [
        delegateCall("d1", { role: "strategist", task: "Frame this" }),
      ],
    },
    { text: "a different framing" },
    { text: "Noted." },
  ]);
  settings.save({ ...settings.get(), openaiModel: "chosen-by-user" }, {});
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.equal(requests[1].provider, "chatgpt");
  assert.equal(requests[1].model, "chosen-by-user");
  assert.equal(requests[1].effort, "high");
  // The subagent never sees the conversation.
  assert.ok(!JSON.stringify(requests[1].messages).includes("Hello"));
  store.close();
});
test("a private chat offers only Claude roles", async () => {
  const { store, engine } = fixture();
  const open = store.newSession("", false);
  const shut = store.newSession("", true);
  assert.ok(engine.availableRoles(open).some((r) => r.provider === "chatgpt"));
  assert.ok(engine.availableRoles(shut).every((r) => r.provider === "claude"));
  assert.ok(engine.availableRoles(shut).length > 0, "Claude roles must remain");
  store.close();
});
test("an unconfigured provider's role is never offered", async () => {
  const { store, engine, settings } = fixture();
  settings.forget("openai");
  const s = store.newSession("", false);
  assert.ok(!engine.availableRoles(s).some((r) => r.id === "strategist"));
  store.close();
});
test("a subagent's full output is written to a sidechain node", async () => {
  const { store, engine } = fixture([
    {
      text: "",
      toolCalls: [delegateCall("d1", { role: "worker", task: "Summarise" })],
    },
    { text: "SUBAGENT_LONG_OUTPUT" },
    { text: "Done." },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  const side = store
    .all()
    .find((n) => n.path.includes("/subagents/") && n.kind === "artifact");
  assert.ok(side, "no sidechain node was written");
  assert.equal(store.read(side!.path).content, "SUBAGENT_LONG_OUTPUT");
  // The transcript is addressable, so the orchestrator can page it in later.
  assert.ok(!s.messages.at(-1)!.content.includes("SUBAGENT_LONG_OUTPUT"));
  store.close();
});
test("a read-capable role may read memory but never write it", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [delegateCall("d1", { role: "critic", task: "Check /rules" })],
    },
    {
      text: "",
      toolCalls: [
        { id: "t1", name: "tree_ls", input: { path: "/rules" } },
        {
          id: "t2",
          name: "tree_write",
          input: {
            path: "/rules/sneaky",
            kind: "rule",
            title: "x",
            content: "x",
            summary: "x",
          },
        },
      ],
    },
    { text: "The rules look fine." },
    { text: "Done." },
  ]);
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  const handback = JSON.stringify(requests[2].messages);
  assert.match(handback, /may only read memory/);
  assert.equal(store.get("/rules/sneaky"), undefined);
  assert.equal(store.proposals().length, 0, "no write may even be proposed");
  store.close();
});
test("a council writes independent notes first, then exchanges them", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [
        {
          id: "c1",
          name: "council",
          input: { question: "Ship or wait?", material: "the facts" },
        },
      ],
    },
    { text: note("SHIP_NOW") },
    { text: note("WAIT_A_WEEK") },
    { text: reply("still ship") },
    { text: reply("concede, ship") },
    { text: "The council agrees: ship." },
  ]);
  settings.save({ ...settings.get(), councilSeats: 2 }, {});
  const seen: string[] = [];
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
    (e) => {
      if (e.type === "council") seen.push(`${e.role}:${e.round}:${e.done}`);
    },
  );
  // Two participants, two rounds, then the orchestrator's own answer.
  assert.equal(requests.length, 6);
  const round1 = requests.slice(1, 3).map((r) => JSON.stringify(r.messages));
  assert.ok(
    round1.every((m) => !m.includes("SHIP_NOW") && !m.includes("WAIT_A_WEEK")),
    "round one must be written in isolation",
  );
  const round2 = requests.slice(3, 5).map((r) => JSON.stringify(r.messages));
  assert.ok(
    round2.some((m) => m.includes("SHIP_NOW")) &&
      round2.some((m) => m.includes("WAIT_A_WEEK")),
    "round two must carry the other participants' notes verbatim",
  );
  // Different vendors by default: a Claude critic and a ChatGPT strategist.
  assert.deepEqual([requests[1].provider, requests[2].provider].sort(), [
    "chatgpt",
    "claude",
  ]);
  assert.deepEqual(s.messages.at(-1)!.meta!.council, [
    "Critic (Claude)",
    "Strategist (ChatGPT)",
  ]);
  assert.ok(seen.includes("Critic:1:false") && seen.includes("Critic:2:true"));
  // The whole exchange is kept as one addressable node.
  assert.ok(store.all().some((n) => n.path.includes("/subagents/council")));
  store.close();
});
test("a council seats the orchestrator when only one council role exists", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "council", input: { question: "Which?" } }],
    },
    { text: note("A") },
    { text: note("B") },
    { text: reply("A") },
    { text: reply("B") },
    { text: "Settled." },
  ]);
  settings.forget("openai");
  settings.forget("gemini");
  settings.forget("deepseek");
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.deepEqual(s.messages.at(-1)!.meta!.council, [
    "Orchestrator (Claude)",
    "Critic (Claude)",
  ]);
  assert.ok(requests.slice(1).every((r) => r.provider === "claude"));
  store.close();
});
test("one exchange round can be configured away", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "council", input: { question: "Which?" } }],
    },
    { text: note("A") },
    { text: note("B") },
    { text: "Settled." },
  ]);
  settings.save({ ...settings.get(), councilRounds: 1, councilSeats: 2 }, {});
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.equal(requests.length, 4, "one round means two participant calls");
  store.close();
});

test("a council seats one vendor at a time before doubling up", () => {
  const role = (id: string, provider: Provider): Role => ({
    id,
    name: id,
    purpose: "test",
    provider,
    model: "m",
    effort: "high",
    context: "isolated",
    tools: "none",
    maxTokens: 1024,
    council: true,
  });
  const pool = [
    role("a", "claude"),
    role("b", "claude"),
    role("c", "chatgpt"),
    role("d", "gemini"),
  ];
  assert.deepEqual(
    Engine.diverseSeats(pool, 3).map((r) => r.id),
    ["a", "c", "d"],
    "a second Claude seat must not displace another vendor",
  );
  assert.deepEqual(
    Engine.diverseSeats(pool, 2).map((r) => r.id),
    ["a", "c"],
  );
  // Only once every vendor is seated does a second seat go to one of them.
  assert.deepEqual(
    Engine.diverseSeats(pool, 4).map((r) => r.id),
    ["a", "c", "d", "b"],
  );
});
test("a council convenes across vendors and is capped by councilSeats", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "council", input: { question: "Which?" } }],
    },
    { text: note("A") },
    { text: note("B") },
    { text: note("C") },
    { text: "Settled." },
  ]);
  settings.save(
    { ...settings.get(), councilRounds: 1, deepseekModel: "ds" },
    {},
  );
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  // Four council roles are configured; three seats, one per vendor.
  assert.equal(requests.length, 5);
  assert.deepEqual(
    requests.slice(1, 4).map((r) => r.provider),
    ["claude", "chatgpt", "gemini"],
  );
  assert.deepEqual(s.messages.at(-1)!.meta!.council, [
    "Critic (Claude)",
    "Strategist (ChatGPT)",
    "Analyst (Gemini)",
  ]);
  store.close();
});
test("a single-vendor council says so rather than reading consensus into it", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "council", input: { question: "Which?" } }],
    },
    { text: note("A") },
    { text: note("B") },
    { text: "Settled." },
  ]);
  settings.save({ ...settings.get(), councilRounds: 1 }, {});
  settings.forget("openai");
  settings.forget("gemini");
  settings.forget("deepseek");
  await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  const handback = JSON.stringify(requests[3].messages);
  assert.match(handback, /singleVendor/);
  assert.match(handback, /one vendor agreeing with itself/);
  store.close();
});
test("a private council names Claude-only as the reason", async () => {
  const { store, engine, settings, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "council", input: { question: "Which?" } }],
    },
    { text: note("A") },
    { text: note("B") },
    { text: "Settled." },
  ]);
  settings.save({ ...settings.get(), councilRounds: 1 }, {});
  await engine.send(req(store.newSession("", true).id, { deepResearch: true }));
  assert.ok(requests.every((r) => r.provider === "claude"));
  assert.match(
    JSON.stringify(requests[3].messages),
    /because this chat is private/,
  );
  store.close();
});

// ---------------------------------------------------------------------------
// Cache-correct context, digests, branching
test("the settled transcript is a cacheable prefix and volatile context follows it", async () => {
  const { store, engine, requests } = fixture([
    { text: "First answer." },
    { text: "Second answer." },
  ]);
  const session = store.newSession("", false);
  await engine.send(req(session.id, { text: "First question" }));
  await engine.send(req(session.id, { text: "Second question" }));
  const second = requests[1].messages;
  // settled turns, then the memory envelope, then the new question.
  assert.deepEqual(
    second.map((m) => m.role),
    ["user", "assistant", "user", "user"],
  );
  assert.equal(second[0].content, "First question");
  assert.equal(second[1].content, "First answer.");
  assert.match(String(second[2].content), /MEMORY SUMMARIES/);
  assert.equal(second[3].content, "Second question");
  // The breakpoint sits on the last block that is identical next turn.
  assert.equal(second[1].cache, true);
  assert.equal(second.filter((m) => m.cache).length, 1);
  // The first two messages are byte-identical to what was sent last turn.
  assert.equal(requests[0].messages.at(-1)!.content, "First question");
  store.close();
});
test("a summary already in the window is not sent again", async () => {
  const { store, engine, requests } = fixture([
    { text: "One." },
    { text: "Two." },
  ]);
  store.write({
    path: "/knowledge/kafka",
    kind: "fact",
    title: "Kafka",
    content: "long content",
    summary: "KAFKA_SUMMARY_SENTINEL",
  });
  const session = store.newSession("", false);
  await engine.send(req(session.id, { text: "tell me about kafka" }));
  await engine.send(req(session.id, { text: "more about kafka" }));
  const first = JSON.stringify(requests[0].messages);
  const second = JSON.stringify(requests[1].messages);
  assert.match(first, /KAFKA_SUMMARY_SENTINEL/);
  assert.ok(
    !second.includes("KAFKA_SUMMARY_SENTINEL"),
    "a summary still in the window must not be re-sent",
  );
  assert.match(second, /already supplied earlier/);
  store.close();
});
test("a changed summary is sent again", async () => {
  const { store, engine, requests } = fixture([
    { text: "One." },
    { text: "Two." },
  ]);
  const node = {
    path: "/knowledge/kafka",
    kind: "fact" as const,
    title: "Kafka",
    content: "long content",
    summary: "ORIGINAL_SUMMARY",
  };
  store.write(node);
  const session = store.newSession("", false);
  await engine.send(req(session.id, { text: "kafka" }));
  store.write({ ...node, summary: "REVISED_SUMMARY" });
  await engine.send(req(session.id, { text: "kafka" }));
  assert.match(JSON.stringify(requests[1].messages), /REVISED_SUMMARY/);
  store.close();
});
test("a long tool loop carries at most one rolling breakpoint", async () => {
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [{ id: "t1", name: "tree_ls", input: { path: "/" } }],
    },
    {
      text: "",
      toolCalls: [{ id: "t2", name: "tree_ls", input: { path: "/rules" } }],
    },
    { text: "Done." },
  ]);
  const session = store.newSession("", false);
  await engine.send(req(session.id, { text: "look around" }));
  for (const r of requests)
    assert.ok(
      r.messages.filter((m) => m.cache).length <= 2,
      "never more than the settled and rolling breakpoints",
    );
  // The rolling breakpoint moves to the newest tool result each round.
  const last = requests[2].messages;
  assert.equal(last.at(-1)!.cache, true);
  assert.equal(last.filter((m) => m.cache).length, 1);
  store.close();
});
test("a large tool result is digested by the worker instead of truncated", async () => {
  const { store, engine, requests } = fixture([{ text: "A tight digest." }]);
  const s = store.newSession("", false);
  const huge = { rows: Array.from({ length: 4000 }, (_, i) => `row ${i}`) };
  const out = JSON.parse(await engine.compress(s, "tree_search", huge));
  assert.equal(out.digested, true);
  assert.equal(out.digest, "A tight digest.");
  assert.ok(out.fullResultPath.includes("/subagents/"));
  // Digesting runs on the worker model, cheaply.
  assert.equal(requests[0].model, DEFAULT_SETTINGS.anthropicWorkerModel);
  assert.equal(requests[0].effort, "low");
  assert.equal(requests[0].purpose, "digest");
  // The raw result is still addressable.
  assert.match(store.read(out.fullResultPath).content, /row 3999/);
  store.close();
});
test("a modest tool result is still trimmed, with no extra call", async () => {
  const { store, engine, requests } = fixture();
  const s = store.newSession("", false);
  const out = await engine.compress(s, "tree_ls", { rows: ["a", "b"] });
  assert.equal(out, JSON.stringify({ rows: ["a", "b"] }));
  assert.equal(requests.length, 0, "small results must not cost a call");
  store.close();
});
test("explore works branches in parallel and scores them identically", async () => {
  const branch = (name: string) =>
    JSON.stringify({
      approach: name,
      plan: ["step"],
      risks: ["risk"],
      cost: "a day",
      killer: "the thing that kills it",
      confidence: 0.6,
    });
  const { store, engine, requests } = fixture([
    {
      text: "",
      toolCalls: [
        {
          id: "e1",
          name: "explore",
          input: {
            question: "How should we migrate?",
            approaches: [
              { name: "dual write", sketch: "write both" },
              { name: "shadow read", sketch: "read both" },
            ],
          },
        },
      ],
    },
    { text: branch("dual write") },
    { text: branch("shadow read") },
    { text: "Dual write, because…" },
  ]);
  const s = await engine.send(
    req(store.newSession("", false).id, { deepResearch: true }),
  );
  assert.equal(requests.length, 4);
  // Each branch is worked in isolation and cannot see the others.
  const one = JSON.stringify(requests[1].messages);
  assert.ok(one.includes("dual write") && !one.includes("shadow read"));
  const handback = JSON.stringify(requests[3].messages);
  assert.ok(
    handback.includes("dual write") && handback.includes("shadow read"),
  );
  assert.match(handback, /killer/);
  assert.equal(s.messages.at(-1)!.meta!.delegated, 2);
  assert.ok(store.all().some((n) => n.path.includes("/subagents/explore")));
  store.close();
});
test("automatic compaction keeps the recent turns, ending a chat folds them", async () => {
  const { store, engine } = fixture([
    { text: '{"summary":"S","decisions":[],"preferences":[]}' },
    { text: '{"summary":"S2","decisions":[],"preferences":[]}' },
  ]);
  const s = store.newSession("", false);
  s.messages = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    content: "turn " + i,
    at: new Date().toISOString(),
  }));
  store.saveSession(s);
  await engine.compact(s, false, 6);
  assert.equal(s.compacted, 6, "the last six messages stay verbatim");
  await engine.compact(s, true);
  assert.equal(s.compacted, 12, "ending the chat folds everything");
  store.close();
});
test("branching copies the thread up to a message and leaves the original", async () => {
  const { store } = fixture();
  const s = store.newSession("asgard", false);
  s.messages = ["a", "b", "c", "d"].map((t, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    content: t,
    at: new Date().toISOString(),
  }));
  store.saveSession(s);
  const forked = store.forkSession(s.id, 1);
  assert.deepEqual(
    forked.messages.map((m) => m.content),
    ["a", "b"],
  );
  assert.equal(forked.project, s.project);
  assert.match(forked.title, /^⑂ /);
  assert.notEqual(forked.id, s.id);
  // The original is untouched.
  assert.equal(store.session(s.id).messages.length, 4);
  // A private chat stays private when branched.
  const secret = store.newSession("", true);
  secret.messages = [{ role: "user", content: "x", at: "now" }];
  store.saveSession(secret);
  assert.equal(store.forkSession(secret.id, 0).private, true);
  store.close();
});

// ---------------------------------------------------------------------------
// The eval harness itself
test("the grader enforces the contract written before the task", () => {
  const base = { id: "t", category: "instruction" as const, prompt: "p" };
  const check = (expect: any, answer: string, wrote: string[] = []) =>
    grade({ ...base, expect }, answer, wrote);
  assert.equal(check({ includes: ["risk:"] }, "RISK: it breaks").pass, true);
  assert.equal(check({ includes: ["risk:"] }, "nothing here").pass, false);
  assert.equal(
    check({ excludes: ["database"] }, "A log of writes.").pass,
    true,
  );
  assert.equal(
    check({ excludes: ["database"] }, "The DATABASE writes it.").pass,
    false,
  );
  assert.equal(check({ maxWords: 3 }, "one two three").pass, true);
  assert.equal(check({ maxWords: 3 }, "one two three four").pass, false);
  assert.equal(
    check({ wrote: ["/knowledge/x"] }, "done", ["/knowledge/x"]).pass,
    true,
  );
  assert.equal(check({ wrote: ["/knowledge/x"] }, "done", []).pass, false);
  // JSON is accepted inside a fence, and a schema violation is caught.
  const schema = { type: "object", required: ["a"] };
  assert.equal(
    check({ jsonSchema: schema }, '```json\n{"a":1}\n```').pass,
    true,
  );
  assert.equal(check({ jsonSchema: schema }, '{"b":1}').pass, false);
  assert.equal(check({ jsonSchema: schema }, "not json").pass, false);
  // Every failure says what went wrong, so a report is actionable.
  assert.deepEqual(check({ includes: ["x"], maxWords: 1 }, "a b").notes, [
    'missing "x"',
    "2 words > 1",
  ]);
});
test("eval tasks keep the answer out of the prompt", () => {
  for (const task of TASKS) {
    assert.ok(task.expect, `${task.id} has no contract`);
    // An instruction-following task is graded on the format it was *told* to
    // use, so that overlap is the point. Everywhere else, finding the expected
    // answer inside the prompt means the task grades reading, not thinking.
    if (task.category === "instruction") continue;
    const surface = (task.expect.includes ?? []).filter(
      (want) =>
        want.length > 4 &&
        task.prompt.toLowerCase().includes(want.toLowerCase()),
    );
    assert.deepEqual(
      surface,
      [],
      `${task.id} leaks its answer into the prompt: ${surface.join(", ")}`,
    );
  }
  // Categories stay balanced enough that one of them cannot carry the score.
  const counts = new Map<string, number>();
  for (const t of TASKS)
    counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  for (const [category, n] of counts)
    assert.ok(n <= TASKS.length / 2, `${category} dominates the suite`);
});
test("the summary reports per-task cost, speed and cache rate", () => {
  const rows = [
    {
      pass: true,
      cost: 0.02,
      input: 900,
      output: 100,
      latency: 2000,
      cacheRate: 0.8,
      calls: 1,
      models: ["m"],
    },
    {
      pass: false,
      cost: 0.04,
      input: 1900,
      output: 100,
      latency: 4000,
      cacheRate: 0.4,
      calls: 3,
      models: ["n"],
    },
  ];
  const s = summarise("suite", rows);
  assert.equal(s.score, 0.5);
  assert.equal(s.costPerTask, 0.03);
  assert.equal(s.tokensPerTask, 1500);
  assert.equal(s.secondsPerTask, 3);
  assert.ok(Math.abs(s.cacheRate - 0.6) < 1e-9);
  assert.equal(s.callsPerTask, 2);
  // Output tokens per second is averaged per task, not over the total.
  assert.equal(s.outputTokensPerSecond, 37.5);
  assert.deepEqual(s.models, ["m", "n"]);
});

// ---------------------------------------------------------------------------
// The research tree: pre-registration, information gain, Bayes update
test("information gain is zero when every hypothesis predicts the same", () => {
  const hs = [
    { id: "a", prior: 0.5 },
    { id: "b", prior: 0.5 },
  ];
  const same = Engine.informationGain(hs, [
    { hypothesisId: "a", expects: "the latency drops" },
    { hypothesisId: "b", expects: "The latency drops " },
  ]);
  assert.equal(same.distinct, 1, "wording and case must not fake disagreement");
  assert.equal(same.bits, 0);
  // An even split over two outcomes is one full bit.
  const split = Engine.informationGain(hs, [
    { hypothesisId: "a", expects: "drops" },
    { hypothesisId: "b", expects: "rises" },
  ]);
  assert.equal(split.distinct, 2);
  assert.ok(Math.abs(split.bits - 1) < 1e-9);
  // A lopsided prior carries less information than an even one.
  const lopsided = Engine.informationGain(
    [
      { id: "a", prior: 0.9 },
      { id: "b", prior: 0.1 },
    ],
    [
      { hypothesisId: "a", expects: "drops" },
      { hypothesisId: "b", expects: "rises" },
    ],
  );
  assert.ok(lopsided.bits < split.bits && lopsided.bits > 0);
});
test("posteriors move toward what the outcome matched and stay a distribution", () => {
  const hs = [
    { id: "a", prior: 0.5 },
    { id: "b", prior: 0.3 },
    { id: "c", prior: 0.2 },
  ];
  const after = Engine.updatePosteriors(hs, ["a"], 0.9);
  assert.ok(Math.abs(after.reduce((n, h) => n + h.posterior, 0) - 1) < 1e-9);
  assert.ok(after.find((h) => h.id === "a")!.delta > 0);
  assert.ok(after.find((h) => h.id === "b")!.delta < 0);
  // A contradicted hypothesis is never driven to zero by one experiment.
  assert.ok(after.find((h) => h.id === "c")!.posterior > 0);
  // Low confidence moves belief less than high confidence.
  const timid = Engine.updatePosteriors(hs, ["a"], 0.55);
  assert.ok(
    timid.find((h) => h.id === "a")!.posterior <
      after.find((h) => h.id === "a")!.posterior,
  );
  // An outcome matching nothing leaves the distribution untouched.
  const nothing = Engine.updatePosteriors(hs, [], 0.9);
  for (const h of nothing) assert.ok(Math.abs(h.delta) < 1e-9);
});
test("an experiment without a prediction for every hypothesis is refused", async () => {
  const { store, engine, requests } = fixture();
  const s = store.newSession("", false);
  await assert.rejects(
    engine.experiment(s, {
      topic: "latency",
      hypotheses: [
        { id: "cache", claim: "the cache is cold", prior: 0.5 },
        { id: "io", claim: "disk io is the limit", prior: 0.5 },
      ],
      experiment: "measure a warm run",
      predictions: [{ hypothesisId: "cache", expects: "drops" }],
    }),
    /io have no prediction/,
  );
  assert.equal(requests.length, 0, "a refusal must not cost a call");
  store.close();
});
test("an experiment that cannot discriminate is refused before it runs", async () => {
  const { store, engine, requests } = fixture();
  const s = store.newSession("", false);
  await assert.rejects(
    engine.experiment(s, {
      topic: "latency",
      hypotheses: [
        { id: "cache", claim: "cold cache", prior: 0.5 },
        { id: "io", claim: "disk io", prior: 0.5 },
      ],
      experiment: "run it again and see",
      predictions: [
        { hypothesisId: "cache", expects: "it will be slow" },
        { hypothesisId: "io", expects: "it will be slow" },
      ],
    }),
    /cannot discriminate/,
  );
  assert.equal(requests.length, 0, "a refusal must not cost a call");
  store.close();
});
test("a run experiment writes a node holding its pre-registration and posteriors", async () => {
  const { store, engine, requests } = fixture([
    {
      text: JSON.stringify({
        outcome: "warm run was 8x faster",
        evidence: ["cold 3.2s", "warm 0.4s"],
        matches: ["cache"],
        confidence: 0.9,
      }),
    },
    { text: '{"ok":true,"issues":[],"confidence":0.85}' },
  ]);
  const s = store.newSession("", false);
  const step = await engine.experiment(s, {
    topic: "Latency regression",
    hypotheses: [
      { id: "cache", claim: "cold cache", prior: 1 },
      { id: "io", claim: "disk io", prior: 1 },
    ],
    experiment: "compare a cold run with a warm run",
    predictions: [
      { hypothesisId: "cache", expects: "warm is much faster" },
      { hypothesisId: "io", expects: "warm is no faster" },
    ],
  });
  // Priors were normalised, and an even split over two outcomes is one bit.
  assert.equal(step.result.informationGain, 1);
  assert.equal(step.result.leader.id, "cache");
  assert.ok(step.result.leader.posterior > 0.5);
  const node = JSON.parse(store.read(step.result.node).content);
  assert.equal(node.preRegistered.length, 2);
  assert.equal(node.outcome, "warm run was 8x faster");
  assert.equal(node.review.ok, true);
  // The review ran on a different vendor from the worker.
  assert.equal(requests[0].provider, "claude");
  assert.notEqual(requests[1].provider, requests[0].provider);
  assert.equal(requests[1].purpose, "review");
  // And the report exists alongside it.
  assert.ok(store.get("/research/latency-regression/report"));
  store.close();
});
test("a failed review caps how far one experiment can move belief", async () => {
  const outcome = {
    text: JSON.stringify({
      outcome: "it looked faster",
      evidence: ["felt quick"],
      matches: ["cache"],
      confidence: 0.99,
    }),
  };
  const run = async (verdict: string) => {
    const { store, engine } = fixture([outcome, { text: verdict }]);
    const s = store.newSession("", false);
    const step = await engine.experiment(s, {
      topic: "t",
      hypotheses: [
        { id: "cache", claim: "c", prior: 0.5 },
        { id: "io", claim: "i", prior: 0.5 },
      ],
      experiment: "e",
      predictions: [
        { hypothesisId: "cache", expects: "fast" },
        { hypothesisId: "io", expects: "slow" },
      ],
    });
    store.close();
    return step.result.leader.posterior;
  };
  const trusted = await run('{"ok":true,"issues":[],"confidence":0.9}');
  const doubted = await run(
    '{"ok":false,"issues":["no numbers"],"confidence":0.9}',
  );
  assert.ok(
    doubted < trusted,
    `a rejected result must move belief less (${doubted} vs ${trusted})`,
  );
  assert.ok(doubted > 0.5, "but it is still weak evidence, not none");
});
test("the research report ranks by belief moved, not by order", async () => {
  const { store, engine } = fixture([
    {
      text: JSON.stringify({
        outcome: "decisive",
        evidence: ["e"],
        matches: ["a"],
        confidence: 0.95,
      }),
    },
    { text: '{"ok":true,"issues":[],"confidence":0.95}' },
    {
      text: JSON.stringify({
        outcome: "inconclusive",
        evidence: ["e"],
        matches: [],
        confidence: 0.5,
      }),
    },
    { text: '{"ok":true,"issues":[],"confidence":0.5}' },
  ]);
  const s = store.newSession("", false);
  const base = {
    topic: "t",
    hypotheses: [
      { id: "a", claim: "a", prior: 0.5 },
      { id: "b", claim: "b", prior: 0.5 },
    ],
    predictions: [
      { hypothesisId: "a", expects: "x" },
      { hypothesisId: "b", expects: "y" },
    ],
  };
  await engine.experiment(s, { ...base, experiment: "the decisive one" });
  await engine.experiment(s, {
    ...base,
    experiment: "the one that taught nothing",
  });
  const report = JSON.parse(store.read("/research/t/report").content);
  assert.equal(report.steps, 2);
  assert.equal(report.movedMost[0].experiment, "the decisive one");
  assert.equal(report.inconclusive, 1);
  store.close();
});
