import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts", "benchmark-parallelism.mjs");
const fixtures = resolve(root, "benchmarks", "fixtures");

function runBenchmark(candidate) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      script,
      "--baseline", resolve(fixtures, "single.json"),
      "--candidate", resolve(fixtures, candidate),
    ], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("parallelism remains disabled until a paired benchmark clears the gate", async () => {
  const response = await runBenchmark("parallel-no-gain.json");
  assert.equal(response.code, 1, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.parallelEligible, false);
  assert.equal(report.policy.enabledByDefault, true);
  assert.match(report.reasons.join("\n"), /no latency, token, or cost gain/);
});

test("a paired benchmark with preserved correctness and measurable gain clears the gate", async () => {
  const response = await runBenchmark("parallel-benefit.json");
  assert.equal(response.code, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.parallelEligible, true);
  assert.equal(report.gains.p95Latency, 0.3);
});
