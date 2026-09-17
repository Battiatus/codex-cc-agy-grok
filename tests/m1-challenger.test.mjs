import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  TERMINAL_STATUSES,
  decorateJob,
  jobPaths,
  listAllRuns,
  listJobs,
  newJobId,
  nowIso,
  processAlive,
  readJobTails,
  reapStaleJobs,
  stateRootBase,
  writeJsonAtomic,
} from "../src/lib/jobs.mjs";
import { renderRunsDashboard, renderResult, renderJobTable } from "../src/lib/render.mjs";
import { parseArgs } from "../src/lib/args.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = join(repositoryRoot, "src", "bridge.mjs");

async function scratch(name) {
  return mkdtemp(join(tmpdir(), `m1-challenge-${name}-`));
}

// ---------------------------------------------------------------------------
// 1. processAlive Stress and Edge-Case Tests
// ---------------------------------------------------------------------------
test("processAlive: boundary values, invalid types, zero, negative, dead and live PIDs", async () => {
  // Invalid types and non-integers
  assert.equal(processAlive(0), false, "PID 0 must be false");
  assert.equal(processAlive(-1), false, "Negative PID must be false");
  assert.equal(processAlive(-9999), false, "Large negative PID must be false");
  assert.equal(processAlive(null), false, "null must be false");
  assert.equal(processAlive(undefined), false, "undefined must be false");
  assert.equal(processAlive(NaN), false, "NaN must be false");
  assert.equal(processAlive(Infinity), false, "Infinity must be false");
  assert.equal(processAlive(-Infinity), false, "-Infinity must be false");
  assert.equal(processAlive("1234"), false, "string PID must be false");
  assert.equal(processAlive(12.34), false, "float PID must be false");
  assert.equal(processAlive({}), false, "object must be false");
  assert.equal(processAlive([]), false, "array must be false");
  assert.equal(processAlive(true), false, "boolean must be false");

  // Live PID: current process
  assert.equal(processAlive(process.pid), true, "Current process PID must be true");

  // Dead PID: spawn a child that exits immediately
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const childPid = child.pid;
  await new Promise((done) => child.on("exit", done));

  // Wait a short moment to ensure OS process cleanup
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(processAlive(childPid), false, "Terminated process PID must be false");
});

// ---------------------------------------------------------------------------
// 2. readJobTails Stress and Edge-Case Tests
// ---------------------------------------------------------------------------
test("readJobTails: empty files, missing files, multi-MB files, and UTF-8 multibyte boundary slicing", async () => {
  const home = await scratch("tails-stress");
  const connectorId = "codex";
  const jobId = "tail-stress-job";
  const paths = jobPaths(connectorId, jobId, home);
  await mkdir(paths.directory, { recursive: true });

  // 2a. Missing files
  const missingTails = await readJobTails(connectorId, "non-existent-job-id", { stateHome: home });
  assert.equal(missingTails.stdoutTail, "");
  assert.equal(missingTails.stderrTail, "");

  // 2b. Empty files (0 bytes)
  await writeFile(paths.stdout, "", "utf8");
  await writeFile(paths.stderr, "", "utf8");
  const emptyTails = await readJobTails(connectorId, jobId, { stateHome: home });
  assert.equal(emptyTails.stdoutTail, "");
  assert.equal(emptyTails.stderrTail, "");

  // 2c. Multi-MB files (e.g. 5MB stdout and 3MB stderr)
  const linesCount5MB = 5000;
  const bigStdoutContent = Array.from({ length: linesCount5MB }, (_, i) => `{"line":${i + 1},"data":"${"A".repeat(100)}"}\n`).join("");
  const bigStderrContent = Array.from({ length: 3000 }, (_, i) => `[ERR-${i + 1}] Some error message here\n`).join("");
  
  await writeFile(paths.stdout, bigStdoutContent, "utf8");
  await writeFile(paths.stderr, bigStderrContent, "utf8");

  const tailStart = Date.now();
  const bigTails = await readJobTails(connectorId, jobId, { lines: 10, stateHome: home });
  const tailDuration = Date.now() - tailStart;

  assert.ok(tailDuration < 500, `Tailing multi-MB files took ${tailDuration}ms, must be fast (bounded byte budget)`);
  const stdoutLines = bigTails.stdoutTail.split("\n").filter(Boolean);
  const stderrLines = bigTails.stderrTail.split("\n").filter(Boolean);
  assert.equal(stdoutLines.length, 10);
  assert.equal(stderrLines.length, 10);
  assert.ok(stdoutLines[9].includes(`"line":${linesCount5MB}`));
  assert.ok(stderrLines[9].includes("[ERR-3000]"));

  // 2d. UTF-8 multibyte characters right at byte boundary
  const paddingBytes = 65530; // Close to 65536
  const padding = "A".repeat(paddingBytes);
  const utf8Payload = `${padding}\nLineBeforeBoundary\n🚀 Événement: 汉字测试 — Système sécurisé! 🎯\nFinalLineAtEnd\n`;
  await writeFile(paths.stdout, utf8Payload, "utf8");

  const utf8Tails = await readJobTails(connectorId, jobId, { lines: 5, stateHome: home });
  assert.ok(utf8Tails.stdoutTail.includes("FinalLineAtEnd"));
  assert.ok(utf8Tails.stdoutTail.includes("Système sécurisé!"));

  // 2e. Line count behaviors: 1 line, huge lines (e.g. 500 lines)
  const singleLineTail = await readJobTails(connectorId, jobId, { lines: 1, stateHome: home });
  assert.equal(singleLineTail.stdoutTail.trim(), "FinalLineAtEnd");

  const hugeLineTail = await readJobTails(connectorId, jobId, { lines: 500, stateHome: home });
  assert.ok(hugeLineTail.stdoutTail.split("\n").length >= 3);
});

// ---------------------------------------------------------------------------
// 3. Prompt Sanitization & Markdown Dashboard Table Formatting
// ---------------------------------------------------------------------------
test("renderRunsDashboard: table structure integrity, pipes, newlines, tabs, HTML tags, and massive prompts", () => {
  const adversarialJobs = [
    {
      connector: "codex",
      jobId: "codex-adv-1",
      status: "RUNNING",
      hostPid: 1111,
      model: "gpt-5",
      liveDurationMs: 1500,
      mode: "review",
      scopeKind: "uncommitted",
      prompt: "Line 1 | Pipe 1 | Pipe 2\r\nLine 2\tTabbed\nLine 3 | Another pipe",
    },
    {
      connector: "claude",
      jobId: "claude-adv-2",
      status: "COMPLETED",
      hostPid: null,
      model: "claude-3-7-sonnet",
      durationMs: 45000,
      mode: "write",
      scopeKind: "branch",
      prompt: "A".repeat(5000), // Massive 5000-char prompt
    },
    {
      connector: "grok",
      jobId: "grok-adv-3",
      status: "FAILED",
      hostPid: null,
      model: null,
      durationMs: 0,
      mode: null,
      scopeKind: null,
      prompt: "<script>alert('xss')</script> | `rm -rf /` | \u0000\u001b[31mRed\u001b[0m",
    },
    {
      connector: "copilot",
      jobId: "copilot-adv-4",
      status: "QUEUED",
      hostPid: null,
      model: "copilot-v1",
      durationMs: null,
      liveDurationMs: null,
      mode: "review",
      scopeKind: "auto",
      prompt: "", // Empty prompt
    },
    {
      connector: "agy",
      jobId: "agy-adv-5",
      status: "STALE",
      hostPid: null,
      model: "antigravity-deep",
      durationMs: null,
      liveDurationMs: 999,
      mode: "review",
      scopeKind: "staged",
      prompt: null, // Null prompt
    },
  ];

  const markdown = renderRunsDashboard(adversarialJobs);
  const lines = markdown.split("\n");

  // Verify header and divider
  assert.equal(lines[0], "| connector | job | status | pid | model | duration | stream | scope | prompt |");
  assert.equal(lines[1], "| --- | --- | --- | --- | --- | --- | --- | --- |");

  // Every row must be a single line (no unescaped newlines breaking table rows)
  assert.equal(lines.length, 7, "Must have exactly header + divider + 5 job rows");

  for (let i = 2; i < lines.length; i++) {
    const row = lines[i];
    assert.ok(row.startsWith("| ") && row.endsWith(" |"), `Row ${i} must start and end with pipe`);
    
    // Check column count by splitting by unescaped pipes
    const columns = row.split(/(?<!\\)\|/).map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    assert.equal(columns.length, 8, `Row ${i} must have exactly 8 columns (got ${columns.length}): ${row}`);
  }

  // Verify specific sanitizations
  // 1. Check codex prompt escaped pipes
  const codexRow = lines.find((l) => l.includes("`codex-adv-1`"));
  assert.ok(codexRow.includes("\\|"), "Pipes in prompt must be escaped with \\|");
  assert.ok(!codexRow.includes("\nLine 2"), "Newlines in prompt must be replaced with spaces");

  // 2. Check massive prompt truncation
  const claudeRow = lines.find((l) => l.includes("`claude-adv-2`"));
  assert.ok(claudeRow.includes("..."), "Massive prompt must be truncated with trailing ellipsis");
  assert.ok(claudeRow.length < 200, "Row length must remain reasonable");

  // 3. Check empty / null prompt fallback
  const copilotRow = lines.find((l) => l.includes("`copilot-adv-4`"));
  assert.ok(copilotRow.includes("—"), "Empty prompt should render fallback dash");
});

// ---------------------------------------------------------------------------
// 4. Multi-Agent Cross-Connector Job Store & Supervision (node src/bridge.mjs runs)
// ---------------------------------------------------------------------------
test("Multi-agent runs across 7 simulated connectors via direct CLI and state scanning", async () => {
  const home = await scratch("multi-agent-runs");
  const testRepoA = join(home, "repo-alpha");
  const testRepoB = join(home, "repo-beta");
  await mkdir(testRepoA, { recursive: true });
  await mkdir(testRepoB, { recursive: true });

  const connectors = ["codex", "claude", "grok", "agy", "copilot", "qwen", "opencode"];
  const createdJobs = [];

  for (let idx = 0; idx < connectors.length; idx++) {
    const connector = connectors[idx];
    const jobId = `${connector}-job-${idx + 1}`;
    const repo = idx % 2 === 0 ? testRepoA : testRepoB;
    const paths = jobPaths(connector, jobId, home);
    await mkdir(paths.directory, { recursive: true });

    const jobData = {
      bridgeVersion: "0.3.0",
      connector,
      jobId,
      status: idx === 0 ? "RUNNING" : idx === 1 ? "QUEUED" : idx === 2 ? "FAILED" : "COMPLETED",
      completed: idx > 2,
      mode: idx % 2 === 0 ? "review" : "write",
      scopeKind: "uncommitted",
      repositoryRoot: repo,
      sourceCwd: repo,
      prompt: `Agent ${connector} task execution with special characters: [é, à, 🚀, |]`,
      model: `${connector}-v1-model`,
      targetPid: idx === 0 ? process.pid : null, // index 0 has live target PID
      workerPid: idx === 1 ? process.pid : null, // index 1 has live worker PID
      durationMs: idx > 2 ? (idx * 1500) : null,
      createdAt: new Date(Date.now() - (10 - idx) * 60000).toISOString(),
      startedAt: new Date(Date.now() - 5000).toISOString(),
      updatedAt: nowIso(),
    };

    await writeJsonAtomic(paths.job, jobData);
    createdJobs.push(jobData);
  }

  // 4a. Verify listAllRuns returns all 7 jobs sorted chronologically descending
  const allRuns = await listAllRuns({ all: true, stateHome: home });
  assert.equal(allRuns.length, 7, "Should discover all 7 jobs across connectors");

  // Verify sort order: newest first
  for (let i = 0; i < allRuns.length - 1; i++) {
    assert.ok(
      new Date(allRuns[i].createdAt).getTime() >= new Date(allRuns[i + 1].createdAt).getTime(),
      "Runs must be sorted chronologically descending",
    );
  }

  // Verify decoration on active jobs (RUNNING, QUEUED)
  const runningJob = allRuns.find((j) => j.status === "RUNNING");
  assert.ok(runningJob);
  assert.equal(runningJob.targetAlive, true);
  assert.equal(runningJob.hostPid, process.pid);
  assert.ok(runningJob.liveDurationMs >= 5000, `Live duration was ${runningJob.liveDurationMs}ms`);

  // 4b. Verify repository scoping
  const scopedRunsA = await listAllRuns({ repositoryRoot: testRepoA, stateHome: home });
  assert.equal(scopedRunsA.length, 4, "Repo A should have 4 jobs");
  assert.ok(scopedRunsA.every((j) => j.repositoryRoot === testRepoA));

  const scopedRunsB = await listAllRuns({ repositoryRoot: testRepoB, stateHome: home });
  assert.equal(scopedRunsB.length, 3, "Repo B should have 3 jobs");
  assert.ok(scopedRunsB.every((j) => j.repositoryRoot === testRepoB));

  // 4c. Verify CLI invocation: node src/bridge.mjs runs --all --format markdown
  const cliMarkdownResult = spawnSync(
    process.execPath,
    [bridgePath, "runs", "--all", "--format", "markdown"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_CONNECTOR_HOME: home,
      },
    },
  );
  assert.equal(cliMarkdownResult.status, 0, `CLI runs failed: ${cliMarkdownResult.stderr}`);
  const cliMarkdown = cliMarkdownResult.stdout;
  assert.ok(cliMarkdown.includes("| connector | job | status | pid | model | duration | stream | scope | prompt |"));
  for (const connector of connectors) {
    assert.ok(cliMarkdown.includes(connector), `Dashboard markdown should include connector ${connector}`);
  }

  // 4d. Verify CLI invocation: node src/bridge.mjs runs --all --format json
  const cliJsonResult = spawnSync(
    process.execPath,
    [bridgePath, "runs", "--all", "--format", "json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_CONNECTOR_HOME: home,
      },
    },
  );
  assert.equal(cliJsonResult.status, 0);
  const parsedJsonRuns = JSON.parse(cliJsonResult.stdout);
  assert.equal(parsedJsonRuns.length, 7);
  assert.ok(parsedJsonRuns.some((r) => r.connector === "qwen"));
  assert.ok(parsedJsonRuns.some((r) => r.connector === "opencode"));
});

// ---------------------------------------------------------------------------
// 5. decorateJob Resilience with missing / aberrant properties
// ---------------------------------------------------------------------------
test("decorateJob: edge cases with null, empty, non-string prompts, missing timestamps", () => {
  // Null job
  assert.equal(decorateJob(null), null);

  // Empty job object
  const emptyDecorated = decorateJob({});
  assert.ok(emptyDecorated);
  assert.equal(emptyDecorated.liveDurationMs, null);
  assert.equal(emptyDecorated.hostPid, null);
  assert.equal(emptyDecorated.targetAlive, false);
  assert.equal(emptyDecorated.workerAlive, false);
  assert.equal(emptyDecorated.processAlive, false);
  assert.equal(emptyDecorated.promptSummary, null);

  // Job with future startedAt or corrupted timestamps
  const futureDecorated = decorateJob({
    startedAt: new Date(Date.now() + 100000).toISOString(),
  });
  assert.equal(futureDecorated.liveDurationMs, 0, "Future startedAt clamped to 0ms min");

  // Job with finishedAt but no durationMs
  const finishedJob = decorateJob({
    startedAt: "2026-08-30T12:00:00.000Z",
    finishedAt: "2026-08-30T12:01:30.000Z",
  });
  assert.equal(finishedJob.liveDurationMs, 90000);
});

// ---------------------------------------------------------------------------
// 6. reapStaleJobs adversarial tests
// ---------------------------------------------------------------------------
test("reapStaleJobs: handles dead worker PIDs, dead target PIDs, already terminal jobs, and missing result files", async () => {
  const home = await scratch("reap-stress");
  const connectorId = "codex";

  // Create dead child process to get guaranteed dead PID
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = child.pid;
  await new Promise((done) => child.on("exit", done));

  // Job 1: RUNNING with dead PID (should be reaped to STALE)
  const p1 = jobPaths(connectorId, "stale-job-1", home);
  await mkdir(p1.directory, { recursive: true });
  await writeJsonAtomic(p1.job, {
    bridgeVersion: "0.3.0",
    connector: connectorId,
    jobId: "stale-job-1",
    status: "RUNNING",
    workerPid: deadPid,
    targetPid: deadPid,
    createdAt: nowIso(),
  });

  // Job 2: RUNNING with live PID (should NOT be reaped)
  const p2 = jobPaths(connectorId, "live-job-2", home);
  await mkdir(p2.directory, { recursive: true });
  await writeJsonAtomic(p2.job, {
    bridgeVersion: "0.3.0",
    connector: connectorId,
    jobId: "live-job-2",
    status: "RUNNING",
    workerPid: process.pid,
    createdAt: nowIso(),
  });

  // Job 3: Already COMPLETED with dead PID (should NOT be reaped)
  const p3 = jobPaths(connectorId, "completed-job-3", home);
  await mkdir(p3.directory, { recursive: true });
  await writeJsonAtomic(p3.job, {
    bridgeVersion: "0.3.0",
    connector: connectorId,
    jobId: "completed-job-3",
    status: "COMPLETED",
    workerPid: deadPid,
    createdAt: nowIso(),
  });

  const reaped = await reapStaleJobs(connectorId, home);
  assert.deepEqual(reaped, ["stale-job-1"]);

  const reapedJob = JSON.parse(await readFile(p1.job, "utf8"));
  assert.equal(reapedJob.status, "STALE");
  assert.equal(reapedJob.completed, false);
  assert.equal(reapedJob.workerPid, null);

  const liveJob = JSON.parse(await readFile(p2.job, "utf8"));
  assert.equal(liveJob.status, "RUNNING");
});

// ---------------------------------------------------------------------------
// 7. CLI status command enrichment & tail inspection
// ---------------------------------------------------------------------------
test("CLI status command: single job enrichment, --tail option, markdown and json formats", async () => {
  const home = await scratch("status-cli-stress");
  const connectorId = "claude";
  const jobId = "claude-status-enrich-1";
  const paths = jobPaths(connectorId, jobId, home);
  await mkdir(paths.directory, { recursive: true });

  await writeJsonAtomic(paths.job, {
    bridgeVersion: "0.3.0",
    connector: connectorId,
    jobId,
    status: "RUNNING",
    mode: "review",
    scopeKind: "uncommitted",
    model: "claude-sonnet-4",
    prompt: "Verify mathematical correctness of algorithms",
    workerPid: process.pid,
    createdAt: new Date(Date.now() - 8000).toISOString(),
    startedAt: new Date(Date.now() - 8000).toISOString(),
  });

  await writeFile(paths.stdout, '{"event":"init"}\n{"event":"processing"}\n{"event":"finished"}\n', "utf8");
  await writeFile(paths.stderr, '[DEBUG] Connecting...\n[DEBUG] Stream opened\n', "utf8");

  // CLI invocation: status <jobId> in Markdown
  const mdResult = spawnSync(
    process.execPath,
    [bridgePath, "status", jobId, "--format", "markdown", "--tail", "2"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGENT_CONNECTOR_HOME: home },
    },
  );
  assert.equal(mdResult.status, 0);
  assert.ok(mdResult.stdout.includes(`## ${connectorId} · RUNNING`));
  assert.ok(mdResult.stdout.includes(`pid ${process.pid}`));
  assert.ok(mdResult.stdout.includes("model claude-sonnet-4"));
  assert.ok(mdResult.stdout.includes("### Recent stdout"));
  assert.ok(mdResult.stdout.includes('{"event":"finished"}'));
  assert.ok(mdResult.stdout.includes("### Recent stderr"));
  assert.ok(mdResult.stdout.includes("[DEBUG] Stream opened"));

  // CLI invocation: status <jobId> in JSON
  const jsonResult = spawnSync(
    process.execPath,
    [bridgePath, "status", jobId, "--format", "json", "--tail", "2"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGENT_CONNECTOR_HOME: home },
    },
  );
  assert.equal(jsonResult.status, 0);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.jobId, jobId);
  assert.equal(parsed.status, "RUNNING");
  assert.equal(parsed.targetAlive, false);
  assert.equal(parsed.workerAlive, true);
  assert.equal(parsed.processAlive, true);
  assert.ok(parsed.liveDurationMs >= 8000);
});
