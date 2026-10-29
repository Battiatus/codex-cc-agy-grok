import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

export function newJobId(providerId) {
  return `${providerId}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

// Not the OS temp directory: Storage Sense and tmp reapers would silently erase
// the job history.
export function stateRoot(stateHome = null) {
  const configured = stateHome || process.env.AGENT_CONNECTOR_HOME;
  return configured ? resolve(configured) : join(homedir(), ".agent-connectors");
}

function jobsRoot(stateHome = null) {
  return join(stateRoot(stateHome), "jobs");
}

// One record per working directory, so two sessions open on different
// repositories never hand off each other's transcript.
export function sessionPath(cwd, stateHome = null) {
  return join(stateRoot(stateHome), "sessions", `${sha256(resolve(cwd)).slice(0, 16)}.json`);
}

export function jobPaths(jobId, stateHome = null) {
  if (!/^[\w-]+$/.test(jobId || "")) throw new Error(`Invalid job id: ${jobId}`);
  const directory = join(jobsRoot(stateHome), jobId);
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
    events: join(directory, "events.ndjson"),
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

// On Windows a reader can hit EPERM/EBUSY (or a half-visible file) while
// writeJsonAtomic renames over the target; a short retry covers that window.
export async function readJsonOrNull(path) {
  let lastError = null;
  for (const delay of WRITE_RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    try {
      return await readJson(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (!RECOVERABLE_WRITE_CODES.has(error?.code) && !(error instanceof SyntaxError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// R2: append-only orchestration journal. One NDJSON line per meaningful step so
// a job's life (queued → spawned → streaming → exit → validated → finished) is
// never inferred — it is recorded. Plain append: never throws into the caller.
export async function appendEvent(jobId, kind, data = {}, stateHome = null) {
  const paths = jobPaths(jobId, stateHome);
  await mkdir(paths.directory, { recursive: true }).catch(() => {});
  // kind/ts/jobId come last so caller data can never shadow the envelope.
  const line = `${JSON.stringify({ ...data, ts: nowIso(), jobId, kind })}\n`;
  await appendFile(paths.events, line, "utf8").catch(() => {});
}

export async function readEvents(jobId, { offset = 0 } = {}, stateHome = null) {
  try {
    const raw = await readFile(jobPaths(jobId, stateHome).events, "utf8");
    const slice = raw.slice(offset);
    const lines = slice.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return { events: lines, offset: raw.length };
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], offset: 0 };
    throw error;
  }
}

// Read-modify-write calls are chained per file so a fire-and-forget heartbeat
// can never land after, and undo, the final status write. A terminal status is
// sticky: nothing after it may move the job back to RUNNING.
const writeChains = new Map();

export function updateJob(jobId, patch, stateHome = null) {
  const path = jobPaths(jobId, stateHome).job;
  const run = async () => {
    const current = (await readJsonOrNull(path)) || {};
    const sticky = TERMINAL_STATUSES.has(current.status)
      ? { status: current.status, completed: current.completed }
      : {};
    const next = { ...current, ...patch, ...sticky, updatedAt: nowIso() };
    await writeJsonAtomic(path, next);
    return next;
  };
  const chained = (writeChains.get(path) || Promise.resolve()).then(run, run);
  writeChains.set(path, chained.catch(() => {}));
  return chained;
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

export async function readJobTails(jobId, options = {}) {
  const opts = typeof options === "number" ? { lines: options } : (options || {});
  const lines = opts.lines ?? 15;
  const maxBytes = opts.maxBytes ?? 65536;
  const stateHome = opts.stateHome ?? null;
  const paths = jobPaths(jobId, stateHome);

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
async function jobIds(stateHome) {
  try {
    // Anything else in the folder (.DS_Store, a stray file) is not a job.
    return (await readdir(jobsRoot(stateHome))).filter((name) => /^[\w-]+$/.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// A worker writes result.json before its final job.json update. If it died, or
// was killed, in between, the result stands: the job record is aligned to it
// rather than overwritten as STALE or CANCELED. Returns the updated job, or null
// when there is no terminal result.
export async function settleFinishedJob(jobId, stateHome = null) {
  const job = await readJsonOrNull(jobPaths(jobId, stateHome).job);
  if (job && TERMINAL_STATUSES.has(job.status)) return job;
  const result = await readJsonOrNull(jobPaths(jobId, stateHome).result);
  if (!result || !TERMINAL_STATUSES.has(result.status)) return null;
  return updateJob(jobId, {
    status: result.status,
    completed: result.completed,
    verdict: result.verdict ?? null,
    branch: result.branch ?? null,
    finishedAt: result.finishedAt ?? nowIso(),
    targetPid: null,
    workerPid: null,
  }, stateHome);
}

// A background job is QUEUED before its worker pid is recorded; reaping it in
// that window would mark a job STALE that is about to run.
const QUEUED_GRACE_MS = 60_000;

export async function reapStaleJobs(stateHome = null) {
  const reaped = [];
  for (const jobId of await jobIds(stateHome)) {
    const paths = jobPaths(jobId, stateHome);
    const job = await readJsonOrNull(paths.job);
    if (!job || TERMINAL_STATUSES.has(job.status)) continue;
    if (job.status !== "RUNNING" && job.status !== "QUEUED") continue;
    if (processAlive(job.workerPid) || processAlive(job.targetPid)) continue;
    if (job.status === "QUEUED" && !job.workerPid && Date.now() - Date.parse(job.createdAt) < QUEUED_GRACE_MS) continue;
    if (await settleFinishedJob(jobId, stateHome)) {
      reaped.push(jobId);
      continue;
    }
    const error = "The worker process disappeared before writing a terminal result.";
    const finishedAt = nowIso();
    await writeJsonAtomic(paths.result, {
      bridgeVersion: job.bridgeVersion,
      connector: job.connector,
      jobId,
      status: "STALE",
      completed: false,
      error,
      finishedAt,
    });
    await updateJob(jobId, {
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

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Per-provider track record over finished jobs, newest first. `recent` keeps
// only each provider's last N jobs, so routing follows current behaviour (a
// fixed login, a broken model) rather than the whole history.
export function providerStats(jobs, { recent = Infinity } = {}) {
  const byProvider = new Map();
  const newestFirst = [...jobs].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  for (const job of newestFirst) {
    // Canceled and empty-scope jobs say nothing about the provider.
    if (!job.connector || !TERMINAL_STATUSES.has(job.status) || ["CANCELED", "EMPTY_SCOPE"].includes(job.status)) continue;
    const entry = byProvider.get(job.connector) ?? { provider: job.connector, finished: [] };
    if (entry.finished.length < recent) entry.finished.push(job);
    byProvider.set(job.connector, entry);
  }
  return [...byProvider.values()].map(({ provider, finished }) => {
    const completed = finished.filter((job) => job.completed);
    const failures = {};
    for (const job of finished) if (!job.completed) failures[job.status] = (failures[job.status] || 0) + 1;
    const [topStatus, topCount] = Object.entries(failures).sort((left, right) => right[1] - left[1])[0] ?? [];
    return {
      provider,
      jobs: finished.length,
      completed: completed.length,
      successRate: finished.length ? completed.length / finished.length : 0,
      medianDurationMs: median(completed.map((job) => job.durationMs).filter((value) => typeof value === "number")),
      costUsd: finished.reduce((sum, job) => sum + (typeof job.costUsd === "number" ? job.costUsd : 0), 0),
      topFailure: topStatus ? { status: topStatus, count: topCount } : null,
    };
  }).sort((left, right) => right.jobs - left.jobs);
}

// newJobId embeds the creation time, so `since` skips old jobs without reading
// their records. An id without a readable time is always read.
function createdAtFromId(jobId) {
  // <provider>-<time36>-<hex>: counted from the end, a hyphenated provider id still works.
  const stamp = parseInt(jobId.split("-").at(-2), 36);
  return Number.isFinite(stamp) ? stamp : Infinity;
}

export async function listJobs({ all = false, repositoryRoot = null, limit = MAX_LISTED_JOBS, since = 0, stateHome = null } = {}) {
  const jobs = [];
  for (const jobId of await jobIds(stateHome)) {
    if (createdAtFromId(jobId) < since) continue;
    const job = await readJsonOrNull(jobPaths(jobId, stateHome).job);
    if (job) jobs.push(decorateJob(job));
  }
  const scoped = repositoryRoot
    ? jobs.filter((job) => job.repositoryRoot === repositoryRoot)
    : jobs;
  const sorted = scoped.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)));
  return all ? sorted : sorted.slice(0, limit);
}
