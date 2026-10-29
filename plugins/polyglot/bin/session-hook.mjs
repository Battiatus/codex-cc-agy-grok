import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./lib/git.mjs";
import {
  TERMINAL_STATUSES,
  jobPaths,
  listJobs,
  nowIso,
  readJsonOrNull,
  reapStaleJobs,
  sessionPath,
  updateJob,
  writeJsonAtomic,
} from "./lib/jobs.mjs";

// SessionStart records the host transcript path so `handoff` can find the
// conversation without the user pasting a path. SessionEnd reaps jobs whose
// worker died, which is otherwise the only way a RUNNING job stays RUNNING
// forever. UserPromptSubmit tells the host which background jobs finished
// since it last looked, so delegation does not need a blocking `wait`.
const READ_STDIN_TIMEOUT_MS = 3_000;
// Older finished jobs are history, not news.
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_NOTIFIED = 5;
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "agent-bridge.mjs");

function describe(job, result) {
  const parts = [`\`${job.jobId}\``, job.mode, job.status];
  if (result?.verdict) parts.push(`verdict ${result.verdict}`);
  const findings = result?.review?.findings;
  if (Array.isArray(findings) && findings.length) {
    const high = findings.filter((finding) => ["critical", "high"].includes(finding.severity)).length;
    parts.push(`${findings.length} finding${findings.length === 1 ? "" : "s"}${high ? ` (${high} critical/high)` : ""}`);
  }
  if (result?.branch) parts.push(`branch ${result.branch} (${result.filesChanged?.length ?? "?"} files)`);
  if (typeof job.costUsd === "number") parts.push(`$${job.costUsd.toFixed(4)}`);
  return `- ${parts.join(" · ")}`;
}

// Windows paths compare case-insensitively (hosts disagree on the drive letter).
const samePath = (left, right) => (process.platform === "win32"
  ? String(left).toLowerCase() === String(right).toLowerCase()
  : left === right);

// Finished jobs of this repository the host has not read yet. Jobs created
// before twice the window are skipped by id, so a long history stays cheap.
async function unseenFinishedJobs(cwd) {
  const where = repositoryRoot(cwd) || resolve(cwd);
  const since = Date.now() - NOTIFY_WINDOW_MS;
  const jobs = await listJobs({ all: true, since: since - NOTIFY_WINDOW_MS });
  return jobs.filter((job) => TERMINAL_STATUSES.has(job.status)
    && !job.notifiedAt
    && samePath(job.repositoryRoot || job.sourceCwd, where)
    && Date.parse(job.finishedAt) >= since);
}

async function finishedJobsNote(fresh) {
  const shown = fresh.slice(0, MAX_NOTIFIED);
  const lines = await Promise.all(shown.map(async (job) => describe(job, await readJsonOrNull(jobPaths(job.jobId).result))));
  return [
    `polyglot: ${fresh.length} delegated job${fresh.length === 1 ? "" : "s"} finished since you last checked.`,
    ...lines,
    fresh.length > shown.length ? `- and ${fresh.length - shown.length} more (runs).` : null,
    `Read one with: node "${BRIDGE}" result <job-id> --format markdown`,
  ].filter(Boolean).join("\n");
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(), READ_STDIN_TIMEOUT_MS);
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const event = process.argv[2] || "SessionStart";

  if (event === "SessionEnd") {
    const reaped = await reapStaleJobs();
    if (reaped.length) {
      process.stderr.write(`polyglot reaped ${reaped.length} stale job(s)\n`);
    }
    return;
  }

  const payload = await readStdinJson();
  if (event === "UserPromptSubmit") {
    const fresh = await unseenFinishedJobs(payload.cwd || process.cwd());
    if (!fresh.length) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: await finishedJobsNote(fresh) },
    }));
    // Marked after printing: a hook killed in between repeats a note rather than losing it.
    const notifiedAt = nowIso();
    await Promise.all(fresh.map((job) => updateJob(job.jobId, { notifiedAt }).catch(() => {})));
    return;
  }

  const transcriptPath = payload.transcript_path
    || payload.transcriptPath
    || process.env.CLAUDE_TRANSCRIPT_PATH
    || null;
  if (!transcriptPath) return;

  const cwd = payload.cwd || process.cwd();
  await writeJsonAtomic(sessionPath(repositoryRoot(cwd) || cwd), {
    transcriptPath,
    cwd,
    sessionId: payload.session_id || payload.sessionId || null,
    source: payload.source || event,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  process.stderr.write(`polyglot session hook failed: ${error.message}\n`);
});
