# PLAN.md

> Created at the start; updated throughout. Checkboxes require verification evidence.

## Task

Build Asgard, a double-clickable local Electron desktop harness for Astro with hierarchical SQLite memory and two-provider routing.

## Context

Empty workspace. Host: macOS Apple Silicon (Darwin arm64). Node 18 is the shell default but is NOT usable: electron-builder require()s ESM-only deps and needs >=22.12.0 (pinned in .nvmrc / engines / a preflight guard in scripts/build.mjs). Provider credentials and the DeepSeek model ID have not been supplied. Memory stays in SQLite; only explicit provider calls leave the app.

## Approach

Build a typed main-process domain layer and narrowly scoped preload bridge, then the React interface. Exercise the real SQLite implementation and fake provider transports in automated tests. Build and launch Electron locally, then package a macOS DMG. Distinguish local verification from live API and OS-launch checks.

## Milestones

- [x] M1: Electron + React + TypeScript, SQLite, first window | verify: npm run dev opens a window and creates a database.
- [x] M2: Tree schema, tools, FTS5, browser | verify: all tree-tool unit tests pass.
- [ ] M3: safeStorage settings, provider adapters, chat | verify: real message round-trip to both providers and no keys in logs or returned renderer data.
- [ ] M4: Router, context, caching | verify: easy/hard/privacy tests and live cached tokens > 0 on second eligible call.
- [x] M5: Compaction, decision nodes, rule proposals | verify: summary/decisions exist and raw is absent from subsequent automatic context.
- [x] M6: Deterministic checks, retry, high-stakes review | verify: failing schema escalates to Opus and review/revision flow tests pass.
- [x] M7: Calls, dashboard, context inspector | verify: aggregate totals match seeded calls.
- [x] Final: macOS arm64 installer | verify: installed app opens through the OS and npm test passes.

## Scope boundaries

### In scope

Single local persona, Electron/React/TS, better-sqlite3/FTS5, secure credentials, explicit private-content routing, tree tools, bounded context, compaction, approvals, verification, cost dashboard, packaging.

### Out of scope

Agent shell/filesystem tools, browsing, extra models, swarm reasoning, telemetry, cloud sync. Stored milestone checks are evaluated as structured checks; arbitrary shell commands are displayed for the user, never executed by the agent.

## Open questions

- User will enter the DeepSeek model ID and provider keys in Settings.
- The requested default claude-opus-5-5 is configurable; its availability requires verification against the user's account.
- Signing/notarization credentials are not provided; local installer may be unsigned.

## Risks

- Dependency downloads and native SQLite compilation require network and build tooling.
- Live model and prompt-cache checks cannot pass without credentials and an available model.
- OS secure storage must be available; saving credentials fails closed otherwise.

## Notes

_Created: 2026-09-25_

- Initial plan recorded before application code.

- Local verification: `npm test` passes 34 tests against real FTS5 SQLite and deterministic provider transports. `npm run build` passes TypeScript and Vite. M2/M5/M6/M7 verified.
- Dependency installation uses a workspace cache and Node 22.22.1 (see .nvmrc). The native SQLite module is installed for Electron’s ABI using `scripts/native.mjs`.
- M1 verified 2026-09-25: `npm run dev` serves the renderer on 127.0.0.1:5173 (HTTP 200) with Electron
  attached; a smoke run against that dev server reports title "Asgard · Astro", bridge=true,
  nodeIntegration=false, secureStorage=true, 7 seeded nodes, and renders a full frame (work/smoke.png).
- Final verified 2026-09-25: `npm run dist` produced outputs/installer/Asgard-1.0.0-arm64.dmg (123 MB,
  unsigned, identity null). outputs/installer/mac-arm64/Asgard.app launched via macOS `open`, ran as a
  process, and opened its SQLite store in ~/Library/Application Support/Asgard. `npm test` passes 34/34.
- Packaging previously failed under Node 18 with ERR_REQUIRE_ESM from @noble/hashes via
  app-builder-lib. Fixed by pinning the runtime, not by changing dependencies.
- The --smoke-test screenshot captured on did-finish-load, before first paint, so it always wrote a
  blank backgroundColor frame. It now settles document.fonts plus two rAFs before capturePage.
- M3 and M4 live API/cache checks remain pending; simulated transport checks are not represented as
  live verification.
- 2026-09-26: Interface and provider work.
  - Assistant replies render GFM markdown (`react-markdown` + `remark-gfm`). Raw HTML is skipped,
    links render inert (the renderer never navigates) and images are replaced by a label; the page
    CSP already restricts `img-src` to self/data.
  - Provider reasoning is shown in a collapsed "Line of reasoning" disclosure. It is transported on
    the send response only and stripped by `Store.saveSession`, so it is never persisted; verified by
    `reasoning reaches the renderer once but is never written to disk`.
  - Gemini added as the auto-routed cheap tier via the OpenAI-compatible endpoint. DeepSeek remains
    configurable but is never auto-selected; verified by `auto routing never selects DeepSeek, at
either tier` and `Force DeepSeek still reaches DeepSeek on a public session`.
  - Privacy boundary generalised from "not DeepSeek" to `PRIVATE_SAFE` (Anthropic only); verified by
    `private sessions refuse Gemini as well as DeepSeek`.
  - Files, folders and .zip archives can be dropped or pasted onto the composer. Paths come from
    `webUtils.getPathForFile` in preload; main reads them, walks folders (skipping VCS/build dirs),
    expands zips with a synchronous reader under per-entry and total size caps, stores each file as
    an artifact node under the session, and inlines the text into that one request. Extracted text
    never reaches the renderer.
  - `npm test` passes 45/45 (was 34). `npm run build` passes. Smoke run renders markdown, the
    reasoning disclosure and attachment chips (work/smoke.png).
  - Still pending: live Gemini/Anthropic/DeepSeek API and prompt-cache checks require credentials.
    M3/M4 remain unchecked.

- 2026-10-13: Claude built in, ChatGPT added, interface brought to web-platform parity.
  - Provider `opus` is now `claude`, the built-in default: `claude-opus-5`, the Anthropic
    endpoint and the published per-million rates ship in `DEFAULT_SETTINGS`, and all of them stay
    editable in Settings. Legacy configs are migrated on read (`claude-opus-5-5` is retired and
    missing keys fall back to defaults); verified by `a config written by an older build gains the
new defaults`.
  - Claude requests now use adaptive thinking with `display: "summarized"` and
    `output_config.effort` instead of `budget_tokens`, which current models reject; verified by
    `the Anthropic transport sends adaptive thinking, effort and media blocks`.
  - ChatGPT added as the second chat provider over the OpenAI-compatible transport with its own
    `openai` credential slot, model, endpoint, price table and `max_completion_tokens`; it is never
    auto-routed and never used by a private session. Verified by `the ChatGPT transport uses its own
key, token field and image parts` and `choosing ChatGPT routes the turn to it and keeps private
work on Claude`.
  - The privacy boundary is derived from `PRIVATE_SAFE` throughout, so Gemini and ChatGPT are now
    refused private memory exactly as DeepSeek was; verified by `Gemini is refused private memory
just like DeepSeek`.
  - Auto routing skips the classifier when no cheap tier is configured, and compaction prefers the
    cheap tier only when it is configured and the session is public (it used to call DeepSeek, which
    auto routing never selects and which ships without a model id).
  - Replies stream. Transports emit text and thinking deltas, the engine forwards stage, tool and
    delta events to the one trusted frame on `asgard:stream`, and the interface renders the reply as
    it arrives with a stop button (Esc) backed by `AbortController`. Verified by `streaming deltas
reach the interface and are never persisted` and `stopping aborts the request in flight`.
  - Uploads: an attach button opens the OS picker, drag-and-drop covers the whole chat pane, and
    images (png/jpg/gif/webp, 5 MB each) and PDFs now become provider content blocks instead of
    being skipped as binaries. Bytes stay in main, ride one request, and never enter the transcript;
    verified by `images and PDFs ride on one request and never enter the transcript`.
  - Interface: fenced code blocks with a language label and copy button, per-message copy and "Ask
    again", a streaming reply with reasoning and a tool trail, scroll-to-latest, an auto-growing
    composer, and chat rename/delete in the sidebar (`renaming and deleting a chat removes its
transcript only`).
  - `npm test` passes 56/56 (was 45). `npm run build` passes. The smoke run renders bold, italic,
    headings, lists, tables, task lists, blockquotes and a code block (work/smoke.png).
  - Note: the installer in outputs/installer predated the markdown renderer, which is why bold text
    did not appear in the installed app; it has been rebuilt from this source.
  - Still pending: live Claude/ChatGPT/Gemini API and prompt-cache checks require credentials.
    M3/M4 remain unchecked.

- 2026-10-13 (second pass): empty answers fixed, interface rebuilt around the chat.
  - Root cause of "The answer is empty / Output hit the configured token limit": adaptive thinking
    draws from the same budget as the answer, and the shipped ceiling of 8192 output tokens was
    spent reasoning before any text was written. `hardMaxTokens` now defaults to 32000, `effort`
    to `medium`, `easyMaxTokens` to 4096, and a stored config still holding the old defaults is
    migrated on read. `Engine.answer` also raises the budget once and retries when a reply comes
    back empty at the ceiling, and a truncated empty answer now explains the cause instead of
    reporting a bare limit. Verified by `an answer that spent its budget thinking is retried with
more room`, `a truncated empty answer explains the budget instead of a bare limit` and the
    migration test.
  - Lower effort also addresses the latency: `medium` is the default for every chat and is editable
    in Settings.
  - Interface rebuilt to match the Claude web app: a chat rail (new chat, search, chats grouped by
    day, rename/delete, Memory/Usage/Settings), one centred conversation column with right-aligned
    user bubbles and plain assistant text, a compact "Thought process" disclosure, a quiet
    verification line, and a docked composer with attach, model, high stakes and checks.
  - The memory tree is no longer part of the chat chrome. It is Asgard's internal reference surface,
    reachable from Memory (⌘K) together with rule proposals and the node editor; the context
    inspector is a drawer opened from the header. Chat-facing nudges remain: a pending-proposal
    banner above the composer and a compaction marker in the thread.
  - `npm test` passes 58/58. `npm run build` passes. Smoke renders the new layout (work/smoke.png).

- 2026-10-13 (third pass): tiered reasoning and a real delegation mesh.
  - Claude now runs at three tiers — deep (`claude-opus-5`, swap in `claude-fable-5-1` from
    Settings), quick (`claude-sonnet-5`) and worker (`claude-haiku-4-5`) — each with its own model
    id and price table. Verified by `each tier is priced from its own table`.
  - The complexity classifier is gone. An ordinary turn is one quick-tier call with no router
    round trip; deep research or high stakes puts the orchestrator in charge; a failed check
    escalates quick to deep. Verified by `an ordinary turn is one quick-tier call, with no
classifier`, `deep research runs the orchestrator tier and offers delegation`, `a high-stakes
turn uses the orchestrator even without deep research` and `a failed check escalates the quick
tier to the orchestrator, never to DeepSeek`.
  - Deep research adds the `delegate` tool: self-contained sub-tasks run on the worker tier in a
    fresh context with no tools and no conversation history, several at a time, optionally schema
    checked with one correction pass, capped by `delegationLimit` (default 6). Verified by `deep
research delegates sub-tasks to the worker tier in one parallel batch`, `a delegated sub-task is
schema-checked and corrected once`, `delegation is capped per turn and the cap is reported to
the model` and `delegation is unavailable to the quick tier`.
  - Because all three tiers are Anthropic, the mesh also runs in a private chat, where no other
    vendor is allowed. Verified by `a private chat still delegates, and only ever to Claude`.
  - Compaction moved from Gemini to the worker tier, so it no longer needs a second vendor.
  - Haiku 4.5 rejects `output_config.effort` and adaptive thinking; the transport drops both for
    that model. Verified by `the worker model is sent without adaptive thinking or effort`.
  - Interface: a Deep research toggle in the composer, delegated sub-tasks shown live as they run
    and complete, and the answer footer naming the model, the tier and how many sub-tasks it
    delegated.
  - `npm test` passes 65/65 (was 58). `npm run build` passes. Smoke renders the new composer.

- 2026-10-13 (fourth pass): named subagents and a council, modelled on current harness practice.
  - Read the harness-engineering sources first and designed against them: subagent context modes
    (isolated vs inherited) from LangChain's multi-agent context post; summary-only returns with
    full transcripts in sidechains, deny-first permissions and "context as a scarce resource" from
    the Claude Code design-space paper (arXiv 2604.14228); the hooks → deny → ask → mode → allow
    evaluation order and "a subagent never exceeds its parent" from the Claude Agent SDK permission
    docs; typed schemas on every inter-agent payload from GitHub's multi-agent failure write-up;
    and the harness review checklist's rule that tool permissions must be explicit.
  - Roles are now data in Settings: id, name, purpose, provider, model, effort, context mode, tool
    scope, token ceiling and council membership, with four shipped (worker, verifier, critic,
    strategist). Verified by `a role runs on its own provider, model and effort`.
  - Availability is deny-first: no key or no model means the role is never offered, and a private
    chat drops every non-Claude role. Verified by `a private chat offers only Claude roles` and
    `an unconfigured provider's role is never offered`.
  - Subagent output goes to a sidechain node and only the result plus its path returns, so a
    subagent cannot inflate the orchestrator's context. Verified by `a subagent's full output is
written to a sidechain node`.
  - Tool scope only ever narrows: a read-capable role gets the read-only memory tools in a bounded
    loop and anything else is refused. Verified by `a read-capable role may read memory but never
write it`, which also asserts no proposal is created.
  - The council is the actual mesh: participants write independently, then read each other's notes
    verbatim and revise, and the orchestrator concludes. Notes are schema-capped so the whole
    exchange stays small. Verified by `a council writes independent notes first, then exchanges
them` (which asserts round one contains none of the other notes and round two contains all of
    them), `a council seats the orchestrator when only one council role exists` and `one exchange
round can be configured away`.
  - Cost is now priced from the model that actually ran, not the tier that was requested.
  - `npm test` passes 73/73 (was 65). `npm run build` passes. Smoke renders the role cards.

- 2026-10-13 (fifth pass): the council is cross-vendor, not Claude talking to itself.
  - Shipped council roles now cover all four providers: Critic (Claude), Strategist (ChatGPT),
    Analyst (Gemini) and Contrarian (DeepSeek).
  - Seats are allocated one vendor at a time (`Engine.diverseSeats`) up to `councilSeats`
    (default 3), so a second Claude seat never displaces another vendor. Verified by `a council
seats one vendor at a time before doubling up` and `a council convenes across vendors and is
capped by councilSeats`.
  - A single-vendor council now says so in its result rather than letting agreement look like
    consensus, and names the reason when it is a private chat. Verified by `a single-vendor council
says so rather than reading consensus into it` and `a private council names Claude-only as the
reason`.
  - Settings shows the live council composition and warns when only one vendor can be seated.
  - `npm test` passes 77/77 (was 73).

- 2026-10-14: efficiency and verification pass, branching, and the new palette.
  - Cache-correct ordering. The volatile memory envelope used to be `messages[0]`, which changed
    every turn and made the entire transcript uncacheable. The settled transcript is now the
    prefix, with the breakpoint on its last block and everything per-turn after it, plus one
    rolling breakpoint that follows the newest tool result through a long tool loop (four
    breakpoints is the limit: tools, system, settled, rolling). Verified by `the settled transcript
is a cacheable prefix and volatile context follows it` and `a long tool loop carries at most one
rolling breakpoint`.
  - Retrieval reuse: a summary already in the live window is not re-sent, only new or changed ones
    are, with a count of what came earlier. Verified by `a summary already in the window is not sent
again` and `a changed summary is sent again`.
  - Large tool results are digested by the worker tier instead of truncated; small ones still cost
    no extra call. Verified by both `compress` tests.
  - Automatic compaction keeps the last six turns verbatim; ending a chat still folds everything.
    Deliberately _not_ made more eager: with the transcript cached, carrying it beats
    re-summarising it. Verified by `automatic compaction keeps the recent turns...`.
  - Independent review now runs on a different vendor where one is configured.
  - Branching, both shapes: the `explore` tool works two to four approaches in parallel against one
    scoring schema and hands them back side by side, and `forkSession` branches a chat from any
    message. Verified by `explore works branches in parallel and scores them identically` and
    `branching copies the thread up to a message and leaves the original`.
  - Two bugs the new tests caught: `explore` had silently failed to apply in an earlier edit (the
    tool was advertised but unimplemented), and `forkSession` double-slugified the project path.
  - Interface: the whole stylesheet is tokenised and themed — F4F7F5 canvas, 203126 rail,
    222823 ink, 38369A primary, 7899D4 secondary, EF8557 accent — with light, dark and system in
    Settings. Light is the default. Both themes were rendered and checked.
  - One claim in the previous audit was wrong and is corrected here: tool results do _not_ persist
    across turns (only final messages are stored), so there was no cross-turn sub-work to collapse.
  - `npm test` passes 86/86 (was 77). `npm run build` passes.

- 2026-10-14: app icon redrawn in the new palette. `assets/icon.svg` is an 824pt squircle on the
  1024pt macOS grid, a 203126→222823 tile with the ANSUZ rune drawn as paths (never a Runic font,
  which macOS may not have) and an EF8557 accent. `npm run icon` rasterises it through Electron and
  `iconutil`; the dev Dock icon is set from the PNG so `npm run dev` matches the packaged app.
  A vertical stroke has a zero-width bounding box, so the rune's stem needed `userSpaceOnUse`
  gradient units to render at all.

- 2026-10-14: the eval harness exists, which unblocks every later claim.
  - `evals/tasks.ts`: 11 tasks across instruction following, retrieval, reasoning, structured
    output, agentic memory use and honesty, each with a grading contract written before the run and
    deliberately not handed to the model as `checks`.
  - `evals/run.ts`: runs the suite through named configurations (quick, deep, deep+review) and
    reports pass rate, cost per task, tokens per task, seconds per task, calls per task and cache
    rate, with the models that actually ran recorded in every report. `npm run eval` is free and
    scripted; `npm run eval -- --live` makes real calls.
  - The grader and the suite's own hygiene are tested (89/89): contracts are enforced exactly, no
    non-instruction task leaks its answer into its prompt, and no category can carry the score.
  - Dry run verified end to end; scores from it are meaningless by construction and the runner says
    so. Live numbers still need a key.

- 2026-10-14: icon redrawn as a Valknut, and the theme audited.
  - `assets/icon.svg` is now three interlocking equilateral triangles (circumradius 230, centroids
    120 from centre at 120-degree intervals) in F4F7F5 / 7899D4 / EF8557 on the green tile. The
    first attempt used a far smaller offset and the three collapsed into a single outline; the
    comment records the geometry so that does not recur. The rail brandmark is the same mark drawn
    from the same path data, so the icon and the in-app logo cannot drift.
  - Dark mode now has three clearly separated levels — rail #171d19 < canvas #222823 < surface
    #2e3730 — so the sidebar, the thread and the composer are distinguishable without reading them.
  - Three real CSS faults found while auditing, all introduced by the earlier bulk tokenisation:
    seven dark-mode tokens were self-referential (`--ok: var(--ok)`), which is a cycle and left
    them invalid in dark mode; five tokens (`--bg`, `--panel`, `--panel-2`, `--text`, `--text-2`)
    were used by thirty rules but never defined, so those rules rendered with no colour; and
    `.chat-row.current .chat-link` outspecified the rail override, painting the selected chat's
    title near-black on the dark rail. A token audit (no cycles, nothing used-but-undefined) is the
    check to run after any palette change.
  - The "system" theme is now resolved in the renderer rather than by a duplicated media query, so
    each colour is defined exactly once.

- 2026-10-14: the research tree, which is the evidence half of deep research.
  - `experiment` runs one pre-registered experiment against competing hypotheses and folds the
    result into a tree. Pre-registration, hypothesis coverage and discriminating power are enforced
    mechanically rather than asked for in a prompt, and all three refusals happen before any
    provider call, so a worthless experiment costs nothing. Verified by `an experiment without a
prediction for every hypothesis is refused` and `an experiment that cannot discriminate is
refused before it runs`, both of which also assert zero calls were made.
  - Expected information gain is the entropy over predicted outcomes weighted by prior: identical
    predictions give exactly zero bits, an even two-way split exactly one, and a lopsided prior
    less. Verified by `information gain is zero when every hypothesis predicts the same`.
  - The Bayes update is capped by the verifier: a failed review moves belief less than a passed one
    but not to nothing, and no single experiment drives a hypothesis to zero. Verified by
    `posteriors move toward what the outcome matched...` and `a failed review caps how far one
experiment can move belief`.
  - `/research/<topic>/report` ranks steps by belief moved, not by order, and counts how many taught
    nothing. Verified by `the research report ranks by belief moved, not by order`.
  - `npm test` passes 96/96 (was 89).

- 2026-10-14: Tier re-mapping for token efficiency. Deep research now orchestrates on
  `claude-fable-5-1` (reasoning and decisions), ordinary turns stay on `claude-sonnet-5`, and
  `claude-opus-5` is the worker for delegated sub-tasks, digests and compaction. Price tables
  follow (Fable cache reads at $0.25/MTok). `RETIRED_DEFAULTS` now compares by value and
  migrates the previous Opus orchestrator default and the first release's all-zero Anthropic
  price table, which had been billing every Claude call as $0 on the dashboard; a stored
  worker model is left alone. The Anthropic
  transport handles `stop_reason: "refusal"` (notice text, `ModelReply.refused`, no retry or
  escalation). Verified by `the Opus orchestrator default moves to Fable, worker and chosen models
  stay` and `a refusal comes back as a notice, not an empty reply`. Live check of
  `claude-fable-5-1` against this account's key is pending (no key in the shell; run the
  provider test in Settings). Claude roles (worker, verifier, critic) default to 8192 output
  tokens instead of 4096, because the worker slot now holds a thinking model and adaptive
  thinking is drawn from the same budget as the answer.
