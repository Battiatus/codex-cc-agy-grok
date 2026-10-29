import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockProvider = join(repositoryRoot, "tests", "mock-provider.mjs");
const CONNECTORS = ["codex", "grok", "agy", "claude"];
const bridge = join(repositoryRoot, "plugins", "polyglot", "bin", "agent-bridge.mjs");
const PROVIDER_COMMANDS = new Set([
  "run", "review", "adversarial-review", "rescue", "resume", "handoff", "setup", "capabilities", "doctor",
]);

const scratchDirectories = [];

async function scratch(name) {
  const directory = await mkdtemp(join(tmpdir(), `polyglot-e2e-${name}-`));
  scratchDirectories.push(directory);
  return directory;
}

after(() => Promise.all(scratchDirectories.map((directory) =>
  rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}))));

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

// The connector argument becomes --to for the commands that target a provider;
// job-id commands (status, result, wait, cancel, runs) take none.
async function runBridge(connector, args, { env = {}, home = null } = {}) {
  const stateHome = home || (await scratch("state"));
  const [command, ...rest] = args;
  const argv = PROVIDER_COMMANDS.has(command) && connector ? [command, "--to", connector, ...rest] : args;
  const result = spawnSync(process.execPath, [bridge, ...argv], {
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

test("write mode is gated and lands on a branch, never in the working tree", async () => {
  const directory = await repositoryWithChange({ dirty: true });
  const ungated = await runBridge("codex", [
    "run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--timeout", "60s",
  ]);
  assert.equal(ungated.parsed, null);
  assert.match(ungated.stderr, /requires the explicit --confirm-write flag/);

  const { parsed, stateHome } = await runBridge(
    "codex",
    [
      "run", "--cwd", directory, "--prompt", "edit",
      "--mode", "write", "--confirm-write", "--timeout", "60s",
    ],
    { env: { MOCK_WRITE: "1", MOCK_TEXT: "done" } },
  );
  assert.equal(parsed.mode, "write");
  assert.equal(parsed.isolationStrategy, "git-worktree-branch");
  assert.equal(parsed.branch, `polyglot/${parsed.jobId}`);
  // Exactly the agent's change: the user's pre-existing math.js edit is not in it.
  assert.deepEqual(parsed.filesChanged, ["mutated-by-provider.txt"]);
  await assert.rejects(stat(join(directory, "mutated-by-provider.txt")), "the working tree is untouched");
  assert.equal(await readFile(join(directory, "math.js"), "utf8"), "export const add = (a, b) => a - b;\n");
  assert.equal(git(directory, ["show", `${parsed.branch}:mutated-by-provider.txt`]).stdout, "codex");
  assert.equal(git(directory, ["worktree", "list"]).stdout.trim().split("\n").length, 1, "the worktree is removed");
  assert.equal(parsed.scope, null);

  const markdown = await runBridge(null, ["result", parsed.jobId, "--format", "markdown"], { home: stateHome });
  assert.match(markdown.stdout, /git diff [0-9a-f]{12} polyglot\//);
});

test("a write job that changes nothing leaves no branch behind", async () => {
  const directory = await repositoryWithChange({ dirty: false });
  const { parsed } = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "noop", "--mode", "write", "--confirm-write", "--timeout", "60s"],
    { env: { MOCK_TEXT: "nothing to do" } },
  );
  assert.equal(parsed.status, "COMPLETED");
  assert.equal(parsed.branch, null);
  assert.deepEqual(parsed.filesChanged, []);
  assert.equal(git(directory, ["branch", "--list", "polyglot/*"]).stdout.trim(), "");
});

test("write mode outside a git repository is refused", async () => {
  const directory = await scratch("no-git");
  const { parsed } = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--confirm-write", "--timeout", "60s"],
  );
  assert.equal(parsed.status, "FAILED");
  assert.match(parsed.error, /needs a git repository/);
});

test("options the provider cannot honour are refused instead of ignored", async () => {
  const directory = await repositoryWithChange();
  const budget = await runBridge("codex", [
    "run", "--cwd", directory, "--prompt", "x", "--max-budget-usd", "5",
  ]);
  assert.match(budget.stderr, /does not support --max-budget-usd/);

  const effort = await runBridge("grok", [
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

  const waited = await runBridge(null, ["wait", jobId, "--timeout", "60s"], { home });
  assert.equal(waited.status, 0, "exit 0 when every job completed");
  assert.equal(waited.parsed.done, true);
  const result = waited.parsed.jobs[0];
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
  assert.match(markdown.stdout, /\| provider \| job \| status \|/);
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
  const jobDirectory = join(home, "jobs", jobId);
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
    join(stateHome, "jobs", parsed.jobId, "provider.stderr.log"),
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
  assert.equal(parsed.connector, "claude");
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
  assert.match(dashboardMarkdown.stdout, /\| provider \| job \| status \| pid \| model \| duration \| cost \| activity \| scope \| prompt \|/);
  assert.match(dashboardMarkdown.stdout, /\*\*2 jobs\*\*/);
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

for (const connector of ["codex", "claude", "grok", "agy", "copilot", "qwen", "opencode"]) {
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
    const jobJsonPath = join(home, "jobs", parsed.jobId, "job.json");
    const jobData = JSON.parse(await readFile(jobJsonPath, "utf8"));
    assert.match(jobData.prompt, /Conduct an adversarial Red Team code review focused on: security, boundary checks, input validation/);
    assert.match(jobData.prompt, /critical vulnerabilities, security defects, edge cases, exploit vectors/);
  });

  test(`${connector}: rescue writes on a branch and propagates error and test context`, async () => {
    const directory = await repositoryWithChange({ dirty: true });
    const home = await scratch(`rescue-${connector}`);
    const { parsed } = await runBridge(connector, [
      "rescue",
      "--prompt", "fix broken calculations",
      "--error", "TypeError: add is not a function\n    at test.js:10:5",
      "--test", "npm test",
      "--cwd", directory,
      "--confirm-write",
      "--timeout", "60s",
    ], { home, env: { MOCK_WRITE: "1", MOCK_TEXT: "fixed calculations" } });

    assert.equal(parsed.status, "COMPLETED");
    assert.equal(parsed.completed, true);
    assert.equal(parsed.mode, "write");
    assert.deepEqual(parsed.filesChanged, ["mutated-by-provider.txt"]);
    assert.equal(parsed.branch, `polyglot/${parsed.jobId}`);

    // Inspect the stored job to verify rescue prompt composition
    const jobJsonPath = join(home, "jobs", parsed.jobId, "job.json");
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
    "--confirm-write",
    "--background",
    "--timeout", "60s",
  ], { home, env: { MOCK_WRITE: "1", MOCK_DELAY_MS: "300", MOCK_TEXT: "rescued" } });
  assert.equal(rescueStart.parsed.status, "QUEUED");
  const rescueJobId = rescueStart.parsed.jobId;

  const waited = await runBridge(null, ["wait", advJobId, rescueJobId, "--timeout", "60s"], { home });
  assert.equal(waited.parsed.done, true);
  const [advResult, rescueResult] = waited.parsed.jobs;
  assert.equal(advResult.status, "COMPLETED");
  assert.equal(advResult.mode, "review");
  assert.equal(advResult.verdict, "needs-attention");

  assert.equal(rescueResult.status, "COMPLETED");
  assert.equal(rescueResult.mode, "write");
  assert.equal(rescueResult.branch, `polyglot/${rescueJobId}`);
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

  const jobs = await readdir(join(home, "jobs"));
  const stored = await runBridge("codex", ["result", jobs[0]], { home });
  assert.equal(stored.parsed.status, "COMPLETED");
  assert.equal(stored.parsed.completed, true);
  assert.equal(stored.parsed.verdict, "needs-attention");
  assert.deepEqual(stored.parsed.schemaErrors, []);
  assert.match(result.stdout, /"status":\s*"COMPLETED"/);
});

test("a prompt far beyond the command-line limit reaches every provider intact, never as an argument", async () => {
  const directory = await repositoryWithChange();
  // 200 KB of diff: the size that used to fail with spawn ENAMETOOLONG.
  await writeFile(join(directory, "math.js"), `${"// padding line for a large diff\n".repeat(6_000)}`, "utf8");
  const providersDirectory = join(repositoryRoot, "plugins", "polyglot", "bin", "providers");
  for (const file of (await readdir(providersDirectory)).filter((name) => name.endsWith(".json"))) {
    const provider = JSON.parse(await readFile(join(providersDirectory, file), "utf8"));
    const capture = await scratch(`prompt-${provider.id}`);
    const { parsed } = await runBridge(
      provider.id,
      ["review", "--cwd", directory, "--timeout", "60s"],
      { env: { MOCK_STDIN_PATH: join(capture, "stdin.txt"), MOCK_ECHO_ARGV: "1", MOCK_ARGV_PATH: join(capture, "argv.json") } },
    );
    assert.notEqual(parsed.status, "FAILED", `${provider.id}: ${parsed.error}`);
    const argv = JSON.parse(await readFile(join(capture, "argv.json"), "utf8"));
    const delivered = provider.invocation.promptVia === "file"
      ? await readFile(argv[argv.indexOf("--prompt-file") + 1], "utf8")
      : await readFile(join(capture, "stdin.txt"), "utf8");
    assert.ok(delivered.length > 150_000, `${provider.id} must receive the full prompt`);
    assert.match(delivered, /<<<DIFF/);
    assert.ok(!argv.some((token) => token.includes("<<<DIFF")), `${provider.id} must not get the prompt as an argument`);
  }
});

test("rescue refuses to write without --confirm-write", async () => {
  const directory = await repositoryWithChange();
  const { parsed, stderr, status } = await runBridge("claude", ["rescue", "--cwd", directory, "--error", "boom"]);
  assert.equal(parsed, null);
  assert.equal(status, 1);
  assert.match(stderr, /requires the explicit --confirm-write flag/);
});

test("an unknown provider is refused with the list of valid ones", async () => {
  const { stderr, status } = await runBridge("../../etc", ["review"]);
  assert.equal(status, 1);
  assert.match(stderr, /Unknown provider: \.\.\/\.\.\/etc\. Expected one of agy, claude, codex/);
});

test("exit codes separate completed, not completed and still running", { timeout: 40_000 }, async () => {
  const directory = await repositoryWithChange();
  const completed = await runBridge("codex", ["review", "--cwd", directory, "--timeout", "60s"]);
  assert.equal(completed.status, 0);

  const violated = await runBridge("claude", ["review", "--cwd", directory, "--timeout", "60s"], { env: { MOCK_MALFORMED: "1" } });
  assert.equal(violated.parsed.status, "SCHEMA_VIOLATION");
  assert.equal(violated.status, 2);

  const home = await scratch("wait-pending");
  const slow = await runBridge(
    "grok",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "30000" } },
  );
  const pending = await runBridge(null, ["wait", slow.parsed.jobId, "--timeout", "1s"], { home });
  assert.equal(pending.status, 3);
  assert.equal(pending.parsed.done, false);
  assert.deepEqual(pending.parsed.pending, [slow.parsed.jobId]);
  await runBridge(null, ["cancel", slow.parsed.jobId], { home });
});

test("canceling a write job discards its branch and worktree", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("cancel-write");
  const started = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--confirm-write", "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "30000", MOCK_WRITE: "1" } },
  );
  const jobId = started.parsed.jobId;
  // The worktree exists once the provider is running.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await runBridge(null, ["status", jobId], { home });
    if (probe.parsed?.status === "RUNNING") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const canceled = await runBridge(null, ["cancel", jobId], { home });
  assert.equal(canceled.parsed.status, "CANCELED");
  assert.equal(git(directory, ["branch", "--list", "polyglot/*"]).stdout.trim(), "");
  assert.equal(git(directory, ["worktree", "list"]).stdout.trim().split("\n").length, 1);
  const stored = await runBridge(null, ["status", jobId], { home });
  assert.equal(stored.parsed.status, "CANCELED", "a terminal status is never overwritten");
});

test("a commit failure keeps the agent's work and fails the job instead of losing it", async () => {
  const directory = await repositoryWithChange();
  const { parsed, status, stateHome } = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--confirm-write", "--timeout", "60s"],
    { env: { MOCK_WRITE: "1", MOCK_LOCK_INDEX: "1" } },
  );
  assert.equal(parsed.status, "FAILED");
  assert.equal(status, 2);
  assert.equal(parsed.phase, "commit");
  assert.match(parsed.error, /kept in/);
  assert.equal(await readFile(join(parsed.executionCwd, "mutated-by-provider.txt"), "utf8"), "codex");
  assert.equal(parsed.branch, `polyglot/${parsed.jobId}`, "the branch is kept with the worktree");
  // The branch is still at its base: apply must not report an empty success.
  const applied = await runBridge(null, ["apply", parsed.jobId], { home: stateHome });
  assert.match(applied.stderr, /no committed change to apply/);
});

test("a write job flags a provider that wrote the source tree", async () => {
  const directory = await repositoryWithChange();
  const { parsed, stateHome } = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--confirm-write", "--timeout", "60s"],
    { env: { MOCK_WRITE: "1", MOCK_WRITE_SOURCE: join(directory, "rogue.txt") } },
  );
  assert.equal(parsed.sourceTreeModified, true);
  const markdown = await runBridge(null, ["result", parsed.jobId, "--format", "markdown"], { home: stateHome });
  assert.match(markdown.stdout, /source working tree changed/);

  const clean = await runBridge(
    "codex",
    ["run", "--cwd", directory, "--prompt", "edit", "--mode", "write", "--confirm-write", "--timeout", "60s"],
    { env: { MOCK_WRITE: "1" } },
  );
  assert.equal(clean.parsed.sourceTreeModified, false);
});

test("a result written just before the worker died stands against the reaper and cancel", async () => {
  const home = await scratch("settle-state");
  for (const jobId of ["codex-settled-1", "codex-settled-2"]) {
    const jobDirectory = join(home, "jobs", jobId);
    await mkdir(jobDirectory, { recursive: true });
    const base = { bridgeVersion: "0.4.0", connector: "codex", jobId, mode: "review", createdAt: new Date().toISOString() };
    await writeFile(join(jobDirectory, "job.json"), JSON.stringify({
      ...base, status: "RUNNING", completed: false, workerPid: 999_999_999, targetPid: 999_999_998,
    }), "utf8");
    await writeFile(join(jobDirectory, "result.json"), JSON.stringify({
      ...base, status: "COMPLETED", completed: true, verdict: "approve", finishedAt: new Date().toISOString(),
    }), "utf8");
  }
  const reaped = await runBridge(null, ["status", "codex-settled-1", "--reap"], { home });
  assert.equal(reaped.parsed.status, "COMPLETED", "the reaper aligns to the stored result instead of STALE");

  const canceled = await runBridge(null, ["cancel", "codex-settled-2"], { home });
  assert.equal(canceled.parsed.status, "COMPLETED", "cancel does not overwrite a finished job");
  const stored = await runBridge(null, ["result", "codex-settled-2"], { home });
  assert.equal(stored.parsed.status, "COMPLETED");
});

test("a git ref that looks like an option is refused", async () => {
  const directory = await repositoryWithChange();
  const { stderr, status } = await runBridge("codex", [
    "review", "--cwd", directory, "--scope", "commit", "--commit", "--output=pwned.txt",
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /Invalid --commit/);
});

async function pollJob(home, jobId, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await readFile(join(home, "jobs", jobId, "job.json"), "utf8").then(JSON.parse, () => null);
    if (job && predicate(job)) return job;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`job ${jobId} never reached the expected state`);
}

function runHook(event, payload, home) {
  return spawnSync(process.execPath, [join(repositoryRoot, "plugins", "polyglot", "bin", "session-hook.mjs"), event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENT_CONNECTOR_HOME: home },
  });
}

const WRITE_JOB = ["run", "--prompt", "edit", "--mode", "write", "--confirm-write", "--timeout", "60s"];

test("a running job shows the agent's current action while it works", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("live");
  const started = await runBridge(
    "agy",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "20000" } },
  );
  const jobId = started.parsed.jobId;
  const job = await pollJob(home, jobId, (record) => record.progress?.lastAction);
  assert.equal(job.progress.lastAction, "read_file math.js", "paths are shown relative to the workspace");
  const status = await runBridge(null, ["status", jobId, "--format", "markdown"], { home });
  assert.match(status.stdout, /\*\*Now:\*\* `read_file math\.js` \(1 action/);
  const runs = await runBridge(null, ["runs", "--all", "--format", "markdown"], { home });
  assert.match(runs.stdout, /\| RUNNING \|.*\| read_file math\.js/);
  await runBridge(null, ["cancel", jobId], { home });
});

test("the next prompt hears about background jobs that finished, once", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("notify");
  const started = await runBridge("codex", ["review", "--cwd", directory, "--background", "--timeout", "60s"], { home });
  const jobId = started.parsed.jobId;
  await pollJob(home, jobId, (record) => record.status === "COMPLETED");

  assert.equal(runHook("UserPromptSubmit", { cwd: await scratch("elsewhere") }, home).stdout, "", "other repositories stay quiet");
  const output = JSON.parse(runHook("UserPromptSubmit", { cwd: directory }, home).stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /1 delegated job finished/);
  assert.ok(output.additionalContext.includes(`\`${jobId}\` · review · COMPLETED · verdict needs-attention · 1 finding (1 critical/high)`));
  assert.equal(runHook("UserPromptSubmit", { cwd: directory }, home).stdout, "", "a job is announced once");

  // A job the host already read is not news.
  const read = await runBridge("codex", ["review", "--cwd", directory, "--background", "--timeout", "60s"], { home });
  await runBridge(null, ["wait", read.parsed.jobId], { home });
  assert.equal(runHook("UserPromptSubmit", { cwd: directory }, home).stdout, "");
});

test("apply brings a write job's branch into the working tree, all or nothing, and discard drops it", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange({ dirty: true });
  const { parsed, stateHome: home } = await runBridge(
    "codex",
    [...WRITE_JOB, "--cwd", directory],
    { env: { MOCK_WRITE: "1", MOCK_WRITE_LATIN1: "1" } },
  );
  const added = join(directory, "mutated-by-provider.txt");

  await writeFile(added, "mine", "utf8");
  const clash = await runBridge(null, ["apply", parsed.jobId], { home });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /Nothing was applied/);
  assert.equal(await readFile(added, "utf8"), "mine", "a clash changes nothing");
  await rm(added);

  const applied = await runBridge(null, ["apply", parsed.jobId], { home });
  assert.equal(applied.parsed.action, "applied");
  assert.equal(await readFile(added, "utf8"), "codex");
  assert.deepEqual([...await readFile(join(directory, "latin1.txt"))], [0x63, 0x61, 0x66, 0xe9], "bytes survive, not just UTF-8");
  assert.equal(await readFile(join(directory, "math.js"), "utf8"), "export const add = (a, b) => a - b;\n", "local edits are kept");
  assert.match((await runBridge(null, ["apply", parsed.jobId], { home })).stderr, /already applied/);

  const discarded = await runBridge(null, ["discard", parsed.jobId], { home });
  assert.equal(discarded.parsed.action, "discarded");
  assert.equal(git(directory, ["branch", "--list", "polyglot/*"]).stdout.trim(), "");
  assert.match((await runBridge(null, ["apply", parsed.jobId], { home })).stderr, /no branch to apply/);
});

test("retry replays a job, on another provider if asked, and continue resumes its session", { timeout: 40_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("retry");
  const failed = await runBridge("claude", ["review", "--cwd", directory, "--timeout", "60s"], { home, env: { MOCK_MALFORMED: "1" } });
  assert.equal(failed.parsed.status, "SCHEMA_VIOLATION");

  const retried = await runBridge(null, ["retry", failed.parsed.jobId, "--to", "grok"], { home });
  assert.equal(retried.parsed.connector, "grok");
  assert.equal(retried.parsed.status, "COMPLETED");
  assert.equal(retried.parsed.scope.kind, "uncommitted", "the original directory and scope come along");
  const record = JSON.parse(await readFile(join(home, "jobs", retried.parsed.jobId, "job.json"), "utf8"));
  assert.equal(record.retryOf, failed.parsed.jobId);

  const write = await runBridge("codex", [...WRITE_JOB, "--cwd", directory], { home, env: { MOCK_TEXT: "done" } });
  assert.match((await runBridge(null, ["retry", write.parsed.jobId], { home })).stderr, /--confirm-write/);
  assert.match(
    (await runBridge(null, ["continue", write.parsed.jobId, "--prompt", "more"], { home })).stderr,
    /temporary worktree/,
    "a session that ran in a removed worktree is not resumed",
  );

  const argvPath = join(home, "argv.json");
  const continued = await runBridge(
    null,
    ["continue", failed.parsed.jobId, "--prompt", "and the tests?"],
    { home, env: { MOCK_ECHO_ARGV: "1", MOCK_ARGV_PATH: argvPath, MOCK_TEXT: "fine" } },
  );
  assert.equal(continued.parsed.connector, "claude");
  assert.equal(continued.parsed.status, "COMPLETED");
  const argv = JSON.parse(await readFile(argvPath, "utf8"));
  const resumeAt = argv.indexOf("--resume");
  assert.deepEqual(argv.slice(resumeAt, resumeAt + 2), ["--resume", "claude-session-1"]);
});

test("another agent reviews a write job's branch in a worktree of that branch", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const write = await runBridge("codex", [...WRITE_JOB, "--cwd", directory], { env: { MOCK_WRITE: "1", MOCK_TEXT: "done" } });
  const review = await runBridge("claude", ["review", "--job", write.parsed.jobId, "--timeout", "60s"], { home: write.stateHome });
  assert.equal(review.parsed.status, "COMPLETED");
  assert.equal(review.parsed.scope.kind, "commit");
  assert.equal(review.parsed.scope.commit, write.parsed.branch);
  assert.equal(review.parsed.scope.base, write.parsed.baseRef, "the whole branch from its base, as apply sees it");
  assert.equal(review.parsed.scope.fileCount, 1);
  assert.equal(review.parsed.isolationStrategy, "git-worktree");
  const prompt = await readFile(review.parsed.promptComposedPath, "utf8");
  assert.match(prompt, /mutated-by-provider\.txt/);
  assert.match(prompt, /another agent \(codex\) made for this task:\nedit/);
});

test("--to auto routes to the provider with the best recent record, and runs --stats shows it", { timeout: 30_000 }, async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("auto");
  const history = [["codex", "FAILED"], ["codex", "TIMEOUT"], ["grok", "COMPLETED"], ["grok", "COMPLETED"]];
  for (const [index, [connector, status]] of history.entries()) {
    const jobId = `${connector}-history-${index}`;
    await mkdir(join(home, "jobs", jobId), { recursive: true });
    await writeFile(join(home, "jobs", jobId, "job.json"), JSON.stringify({
      connector, jobId, status, completed: status === "COMPLETED", durationMs: 1_000,
      createdAt: new Date(Date.now() - 60_000 + index).toISOString(),
    }), "utf8");
  }
  const routed = await runBridge(null, ["review", "--to", "auto", "--cwd", directory, "--timeout", "60s"], { home, env: { CLAUDECODE: "" } });
  assert.equal(routed.parsed.connector, "grok");
  const record = JSON.parse(await readFile(join(home, "jobs", routed.parsed.jobId, "job.json"), "utf8"));
  assert.equal(record.autoRouted, true);
  assert.equal(record.launch.options.to, "auto", "a retry routes again");

  // A second opinion never goes back to the job's author, even the best one.
  const write = await runBridge("grok", [...WRITE_JOB, "--cwd", directory], { home, env: { MOCK_WRITE: "1", MOCK_TEXT: "done" } });
  const second = await runBridge(null, ["review", "--to", "auto", "--job", write.parsed.jobId, "--timeout", "60s"], { home, env: { CLAUDECODE: "" } });
  assert.notEqual(second.parsed.connector, "grok");
  assert.match(
    (await runBridge(null, ["resume", "--to", "auto", "--session", "s", "--prompt", "x"], { home })).stderr,
    /cannot resume a session/,
  );

  const stats = await runBridge(null, ["runs", "--stats", "--format", "markdown"], { home });
  assert.match(stats.stdout, /\| grok \| 4 \| 4 \| 100% \|/);
  assert.match(stats.stdout, /\| codex \| 2 \| 0 \| 0% \| — \| — \| (FAILED|TIMEOUT) ×1 \|/);
});
