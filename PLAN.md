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
*Created: 2026-09-25*
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
