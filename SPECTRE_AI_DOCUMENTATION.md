# Spectre AI — Complete Documentation

**Version:** 3.3.9
**Date:** January 7, 2026
**Status:** Production
**Author:** Tazul Islam

---

## Purpose

Spectre AI is an integrated intelligent assistant for Arduino IDE 2.x that provides AI-powered code assistance, context-aware suggestions, multi-step autonomous agents, and long-term memory retention for developer sessions. This document is the canonical, end-to-end guide for developers, integrators, and contributors.

## Table of Contents

1. Overview
2. Quick start
3. Architecture
4. Memory system
5. Model & tokens
6. Protocols & integration
7. Spectre APIs & configuration
8. Agent mode
9. Persistence & storage
10. Testing & performance
11. Troubleshooting & FAQ
12. Security & privacy
13. Code quality & maintenance
14. Versioning

---
Spectre AI offers two primary capabilities:
- Autonomous agent mode — execute multi-step tasks (e.g., refactor code, run test sequences, perform device programming) with recovery and action logging.
<!-- Contribution guide available in /docs/CONTRIBUTING.md -->
Key goals: accuracy, keep project context, low-latency responses, cost control (assisted by model selection Flash vs Flash-Lite), and a memory system to keep long-term project context.

## 2. Quick start

Prerequisites:
- Arduino IDE 2.x with extension installed.
- Google Gemini API key configured in Spectre credentials.

Quick run:

1. In the IDE, open the Spectre assistant panel.
2. Select the model in Settings: `gemini-3.1-flash-lite` for fast tasks, or `gemma-4-31b`/`gemma-4-26b` for comprehensive responses.
3. Ask a question or select an agent action (e.g., "Improve loop performance" or "Generate I2C scan routine").

For developers: run the extension in dev mode:

```powershell
yarn --cwd ./arduino-ide-extension watch
yarn --cwd ./electron-app watch
```

## 3. Architecture

Spectre AI uses a three-tier architecture:

- Frontend (Electron renderer): UI, streaming, user interactions, memory visualization
- Protocol (shared): typed RPC interfaces, memory contract, token counter
- Backend (Node): Gemini API integration, long-running agent processes, secure secrets handling

Communication is JSON-RPC 2.0 over WebSocket; streaming responses use server-initiated events.

Important files:
- `arduino-ide-extension/src/browser/spectre/` — Spectre UI + orchestration
- `arduino-ide-extension/src/common/protocol/` — typed service interfaces/contracts
- `arduino-ide-extension/src/node/` — Gemini integration + agent function definitions

### 3.1 Code map (frontend)

This section is a practical map of the key modules in `arduino-ide-extension/src/browser/spectre/` and what they do (as of v3.3.9).

**Core UI & orchestration**
- `spectre-widget.tsx`
	- Main integration hub: sessions/messages/input state, streaming coordination, IDE service wiring, and agent-mode orchestration.
- `spectre-view-contribution.tsx`
	- Registers the view and contribution wiring so the Spectre UI appears in the IDE.

**Streaming & secrets clients**
- `clients/ai-frontend-client.ts`
	- Receives streaming deltas/completions and quota updates from the backend.
- `clients/secrets-frontend-client.ts`
	- Receives Gemini API key status changes from the backend.

**Agent mode helpers** (`arduino-ide-extension/src/browser/spectre/agent/`)
- `function-call-runner.ts` — executes function/tool calls sequentially and records results.
- `loop-detector.ts` — detects repeated actions/failures to prevent infinite loops.
- `agent-tools.ts`, `agent-mode-tools.ts` — core agent-mode wiring and tool availability.
- `agent-execution-router.ts` — routes tool calls to the correct implementation.
- `sketch-operations.ts` — sketch read/write/modify workflows used by tools.
- `upload-tools.ts` — upload/verify workflows and output analysis.
- `board-tools.ts`, `platform-tools.ts` — board/platform selection and platform operations.
- `agent-actions.ts`, `completion.ts`, `react-loop.ts` — action logging, completion detection, and loop-safe orchestration.

**Boards & platform helpers**
- `board/` — board selection helpers and utilities used by both basic and agent modes.

**Sketch, upload, storage**
- `feature/sketch-utilities.ts` — sketch context collection (open files/tabs, main sketch).
- `feature/upload-helper.ts` — upload/verify output helpers and error formatting.
- `feature/storage-helper.ts` — session persistence (including request logs / tracking data).

**Memory system**
- `memory/memory-types.ts` — memory data model (recent raw buffer + summarized memory bank).
- `memory/memory-manager.ts` — token-aware prompt assembly + summarization/compression.
- `memory/memory-helper.ts` — persistence to/from `localStorage`.
- `memory/session-memory-tools.ts` — session-level wiring for memory + defaults.

**UI rendering utilities**
- `ui/spectre-view.tsx` — Spectre view container.
- `ui/widget-rendering.tsx`, `ui/message-rendering.tsx`, `ui/code-block-rendering.tsx` — React rendering for sessions/messages/code.
- `ui/stream-controller.ts` — stream state coordination.
- `ui/ui-helper.ts`, `ui/ui-utilities.ts` — formatting utilities (code blocks, small helpers).

**Config and validation**
- `utils/model-config.ts` — model limits used in the UI (e.g., RPM/character caps).
- `utils/token-counter.ts` — heuristic token estimation used for budgeting.
- `utils/validation-helper.ts` — user-facing validation/error formatting.
- `utils/auto-title.ts` — session title generation.

### 3.2 Code map (backend)

**Protocol layer**
- `arduino-ide-extension/src/common/protocol/spectre-ai-service.ts`
	- Defines request/response types, function declarations, streaming events, and the RPC interface.
- `arduino-ide-extension/src/common/protocol/spectre-secrets-service.ts`
	- Defines secure API key storage RPC interface.
- `arduino-ide-extension/src/common/protocol/spectre-types.ts`
	- Shared timing constants and logging utilities (`spectreLog/spectreWarn/spectreError`).

**Node services**
- `arduino-ide-extension/src/node/spectre-ai-service-impl.ts`
	- Implements Gemini calls, streaming, quota/rate limiting (RPM/TPM/RPD), request queueing, and retries.
- `arduino-ide-extension/src/node/spectre-secrets-service-impl.ts`
	- Stores the Gemini API key securely (keychain + fallback) and pushes status changes to the frontend.
- `arduino-ide-extension/src/node/spectre-agent-functions.ts`
	- Declares the agent function/tool surface exposed to the model.

### 3.3 Why `spectre-widget.tsx` is large

`spectre-widget.tsx` is large because it currently acts as the integration hub between:
- UI state (sessions/messages/input rendering and interaction)
- IDE services (sketches, editors, output channels, boards, ports, libraries)
- Streaming transport (incremental deltas, cancellation, fallback completion)
- Agent runtime (loop detection, function call sequencing, task panel extraction)
- Persistence (sessions + request logs + daily tracker)
- Memory management (rolling buffer + summaries)

Even with helpers extracted, the widget still contains a lot of “glue code” needed to coordinate these subsystems. The safest size reductions are to keep extracting pure helpers (e.g., title generation, formatting, parsing) and to move longer, self-contained agent orchestration subroutines into `agent/*` modules.

## 4. Memory system

Spectre uses a three-part memory system that balances fidelity with token budget:

1. Rolling buffer — keeps recent messages at full fidelity (40 messages / ~25k tokens). Active context is built from this buffer.
2. Memory bank — stores summarized snippets and longer-living context.
3. Meta-compression — periodically compresses older summaries down to a smaller high-level summary.

Key behaviors (defaults in `arduino-ide-extension/src/browser/spectre/memory/memory-manager.ts`):
- Rolling buffer size: up to 40 recent messages.
- Summarization trigger: when recent messages reach 30+ messages or exceed ~25,000 estimated tokens.
- Memory bank cap: ~100,000 estimated tokens.
- Summarization model: `gemini-3.1-flash-lite`.
- Summary sizes: first-level summaries up to ~2048 output tokens; compressed/meta summaries up to ~4096 output tokens.
- Summarization temperature: 0.2 (for consistent summaries).

The memory system aims to keep conversation state across sessions while staying within model limits and cost budgets.

---

## 5. Model & tokens

Supported models (UI preference): `gemini-3.1-flash-lite`, `gemma-4-31b`, and `gemma-4-26b`.

Token budgets (prompt assembly targets):
- Flash-Lite: ~30k tokens/request
- Flash: ~50k tokens/request

Recommended distribution:
- Memory bank: 15–25k tokens
- Recent messages: 15–25k tokens
- Sketch context: 3–6k tokens
- Current prompt: 2–4k tokens

Token estimation (heuristics): JSON ~3 chars/token, code ~3.5 chars/token, natural language ~1.3 tokens/word, mixed ~4 chars/token. Accuracy ~90% vs actual Gemini tokenization.

Pre-send checks verify assembled token usage stays within the chosen model budget.

---

## 6. Protocols & integration

Communication uses JSON-RPC 2.0 over WebSocket with support for request/response and streaming events. Key services:
- `spectre-ai-service`: LLM and task orchestration
- `spectre-secrets-service`: secure credential storage for Gemini API

Streaming behavior follows: start-stream → chunk events → end-stream → final response.

Sample pseudo-call:

```ts
await spectreAiClient.request('ask', {
	sessionId: 'abcd',
	prompt: 'Generate a simple I2C scanner',
	model: 'gemini-3.1-flash-lite'
});
```

---

## 7. Spectre APIs & configuration

Preferences:
- `arduino.spectre.model` — `gemini-3.1-flash-lite`, `gemma-4-31b`, or `gemma-4-26b`.
- `arduino.spectre.thinkingLevel` — `OFF`, `LOW`, `MEDIUM`, or `HIGH`.
- `arduino.spectre.grounding` — boolean; enables Google Search grounding when set to true.
- `arduino.spectre.mode` — `basic` (conversational) or `agent` (tool-using automation).

Memory retention defaults are currently configured in code (see `memory/memory-manager.ts`) rather than exposed as user preferences.

Example default configuration (abridged):

```ts
const DEFAULT_MEMORY_CONFIG = {
	maxRecentMessages: 40,
	memoryBankTokenCap: 100000,
	summarizationTrigger: { minMessages: 30, maxTokens: 25000 },
	compressionTrigger: { threshold: 0.9 }
};
```

---

## 8. Agent mode

Agent mode runs multi-step tasks with safety guardrails:
- Step definitions include retry and rollback policies
- Guardrails prevent infinite loops; actions are idempotent when possible
- Action logs track agent steps for auditability

Typical agent pipeline:
1. Analyze the codebase and locate targets
2. Generate or propose changes
3. Apply changes; run lint/tests
4. Roll back on failure and present a report

---

## 9. Persistence & storage

Session memory is saved to `localStorage` and restored on startup. Example:

```ts
localStorage.setItem(`spectre-memory-${sessionId}`, JSON.stringify({
	recentMessages, memoryBank, stats, config
}));
```

Backups and exports are available in the UI for portability and migration.

---

## 10. Testing & performance

Tests should cover:
- Long conversation stress tests (1k+ messages)
- Agent workflows (end-to-end)
- Memory summarization and accuracy

Performance targets:
- Overhead per message < 5ms
- Summarization latency 2–4s (async)
- Compression latency 5–10s (async)

CI hooks:
- Place tests under `arduino-ide-extension/src/test` and integrate with `yarn test` and `yarn build` tasks.

---

## 11. Troubleshooting & FAQ

Q: Model returns irrelevant or unhelpful answers
A: Increase context fidelity by switching to `gemma-4-31b` or insert explicit sketch and board details.

Q: Missing session memory
A: Look for keys `spectre-memory-*` in `localStorage` and use the import/export UI; ensure the running Spectre instance has read access to localStorage.

Q: Agent loop or infinite actions
A: Agents have loop guards; add idempotency to steps and ensure continuation instructions are conditional.

---

## 12. Security & privacy

- Store secrets with `spectre-secrets-service`; do not log API keys.
- Use scoped Gemini API keys with minimal permissions.
- Avoid sending sensitive data in prompts.

---

## 13. Code quality & maintenance

This section documents practical, verifiable guidance for maintaining Spectre AI.

### Logging

- Use `spectreWarn` / `spectreError` for warnings/errors.
- Avoid verbose logging in hot paths unless gated for development.

### Where to look first

- Frontend orchestration: `arduino-ide-extension/src/browser/spectre/spectre-widget.tsx`
- Basic chat flow + prompt assembly: `arduino-ide-extension/src/browser/spectre/chat/chat-tools.ts`
- Agent-mode tool execution: `arduino-ide-extension/src/browser/spectre/agent/function-call-runner.ts`
- Memory retention: `arduino-ide-extension/src/browser/spectre/memory/memory-manager.ts`
- Backend Gemini integration + quotas: `arduino-ide-extension/src/node/spectre-ai-service-impl.ts`

### Verification

- Build: `yarn build` (repo root)
- Tests (when available): `yarn test` (repo root)

## 14. Versioning

- The current repository version is defined in the root `package.json`.
- As of this document: **v3.3.9**.

---

For contributions, see `docs/CONTRIBUTING.md`.

---

**Maintained by:** Tazul Islam  
**License:** As per Arduino IDE 2.x  
**Last review:** January 7, 2026
