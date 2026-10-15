import Ajv from "ajv";
import { Store } from "../src/main/store";
import { SettingsStore } from "../src/main/settings";
import { Engine } from "../src/main/engine";
import { Clients, ModelRequest, Transport } from "../src/main/providers";
import { DEFAULT_SETTINGS, Settings } from "../src/shared/types";
import { TASKS, Task } from "./tasks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * The eval harness. It runs the same task set through several harness
 * configurations and reports, per configuration: pass rate, tokens, estimated
 * cost per task, wall-clock per task and cache hit rate.
 *
 * It measures the harness, not the model: the only honest comparison is
 * between two configurations over the same tasks on the same day, which is why
 * every report records the models that actually ran.
 */
export interface Config {
  name: string;
  deepResearch?: boolean;
  highStakes?: boolean;
  settings?: Partial<Settings>;
}
export const CONFIGS: Config[] = [
  { name: "quick", settings: { delegationLimit: 0 } },
  { name: "deep", deepResearch: true },
  { name: "deep+review", deepResearch: true, highStakes: true },
];
const ajv = new Ajv({ allErrors: true, strict: false });
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Grade one answer against the contract written before the task ran. */
export function grade(task: Task, answer: string, wrote: string[]) {
  const notes: string[] = [];
  const text = answer.toLowerCase();
  for (const want of task.expect.includes ?? [])
    if (!text.includes(want.toLowerCase())) notes.push(`missing "${want}"`);
  for (const avoid of task.expect.excludes ?? [])
    if (text.includes(avoid.toLowerCase())) notes.push(`contains "${avoid}"`);
  if (task.expect.maxWords && words(answer) > task.expect.maxWords)
    notes.push(`${words(answer)} words > ${task.expect.maxWords}`);
  for (const path of task.expect.wrote ?? [])
    if (!wrote.includes(path)) notes.push(`did not write ${path}`);
  if (task.expect.jsonSchema) {
    try {
      const parsed = JSON.parse(
        answer.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
      );
      if (!ajv.compile(task.expect.jsonSchema)(parsed))
        notes.push("schema mismatch");
    } catch {
      notes.push("not JSON");
    }
  }
  return { pass: notes.length === 0, notes };
}
const secure = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
/** A scripted transport so the harness itself can be exercised without spend. */
export function dryTransport(): Transport {
  return {
    async complete(r: ModelRequest) {
      const text = r.tools?.length ? "RISK: dry run" : "dry run";
      return {
        text,
        toolCalls: [],
        wire: { role: "assistant", content: [{ type: "text", text }] },
        input: 1200,
        cached: 900,
        cacheWrite: 0,
        output: 60,
        model: r.model || "dry",
      };
    },
  };
}
export async function runSuite(config: Config, live: boolean) {
  const rows: any[] = [];
  for (const task of TASKS) {
    const store = new Store(":memory:");
    const settings = new SettingsStore(store, secure);
    settings.save(
      { ...DEFAULT_SETTINGS, ...config.settings },
      live
        ? {
            anthropic: process.env.ANTHROPIC_API_KEY ?? "",
            openai: process.env.OPENAI_API_KEY ?? "",
          }
        : { anthropic: "dry" },
    );
    for (const [path, title, summary, content] of task.memory ?? [])
      store.write({ path, kind: "fact", title, content, summary });
    const before = new Set(store.all().map((n) => n.path));
    const engine = new Engine(
      store,
      settings,
      live ? new Clients(settings) : dryTransport(),
    );
    const session = store.newSession("", false);
    const started = Date.now();
    let answer = "",
      failure = "";
    try {
      const saved = await engine.send({
        sessionId: session.id,
        text: task.prompt,
        route: "auto",
        deepResearch: !!config.deepResearch,
        highStakes: !!config.highStakes,
        checks: {
          format: task.checks?.format ?? "text",
          jsonSchema: task.checks?.jsonSchema,
          requiredText: task.checks?.requiredText ?? [],
        },
        attachmentIds: [],
      });
      answer = saved.messages.at(-1)?.content ?? "";
    } catch (e) {
      failure = e instanceof Error ? e.message : "failed";
    }
    const latency = Date.now() - started;
    const wrote = store
      .all()
      .map((n) => n.path)
      .filter((p) => !before.has(p));
    const scored = failure
      ? { pass: false, notes: [failure] }
      : grade(task, answer, wrote);
    const d = store.dashboard();
    rows.push({
      task: task.id,
      category: task.category,
      pass: scored.pass,
      notes: scored.notes,
      calls: d.calls,
      input: d.input,
      output: d.output,
      cached: d.cached,
      cacheRate: d.cacheRate,
      cost: d.cost,
      latency,
      models: [...new Set(d.recent.map((c) => c.model))],
    });
    store.close();
  }
  return rows;
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export function summarise(name: string, rows: any[]) {
  const passed = rows.filter((r) => r.pass).length;
  return {
    config: name,
    tasks: rows.length,
    passed,
    score: passed / Math.max(1, rows.length),
    costPerTask: mean(rows.map((r) => r.cost)),
    tokensPerTask: mean(rows.map((r) => r.input + r.output)),
    secondsPerTask: mean(rows.map((r) => r.latency)) / 1000,
    outputTokensPerSecond: mean(
      rows.map((r) => (r.latency ? (r.output * 1000) / r.latency : 0)),
    ),
    cacheRate: mean(rows.map((r) => r.cacheRate)),
    callsPerTask: mean(rows.map((r) => r.calls)),
    models: [...new Set(rows.flatMap((r) => r.models))],
  };
}
async function main() {
  const live = process.argv.includes("--live");
  if (live && !process.env.ANTHROPIC_API_KEY) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment.");
    process.exit(1);
  }
  const only = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
  const configs = only ? CONFIGS.filter((c) => c.name === only) : CONFIGS;
  const report: any = {
    at: new Date().toISOString(),
    mode: live ? "live" : "dry",
    suites: [],
  };
  for (const config of configs) {
    const rows = await runSuite(config, live);
    const summary = summarise(config.name, rows);
    report.suites.push({ ...summary, rows });
    console.log(
      `\n${config.name}: ${summary.passed}/${summary.tasks} passed` +
        `  ·  $${summary.costPerTask.toFixed(4)}/task` +
        `  ·  ${Math.round(summary.tokensPerTask)} tok/task` +
        `  ·  ${summary.secondsPerTask.toFixed(1)}s/task` +
        `  ·  cache ${(summary.cacheRate * 100).toFixed(0)}%`,
    );
    for (const row of rows)
      if (!row.pass) console.log(`   ✗ ${row.task}: ${row.notes.join("; ")}`);
  }
  mkdirSync(join(process.cwd(), "work/evals"), { recursive: true });
  const file = join(
    process.cwd(),
    `work/evals/${report.mode}-${Date.now()}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${file}`);
  if (!live)
    console.log(
      "dry mode exercises the harness only; scores are meaningless without --live.",
    );
}
if (process.argv[1]?.includes("evals")) void main();
