# Spectre AI — Complete Documentation

**Version:** 1.0.0
**Date:** November 20, 2025
**Status:** Production

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
13. Changelog & versioning

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
2. Select the model in Settings: `gemini-2.5-flash` for comprehensive responses or `gemini-2.5-flash-lite` to reduce cost.
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
- `arduino-ide-extension/src/browser/spectre/` — UI and client
- `arduino-ide-extension/src/common/protocol/` — interfaces and contracts
- `arduino-ide-extension/src/node/` — server implementation

## 4. Memory system

Spectre uses a three-part memory system that balances fidelity with token budget:

1. Rolling buffer — keeps recent messages at full fidelity (40 messages / ~25k tokens). Active context is built from this buffer.
2. Memory bank — stores summarized snippets and longer-living context.
3. Meta-compression — periodically compresses older summaries down to a smaller high-level summary.

Key behaviors:
- Rolling buffer threshold: summarize when buffer size reaches 30 messages or 25,000 tokens.
- Summarization model: Gemini 2.5 Flash-Lite (cost-effective, deterministic).
- Compression targets: first-level summaries ~2048 tokens, meta-summary ~4096 tokens.
 - Temperature: 0.2 (for consistent summaries)

The memory system aims to keep conversation state across sessions while staying within model limits and cost budgets.

---

## 5. Model & tokens

Supported models: `gemini-2.5-flash` and `gemini-2.5-flash-lite`.

Token budgets:
- Flash-Lite: 30k tokens/request
- Flash: 50k tokens/request

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
	model: 'gemini-2.5-flash-lite'
});
```

---

## 7. Spectre APIs & configuration

Preferences:
- `arduino.spectre.model` — `gemini-2.5-flash` or `gemini-2.5-flash-lite`.
- `arduino.spectre.memory.maxRecentMessages`, `arduino.spectre.memory.memoryBankTokenCap`.

Example default configuration:

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
A: Increase context fidelity by switching to `gemini-2.5-flash` or insert explicit sketch and board details.

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

## 13. Changelog & versioning

Release v1.0.0 highlights:
- Memory bank capacity increased to 100k tokens
- First-level summaries extended to 2048 tokens
- Flash-Lite improved budgeting options

---

For contributions, see `docs/CONTRIBUTING.md`.

---

**Maintained by:** Tazul Islam  
**License:** As per Arduino IDE 2.x  
**Last review:** November 20, 2025
