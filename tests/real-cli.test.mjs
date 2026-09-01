import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Opt-in: these tests spend real provider quota. Run with
//   POLYGLOT_REAL_CLI=1 npm run test:real
// and optionally narrow with POLYGLOT_REAL_CONNECTORS=codex,grok
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.POLYGLOT_REAL_CLI === "1";
const selected = (process.env.POLYGLOT_REAL_CONNECTORS || "codex,grok,agy,claude")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const REVIEW_TIMEOUT_MS = 9 * 60 * 1000;

function bridgeFor(connector) {
  return join(repositoryRoot, "plugins", `${connector}-connector`, "bin", "agent-bridge.mjs");
}

function runBridge(connector, args, timeoutMs = 120_000) {
  const result = spawnSync(process.execPath, [bridgeFor(connector), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, AGENT_CONNECTOR_MOCK: "", AGENT_CONNECTOR_CHAIN: "" },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), "polyglot-real-"));
  const git = (args) => spawnSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
  git(["init", "-q", "."]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  return { directory, git };
}

async function repositoryWithPlantedDefect() {
  const { directory, git } = await temporaryRepository();
  await writeFile(join(directory, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  await writeFile(join(directory, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
  return directory;
}

for (const connector of selected) {
  test(`${connector}: the installed CLI is ready and every declared flag exists`, { skip: !enabled }, () => {
    const { parsed } = runBridge(connector, ["doctor"], 90_000);
    assert.ok(parsed, "doctor must return JSON");
    assert.equal(parsed.installed, true, `${connector} is not installed`);
    assert.equal(parsed.authenticated, true, `${connector} is not authenticated: ${parsed.remediation}`);
    assert.equal(parsed.flagAudit.checked, true, "the flag audit needs help output");
    assert.deepEqual(
      parsed.flagAudit.missing,
      [],
      `${connector} declares flags the installed CLI does not accept`,
    );
  });

  test(`${connector}: a real review finds the planted defect and returns a valid payload`, {
    skip: !enabled,
    timeout: REVIEW_TIMEOUT_MS + 60_000,
  }, async () => {
    const directory = await repositoryWithPlantedDefect();
    const { parsed } = runBridge(
      connector,
      ["review", "--cwd", directory, "--scope", "uncommitted", "--timeout", "8m"],
      REVIEW_TIMEOUT_MS,
    );
    assert.ok(parsed, "the bridge must return JSON");
    assert.ok(
      ["COMPLETED", "COMPLETED_WITH_DENIALS"].includes(parsed.status),
      `unexpected status ${parsed.status}: ${JSON.stringify(parsed.schemaErrors ?? parsed.error)}`,
    );
    assert.deepEqual(parsed.schemaErrors, [], "the payload must satisfy the review schema");
    assert.equal(parsed.verdict, "needs-attention", "an inverted operator must not be approved");
    assert.equal(parsed.scope.kind, "uncommitted");
    assert.equal(parsed.scope.fileCount, 1);
    assert.equal(parsed.isolationStrategy, "in-place-read-only");
    assert.equal(parsed.workspaceExported, false, "nothing may leave the workspace by default");
    assert.ok(parsed.review.findings.length > 0, "the planted defect must be reported");
    assert.ok(
      parsed.review.findings.some((finding) => finding.file.endsWith("math.js")),
      "a finding must cite math.js",
    );
    assert.ok(parsed.usage.inputTokens > 0, "usage must be reported");
    assert.ok(parsed.nativeSessionId, "the native session id must be captured");
  });
}

// The vendors' own validators catch manifest mistakes our schema checks cannot,
// such as `agents` needing file paths rather than a directory.
const VENDOR_VALIDATORS = [
  { binary: "claude", args: (path) => ["plugin", "validate", path], expect: /Validation passed/ },
  { binary: "grok", args: (path) => ["plugin", "validate", path], expect: /valid/i },
  { binary: "agy", args: (path) => ["plugin", "validate", path], expect: /ok|processed/i },
];

for (const { binary, args, expect } of VENDOR_VALIDATORS) {
  test(`${binary} accepts every generated plugin manifest`, { skip: !enabled, timeout: 300_000 }, () => {
    for (const connector of ["codex", "grok", "agy", "claude"]) {
      const pluginPath = join(repositoryRoot, "plugins", `${connector}-connector`);
      const probe = spawnSync(binary, args(pluginPath), {
        encoding: "utf8",
        windowsHide: true,
        timeout: 90_000,
      });
      const output = `${probe.stdout || ""}\n${probe.stderr || ""}`;
      assert.match(output, expect, `${binary} rejected ${connector}-connector:\n${output}`);
      assert.ok(
        !/Validation failed|✘/.test(output),
        `${binary} reported a failure for ${connector}-connector:\n${output}`,
      );
    }
  });
}

test("a clean tree is reported as an empty scope by a real CLI", {
  skip: !enabled || selected.length === 0,
  timeout: 300_000,
}, async () => {
  const { directory, git } = await temporaryRepository();
  await writeFile(join(directory, "a.js"), "export const a = 1;\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  const { parsed } = runBridge(
    selected[0],
    ["review", "--cwd", directory, "--scope", "uncommitted", "--timeout", "2m"],
    150_000,
  );
  assert.equal(parsed.status, "EMPTY_SCOPE");
  assert.equal(parsed.completed, false);
  assert.equal(parsed.scope.empty, true);
});
