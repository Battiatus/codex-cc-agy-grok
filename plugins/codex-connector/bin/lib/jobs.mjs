import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const WRITE_RETRY_DELAYS_MS = [0, 15, 40, 90, 200];
const RECOVERABLE_WRITE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const MAX_LISTED_JOBS = 25;

export const TERMINAL_STATUSES = new Set([
  "CANCELED",
  "COMPLETED",
  "COMPLETED_WITH_DENIALS",
  "COULD_NOT_REVIEW",
  "EMPTY_SCOPE",
  "FAILED",
  "SCHEMA_VIOLATION",
  "SEMANTIC_MISMATCH",
  "STALE",
  "TIMEOUT",
]);

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function newJobId(connectorId) {
  return `${connectorId}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function stateRootBase(stateHome = null) {
  const configured = stateHome || process.env.AGENT_CONNECTOR_HOME;
  return configured ? resolve(configured) : join(tmpdir(), "agent-connectors");
}

export function stateRoot(connectorId, stateHome = null) {
  return join(stateRootBase(stateHome), connectorId);
}

export function jobPaths(connectorId, jobId, stateHome = null) {
  const directory = join(stateRoot(connectorId, stateHome), "jobs", jobId);
  return {
    directory,
    job: join(directory, "job.json"),
    request: join(directory, "request.json"),
    result: join(directory, "result.json"),
    stdout: join(directory, "provider.stdout.ndjson"),
    stderr: join(directory, "provider.stderr.log"),
    finalMessage: join(directory, "provider.final.txt"),
    schema: join(directory, "output-schema.json"),
    promptComposed: join(directory, "prompt.composed.txt"),
    invocation: join(directory, "invocation.json"),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// rename() onto a path another handle holds fails with EPERM on Windows, which
// is exactly what a cancel racing the worker produces. Retry instead of losing
// the job record.
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let lastError = null;
  for (const delay of WRITE_RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, path);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => {});
      if (!RECOVERABLE_WRITE_CODES.has(error?.code)) throw error;
    }
  }
  throw lastError;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readJsonOrNull(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function updateJob(connectorId, jobId, patch, stateHome = null) {
  const paths = jobPaths(connectorId, jobId, stateHome);
  const current = (await readJsonOrNull(paths.job)) || {};
  const next = { ...current, ...patch, updatedAt: nowIso() };
  await writeJsonAtomic(paths.job, next);
  return next;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function decorateJob(job) {
  if (!job) return null;
  const started = job.startedAt || job.createdAt;
  let liveDurationMs = job.durationMs ?? null;
  if (liveDurationMs === null && started) {
    const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
    liveDurationMs = Math.max(0, end - new Date(started).getTime());
  }

  const isTargetAlive = processAlive(job.targetPid);
  const isWorkerAlive = processAlive(job.workerPid);
  const isAlive = isTargetAlive || isWorkerAlive;
  const hostPid = isAlive
    ? (isTargetAlive ? job.targetPid : job.workerPid)
    : (job.targetPid || job.workerPid || null);

  const promptText = job.prompt || "";
  const promptSummary = promptText
    ? promptText.replace(/[\r\n\t]+/g, " ").trim()
    : null;

  return {
    ...job,
    liveDurationMs,
    hostPid,
    targetAlive: isTargetAlive,
    workerAlive: isWorkerAlive,
    processAlive: isAlive,
    model: job.model || null,
    promptSummary: promptSummary && promptSummary.length > 60
      ? `${promptSummary.slice(0, 57)}...`
      : promptSummary,
  };
}

export async function readJobTails(connectorId, jobId, options = {}) {
  const opts = typeof options === "number" ? { lines: options } : (options || {});
  const lines = opts.lines ?? 15;
  const maxBytes = opts.maxBytes ?? 65536;
  const stateHome = opts.stateHome ?? null;
  const paths = jobPaths(connectorId, jobId, stateHome);

  async function tailFile(filePath) {
    try {
      const buffer = await readFile(filePath);
      if (!buffer.length) return "";
      const slice = buffer.length > maxBytes
        ? buffer.subarray(buffer.length - maxBytes)
        : buffer;
      const text = slice.toString("utf8");
      const splitLines = text.split(/\r?\n/).filter(Boolean);
      return splitLines.slice(-lines).join("\n");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  const [stdoutTail, stderrTail] = await Promise.all([
    tailFile(paths.stdout),
    tailFile(paths.stderr),
  ]);

  return { stdoutTail, stderrTail };
}

// A detached worker that dies before writing result.json would otherwise leave
// the job RUNNING forever. Anything whose worker is gone becomes STALE.
export async function reapStaleJobs(connectorId, stateHome = null) {
  const jobsDirectory = join(stateRoot(connectorId, stateHome), "jobs");
  let names;
  try {
    names = await readdir(jobsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reaped = [];
  for (const jobId of names) {
    const paths = jobPaths(connectorId, jobId, stateHome);
    const job = await readJsonOrNull(paths.job);
    if (!job || TERMINAL_STATUSES.has(job.status)) continue;
    if (job.status !== "RUNNING" && job.status !== "QUEUED") continue;
    if (processAlive(job.workerPid) || processAlive(job.targetPid)) continue;
    const error = "The worker process disappeared before writing a terminal result.";
    const finishedAt = nowIso();
    await writeJsonAtomic(paths.result, {
      bridgeVersion: job.bridgeVersion,
      connector: connectorId,
      jobId,
      status: "STALE",
      completed: false,
      error,
      finishedAt,
    });
    await updateJob(connectorId, jobId, {
      status: "STALE",
      completed: false,
      error,
      finishedAt,
      targetPid: null,
      workerPid: null,
    }, stateHome);
    reaped.push(jobId);
  }
  return reaped;
}

export async function listJobs(connectorId, { all = false, repositoryRoot = null, stateHome = null } = {}) {
  const jobsDirectory = join(stateRoot(connectorId, stateHome), "jobs");
  let names;
  try {
    names = await readdir(jobsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const jobs = [];
  for (const jobId of names) {
    const job = await readJsonOrNull(jobPaths(connectorId, jobId, stateHome).job);
    if (job) jobs.push(decorateJob({ ...job, connector: job.connector || connectorId }));
  }
  const scoped = repositoryRoot
    ? jobs.filter((job) => job.repositoryRoot === repositoryRoot)
    : jobs;
  const sorted = scoped.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)));
  return all ? sorted : sorted.slice(0, MAX_LISTED_JOBS);
}

export async function listAllRuns({ all = false, repositoryRoot = null, limit = MAX_LISTED_JOBS, stateHome = null } = {}) {
  const base = stateRootBase(stateHome);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const connectorDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const allJobs = [];

  for (const connectorId of connectorDirs) {
    const jobsDir = join(base, connectorId, "jobs");
    let jobIds;
    try {
      jobIds = await readdir(jobsDir);
    } catch {
      continue;
    }

    for (const jobId of jobIds) {
      const job = await readJsonOrNull(jobPaths(connectorId, jobId, stateHome).job);
      if (job) {
        allJobs.push(decorateJob({ ...job, connector: job.connector || connectorId }));
      }
    }
  }

  const scoped = repositoryRoot
    ? allJobs.filter((job) => job.repositoryRoot === repositoryRoot)
    : allJobs;

  const sorted = scoped.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)));

  return all ? sorted : sorted.slice(0, limit);
}
