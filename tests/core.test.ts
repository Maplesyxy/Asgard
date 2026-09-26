import { Clients } from "../src/main/providers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, isRaw } from "../src/main/store";
import { SettingsStore } from "../src/main/settings";
import { Engine, verify, TOOLS } from "../src/main/engine";
import { ModelReply, ModelRequest, Transport } from "../src/main/providers";
import { DEFAULT_SETTINGS, SendRequest } from "../src/shared/types";
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
    {},
  );
  const requests: ModelRequest[] = [];
  const transport: Transport = {
    async complete(req) {
      requests.push(structuredClone(req));
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
        model:
          req.provider === "opus" ? "claude-opus-5-5" : "user-selected-model",
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
  highStakes: false,
  checks: { format: "text", requiredText: [] },
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
  const ls = engine.tool(s, "opus", "tree_ls", { path: "/knowledge" }) as any[];
  assert.equal(ls.length, 1);
  assert.equal(ls[0].content, undefined);
  assert.equal(
    (
      engine.tool(s, "opus", "tree_ls", {
        path: "/knowledge",
        depth: 2,
      }) as any[]
    ).length,
    2,
  );
  assert.equal(
    (
      engine.tool(s, "opus", "tree_read", {
        path: "/knowledge/nest/leaf",
      }) as any
    ).content,
    "full content",
  );
  assert.equal(
    (engine.tool(s, "opus", "tree_search", { query: "content" }) as any[])
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
  engine.tool(s, "opus", "tree_move", {
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
  const p = engine.tool(store.newSession("", false), "opus", "tree_archive", {
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
test("all DeepSeek read tools block private data and filtered searches omit it", () => {
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
  engine.tool(s, "opus", "tree_write", {
    path: "/rules/tone",
    kind: "rule",
    title: "Tone",
    content: "Concise",
    summary: "Concise",
  });
  assert.equal(store.get("/rules/tone"), undefined);
  engine.decide(store.proposals()[0].id, true);
  assert.equal(store.get("/rules/tone")?.content, "Concise");
  engine.tool(s, "opus", "tree_archive", { path: "/rules/tone" });
  assert.ok(store.get("/rules/tone"));
  engine.decide(store.proposals()[0].id, false);
  assert.ok(store.get("/rules/tone"));
  put(store, "/knowledge/rule");
  engine.tool(s, "opus", "tree_move", {
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
test("easy confidence >= .7 routes DeepSeek", async () => {
  const { store, engine, requests } = fixture([easy, { text: "Hello!" }]);
  await engine.send(req(store.newSession("", false).id));
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["deepseek", "deepseek"],
  );
  store.close();
});
test("hard and low-confidence classifications route Opus", async () => {
  for (const c of [
    { tier: "hard", confidence: 1, reason: "Planning" },
    { tier: "easy", confidence: 0.69, reason: "Uncertain" },
  ]) {
    const { store, engine, requests } = fixture([
      { text: JSON.stringify(c) },
      { text: "Answer" },
    ]);
    await engine.send(req(store.newSession("", false).id));
    assert.deepEqual(
      requests.map((r) => r.provider),
      ["deepseek", "opus"],
    );
    store.close();
  }
});
test("invalid classifier fails closed to Opus", async () => {
  const { store, engine, requests } = fixture([
    { text: "invalid" },
    { text: "Answer" },
  ]);
  await engine.send(req(store.newSession("", false).id));
  assert.equal(requests[1].provider, "opus");
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
    ["opus"],
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
    ["opus"],
  );
  store.close();
});
test("private Opus tool read taints subsequent turns and derived writes", async () => {
  const { store, engine } = fixture();
  put(store, "/profile/secret", "private", true);
  const s = store.newSession("", false);
  engine.tool(s, "opus", "tree_read", { path: "/profile/secret" });
  engine.tool(s, "opus", "tree_write", {
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
test("failed JSON schema escalates once to Opus", async () => {
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
    ["deepseek", "opus"],
  );
  assert.equal(s.messages[1].meta?.escalated, true);
  assert.equal(s.messages[1].meta?.verified, true);
  store.close();
});
test("Opus validation failures never call DeepSeek", async () => {
  const { store, engine, requests } = fixture([{ text: "no json" }]);
  const s = await engine.send(
    req(store.newSession("", false).id, {
      route: "opus",
      checks: { format: "json", requiredText: [] },
    }),
  );
  assert.equal(s.messages[1].meta?.verified, false);
  assert.deepEqual(
    requests.map((r) => r.provider),
    ["opus"],
  );
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
  assert.equal(requests[0].provider, "deepseek");
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
test("private compaction uses only Opus and marks summaries and decisions private", async () => {
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
  assert.equal(requests[0].provider, "opus");
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
  const read = engine.tool(s, "opus", "tree_read", {
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
    provider: "opus",
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
  assert.deepEqual(d.routes, [
    { provider: "deepseek", count: 1 },
    { provider: "opus", count: 1 },
  ]);
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
    provider: "opus",
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
      provider: "opus",
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
