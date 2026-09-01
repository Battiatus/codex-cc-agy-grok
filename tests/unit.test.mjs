import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, parseDuration } from "../src/lib/args.mjs";
import { createCapture, lastJsonObject, parseProviderOutput, stripAnsi } from "../src/lib/parse.mjs";
import { interpretVerdict, loadSchema, validate } from "../src/lib/schema.mjs";
import { buildInvocationArgs, composePrompt } from "../src/lib/invocation.mjs";
import { diffText, resolveScope } from "../src/lib/git.mjs";
import { isSecretName, prepareExecutionRoot } from "../src/lib/isolation.mjs";
import { resolveExecutable } from "../src/lib/exec.mjs";
import { renderResult, renderRunsDashboard } from "../src/lib/render.mjs";
import { buildHandoffDigest } from "../src/lib/transfer.mjs";
import { listAllRuns, readJobTails } from "../src/lib/jobs.mjs";

async function scratch(name) {
  return mkdtemp(join(tmpdir(), `polyglot-${name}-`));
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function connectorConfig(pluginName) {
  return JSON.parse(
    await readFile(new URL(`../plugins/${pluginName}/connector.json`, import.meta.url), "utf8"),
  );
}

async function repositoryWithChange() {
  const directory = await scratch("repo");
  git(directory, ["init", "-q", "."]);
  git(directory, ["config", "user.email", "t@t.t"]);
  git(directory, ["config", "user.name", "t"]);
  await writeFile(join(directory, "math.js"), "export const add = (a, b) => a + b;\n", "utf8");
  await writeFile(join(directory, ".gitignore"), "ignored.txt\n", "utf8");
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-qm", "base"]);
  await writeFile(join(directory, "math.js"), "export const add = (a, b) => a - b;\n", "utf8");
  await writeFile(join(directory, "ignored.txt"), "IGNORED_SECRET\n", "utf8");
  return directory;
}

test("unknown flags are rejected instead of silently swallowed", () => {
  assert.throws(() => parseArgs(["run", "--expect-resposne", "X"]), /Unknown option: --expect-resposne/);
  assert.throws(() => parseArgs(["run", "--moode", "write"]), /Unknown option: --moode/);
});

test("a prompt may start with -- and inline values are supported", () => {
  const dashed = parseArgs(["run", "--prompt", "--dangerously-skip-permissions is unsafe"]);
  assert.equal(dashed.options.prompt, "--dangerously-skip-permissions is unsafe");
  assert.equal(parseArgs(["run", "--mode=write"]).options.mode, "write");
  assert.deepEqual(parseArgs(["run", "--", "--literal"]).options._, ["--literal"]);
  assert.equal(parseArgs(["run", "--confirm-write"]).options["confirm-write"], true);
});

test("--stream flag is parsed as boolean and supports inline values", () => {
  assert.equal(parseArgs(["run", "--stream"]).options.stream, true);
  assert.equal(parseArgs(["run", "--stream=true"]).options.stream, true);
  assert.equal(parseArgs(["run", "--stream=false"]).options.stream, false);
  assert.equal(parseArgs(["run", "--stream=1"]).options.stream, true);
  assert.equal(parseArgs(["run", "--stream=0"]).options.stream, false);
});

test("durations accept hours and reject nonsense", () => {
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("2.5m"), 150_000);
  assert.equal(parseDuration("45s"), 45_000);
  assert.throws(() => parseDuration("soon"), /Invalid duration/);
  assert.throws(() => parseDuration("0s"), /must be positive/);
});

test("the review schema validates payloads and interprets verdicts", async () => {
  const { schema } = await loadSchema("review");
  const valid = {
    verdict: "needs-attention",
    summary: "one defect",
    findings: [{
      severity: "high",
      title: "t",
      body: "b",
      file: "a.js",
      line_start: 1,
      line_end: 2,
      confidence: 0.5,
      recommendation: "fix",
    }],
    next_steps: ["fix it"],
  };
  assert.deepEqual(validate(schema, valid), []);
  assert.ok(validate(schema, { ...valid, verdict: "maybe" }).length > 0);
  assert.ok(validate(schema, { verdict: "approve", summary: "s" }).length > 0);
  assert.ok(validate(schema, { ...valid, findings: [{ ...valid.findings[0], line_start: 0 }] })
    .some((error) => error.includes("line_start")));

  assert.deepEqual(interpretVerdict({ verdict: "approve" }), {
    verdict: "approve",
    completed: true,
    attention: false,
  });
  assert.equal(interpretVerdict({ verdict: "could-not-review" }).completed, false);
  assert.equal(interpretVerdict({ verdict: "nonsense" }), null);
});

test("output capture keeps multi-byte characters intact and bounds by bytes", () => {
  const capture = createCapture();
  const text = "→é漢字🚀".repeat(500);
  const buffer = Buffer.from(text, "utf8");
  for (let offset = 0; offset < buffer.length; offset += 7) {
    capture.push(buffer.subarray(offset, offset + 7));
  }
  capture.end();
  assert.equal(capture.text(), text);
  assert.ok(!capture.text().includes("�"));

  const bounded = createCapture(64);
  bounded.push(Buffer.from("a".repeat(500), "utf8"));
  bounded.end();
  assert.ok(bounded.truncated());
});

test("each provider envelope is parsed from its real shape", () => {
  const payload = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };

  const claude = parseProviderOutput("claude", {
    stdout: JSON.stringify({
      session_id: "claude-1",
      total_cost_usd: 1.5,
      usage: { input_tokens: 10, output_tokens: 2 },
      permission_denials: [{ tool_name: "Write", message: "denied" }],
      result: JSON.stringify(payload),
      structured_output: payload,
    }),
  });
  assert.equal(claude.nativeSessionId, "claude-1");
  assert.deepEqual(claude.structured, payload);
  assert.equal(claude.denials.length, 1);
  assert.equal(claude.denials[0].tool, "Write");
  assert.equal(claude.costUsd, 1.5);

  const grok = parseProviderOutput("grok", {
    stdout: JSON.stringify({
      text: JSON.stringify(payload),
      stopReason: "end_turn",
      sessionId: "grok-1",
      structuredOutput: payload,
    }),
  });
  assert.equal(grok.nativeSessionId, "grok-1");
  assert.deepEqual(grok.structured, payload);
  assert.deepEqual(grok.notices, []);

  const agy = parseProviderOutput("agy", {
    stdout: JSON.stringify({
      conversation_id: "agy-1",
      status: "ERROR",
      response: JSON.stringify(payload),
      structured_output: payload,
    }),
  });
  assert.equal(agy.nativeSessionId, "agy-1");
  assert.match(agy.providerError, /status=ERROR/);
});

test("codex notices are separated from sandbox denials and the final message wins", () => {
  const stdout = [
    { type: "thread.started", thread_id: "codex-1" },
    { type: "item.completed", item: { type: "error", message: "Exceeded skills context budget of 2%." } },
    { type: "item.completed", item: { type: "error", message: "failed to parse plugin hooks config" } },
    { type: "item.completed", item: { type: "agent_message", text: "chatter" } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n");

  const clean = parseProviderOutput("codex", { stdout, finalMessage: '{"verdict":"approve"}' });
  assert.equal(clean.nativeSessionId, "codex-1");
  assert.deepEqual(clean.denials, []);
  assert.equal(clean.notices.length, 2);
  assert.deepEqual(clean.structured, { verdict: "approve" });
  assert.equal(clean.usage.inputTokens, 5);

  const denied = parseProviderOutput("codex", {
    stdout: `${stdout}\n${JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: "write blocked by sandbox: read-only file system" },
    })}`,
    finalMessage: "done",
  });
  assert.equal(denied.denials.length, 1);
});

test("provider text quoting a denial phrase is not treated as a denial", () => {
  const parsed = parseProviderOutput("claude", {
    stdout: JSON.stringify({
      session_id: "c",
      permission_denials: [],
      result: "The reviewed file contains the string 'permission denied' in a log message.",
      structured_output: null,
    }),
  });
  assert.deepEqual(parsed.denials, []);
  assert.equal(parsed.providerError, null);
});

test("argument groups are all-or-nothing so a missing value never shifts the command line", async () => {
  const config = await connectorConfig("codex-connector");
  const withoutModel = buildInvocationArgs(config, {
    executionCwd: "/w",
    prompt: "p",
    mode: "review",
    session: null,
    model: null,
    effort: null,
    budgetUsd: null,
    schemaPath: "",
    finalMessagePath: "",
  });
  assert.ok(!withoutModel.args.includes("-m"));
  assert.ok(!withoutModel.args.includes(""));
  assert.equal(withoutModel.applied.model, false);
  assert.deepEqual(withoutModel.args.slice(0, 7), [
    "exec", "--json", "--skip-git-repo-check", "-C", "/w", "--sandbox", "read-only",
  ]);
  assert.equal(withoutModel.args.at(-1), "p");

  const full = buildInvocationArgs(config, {
    executionCwd: "/w",
    prompt: "p",
    mode: "review",
    session: null,
    model: "gpt-5.4-mini",
    effort: "high",
    budgetUsd: null,
    schemaPath: "/s.json",
    finalMessagePath: "/f.txt",
  });
  assert.ok(full.args.includes("--output-schema"));
  assert.ok(full.args.includes("/s.json"));
  assert.ok(full.args.includes('model_reasoning_effort="high"'));
  assert.equal(full.applied.schema, true);
  assert.equal(full.applied.finalMessage, true);
});

test("codex review-mode resume carries the sandbox through -c", async () => {
  const config = await connectorConfig("codex-connector");
  const resumed = buildInvocationArgs(config, {
    executionCwd: "/w",
    prompt: "follow up",
    mode: "review",
    session: "session-1",
    model: null,
    effort: null,
    budgetUsd: null,
    schemaPath: "",
    finalMessagePath: "",
  });
  assert.equal(resumed.applied.resume, true);
  assert.ok(resumed.args.includes('sandbox_mode="read-only"'));
  assert.ok(resumed.args.includes("session-1"));
});

test("grok review mode denies the write and shell tools by their real names", async () => {
  const config = await connectorConfig("grok-connector");
  const review = buildInvocationArgs(config, {
    executionCwd: "/w",
    prompt: "p",
    mode: "review",
    session: null,
    model: null,
    effort: null,
    budgetUsd: null,
    schemaInline: "{}",
  }).args;
  const allowed = review[review.indexOf("--tools") + 1].split(",");
  const denied = review[review.indexOf("--disallowed-tools") + 1].split(",");
  assert.deepEqual(allowed, ["read_file", "list_dir", "grep"]);
  for (const tool of ["run_terminal_command", "write", "search_replace", "spawn_subagent"]) {
    assert.ok(denied.includes(tool), `${tool} must be denied in review mode`);
  }
});

test("git scope resolution distinguishes uncommitted, staged, branch and empty", async () => {
  const directory = await repositoryWithChange();
  const uncommitted = resolveScope(directory, { scope: "uncommitted" });
  assert.equal(uncommitted.kind, "uncommitted");
  assert.equal(uncommitted.files.length, 1);
  assert.equal(uncommitted.files[0].path, "math.js");
  assert.deepEqual(uncommitted.untracked, []);
  assert.equal(uncommitted.empty, false);
  assert.match(diffText(directory, uncommitted), /-export const add = \(a, b\) => a \+ b;/);

  assert.equal(resolveScope(directory, { scope: "staged" }).empty, true);
  git(directory, ["add", "math.js"]);
  assert.equal(resolveScope(directory, { scope: "staged" }).files.length, 1);

  const branch = resolveScope(directory, { scope: "branch", base: "HEAD" });
  assert.equal(branch.kind, "branch");
  assert.equal(branch.empty, true);

  assert.equal(resolveScope(directory, { scope: "auto" }).kind, "uncommitted");
  assert.throws(() => resolveScope(directory, { scope: "commit" }), /requires --commit/);

  const outside = resolveScope(await scratch("plain"), { scope: "auto" });
  assert.equal(outside.isGit, false);
  assert.equal(outside.kind, "workspace");
});

test("review runs in place by default and keeps git history available", async () => {
  const directory = await repositoryWithChange();
  const isolation = await prepareExecutionRoot({
    mode: "review",
    cwd: directory,
    jobId: "job-inplace",
    isolate: false,
  });
  assert.equal(isolation.executionCwd, directory);
  assert.equal(isolation.strategy, "in-place-read-only");
  assert.equal(isolation.exported, false);
  assert.equal(isolation.gitHistoryAvailable, true);
  assert.equal(await isolation.cleanup(), null);
});

test("--isolate uses a git worktree that still has history, then cleans up", async () => {
  const directory = await repositoryWithChange();
  const isolation = await prepareExecutionRoot({
    mode: "review",
    cwd: directory,
    jobId: "job-worktree",
    isolate: true,
  });
  assert.equal(isolation.strategy, "git-worktree");
  assert.equal(isolation.gitHistoryAvailable, true);
  assert.equal(git(isolation.executionCwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim(), "true");
  assert.match(await readFile(join(isolation.executionCwd, "math.js"), "utf8"), /a - b/);
  assert.equal(await isolation.cleanup(), null);
});

test("the copy fallback refuses credentials and generated directories", async () => {
  const directory = await scratch("copy");
  await writeFile(join(directory, "app.js"), "ok\n", "utf8");
  for (const name of [
    ".env",
    "id_rsa",
    "credentials.json",
    "prod.tfvars",
    "service-account-prod.json",
  ]) {
    await writeFile(join(directory, name), "SECRET\n", "utf8");
  }
  await mkdir(join(directory, ".ssh"), { recursive: true });
  await writeFile(join(directory, ".ssh", "config"), "Host *\n", "utf8");
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await writeFile(join(directory, "node_modules", "x.js"), "dep\n", "utf8");

  const isolation = await prepareExecutionRoot({
    mode: "review",
    cwd: directory,
    jobId: "job-copy",
    isolate: true,
  });
  assert.equal(isolation.strategy, "filtered-copy");
  const omitted = new Set(isolation.omitted.map((entry) => entry.path));
  for (const path of [
    ".env",
    "id_rsa",
    "credentials.json",
    "prod.tfvars",
    "service-account-prod.json",
    ".ssh",
    "node_modules",
  ]) {
    assert.ok(omitted.has(path), `${path} must be omitted from the copy`);
  }
  assert.equal(await readFile(join(isolation.executionCwd, "app.js"), "utf8"), "ok\n");
  await assert.rejects(readFile(join(isolation.executionCwd, "id_rsa"), "utf8"));
  assert.equal(await isolation.cleanup(), null);
});

test("credential filename detection covers the common private-key shapes", () => {
  for (const name of [
    ".env", ".env.local", ".netrc", ".git-credentials", "id_rsa", "id_ed25519",
    "server.key", "cert.pem", "apns.p8", "bundle.p12", "store.jks", "prod.tfvars",
    "terraform.tfstate", "secrets.yaml", "credentials.json", "service_account.json",
  ]) {
    assert.ok(isSecretName(name), `${name} must be treated as a credential`);
  }
  for (const name of [".env.example", ".env.sample", "index.js", "README.md"]) {
    assert.ok(!isSecretName(name), `${name} must not be treated as a credential`);
  }
});

test("the review prompt embeds the diff and authorizes read tools while forbidding mutations", () => {
  const prompt = composePrompt({
    connectorId: "codex",
    mode: "review",
    executionCwd: "/w",
    sourceCommit: "abc123",
    scope: {
      kind: "uncommitted",
      files: [{ path: "math.js" }],
      untracked: [],
      added: 1,
      removed: 1,
      diffCommand: "git diff HEAD",
    },
    diff: "--- a/math.js\n+++ b/math.js\n",
    schemaRaw: '{"type":"object"}',
    userPrompt: "review it",
    isolation: "in-place-read-only",
  });
  assert.match(prompt, /<<<DIFF/);
  assert.match(prompt, /math\.js/);
  assert.match(prompt, /could-not-review/);
  assert.match(prompt, /read-only tools/i);
  assert.match(prompt, /grep, read_file, list_dir/i);
  assert.match(prompt, /Do not modify, create or delete any file/);
  assert.doesNotMatch(prompt, /no shell and no git tools/);
});

test("the target executable resolves to something spawnable on this platform", () => {
  const resolution = resolveExecutable("node");
  assert.ok([
    "native",
    "shim-entrypoint",
    "sibling-shim-entrypoint",
    "shebang-node",
    "unverified",
    "path-fallback",
  ].includes(resolution.strategy));
  const probe = spawnSync(resolution.command, [...resolution.prefixArgs, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(probe.status, 0);
});

test("markdown rendering surfaces the verdict, findings and non-approvals", () => {
  const markdown = renderResult({
    connector: "codex",
    jobId: "j1",
    status: "COMPLETED",
    mode: "review",
    verdict: "needs-attention",
    scope: { kind: "uncommitted", fileCount: 1, added: 5, removed: 1, empty: false },
    isolationStrategy: "in-place-read-only",
    durationMs: 62_500,
    usage: { inputTokens: 10, outputTokens: 2 },
    costUsd: 0.25,
    review: {
      summary: "one defect",
      findings: [
        { severity: "low", title: "minor", body: "b", file: "a.js", line_start: 9, line_end: 9, confidence: 0.4, recommendation: "r" },
        { severity: "critical", title: "major", body: "b", file: "math.js", line_start: 2, line_end: 2, confidence: 1, recommendation: "r" },
      ],
      next_steps: ["fix"],
    },
    permissionDenials: [],
  });
  assert.ok(!markdown.includes("\\n"));
  assert.match(markdown, /verdict \*\*needs-attention\*\*/);
  assert.ok(markdown.indexOf("CRITICAL") < markdown.indexOf("LOW"), "findings must be severity ordered");

  const empty = renderResult({
    connector: "grok",
    jobId: "j2",
    status: "EMPTY_SCOPE",
    mode: "review",
    scope: { kind: "uncommitted", fileCount: 0, added: 0, removed: 0, empty: true },
  });
  assert.match(empty, /Nothing was in scope\. This is not an approval\./);
});

test("a handoff refuses a transcript outside the host directory", async () => {
  const directory = await scratch("transfer");
  const outside = join(directory, "stolen.jsonl");
  await writeFile(outside, `${JSON.stringify({ message: { role: "user", content: "hi" } })}\n`, "utf8");
  await assert.rejects(
    buildHandoffDigest({ fromHost: "claude", source: outside }),
    /may only be read from|Transcript not found/,
  );
  await assert.rejects(
    buildHandoffDigest({ fromHost: "nowhere", source: outside }),
    /Unsupported --from-host/,
  );
});

test("listAllRuns aggregates and sorts jobs across multiple connector state directories", async () => {
  const home = await scratch("runs-state");
  const connectors = ["codex", "claude", "grok", "agy", "copilot"];
  
  // Create state directory and sample jobs
  for (let i = 0; i < connectors.length; i++) {
    const connector = connectors[i];
    const jobId = `${connector}-job-${i}`;
    const jobDir = join(home, connector, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        bridgeVersion: "0.3.0",
        connector,
        jobId,
        status: i === 0 ? "RUNNING" : "COMPLETED",
        completed: i !== 0,
        mode: "review",
        scopeKind: "uncommitted",
        prompt: `Test prompt for ${connector}`,
        model: `${connector}-model-v1`,
        workerPid: i === 0 ? process.pid : null,
        targetPid: i === 0 ? process.pid : null,
        repositoryRoot: i % 2 === 0 ? "/repo/alpha" : "/repo/beta",
        createdAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        startedAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        finishedAt: i !== 0 ? new Date(Date.now() - (10 - i - 1) * 60000).toISOString() : null,
        durationMs: i !== 0 ? 60000 : null,
      }, null, 2),
      "utf8",
    );
  }

  // 1. Unscoped (all: true) - returns all 5 jobs sorted by createdAt desc
  const allRuns = await listAllRuns({ all: true, stateHome: home });
  assert.equal(allRuns.length, 5);
  assert.equal(allRuns[0].connector, "copilot"); // newest
  assert.equal(allRuns[4].connector, "codex");   // oldest

  // Verify dynamic enrichment
  const runningJob = allRuns.find((j) => j.status === "RUNNING");
  assert.ok(runningJob);
  assert.equal(runningJob.hostPid, process.pid);
  assert.ok(runningJob.liveDurationMs > 0);

  // 2. Scoped by repositoryRoot
  const scopedRuns = await listAllRuns({ repositoryRoot: "/repo/alpha", all: false, stateHome: home });
  assert.equal(scopedRuns.length, 3);
  assert.ok(scopedRuns.every((j) => j.repositoryRoot === "/repo/alpha"));

  // 3. Non-existent state directory returns empty array
  const emptyRuns = await listAllRuns({ stateHome: join(home, "non-existent") });
  assert.deepEqual(emptyRuns, []);
});

test("readJobTails extracts bounded lines from stdout and stderr logs", async () => {
  const home = await scratch("tails-state");
  const jobId = "tail-test-job-1";
  const jobDir = join(home, "codex", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });

  // Generate 25 lines of stdout and 20 lines of stderr
  const stdoutLines = Array.from({ length: 25 }, (_, i) => `{"event":"step","index":${i + 1}}`).join("\n") + "\n";
  const stderrLines = Array.from({ length: 20 }, (_, i) => `[LOG ${i + 1}] Debug message`).join("\n") + "\n";

  await writeFile(join(jobDir, "provider.stdout.ndjson"), stdoutLines, "utf8");
  await writeFile(join(jobDir, "provider.stderr.log"), stderrLines, "utf8");

  const tails = await readJobTails("codex", jobId, { lines: 5, stateHome: home });
  assert.equal(tails.stdoutTail.split("\n").filter(Boolean).length, 5);
  assert.equal(tails.stderrTail.split("\n").filter(Boolean).length, 5);
  assert.ok(tails.stdoutTail.includes('"index":25'));
  assert.ok(tails.stderrTail.includes("[LOG 20]"));

  // Missing files return empty strings
  const missingTails = await readJobTails("codex", "non-existent-job", { stateHome: home });
  assert.equal(missingTails.stdoutTail, "");
  assert.equal(missingTails.stderrTail, "");
});

test("renderRunsDashboard formats a valid Markdown table and sanitizes prompt previews", () => {
  const jobs = [
    {
      connector: "codex",
      jobId: "codex-12345",
      status: "RUNNING",
      hostPid: 1234,
      model: "gpt-5.4-mini",
      liveDurationMs: 45200,
      mode: "review",
      scopeKind: "uncommitted",
      prompt: "Review the authentication changes | ensure no secrets\nand check edge cases",
    },
    {
      connector: "claude",
      jobId: "claude-67890",
      status: "COMPLETED",
      hostPid: null,
      model: "claude-sonnet-5",
      durationMs: 12400,
      mode: "write",
      scopeKind: null,
      prompt: "Fix formatting in README.md",
    },
  ];

  const markdown = renderRunsDashboard(jobs);
  assert.ok(markdown.includes("| connector | job | status | pid | model | duration | scope | prompt |"));
  assert.ok(markdown.includes("| --- | --- | --- | --- | --- | --- | --- | --- |"));
  assert.ok(markdown.includes("| codex | `codex-12345` | RUNNING | 1234 | gpt-5.4-mini |"));
  assert.ok(markdown.includes("| claude | `claude-67890` | COMPLETED | — | claude-sonnet-5 |"));
  // Prompt sanitization: no raw newlines or unescaped table-breaking pipes
  assert.ok(!markdown.includes("\nand check edge cases"));
  
  // Empty state rendering
  assert.equal(renderRunsDashboard([]), "No runs recorded across connectors.");
});

test("stripAnsi removes ANSI escape color sequences and formatting", () => {
  assert.equal(stripAnsi("\u001b[32mhello\u001b[0m"), "hello");
  assert.equal(stripAnsi("\u001b[1;31mERROR:\u001b[0m details \u001b[34m[info]\u001b[0m"), "ERROR: details [info]");
  assert.equal(stripAnsi("plain text"), "plain text");
  assert.equal(stripAnsi(null), null);
  assert.equal(stripAnsi(undefined), undefined);
});

test("lastJsonObject extracts JSON containing ANSI escape color sequences", () => {
  const payload = { verdict: "approve", summary: "clean", findings: [], next_steps: [] };
  const raw = `\u001b[32m${JSON.stringify(payload)}\u001b[0m`;
  assert.deepEqual(lastJsonObject(raw), payload);

  const rawWithLogs = `\u001b[34m[INFO] Starting analysis...\u001b[0m\n\u001b[32m${JSON.stringify(payload)}\u001b[0m\n\u001b[90mDone\u001b[0m`;
  assert.deepEqual(lastJsonObject(rawWithLogs), payload);
});

test("lastJsonObject extracts JSON enclosed in markdown code fences", () => {
  const payload = { verdict: "approve", summary: "clean code", findings: [], next_steps: [] };

  const fencedJson = "Here is the result:\n```json\n" + JSON.stringify(payload, null, 2) + "\n```\nHope this helps!";
  assert.deepEqual(lastJsonObject(fencedJson), payload);

  const fencedGeneric = "Analysis completed:\n```\n" + JSON.stringify(payload, null, 2) + "\n```\n";
  assert.deepEqual(lastJsonObject(fencedGeneric), payload);

  const multipleBlocks = "```javascript\nconst a = 1;\n```\n```json\n" + JSON.stringify(payload) + "\n```";
  assert.deepEqual(lastJsonObject(multipleBlocks), payload);
});

test("lastJsonObject extracts JSON surrounded by conversational text before and after", () => {
  const payload = { verdict: "needs-attention", summary: "found bugs", findings: [{ title: "x" }], next_steps: ["fix"] };
  const conversational = `I have completed the code review of the uncommitted changes.

${JSON.stringify(payload, null, 2)}

Please let me know if you would like me to fix these issues.`;
  assert.deepEqual(lastJsonObject(conversational), payload);

  const inlineConversational = `Result: {"verdict":"approve","summary":"ok","findings":[],"next_steps":[]} - End of output.`;
  assert.deepEqual(lastJsonObject(inlineConversational), { verdict: "approve", summary: "ok", findings: [], next_steps: [] });
});

test("parseProviderOutput recovers structured JSON from ANSI, markdown fences and chatter", () => {
  const payload = { verdict: "approve", summary: "looks great", findings: [], next_steps: [] };

  // Codex with markdown fence in finalMessage and ANSI in stdout
  const codexOut = "\u001b[32m" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }) + "\u001b[0m";
  const codexFinal = "Here is the review result:\n```json\n" + JSON.stringify(payload) + "\n```\nThank you!";
  const codex = parseProviderOutput("codex", { stdout: codexOut, finalMessage: codexFinal });
  assert.deepEqual(codex.structured, payload);
  assert.ok(!codex.text.includes("\u001b"));

  // Claude with conversational text in result
  const claude = parseProviderOutput("claude", {
    stdout: JSON.stringify({
      session_id: "c-1",
      result: `Reviewed the diff.\n${JSON.stringify(payload)}\nAll checks passed.`,
      structured_output: null,
    }),
  });
  assert.deepEqual(claude.structured, payload);

  // Grok with ANSI in text response
  const grok = parseProviderOutput("grok", {
    stdout: JSON.stringify({
      sessionId: "g-1",
      text: `\u001b[1m\u001b[32m${JSON.stringify(payload)}\u001b[0m`,
      structuredOutput: null,
    }),
  });
  assert.deepEqual(grok.structured, payload);
});

