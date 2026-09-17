import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { listAllRuns, readJobTails, stateRoot } from "../src/lib/jobs.mjs";
import { renderRunsDashboard } from "../src/lib/render.mjs";
import { repositoryRoot } from "../src/lib/git.mjs";

const execFileAsync = promisify(execFile);
const bridgePath = resolve("src/bridge.mjs");

async function runBridge(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [bridgePath, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      }
    );
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      exitCode: error.code || 1,
      stdout: (error.stdout || "").trim(),
      stderr: (error.stderr || "").trim(),
    };
  }
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
}

test("Empirical Challenge 1: runs command formatting JSON vs Markdown across isolated connectors", async (t) => {
  const testStateHome = await mkdtemp(join(tmpdir(), "m1-challenger-runs-"));

  t.after(async () => {
    await rm(testStateHome, { recursive: true, force: true }).catch(() => {});
  });

  // Empty state test
  const emptyJsonRes = await runBridge(["runs", "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(emptyJsonRes.exitCode, 0);
  assert.deepEqual(JSON.parse(emptyJsonRes.stdout), []);

  const emptyMdRes = await runBridge(["runs", "--format", "markdown"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(emptyMdRes.exitCode, 0);
  assert.equal(emptyMdRes.stdout, "No runs recorded across connectors.");

  // Create mock jobs across 3 connectors with tricky prompt content (pipe symbols, multiline, unicode)
  const repoA = "C:/fake/repo-alpha";
  const repoB = "C:/fake/repo-beta";

  const connectors = ["codex", "claude", "grok"];
  const timestamps = [
    "2026-08-30T10:00:00.000Z",
    "2026-08-30T11:00:00.000Z",
    "2026-08-30T12:00:00.000Z",
  ];

  for (let i = 0; i < connectors.length; i++) {
    const conn = connectors[i];
    const jobId = `${conn}-job-00${i + 1}`;
    const jobDir = join(testStateHome, conn, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });

    const jobData = {
      bridgeVersion: "0.3.0",
      connector: conn,
      jobId,
      status: i === 0 ? "COMPLETED" : (i === 1 ? "RUNNING" : "FAILED"),
      completed: i === 0,
      mode: "review",
      repositoryRoot: i === 2 ? repoB : repoA,
      prompt: `Prompt with | pipe | and \n newline \t tab for connector ${conn}`,
      model: i === 0 ? "gpt-4o" : (i === 1 ? "claude-3-5-sonnet" : null),
      createdAt: timestamps[i],
      startedAt: timestamps[i],
      finishedAt: i === 0 ? "2026-08-30T10:01:05.000Z" : (i === 2 ? "2026-08-30T12:00:10.500Z" : null),
      durationMs: i === 0 ? 65000 : (i === 2 ? 10500 : null),
      targetPid: i === 1 ? process.pid : null,
      workerPid: null,
    };

    await writeFile(join(jobDir, "job.json"), JSON.stringify(jobData, null, 2), "utf8");
    await writeFile(join(jobDir, "provider.stdout.ndjson"), `log line 1 for ${conn}\nlog line 2 for ${conn}\n`, "utf8");
    await writeFile(join(jobDir, "provider.stderr.log"), `error warning for ${conn}\n`, "utf8");
  }

  // Test JSON output
  const jsonRes = await runBridge(["runs", "--all", "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(jsonRes.exitCode, 0);
  const parsedJson = JSON.parse(jsonRes.stdout);
  assert.equal(parsedJson.length, 3);
  // Sort order check: newest first
  assert.equal(parsedJson[0].jobId, "grok-job-003");
  assert.equal(parsedJson[1].jobId, "claude-job-002");
  assert.equal(parsedJson[2].jobId, "codex-job-001");

  // Check enrichment fields in JSON
  assert.equal(parsedJson[0].model, null);
  assert.equal(parsedJson[1].model, "claude-3-5-sonnet");
  assert.equal(parsedJson[2].model, "gpt-4o");
  assert.equal(parsedJson[1].hostPid, process.pid);
  assert.equal(parsedJson[1].targetAlive, true);
  assert.ok(parsedJson[1].liveDurationMs > 0, "live duration must be calculated for running job");

  // Test Markdown output
  const mdRes = await runBridge(["runs", "--all", "--format", "markdown"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(mdRes.exitCode, 0);
  const mdLines = mdRes.stdout.split("\n");
  assert.equal(mdLines[0], "| connector | job | status | pid | model | duration | stream | scope | prompt |");
  assert.equal(mdLines[1], "| --- | --- | --- | --- | --- | --- | --- | --- |");
  assert.equal(mdLines.length, 5); // header, divider, + 3 job rows

  // Verify Markdown table formatting: every row must have 8 columns (9 pipe boundaries)
  for (const row of mdLines) {
    const unescapedPipes = row.replace(/\\\|/g, "").match(/\|/g) || [];
    assert.equal(unescapedPipes.length, 9, `Row "${row}" must have exactly 9 unescaped pipe separators`);
  }

  // Verify pipe characters in prompt were properly escaped as \|
  assert.ok(mdRes.stdout.includes("Prompt with \\| pipe \\| and"), "Pipes in prompt must be escaped in markdown table");
});

test("Empirical Challenge 2: status <jobId> live duration and log tails", async (t) => {
  const testStateHome = await mkdtemp(join(tmpdir(), "m1-challenger-status-"));

  t.after(async () => {
    await rm(testStateHome, { recursive: true, force: true }).catch(() => {});
  });

  const conn = "claude";
  const jobId = "claude-live-duration-test";
  const jobDir = join(testStateHome, conn, "jobs", jobId);
  await mkdir(jobDir, { recursive: true });

  const twentySecAgo = new Date(Date.now() - 20000).toISOString();

  // Create 30 lines of stdout and 20 lines of stderr
  const stdoutLines = Array.from({ length: 30 }, (_, i) => `stdout-stream-line-${i + 1}`).join("\n");
  const stderrLines = Array.from({ length: 20 }, (_, i) => `stderr-log-line-${i + 1}`).join("\n");

  await writeFile(join(jobDir, "provider.stdout.ndjson"), stdoutLines, "utf8");
  await writeFile(join(jobDir, "provider.stderr.log"), stderrLines, "utf8");

  // Write active job without finishedAt or durationMs
  const activeJob = {
    bridgeVersion: "0.3.0",
    connector: conn,
    jobId,
    status: "RUNNING",
    completed: false,
    mode: "write",
    repositoryRoot: "C:/test/repo",
    prompt: "Live duration check prompt",
    model: "claude-3-7-sonnet",
    createdAt: twentySecAgo,
    startedAt: twentySecAgo,
    targetPid: process.pid,
    workerPid: null,
  };
  await writeFile(join(jobDir, "job.json"), JSON.stringify(activeJob, null, 2), "utf8");

  // Test status <jobId> JSON with default tail (15 lines)
  const statusRes = await runBridge(["status", jobId, "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(statusRes.exitCode, 0);
  const statusJson = JSON.parse(statusRes.stdout);

  assert.equal(statusJson.jobId, jobId);
  assert.equal(statusJson.status, "RUNNING");
  assert.equal(statusJson.model, "claude-3-7-sonnet");
  assert.equal(statusJson.hostPid, process.pid);
  assert.equal(statusJson.targetAlive, true);
  assert.ok(statusJson.liveDurationMs >= 19000, `Live duration should be >= 19000ms, got ${statusJson.liveDurationMs}`);

  // Test log tails
  assert.ok(statusJson.stdoutTail, "stdoutTail must be present");
  assert.ok(statusJson.stderrTail, "stderrTail must be present");
  const parsedStdoutLines = statusJson.stdoutTail.split("\n");
  const parsedStderrLines = statusJson.stderrTail.split("\n");

  assert.equal(parsedStdoutLines.length, 15, "Default stdout tail should be 15 lines");
  assert.equal(parsedStdoutLines[parsedStdoutLines.length - 1], "stdout-stream-line-30");
  assert.equal(parsedStdoutLines[0], "stdout-stream-line-16");

  assert.equal(parsedStderrLines.length, 15, "Default stderr tail should be 15 lines");
  assert.equal(parsedStderrLines[parsedStderrLines.length - 1], "stderr-log-line-20");
  assert.equal(parsedStderrLines[0], "stderr-log-line-6");

  // Test custom --tail flag (e.g. 5 lines)
  const customTailRes = await runBridge(["status", jobId, "--tail", "5", "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(customTailRes.exitCode, 0);
  const customJson = JSON.parse(customTailRes.stdout);
  assert.equal(customJson.stdoutTail.split("\n").length, 5);
  assert.equal(customJson.stderrTail.split("\n").length, 5);
  assert.equal(customJson.stdoutTail.split("\n")[4], "stdout-stream-line-30");

  // Test Markdown output for status
  const statusMdRes = await runBridge(["status", jobId, "--format", "markdown"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(statusMdRes.exitCode, 0);
  assert.ok(statusMdRes.stdout.includes("## claude · RUNNING"), "Header should include connector and status");
  assert.ok(statusMdRes.stdout.includes("### Recent stdout"), "Should render Recent stdout section");
  assert.ok(statusMdRes.stdout.includes("### Recent stderr"), "Should render Recent stderr section");
  assert.ok(statusMdRes.stdout.includes("model claude-3-7-sonnet"), "Should render model in facts line");

  // Test non-existent job
  const missingJobRes = await runBridge(["status", "claude-non-existent-999"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(missingJobRes.exitCode, 1);
  assert.ok(missingJobRes.stderr.includes("Job not found: claude-non-existent-999"));
});

test("Empirical Challenge 3: Repository scoping with --cwd vs --all", async (t) => {
  const testStateHome = await mkdtemp(join(tmpdir(), "m1-challenger-scoping-state-"));
  const tempRepoDirA = await mkdtemp(join(tmpdir(), "m1-repo-alpha-"));
  const tempRepoDirB = await mkdtemp(join(tmpdir(), "m1-repo-beta-"));

  initGitRepo(tempRepoDirA);
  initGitRepo(tempRepoDirB);

  const gitRootA = repositoryRoot(tempRepoDirA);
  const gitRootB = repositoryRoot(tempRepoDirB);

  t.after(async () => {
    await rm(testStateHome, { recursive: true, force: true }).catch(() => {});
    await rm(tempRepoDirA, { recursive: true, force: true }).catch(() => {});
    await rm(tempRepoDirB, { recursive: true, force: true }).catch(() => {});
  });

  // Create 4 jobs across 2 connectors and 2 repos
  const jobsData = [
    { conn: "codex", id: "codex-job-a1", repo: gitRootA, time: "2026-08-30T10:00:00.000Z" },
    { conn: "codex", id: "codex-job-b1", repo: gitRootB, time: "2026-08-30T10:05:00.000Z" },
    { conn: "agy", id: "agy-job-a2", repo: gitRootA, time: "2026-08-30T10:10:00.000Z" },
    { conn: "agy", id: "agy-job-b2", repo: gitRootB, time: "2026-08-30T10:15:00.000Z" },
  ];

  for (const j of jobsData) {
    const dir = join(testStateHome, j.conn, "jobs", j.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "job.json"), JSON.stringify({
      bridgeVersion: "0.3.0",
      connector: j.conn,
      jobId: j.id,
      status: "COMPLETED",
      completed: true,
      mode: "review",
      repositoryRoot: j.repo,
      createdAt: j.time,
      startedAt: j.time,
      finishedAt: j.time,
      durationMs: 1000,
    }, null, 2), "utf8");
  }

  // 1. Test --all: should return all 4 jobs
  const allRes = await runBridge(["runs", "--all", "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(allRes.exitCode, 0);
  const allJobs = JSON.parse(allRes.stdout);
  assert.equal(allJobs.length, 4);

  // 2. Test --cwd pointing to repoAlpha: should only return the 2 jobs for repoAlpha
  const alphaRes = await runBridge(["runs", "--cwd", tempRepoDirA, "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(alphaRes.exitCode, 0);
  const alphaJobs = JSON.parse(alphaRes.stdout);
  assert.equal(alphaJobs.length, 2);
  assert.ok(alphaJobs.every((j) => j.repositoryRoot === gitRootA));
  assert.deepEqual(alphaJobs.map((j) => j.jobId), ["agy-job-a2", "codex-job-a1"]);

  // 3. Test --cwd pointing to repoBeta: should only return the 2 jobs for repoBeta
  const betaRes = await runBridge(["runs", "--cwd", tempRepoDirB, "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(betaRes.exitCode, 0);
  const betaJobs = JSON.parse(betaRes.stdout);
  assert.equal(betaJobs.length, 2);
  assert.ok(betaJobs.every((j) => j.repositoryRoot === gitRootB));
  assert.deepEqual(betaJobs.map((j) => j.jobId), ["agy-job-b2", "codex-job-b1"]);

  // 4. Test status list with repo-scoping
  const statusScopeRes = await runBridge(["status", "--cwd", tempRepoDirA, "--format", "json"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(statusScopeRes.exitCode, 0);
  const statusScopeJobs = JSON.parse(statusScopeRes.stdout);
  assert.equal(statusScopeJobs.length, 1);
  assert.equal(statusScopeJobs[0].jobId, "codex-job-a1");
});

test("Empirical Challenge 4: Error handling, validation & log boundary stress", async (t) => {
  const testStateHome = await mkdtemp(join(tmpdir(), "m1-challenger-stress-"));

  t.after(async () => {
    await rm(testStateHome, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Invalid format flag
  const badFormatRes = await runBridge(["runs", "--format", "xml"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(badFormatRes.exitCode, 1);
  assert.match(badFormatRes.stderr, /Unsupported format: xml/);

  // 2. Invalid tail flag (negative or string)
  const badTailRes1 = await runBridge(["status", "any-id", "--tail", "-5"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(badTailRes1.exitCode, 1);
  assert.match(badTailRes1.stderr, /--tail must be a positive number/);

  const badTailRes2 = await runBridge(["status", "any-id", "--tail", "abc"], { AGENT_CONNECTOR_HOME: testStateHome });
  assert.equal(badTailRes2.exitCode, 1);
  assert.match(badTailRes2.stderr, /--tail must be a positive number/);

  // 3. Log tailing with 0-byte log files
  const emptyLogJobId = "codex-empty-log-job";
  const jobDir = join(testStateHome, "codex", "jobs", emptyLogJobId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "job.json"), JSON.stringify({
    bridgeVersion: "0.3.0",
    connector: "codex",
    jobId: emptyLogJobId,
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
  }), "utf8");
  await writeFile(join(jobDir, "provider.stdout.ndjson"), "", "utf8");
  await writeFile(join(jobDir, "provider.stderr.log"), "", "utf8");

  const tails = await readJobTails("codex", emptyLogJobId, { stateHome: testStateHome });
  assert.equal(tails.stdoutTail, "");
  assert.equal(tails.stderrTail, "");

  // 4. Large log file (1MB) tail extraction performance & bounds
  const largeJobId = "codex-large-log-job";
  const largeJobDir = join(testStateHome, "codex", "jobs", largeJobId);
  await mkdir(largeJobDir, { recursive: true });
  await writeFile(join(largeJobDir, "job.json"), JSON.stringify({
    bridgeVersion: "0.3.0",
    connector: "codex",
    jobId: largeJobId,
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
  }), "utf8");

  const largeLog = "x".repeat(100) + "\n";
  const thousandLines = largeLog.repeat(10000); // ~1MB
  await writeFile(join(largeJobDir, "provider.stdout.ndjson"), thousandLines + "FINAL_LINE_CHECK\n", "utf8");

  const largeTails = await readJobTails("codex", largeJobId, { lines: 10, stateHome: testStateHome });
  assert.ok(largeTails.stdoutTail.endsWith("FINAL_LINE_CHECK"));
  assert.equal(largeTails.stdoutTail.split("\n").length, 10);
});
