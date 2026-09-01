# Streaming & Real E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement real-time live output streaming (`--stream`), harden structured JSON/NDJSON parsing against noise/markdown wrappers, and achieve 100% test compatibility across Node.js/Bun and Windows/Linux for the 7 polyglot agent connectors.

**Architecture:** 
1. Enhance `src/lib/args.mjs` and `src/lib/provider.mjs` with `--stream` support, allowing real-time token/log streaming to stdout while preserving byte-safe in-memory captures for schema validation.
2. Upgrade `src/lib/parse.mjs` to extract JSON from markdown fences, strip ANSI escapes, and resist interspersed CLI notices across Claude, Codex, Grok, and AGY envelopes.
3. Harmonize test suites (`tests/unit.test.mjs`, `tests/bridge.test.mjs`) for seamless execution under both Node.js (`node --test`) and Bun (`bun test`).
4. Hardened `tests/real-cli.test.mjs` and `src/lib/setup.mjs` for cross-platform CLI discovery and clear doctor diagnostics.
5. Rebuild plugins via `scripts/build-plugins.mjs` and validate cross-host parity with `scripts/validate-cross-host.mjs`.

**Tech Stack:** Node.js (>=18.18), Bun, ES Modules, Child Process, JSON Schema, Git Worktrees.

## Global Constraints
- All existing interface contracts in `src/bridge.mjs` and `connector.json` must remain backwards compatible.
- `review` mode must remain strictly read-only with non-zero exit codes or schema violations never reported as completed.
- Zero external runtime dependencies in `src/` (pure Node standard library).
- All 7 plugins must pass cross-host schema and build freshness validation (`scripts/validate-cross-host.mjs`).

---

### Task 1: Argument Parsing & Flag Support for `--stream`

**Files:**
- Modify: `src/lib/args.mjs`
- Test: `tests/unit.test.mjs`

**Interfaces:**
- Consumes: `parseArgs(argv)`
- Produces: `options.stream` (boolean) across all runnable commands (`run`, `review`, `adversarial-review`, `rescue`, `resume`, `handoff`).

- [ ] **Step 1: Write test for `--stream` option in `tests/unit.test.mjs`**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Update `src/lib/args.mjs` to recognize `--stream` in `FLAG_OPTIONS`**
- [ ] **Step 4: Run unit tests to verify pass**

---

### Task 2: Live Output Streaming Engine in `provider.mjs`

**Files:**
- Modify: `src/lib/provider.mjs`
- Modify: `src/bridge.mjs`
- Test: `tests/bridge.test.mjs`

**Interfaces:**
- Consumes: `request.stream` (boolean), `child.stdout`, `child.stderr`
- Produces: live chunk emission to `process.stdout` when `stream === true`, while safely completing capture and result rendering.

- [ ] **Step 1: Write bridge test asserting live streaming emission when `--stream` is provided**
- [ ] **Step 2: Update `src/bridge.mjs` `normalizeRequest` to forward `stream: Boolean(options.stream)`**
- [ ] **Step 3: Update `src/lib/provider.mjs` `runTarget` to pipe stdout/stderr chunks in real-time when `request.stream` is active**
- [ ] **Step 4: Verify test passes with mock and foreground execution**

---

### Task 3: Robust Parsing & Noise Toleration in `parse.mjs`

**Files:**
- Modify: `src/lib/parse.mjs`
- Test: `tests/unit.test.mjs`

**Interfaces:**
- Consumes: Raw `stdout` containing markdown fences (````json ... ````), ANSI escape sequences, or leading/trailing CLI log noise.
- Produces: Normalized `structured` JSON object and clean `text`.

- [ ] **Step 1: Add unit tests for ANSI stripping and markdown JSON fence extraction in `tests/unit.test.mjs`**
- [ ] **Step 2: Implement `stripAnsi` and enhance `lastJsonObject` in `src/lib/parse.mjs`**
- [ ] **Step 3: Verify all parsing tests pass**

---

### Task 4: Test Suite Harmonization for Node.js and Bun on Windows

**Files:**
- Modify: `tests/unit.test.mjs`
- Modify: `tests/bridge.test.mjs`

**Interfaces:**
- Consumes: Test runner execution (`node --test` or `bun test`)
- Produces: 100% pass rate without `ERR_NOT_IMPLEMENTED` or timeout callback leaks.

- [ ] **Step 1: Fix test structure in `tests/unit.test.mjs` so tests are not declared inside other blocks**
- [ ] **Step 2: Adjust timeout assertion in `tests/bridge.test.mjs` to eliminate race conditions on Windows taskkill**
- [ ] **Step 3: Run `bun test` and `node --test` to confirm all unit and bridge tests pass**

---

### Task 5: Real CLI E2E Hardening & Diagnostics

**Files:**
- Modify: `tests/real-cli.test.mjs`
- Modify: `src/lib/setup.mjs`
- Modify: `src/lib/exec.mjs`

**Interfaces:**
- Consumes: OS binaries (`claude`, `codex`, `grok`, `agy`, `gh`)
- Produces: Accurate detection of Windows `.cmd` / global npm shims and non-fatal descriptive skip reports for unauthenticated CLIs.

- [ ] **Step 1: Update `src/lib/setup.mjs` and `src/lib/exec.mjs` for Windows executable resolution and detailed auth diagnostics**
- [ ] **Step 2: Update `tests/real-cli.test.mjs` with graceful skip logging when specific CLIs are missing/unauthenticated**

---

### Task 6: Rebuilding All 7 Connector Plugins & Cross-Host Validation

**Files:**
- Modify: `scripts/build-plugins.mjs`
- Modify: `scripts/validate-cross-host.mjs`
- Generated: `plugins/*`

**Interfaces:**
- Consumes: `src/` code and plugin command templates
- Produces: Synchronized plugins in `plugins/` and 0 failures in `scripts/validate-cross-host.mjs`.

- [ ] **Step 1: Update command markdown templates in `scripts/build-plugins.mjs` with `--stream` flag documentation**
- [ ] **Step 2: Run `node scripts/build-plugins.mjs` to distribute new binaries and manifests**
- [ ] **Step 3: Run `node scripts/validate-cross-host.mjs` to verify cross-host validation 100% pass**
- [ ] **Step 4: Run full QA suite (`npm run qa`)**
