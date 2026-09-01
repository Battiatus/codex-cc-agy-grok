import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--baseline" && token !== "--candidate") {
      throw new Error(`Unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = resolve(value);
    index += 1;
  }
  if (!options.baseline || !options.candidate) {
    throw new Error("Usage: benchmark-parallelism.mjs --baseline <single.json> --candidate <parallel.json>");
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runKey(run) {
  return `${run.caseId}#${run.attempt}`;
}

function validateReport(report, expectedMode, minimumRuns) {
  if (report.mode !== expectedMode) throw new Error(`Expected ${expectedMode} report, got ${report.mode}`);
  if (!Array.isArray(report.runs) || report.runs.length < minimumRuns) {
    throw new Error(`${expectedMode} report needs at least ${minimumRuns} paired attempts`);
  }
  const keys = new Set();
  for (const run of report.runs) {
    if (typeof run.caseId !== "string" || !Number.isInteger(run.attempt) || typeof run.passed !== "boolean") {
      throw new Error(`${expectedMode} report has an invalid run identity`);
    }
    if (!Number.isFinite(run.latencyMs) || run.latencyMs < 0) {
      throw new Error(`${expectedMode} report requires a non-negative latencyMs for every run`);
    }
    const key = runKey(run);
    if (keys.has(key)) throw new Error(`${expectedMode} report has duplicate run ${key}`);
    keys.add(key);
  }
  return keys;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function metric(runs, name, reducer = mean) {
  if (!runs.every((run) => Number.isFinite(run[name]) && run[name] >= 0)) return null;
  return reducer(runs.map((run) => run[name]));
}

function gain(baseline, candidate) {
  if (baseline === null || candidate === null || baseline === 0) return null;
  return (baseline - candidate) / baseline;
}

function summarize(runs) {
  const passed = runs.filter((run) => run.passed).length;
  return {
    runs: runs.length,
    passed,
    failed: runs.length - passed,
    passRate: passed / runs.length,
    p95LatencyMs: metric(runs, "latencyMs", (values) => percentile(values, 0.95)),
    meanTokens: metric(runs, "tokens"),
    meanCostUsd: metric(runs, "costUsd"),
  };
}

const options = parseArgs(process.argv.slice(2));
const policy = await readJson(resolve(root, "benchmarks", "parallel-policy.json"));
const baseline = await readJson(options.baseline);
const candidate = await readJson(options.candidate);
const activation = policy.parallelism?.activation;
if (!activation) throw new Error("Parallel policy activation rules are missing");

const baselineKeys = validateReport(baseline, "single", activation.minimumPairedAttempts);
const candidateKeys = validateReport(candidate, "parallel", activation.minimumPairedAttempts);
if (baselineKeys.size !== candidateKeys.size || [...baselineKeys].some((key) => !candidateKeys.has(key))) {
  throw new Error("Baseline and parallel reports must contain the same caseId/attempt pairs");
}

const baselineSummary = summarize(baseline.runs);
const candidateSummary = summarize(candidate.runs);
const gains = {
  p95Latency: gain(baselineSummary.p95LatencyMs, candidateSummary.p95LatencyMs),
  meanTokens: gain(baselineSummary.meanTokens, candidateSummary.meanTokens),
  meanCost: gain(baselineSummary.meanCostUsd, candidateSummary.meanCostUsd),
};
const reasons = [];
if (candidateSummary.passRate < baselineSummary.passRate || candidateSummary.failed > baselineSummary.failed) {
  reasons.push("correctness regressed or parallel mode introduced additional failures");
}

for (const [name, value] of Object.entries(gains)) {
  if (value !== null && value < -activation.maximumRegression) {
    reasons.push(`${name} regressed by more than ${Math.round(activation.maximumRegression * 100)}%`);
  }
}

const measurableGain = Object.values(gains).some(
  (value) => value !== null && value >= activation.minimumEfficiencyGain,
);
if (!measurableGain) {
  reasons.push(`no latency, token, or cost gain reached ${Math.round(activation.minimumEfficiencyGain * 100)}%`);
}

const parallelEligible = reasons.length === 0;
process.stdout.write(`${JSON.stringify({
  parallelEligible,
  policy: {
    enabledByDefault: policy.parallelism.enabled,
    minimumPairedAttempts: activation.minimumPairedAttempts,
    minimumEfficiencyGain: activation.minimumEfficiencyGain,
  },
  baseline: baselineSummary,
  candidate: candidateSummary,
  gains,
  reasons,
}, null, 2)}\n`);
if (!parallelEligible) process.exitCode = 1;
