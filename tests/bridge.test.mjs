import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockProvider = join(repositoryRoot, "tests", "mock-provider.mjs");
const CONNECTORS = ["codex", "grok", "agy", "claude"];

function bridgeFor(connector) {
  return join(repositoryRoot, "plugins", `${connector}-connector`, "bin", "agent-bridge.mjs");
}

async function scratch(name) {
  return mkdtemp(join(tmpdir(), `polyglot-e2e-${name}-`));
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function repositoryWithChange({ dirty = true } = {}) {
  const directory = await scratch("repo");
  git(directory, ["init", "-q", "."]);
  git(directory, ["config", "user.email", "t@t.t"]);
  git(directory, ["config", "user.name", "t"]);
  await writeFile(join(directory, "math.js"), "export const add = (a, b) => a + b;\n", "utf8");
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-qm", "base"]);
  if (dirty) {
    await writeFile(join(directory, "math.js"), "export const add = (a, b) => a - b;\n", "utf8");
  }
  return directory;
}

async function runBridge(connector, args, { env = {}, home = null } = {}) {
  const stateHome = home || (await scratch("state"));
  const result = spawnSync(process.execPath, [bridgeFor(connector), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      AGENT_CONNECTOR_MOCK: mockProvider,
      AGENT_CONNECTOR_HOME: stateHome,
      AGENT_CONNECTOR_CHAIN: "",
      ...env,
    },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { ...result, parsed, stateHome };
}

for (const connector of CONNECTORS) {
  test(`${connector}: a git-scoped review returns a schema-validated verdict`, async () => {
    const directory = await repositoryWithChange();
    const { parsed } = await runBridge(connector, [
      "review", "--cwd", directory, "--scope", "uncommitted", "--timeout", "60s",
    ]);
    assert.equal(parsed.status, "COMPLETED", JSON.stringify(parsed?.schemaErrors ?? parsed));
    assert.equal(parsed.completed, true);
    assert.equal(parsed.verdict, "needs-attention");
    assert.equal(parsed.scope.kind, "uncommitted");
    assert.equal(parsed.scope.fileCount, 1);
    assert.equal(parsed.review.findings[0].file, "math.js");
    assert.equal(parsed.review.findings[0].line_start, 2);
    assert.deepEqual(parsed.schemaErrors, []);
    assert.equal(parsed.isolationStrategy, "in-place-read-only");
    assert.equal(parsed.workspaceExported, false);
    assert.equal(parsed.gitHistoryAvailable, true);
    assert.equal(parsed.usage.inputTokens, 1_234);
    assert.ok(parsed.nativeSessionId);
    assert.ok(parsed.durationMs >= 0);
  });
}

test("an empty scope is never reported as an approval", async () => {
  const directory = await repositoryWithChange({ dirty: false });
  const { parsed } = await runBridge("codex", [
    "review", "--cwd", directory, "--scope", "uncommitted", "--timeout", "60s",
  ]);
  assert.equal(parsed.status, "EMPTY_SCOPE");
  assert.equal(parsed.completed, false);
  assert.equal(parsed.scope.empty, true);
});

test("a could-not-review verdict is terminal and not completed", async () => {
  const directory = await repositoryWithChange();
  const { parsed } = await runBridge(
    "grok",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { MOCK_VERDICT: "could-not-review" } },
  );
  assert.equal(parsed.status, "COULD_NOT_REVIEW");
  assert.equal(parsed.completed, false);
  assert.equal(parsed.verdict, "could-not-review");
});

test("a malformed payload is a schema violation, not a success", async () => {
  const directory = await repositoryWithChange();
  const malformed = await runBridge(
    "claude",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { MOCK_MALFORMED: "1" } },
  );
  assert.equal(malformed.parsed.status, "SCHEMA_VIOLATION");
  assert.equal(malformed.parsed.completed, false);
  assert.ok(malformed.parsed.schemaErrors.length > 0);

  const prose = await runBridge(
    "claude",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { MOCK_NOT_JSON: "1" } },
  );
  assert.equal(prose.parsed.status, "SCHEMA_VIOLATION");
  assert.equal(prose.parsed.completed, false);
});

test("a real permission denial is reported and never counted as completed", async () => {
  const directory = await repositoryWithChange();
  for (const connector of ["claude", "codex"]) {
    const { parsed } = await runBridge(
      connector,
      ["review", "--cwd", directory, "--timeout", "60s"],
      { env: { MOCK_DENIAL: "1" } },
    );
    assert.equal(parsed.status, "COMPLETED_WITH_DENIALS", `${connector} must report denials`);
    assert.equal(parsed.completed, false);
    assert.equal(parsed.permissionDenialDetected, true);
    assert.ok(parsed.permissionDenials.length > 0);
  }
});

test("benign provider noise does not downgrade a clean review", async () => {
  const directory = await repositoryWithChange();
  const { parsed } = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { MOCK_FS_WARNING: "1" } },
  );
  assert.equal(parsed.status, "COMPLETED");
  assert.equal(parsed.permissionDenialDetected, false);
  assert.deepEqual(parsed.permissionDenials, []);
  assert.ok(parsed.providerNotices.length > 0, "codex error items are surfaced as notices");
});

test("an exact-response assertion still fails closed", async () => {
  const directory = await repositoryWithChange();
  const matched = await runBridge(
    "agy",
    ["run", "--cwd", directory, "--prompt", "ping", "--expect-response", "PONG", "--timeout", "60s"],
    { env: { MOCK_TEXT: "PONG" } },
  );
  assert.equal(matched.parsed.status, "COMPLETED");
  assert.equal(matched.parsed.responseMatched, true);

  const mismatched = await runBridge(
    "agy",
    ["run", "--cwd", directory, "--prompt", "ping", "--expect-response", "PONG", "--timeout", "60s"],
    { env: { MOCK_TEXT: "PONG and some analysis" } },
  );
  assert.equal(mismatched.parsed.status, "SEMANTIC_MISMATCH");
  assert.equal(mismatched.parsed.completed, false);
});

test("write mode is gated, records a rollback ref and lists changed files", async () => {
  const directory = await repositoryWithChange({ dirty: false });
  const ungated = await runBridge("codex", [
    "run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--timeout", "60s",
  ]);
  assert.equal(ungated.parsed, null);
  assert.match(ungated.stderr, /requires the explicit --confirm-write flag/);

  const { parsed } = await runBridge(
    "codex",
    [
      "run", "--cwd", directory, "--prompt", "edit",
      "--mode", "write", "--confirm-write", "--timeout", "60s",
    ],
    { env: { MOCK_WRITE: "1", MOCK_TEXT: "done" } },
  );
  assert.equal(parsed.mode, "write");
  assert.equal(parsed.isolationStrategy, "source-workspace");
  assert.ok(parsed.filesChanged.includes("mutated-by-provider.txt"));
  assert.ok(await stat(join(directory, "mutated-by-provider.txt")));
  assert.equal(parsed.scope, null);
});

test("options the provider cannot honour are refused instead of ignored", async () => {
  const directory = await repositoryWithChange();
  const budget = await runBridge("codex", [
    "run", "--cwd", directory, "--prompt", "x", "--max-budget-usd", "5",
  ]);
  assert.match(budget.stderr, /does not support --max-budget-usd/);

  const effort = await runBridge("agy", [
    "run", "--cwd", directory, "--prompt", "x", "--effort", "xhigh",
  ]);
  assert.match(effort.stderr, /Unsupported effort: xhigh/);

  const scope = await runBridge("codex", ["review", "--cwd", directory, "--scope", "everything"]);
  assert.match(scope.stderr, /Unsupported scope: everything/);
});

test("model and effort reach the provider command line", async () => {
  const directory = await repositoryWithChange();
  const argvPath = join(await scratch("argv"), "argv.json");
  await runBridge(
    "claude",
    [
      "review", "--cwd", directory, "--timeout", "60s",
      "--model", "claude-sonnet-5", "--effort", "high",
    ],
    { env: { MOCK_ECHO_ARGV: "1", MOCK_ARGV_PATH: argvPath } },
  );
  const argv = JSON.parse(await readFile(argvPath, "utf8"));
  for (const token of ["--model", "claude-sonnet-5", "--effort", "high", "--json-schema"]) {
    assert.ok(argv.includes(token), `${token} must reach the provider`);
  }
});

test("a timeout is terminal and the job stops running", { timeout: 25_000 }, async () => {
  const directory = await repositoryWithChange();
  const { parsed } = await runBridge(
    "grok",
    ["review", "--cwd", directory, "--timeout", "1s"],
    { env: { MOCK_DELAY_MS: "20000" } },
  );
  assert.equal(parsed.status, "TIMEOUT");
  assert.equal(parsed.completed, false);
});

test("a background job exposes status, result and per-repository scoping", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("bg-state");
  const started = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "300" } },
  );
  assert.equal(started.parsed.status, "QUEUED");
  const jobId = started.parsed.jobId;

  let result = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await runBridge("codex", ["result", jobId], { home });
    const status = probe.parsed?.status;
    if (status && status !== "QUEUED" && status !== "RUNNING") {
      result = probe.parsed;
      break;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(result, "the background job must reach a terminal state");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.verdict, "needs-attention");

  const scoped = await runBridge("codex", ["status", "--cwd", directory], { home });
  assert.ok(scoped.parsed.some((job) => job.jobId === jobId));

  const elsewhere = await runBridge("codex", ["status", "--cwd", await repositoryWithChange()], { home });
  assert.ok(!elsewhere.parsed.some((job) => job.jobId === jobId), "jobs are scoped per repository");

  const markdown = await runBridge(
    "codex",
    ["status", "--cwd", directory, "--format", "markdown"],
    { home },
  );
  assert.match(markdown.stdout, /\| job \| status \| verdict \|/);
});

test("cancel is terminal and idempotent", { timeout: 20_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("cancel-state");
  const started = await runBridge(
    "grok",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "30000" } },
  );
  const jobId = started.parsed.jobId;
  const canceled = await runBridge("grok", ["cancel", jobId], { home });
  assert.equal(canceled.parsed.status, "CANCELED");
  const again = await runBridge("grok", ["cancel", jobId], { home });
  assert.equal(again.parsed.status, "CANCELED");
  const stored = await runBridge("grok", ["result", jobId], { home });
  assert.equal(stored.parsed.status, "CANCELED");
  assert.equal(stored.parsed.completed, false);
});

test("a job whose worker disappeared is reaped instead of running forever", async () => {
  const home = await scratch("reap-state");
  const jobId = "codex-orphan-1";
  const jobDirectory = join(home, "codex", "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(
    join(jobDirectory, "job.json"),
    `${JSON.stringify({
      bridgeVersion: "0.3.0",
      connector: "codex",
      jobId,
      status: "RUNNING",
      completed: false,
      mode: "review",
      workerPid: 999_999_999,
      targetPid: 999_999_998,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  const reaped = await runBridge("codex", ["status", jobId, "--reap"], { home });
  assert.equal(reaped.parsed.status, "STALE");
  assert.equal(reaped.parsed.completed, false);
  const stored = await runBridge("codex", ["result", jobId], { home });
  assert.equal(stored.parsed.status, "STALE");
});

test("a connector cycle is refused before any isolation work happens", async () => {
  const directory = await repositoryWithChange();
  const { parsed } = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--isolate", "--timeout", "60s"],
    { env: { AGENT_CONNECTOR_CHAIN: "grok,codex" } },
  );
  assert.equal(parsed.status, "FAILED");
  assert.match(parsed.error, /Connector loop detected: grok -> codex -> codex/);
  await assert.rejects(
    stat(join(tmpdir(), "polyglot-agent-isolation", parsed.jobId)),
    "no isolation directory may be created for a refused cycle",
  );
});

test("chain depth is capped and the chain is passed to the target", async () => {
  const directory = await repositoryWithChange();
  const deep = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { AGENT_CONNECTOR_CHAIN: "claude,grok,agy" } },
  );
  assert.match(deep.parsed.error, /Connector chain depth exceeded/);

  const { parsed, stateHome } = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { env: { MOCK_ECHO_CHAIN: "1", AGENT_CONNECTOR_CHAIN: "claude" } },
  );
  const stderrLog = await readFile(
    join(stateHome, "codex", "jobs", parsed.jobId, "provider.stderr.log"),
    "utf8",
  );
  assert.match(stderrLog, /CHAIN=claude,codex/);
});

test("non-ASCII provider output survives the round trip", async () => {
  const directory = await repositoryWithChange();
  const { parsed } = await runBridge(
    "grok",
    ["run", "--cwd", directory, "--prompt", "unicode", "--timeout", "60s"],
    { env: { MOCK_UNICODE: "1" } },
  );
  assert.equal(parsed.status, "COMPLETED");
  assert.ok(!parsed.response.includes("�"), "no replacement characters");
  assert.equal(parsed.response.length, "→é漢字🚀".length * 4_000);
});

test("setup reports real installation and authentication state", async () => {
  const { parsed } = await runBridge("claude", ["setup"]);
  assert.equal(parsed.installed, true);
  assert.equal(parsed.authenticated, true);
  assert.match(parsed.version, /mock-claude/);
  assert.ok(parsed.capabilities.structuredOutput);
  assert.match(parsed.note, /never stores provider credentials/);
});

test("unified runs dashboard aggregates background jobs across connectors in markdown and json", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("unified-runs-state");

  // 1. Launch 2 background jobs with different connectors
  const codexRun = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "5000" } },
  );
  assert.equal(codexRun.parsed.status, "QUEUED");
  const codexJobId = codexRun.parsed.jobId;

  const grokRun = await runBridge(
    "grok",
    ["run", "--cwd", directory, "--prompt", "inspect code", "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "5000" } },
  );
  assert.equal(grokRun.parsed.status, "QUEUED");
  const grokJobId = grokRun.parsed.jobId;

  // 2. Query runs dashboard (default Markdown table)
  const dashboardMarkdown = await runBridge("codex", ["runs", "--cwd", directory, "--format", "markdown"], { home });
  assert.match(dashboardMarkdown.stdout, /\| connector \| job \| status \| pid \| model \| duration \| scope \| prompt \|/);
  assert.match(dashboardMarkdown.stdout, new RegExp(codexJobId));
  assert.match(dashboardMarkdown.stdout, new RegExp(grokJobId));

  // 3. Query runs dashboard with JSON format
  const dashboardJson = await runBridge("codex", ["runs", "--cwd", directory, "--format", "json"], { home });
  assert.ok(Array.isArray(dashboardJson.parsed));
  assert.equal(dashboardJson.parsed.length, 2);
  assert.ok(dashboardJson.parsed.some((r) => r.jobId === codexJobId && r.connector === "codex"));
  assert.ok(dashboardJson.parsed.some((r) => r.jobId === grokJobId && r.connector === "grok"));

  // 4. Test repository scoping
  const elsewhere = await repositoryWithChange();
  const scopedAway = await runBridge("codex", ["runs", "--cwd", elsewhere, "--format", "json"], { home });
  assert.equal(scopedAway.parsed.length, 0);

  const allRuns = await runBridge("codex", ["runs", "--all", "--format", "json"], { home });
  assert.equal(allRuns.parsed.length, 2);
});

test("status command for a single job provides enriched metadata and log tails", async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("status-enrich-state");

  const started = await runBridge(
    "claude",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { home },
  );
  assert.equal(started.parsed.status, "COMPLETED");
  const jobId = started.parsed.jobId;

  // Query status <jobId> in JSON format
  const statusJson = await runBridge("claude", ["status", jobId, "--format", "json"], { home });
  assert.equal(statusJson.parsed.jobId, jobId);
  assert.equal(statusJson.parsed.connector, "claude");
  assert.ok(statusJson.parsed.durationMs >= 0);
  assert.ok("stdoutTail" in statusJson.parsed);
  assert.ok("stderrTail" in statusJson.parsed);

  // Query status <jobId> in Markdown format
  const statusMarkdown = await runBridge("claude", ["status", jobId, "--format", "markdown"], { home });
  assert.match(statusMarkdown.stdout, /## claude · COMPLETED/);
  assert.match(statusMarkdown.stdout, new RegExp(jobId));
});

for (const connector of ["codex", "claude", "grok", "agy", "copilot"]) {
  test(`${connector}: adversarial-review generates Red Team prompt with --focus and returns schema-validated verdict`, async () => {
    const directory = await repositoryWithChange();
    const home = await scratch(`adv-${connector}`);
    const { parsed } = await runBridge(connector, [
      "adversarial-review",
      "--focus", "security, boundary checks, input validation",
      "--cwd", directory,
      "--scope", "uncommitted",
      "--timeout", "60s",
    ], { home });

    assert.equal(parsed.status, "COMPLETED");
    assert.equal(parsed.completed, true);
    assert.equal(parsed.mode, "review");
    assert.equal(parsed.verdict, "needs-attention");
    assert.ok(parsed.review);
    assert.ok(Array.isArray(parsed.review.findings));
    assert.deepEqual(parsed.schemaErrors, []);

    // Inspect the stored job to verify Red Team prompt composition
    const jobJsonPath = join(home, connector, "jobs", parsed.jobId, "job.json");
    const jobData = JSON.parse(await readFile(jobJsonPath, "utf8"));
    assert.match(jobData.prompt, /Conduct an adversarial Red Team code review focused on: security, boundary checks, input validation/);
    assert.match(jobData.prompt, /critical vulnerabilities, security defects, edge cases, exploit vectors/);
  });

  test(`${connector}: rescue runs in write mode, captures rollbackRef, propagates error and test context`, async () => {
    const directory = await repositoryWithChange({ dirty: true });
    const home = await scratch(`rescue-${connector}`);
    const { parsed } = await runBridge(connector, [
      "rescue",
      "--prompt", "fix broken calculations",
      "--error", "TypeError: add is not a function\n    at test.js:10:5",
      "--test", "npm test",
      "--cwd", directory,
      "--timeout", "60s",
    ], { home, env: { MOCK_WRITE: "1", MOCK_TEXT: "fixed calculations" } });

    assert.equal(parsed.status, "COMPLETED");
    assert.equal(parsed.completed, true);
    assert.equal(parsed.mode, "write");
    assert.ok(parsed.filesChanged.includes("mutated-by-provider.txt"));
    assert.ok(parsed.rollbackRef, "rollbackRef must be captured for write-mode rescue");

    // Inspect the stored job to verify rescue prompt composition
    const jobJsonPath = join(home, connector, "jobs", parsed.jobId, "job.json");
    const jobData = JSON.parse(await readFile(jobJsonPath, "utf8"));
    assert.match(jobData.prompt, /Rescue operation: fix broken calculations/);
    assert.match(jobData.prompt, /Error log \/ stack trace:\s+TypeError: add is not a function/);
    assert.match(jobData.prompt, /Failing test command:\s+npm test/);
    assert.match(jobData.prompt, /Diagnose the root cause, make minimal targeted fixes/);
  });
}

test("adversarial-review and rescue support background execution and result retrieval", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("bg-adv-rescue");

  // Background adversarial-review
  const advStart = await runBridge("codex", [
    "adversarial-review",
    "--focus", "security",
    "--cwd", directory,
    "--background",
    "--timeout", "60s",
  ], { home, env: { MOCK_DELAY_MS: "300" } });
  assert.equal(advStart.parsed.status, "QUEUED");
  const advJobId = advStart.parsed.jobId;

  // Background rescue
  const rescueStart = await runBridge("claude", [
    "rescue",
    "--prompt", "fix regression",
    "--error", "AssertionError: expected true",
    "--cwd", directory,
    "--background",
    "--timeout", "60s",
  ], { home, env: { MOCK_WRITE: "1", MOCK_DELAY_MS: "300", MOCK_TEXT: "rescued" } });
  assert.equal(rescueStart.parsed.status, "QUEUED");
  const rescueJobId = rescueStart.parsed.jobId;

  // Poll for adversarial-review completion
  let advResult = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await runBridge("codex", ["result", advJobId], { home });
    if (probe.parsed?.status === "COMPLETED") {
      advResult = probe.parsed;
      break;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(advResult);
  assert.equal(advResult.status, "COMPLETED");
  assert.equal(advResult.mode, "review");
  assert.equal(advResult.verdict, "needs-attention");

  // Poll for rescue completion
  let rescueResult = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await runBridge("claude", ["result", rescueJobId], { home });
    if (probe.parsed?.status === "COMPLETED") {
      rescueResult = probe.parsed;
      break;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(rescueResult);
  assert.equal(rescueResult.status, "COMPLETED");
  assert.equal(rescueResult.mode, "write");
  assert.ok(rescueResult.rollbackRef);
});

test("live output streaming (--stream) pipes chunks to stdout and stderr while returning valid schema result", async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("stream-state");
  const result = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--stream", "--timeout", "60s"],
    { home, env: { MOCK_FS_WARNING: "1" } },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /thread\.started/);
  assert.match(result.stdout, /codex-thread-1/);
  assert.match(result.stderr, /permission denied while opening provider cache/);

  const jobs = await readdir(join(home, "codex", "jobs"));
  const stored = await runBridge("codex", ["result", jobs[0]], { home });
  assert.equal(stored.parsed.status, "COMPLETED");
  assert.equal(stored.parsed.completed, true);
  assert.equal(stored.parsed.verdict, "needs-attention");
  assert.deepEqual(stored.parsed.schemaErrors, []);
  assert.match(result.stdout, /"status":\s*"COMPLETED"/);
});

test("every connector ships an identical bridge and library tree", async () => {
  const reference = await readFile(join(repositoryRoot, "src", "bridge.mjs"), "utf8");
  const libraryNames = (await readdir(join(repositoryRoot, "src", "lib"))).sort();
  for (const connector of CONNECTORS) {
    const pluginBin = join(repositoryRoot, "plugins", `${connector}-connector`, "bin");
    assert.equal(await readFile(join(pluginBin, "agent-bridge.mjs"), "utf8"), reference);
    assert.deepEqual((await readdir(join(pluginBin, "lib"))).sort(), libraryNames);
  }
});
