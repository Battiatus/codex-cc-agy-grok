import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.3.0";
const author = { name: "Polyglot Connectors contributors" };
const marketplaceName = "polyglot-agent-connectors";

const connectors = [
  {
    id: "codex",
    pluginName: "codex-connector",
    displayName: "Codex Connector",
    shortName: "Codex",
    binary: "codex",
    resultAdapter: "codex",
    versionArgs: ["--version"],
    helpProbes: [["exec", "--help"], ["exec", "resume", "--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["login", "status"],
      successPattern: "logged in",
      remediation: "Run `codex login`.",
    },
    installHint: "npm install -g @openai/codex",
    effortValues: ["none", "minimal", "low", "medium", "high", "xhigh"],
    capabilities: {
      structuredOutput: "file",
      model: true,
      effort: "config",
      resume: true,
      budgetUsd: false,
      finalMessageFile: true,
      readOnlyEnforcement: "os-sandbox",
    },
    invocation: {
      baseArgs: ["exec", "--json", "--skip-git-repo-check", "-C", "{cwd}", "--sandbox", "{sandbox}"],
      resumeBaseArgs: [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="{sandbox}"',
        "{session}",
      ],
      reviewArgs: [],
      writeArgs: [],
      resumeExtraArgs: [],
      modelArgs: ["-m", "{model}"],
      effortArgs: ["-c", 'model_reasoning_effort="{effort}"'],
      schemaArgs: ["--output-schema", "{schemaPath}"],
      finalMessageArgs: ["-o", "{finalMessagePath}"],
      budgetArgs: [],
      promptArgs: ["{prompt}"],
    },
  },
  {
    id: "grok",
    pluginName: "grok-connector",
    displayName: "Grok Connector",
    shortName: "Grok Build",
    binary: "grok",
    resultAdapter: "grok",
    versionArgs: ["--version"],
    helpProbes: [["--help"]],
    knownHiddenFlags: ["--no-auto-update"],
    authProbe: {
      args: ["models"],
      successPattern: "logged in",
      remediation: "Run `grok login`.",
    },
    installHint: "See https://grok.com/build for the Grok Build CLI installer.",
    effortValues: ["low", "medium", "high"],
    capabilities: {
      structuredOutput: "inline",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: false,
      finalMessageFile: false,
      readOnlyEnforcement: "tool-allowlist",
    },
    invocation: {
      baseArgs: ["--no-auto-update", "-p", "{prompt}", "--cwd", "{cwd}", "--output-format", "json"],
      reviewArgs: [
        "--permission-mode",
        "dontAsk",
        "--tools",
        "read_file,list_dir,grep",
        "--disallowed-tools",
        "run_terminal_command,write,search_replace,spawn_subagent,search_tool,use_tool,web_search,web_fetch",
      ],
      writeArgs: ["--permission-mode", "acceptEdits"],
      resumeExtraArgs: ["--resume", "{session}"],
      modelArgs: ["-m", "{model}"],
      effortArgs: ["--reasoning-effort", "{effort}"],
      schemaArgs: ["--json-schema", "{schemaInline}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  },
  {
    id: "agy",
    pluginName: "agy-connector",
    displayName: "Antigravity Connector",
    shortName: "Antigravity",
    binary: "agy",
    resultAdapter: "agy",
    versionArgs: ["--version"],
    helpProbes: [["--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["models"],
      successPattern: "\\S",
      remediation: "Start `agy` once interactively to sign in.",
    },
    installHint: "See https://antigravity.google/docs/cli/overview for the Antigravity CLI installer.",
    effortValues: ["low", "medium", "high"],
    capabilities: {
      structuredOutput: "file",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: false,
      finalMessageFile: false,
      readOnlyEnforcement: "plan-mode",
    },
    invocation: {
      baseArgs: [
        "-p",
        "{prompt}",
        "--add-dir",
        "{cwd}",
        "--output-format",
        "json",
        "--print-timeout",
        "{providerTimeout}",
      ],
      reviewArgs: ["--mode", "plan", "--sandbox"],
      writeArgs: ["--mode", "accept-edits", "--dangerously-skip-permissions"],
      resumeExtraArgs: ["--conversation", "{session}"],
      modelArgs: ["--model", "{model}"],
      effortArgs: ["--effort", "{effort}"],
      schemaArgs: ["--json-schema", "{schemaPath}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  },
  {
    id: "claude",
    pluginName: "claude-connector",
    displayName: "Claude Code Connector",
    shortName: "Claude Code",
    binary: "claude",
    resultAdapter: "claude",
    versionArgs: ["--version"],
    helpProbes: [["--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["auth", "status"],
      successPattern: "\"loggedIn\"\\s*:\\s*true",
      remediation: "Run `claude auth login`.",
    },
    installHint: "See https://code.claude.com/docs for the Claude Code installer.",
    effortValues: ["low", "medium", "high", "xhigh", "max"],
    capabilities: {
      structuredOutput: "inline",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: true,
      finalMessageFile: false,
      readOnlyEnforcement: "tool-allowlist",
    },
    invocation: {
      baseArgs: ["-p", "{prompt}", "--output-format", "json", "--add-dir", "{cwd}"],
      reviewArgs: ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"],
      writeArgs: [
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Glob,Grep,Edit,Write,Bash",
      ],
      resumeExtraArgs: ["--resume", "{session}"],
      modelArgs: ["--model", "{model}"],
      effortArgs: ["--effort", "{effort}"],
      schemaArgs: ["--json-schema", "{schemaInline}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  },
  {
    id: "qwen",
    pluginName: "qwen-connector",
    displayName: "Qwen Code Connector",
    shortName: "Qwen Code",
    binary: "qwen",
    resultAdapter: "qwen",
    versionArgs: ["--version"],
    helpProbes: [["--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["auth", "status"],
      successPattern: "loggedIn",
      remediation: "Run `qwen auth login`.",
    },
    installHint: "Install Qwen Code CLI",
    effortValues: ["low", "medium", "high"],
    capabilities: {
      structuredOutput: "inline",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: false,
      finalMessageFile: false,
      readOnlyEnforcement: "tool-allowlist",
    },
    invocation: {
      baseArgs: ["-p", "{prompt}", "--output-format", "json", "--cwd", "{cwd}"],
      reviewArgs: ["--allowedTools", "Read,Glob,Grep"],
      writeArgs: ["--allowedTools", "Read,Glob,Grep,Edit,Write,Bash"],
      resumeExtraArgs: ["--resume", "{session}"],
      modelArgs: ["--model", "{model}"],
      effortArgs: ["--effort", "{effort}"],
      schemaArgs: ["--json-schema", "{schemaInline}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  },
  {
    id: "opencode",
    pluginName: "opencode-connector",
    displayName: "OpenCode Connector",
    shortName: "OpenCode",
    binary: "opencode",
    resultAdapter: "opencode",
    versionArgs: ["--version"],
    helpProbes: [["--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["auth", "status"],
      successPattern: "loggedIn",
      remediation: "Run `opencode auth login`.",
    },
    installHint: "Install OpenCode CLI",
    effortValues: ["low", "medium", "high"],
    capabilities: {
      structuredOutput: "inline",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: false,
      finalMessageFile: false,
      readOnlyEnforcement: "tool-allowlist",
    },
    invocation: {
      baseArgs: ["-p", "{prompt}", "--output-format", "json", "--cwd", "{cwd}"],
      reviewArgs: ["--allowedTools", "Read,Glob,Grep"],
      writeArgs: ["--allowedTools", "Read,Glob,Grep,Edit,Write,Bash"],
      resumeExtraArgs: ["--resume", "{session}"],
      modelArgs: ["--model", "{model}"],
      effortArgs: ["--effort", "{effort}"],
      schemaArgs: ["--json-schema", "{schemaInline}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  },
  {
    id: "copilot",
    pluginName: "copilot-connector",
    displayName: "VSCode Copilot Connector",
    shortName: "Copilot",
    binary: "gh",
    resultAdapter: "copilot",
    versionArgs: ["copilot", "--version"],
    helpProbes: [["copilot", "--help"]],
    knownHiddenFlags: [],
    authProbe: {
      args: ["auth", "status"],
      successPattern: "Logged in",
      remediation: "Run `gh auth login`.",
    },
    installHint: "Install GitHub CLI and Copilot extension",
    effortValues: ["low", "medium", "high"],
    capabilities: {
      structuredOutput: "inline",
      model: true,
      effort: true,
      resume: true,
      budgetUsd: false,
      finalMessageFile: false,
      readOnlyEnforcement: "tool-allowlist",
    },
    invocation: {
      baseArgs: ["copilot", "suggest", "-p", "{prompt}", "--json", "--cwd", "{cwd}"],
      reviewArgs: [],
      writeArgs: [],
      resumeExtraArgs: [],
      modelArgs: [],
      effortArgs: [],
      schemaArgs: ["--schema", "{schemaInline}"],
      finalMessageArgs: [],
      budgetArgs: [],
      promptArgs: [],
    },
  }
];

const BRIDGE = 'node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs"';

function description(connector) {
  return `Delegate bounded, git-scoped review and coding tasks to the local ${connector.shortName} CLI from Codex, Claude Code, Grok Build, or Antigravity.`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function connectorConfig(connector) {
  return {
    schemaVersion: 2,
    id: connector.id,
    displayName: connector.displayName,
    binary: connector.binary,
    resultAdapter: connector.resultAdapter,
    versionArgs: connector.versionArgs,
    helpProbes: connector.helpProbes,
    knownHiddenFlags: connector.knownHiddenFlags,
    authProbe: connector.authProbe,
    installHint: connector.installHint,
    effortValues: connector.effortValues,
    capabilities: connector.capabilities,
    invocation: connector.invocation,
  };
}

function claudeManifest(connector) {
  return {
    name: connector.pluginName,
    version,
    description: description(connector),
    author,
    license: "MIT",
    keywords: ["agent", "delegation", connector.id, "cross-host", "code-review"],
    // skills/, commands/, agents/ and hooks/hooks.json are the canonical
    // locations and are auto-discovered. Declaring them as manifest keys
    // replaces the defaults, and `claude plugin validate` rejects a directory
    // path for `agents`.
  };
}

function codexManifest(connector) {
  return {
    name: connector.pluginName,
    version,
    description: description(connector),
    author,
    license: "MIT",
    keywords: ["agent", "delegation", connector.id, "cross-host", "code-review"],
    interface: {
      displayName: connector.displayName,
      shortDescription: `Delegate reviews and tasks to ${connector.shortName}.`,
      longDescription: `${description(connector)} Review is the default mode, runs with a read-only tool profile, and returns a schema-validated verdict with findings.`,
      developerName: author.name,
      category: "Developer Tools",
      capabilities: ["Interactive"],
      defaultPrompt: [
        `Ask ${connector.shortName} to review my uncommitted changes.`,
        `Delegate this diagnosis to ${connector.shortName}.`,
      ],
    },
  };
}

function antigravityManifest(connector) {
  return {
    $schema: "https://antigravity.google/schemas/v1/plugin.json",
    name: connector.pluginName,
    description: description(connector),
  };
}

function hooksConfig(connector) {
  const command = (event) => `node "\${CLAUDE_PLUGIN_ROOT}/bin/session-hook.mjs" ${event}`;
  return {
    description: `Session capture and stale-job reaping for ${connector.displayName}.`,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: command("SessionStart"), timeout: 5 }] }],
      // Codex clamps SessionEnd hooks to 3s and warns above that.
      SessionEnd: [{ hooks: [{ type: "command", command: command("SessionEnd"), timeout: 3 }] }],
    },
  };
}

function commandFiles(connector) {
  const name = connector.shortName;
  const scoped = connector.pluginName;
  return {
    "review.md": `---
description: Run a ${name} code review of the current git scope and return a schema-validated verdict
argument-hint: '[--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a review to ${name} through the bundled bridge.

Raw arguments: \`$ARGUMENTS\`

Rules:
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Make exactly one bridge call and present its output. Never construct provider commands yourself.
- If the arguments include \`--background\`, launch the command with \`run_in_background: true\` and tell the user to check \`/${scoped}:status\`.
- Otherwise run it in the foreground.
- Pass \`--stream\` for real-time live output streaming to stdout.

\`\`\`bash
${BRIDGE} review $ARGUMENTS --format markdown
\`\`\`

Reading the result:
- \`COMPLETED\` with \`verdict: approve\` is the only clean pass.
- \`EMPTY_SCOPE\` means there was nothing to review. Say so; it is not an approval.
- \`COULD_NOT_REVIEW\` means ${name} could not assess the change. Report why and stop.
- \`SCHEMA_VIOLATION\` means the payload was malformed. Report the schema errors and stop.
- \`COMPLETED_WITH_DENIALS\` means ${name} was blocked from part of the work. List the denials.
- Keep findings in the order returned, with file paths and line numbers verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
`,
    "adversarial-review.md": `---
description: Run an adversarial Red Team code review with ${name} focusing on security vulnerabilities, edge cases, and exploit vectors
argument-hint: '[--focus <area>] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate an adversarial Red Team review to ${name} through the bundled bridge.

Raw arguments: \`$ARGUMENTS\`

Rules:
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Make exactly one bridge call and present its output. Never construct provider commands yourself.
- If the arguments include \`--background\`, launch the command with \`run_in_background: true\` and tell the user to check \`/${scoped}:status\`.
- Otherwise run it in the foreground.
- Pass \`--stream\` for real-time live output streaming to stdout.

\`\`\`bash
${BRIDGE} adversarial-review $ARGUMENTS --format markdown
\`\`\`

Reading the result:
- \`COMPLETED\` with \`verdict: approve\` means no critical vulnerabilities or edge-case failures were found in the scope.
- \`EMPTY_SCOPE\` means there was nothing to review. Say so; it is not an approval.
- \`COULD_NOT_REVIEW\` means ${name} could not assess the change. Report why and stop.
- \`SCHEMA_VIOLATION\` means the payload was malformed. Report the schema errors and stop.
- \`COMPLETED_WITH_DENIALS\` means ${name} was blocked from part of the work. List the denials.
- Keep findings in the order returned, with file paths, line numbers and severities verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
`,
    "rescue.md": `---
description: Run a rescue operation with ${name} in write mode to diagnose and fix errors, failing tests, or broken builds with Git rollback tracking
argument-hint: '[--prompt "<task>"] [--error "<error-log>"] [--test "<test-command>"] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run an emergency rescue operation with ${name} through the bundled bridge in write mode.

Raw arguments: \`$ARGUMENTS\`

Rules:
- Rescue runs in write mode with automated Git rollback snapshotting (\`git stash create\`).
- Make exactly one bridge call:

\`\`\`bash
${BRIDGE} rescue $ARGUMENTS --format markdown
\`\`\`

- Report the terminal status, the verdict when present, every changed file, and the rollback reference.
- If the rescue introduces regressions or fails, use the reported rollback reference to revert changes cleanly.
- Never treat a zero exit code as success. Read \`status\` and \`completed\`.
- Pass \`--stream\` for real-time live output streaming during rescue diagnosis and execution.
`,
    "runs.md": `---
description: Show unified runs dashboard and live supervision of agent execution jobs across connectors
argument-hint: '[--all] [--format json|markdown]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!\`${BRIDGE} runs $ARGUMENTS --format markdown\`

Present the multi-agent runs dashboard table as returned.
`,
    "delegate.md": `---
description: Delegate a bounded task to ${name}, read-only by default
argument-hint: '[--mode write --confirm-write] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m] <task>'
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate to ${name} through the bundled bridge.

Raw arguments: \`$ARGUMENTS\`

Rules:
- Default to review mode. Pass \`--mode write --confirm-write\` only when the user explicitly asked ${name} to change files in this workspace.
- Before any write delegation, confirm with \`AskUserQuestion\` unless the user already authorised it in this turn.
- Make exactly one bridge call:

\`\`\`bash
${BRIDGE} run --prompt "<task>" $ARGUMENTS --format markdown
\`\`\`

- Report the terminal status, the verdict when present, every changed file, and the rollback reference for writes.
- Never treat a zero exit code as success. Read \`status\` and \`completed\`.
- Pass \`--stream\` to stream provider logs in real time.
`,
    "handoff.md": `---
description: Hand this conversation's context to ${name} as a derived context and continue the work there
argument-hint: '[--from-host claude|codex|grok|agy] [--source <transcript>] [--stream] [--background] <task>'
allowed-tools: Bash(node:*)
---

Transfer context to ${name}.

Raw arguments: \`$ARGUMENTS\`

\`\`\`bash
${BRIDGE} handoff --from-host claude $ARGUMENTS --format markdown
\`\`\`

Rules:
- The SessionStart hook records the transcript path, so \`--source\` is only needed when that failed.
- Label the outcome as a derived context transfer, never as a lossless session resume.
- If the bridge reports that no transcript could be identified, ask the user for \`--source <path>\`.
- Pass \`--stream\` to stream output during handoff execution.
`,
    "status.md": `---
description: Show ${name} jobs for this repository with enriched live status, PID, live duration, model, prompt preview, and logs
argument-hint: '[job-id] [--all] [--reap]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!\`${BRIDGE} status $ARGUMENTS --format markdown\`

Present the output as returned. Keep job ids, statuses and verdicts verbatim.
`,
    "result.md": `---
description: Show the stored result of a finished ${name} job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!\`${BRIDGE} result $ARGUMENTS --format markdown\`

Present the full output. Do not summarise. Keep file paths, line numbers and severities verbatim. Do not apply any fix.
`,
    "cancel.md": `---
description: Cancel a running ${name} job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!\`${BRIDGE} cancel $ARGUMENTS --format markdown\`
`,
    "setup.md": `---
description: Check whether the local ${name} CLI is installed, authenticated and flag-compatible
argument-hint: '[--doctor]'
allowed-tools: Bash(node:*)
---

Run the readiness check:

\`\`\`bash
${BRIDGE} setup --format markdown
\`\`\`

If the user passed \`--doctor\`, run this instead and present the flag audit, reaped jobs and state root:

\`\`\`bash
${BRIDGE} doctor
\`\`\`

If \`installed\` is false, give the install hint. If \`authenticated\` is false, give the remediation command and stop. Do not attempt a delegation until both are true.
`,
  };
}

function agentFile(connector) {
  return `---
name: delegate-to-${connector.id}
description: Use when work should be handed to ${connector.shortName} — an independent review of the current change, a second diagnosis, or a bounded implementation task. Forwards to the ${connector.pluginName} bridge and returns its output unchanged.
model: sonnet
tools: Bash
skills:
  - delegate-to-${connector.id}
---

You are a thin forwarding wrapper around the ${connector.displayName} bridge.

Forwarding rules:
- Use exactly one \`Bash\` call to \`${BRIDGE}\`.
- Use \`review\` when the request is a review of the current change. Use \`adversarial-review\` for focused Red Team security/edge-case reviews. Use \`rescue\` for write-mode error or test fixes. Use \`run\` for any other bounded task.
- Default to review mode. Add \`--mode write --confirm-write\` only when the request explicitly authorises changes to this workspace.
- Add \`--background\` when the task is open-ended or likely to run long; otherwise run in the foreground.
- Pass \`--format markdown\` so the output is readable.
- Pass \`--stream\` for live output streaming when requested.
- Leave \`--model\` and \`--effort\` unset unless the request names one.
- Do not inspect the repository, read files, grep, poll status, fetch results, or do any work of your own.
- Return the bridge stdout exactly as-is, with no commentary before or after it.
- If the bridge cannot run, return its error verbatim and stop. Never substitute your own answer.

\`completed\` is true only for \`status: COMPLETED\`. Never claim success from a zero exit code.
`;
}

function skillFile(connector) {
  return `---
name: delegate-to-${connector.id}
description: Delegate a bounded review or coding task to ${connector.shortName} through the local ${connector.binary} CLI, with a git-scoped diff and a schema-validated verdict. Use for independent review, second diagnosis, cross-provider handoff, status, results or cancellation.
---

# ${connector.displayName}

Always call the bundled bridge. Never construct \`${connector.binary}\` command lines yourself.

Bridge: \`${BRIDGE}\`
On a host that does not export \`CLAUDE_PLUGIN_ROOT\`, use the absolute path to this plugin's \`bin/agent-bridge.mjs\`.

## What the bridge guarantees

- \`review\` is the default mode and cannot write. The provider runs with a read-only profile: ${connector.capabilities.readOnlyEnforcement}.
- The bridge resolves the git scope itself and embeds the exact diff in the prompt, so ${connector.shortName} sees the change even without shell or git tools.
- Review returns a payload validated against \`bin/schemas/review-output.schema.json\`: \`verdict\`, \`summary\`, \`findings[]\` with file and line numbers, and \`next_steps[]\`.
- \`completed: true\` requires a schema-valid payload whose verdict is not \`could-not-review\`. A zero exit code is never sufficient.
- Nothing is copied out of the workspace by default. \`--isolate\` creates a detached git worktree, or outside git a copy that refuses credentials and gitignored files.
- \`write\` requires \`--mode write --confirm-write\`, records a rollback ref and reports every changed file.
- Real-time token and log output streaming is supported across commands with \`--stream\`.
- Credentials are never read or stored; the bridge inherits the ${connector.shortName} login.
- Delegating back through the same connector is refused, as is a chain deeper than three connectors.

## Commands

\`\`\`bash
${BRIDGE} setup --format markdown
${BRIDGE} review --scope uncommitted --format markdown
${BRIDGE} review --scope branch --base main --background
${BRIDGE} review --scope uncommitted --stream --format markdown
${BRIDGE} adversarial-review --focus "security" --format markdown
${BRIDGE} rescue --prompt "<task>" --error "<error-log>" --format markdown
${BRIDGE} run --prompt "<task>" --format markdown
${BRIDGE} run --prompt "<task>" --stream --format markdown
${BRIDGE} run --prompt "<task>" --mode write --confirm-write --format markdown
${BRIDGE} handoff --from-host claude --prompt "<task>" --format markdown
${BRIDGE} resume --session "<native-session-id>" --prompt "<follow-up>"
${BRIDGE} runs --format markdown
${BRIDGE} status --format markdown
${BRIDGE} result <job-id> --format markdown
${BRIDGE} cancel <job-id>
${BRIDGE} doctor
\`\`\`

## Statuses

| status | meaning |
| --- | --- |
| \`COMPLETED\` | valid payload returned; read \`verdict\` |
| \`EMPTY_SCOPE\` | nothing was in scope — not an approval |
| \`COULD_NOT_REVIEW\` | the target could not assess the change |
| \`SCHEMA_VIOLATION\` | payload missing or malformed; see \`schemaErrors\` |
| \`COMPLETED_WITH_DENIALS\` | the target was blocked; see \`permissionDenials\` |
| \`SEMANTIC_MISMATCH\` | \`--expect-response\` did not match exactly |
| \`TIMEOUT\`, \`FAILED\`, \`CANCELED\`, \`STALE\` | terminal failures |

See \`references/reporting.md\` for how to report an outcome.
`;
}

function skillReference(connector) {
  return `# Reporting a ${connector.shortName} delegation

Report, in this order:

1. Connector, job id and terminal status.
2. The verdict when present. State plainly that \`EMPTY_SCOPE\` and \`COULD_NOT_REVIEW\` are not approvals.
3. Scope: kind, file count and \`+added/-removed\`. Name the base ref for a branch review.
4. Findings ordered by severity, each as \`file:line — SEVERITY — title\`, with paths and line numbers exactly as returned.
5. Permission denials, schema errors and provider errors when present.
6. For writes: every changed file and the rollback reference.
7. Usage and cost when the provider reported them.
8. The native session id, labelled as provider-specific.

Never:

- Never report success from a zero exit code. Only \`status: COMPLETED\` means completed.
- Never present a cross-provider handoff as a lossless session resume. It is a derived context.
- Never apply a fix from a review without asking which findings to address.
- Never substitute your own analysis when the bridge failed. Report the failure and stop.
`;
}

function pluginReadme(connector) {
  return `# ${connector.displayName}

${description(connector)}

Self-contained package: manifests for Codex, Claude Code and Antigravity, slash commands, a forwarding subagent, session hooks, a skill, and the bridge with its output schema. Grok Build consumes the Claude-compatible layout directly.

## Runtime contract

- Target executable: \`${connector.binary}\`, resolved through a native binary, an npm shim entrypoint or a shebang, so Windows \`.cmd\` shims work
- Default mode: \`review\` — read-only, enforced by ${connector.capabilities.readOnlyEnforcement}, run in place so git history stays available
- Optional export: \`--isolate\` — a detached git worktree, or a credential-filtered copy outside git
- Mutation gate: \`--mode write --confirm-write\`, with a rollback ref and a changed-file list
- Output contract: \`bin/schemas/review-output.schema.json\`, passed as ${connector.capabilities.structuredOutput === "file" ? "a schema file" : "an inline schema"}
- Structured completion: \`completed: true\` requires a schema-valid payload whose verdict is not \`could-not-review\`
- Lifecycle: \`setup\`, \`doctor\`, \`capabilities\`, \`review\`, \`adversarial-review\`, \`rescue\`, \`runs\`, \`run\`, \`resume\`, \`handoff\`, \`status\`, \`result\`, \`cancel\`
- Metrics: \`durationMs\`, \`usage\`${connector.capabilities.budgetUsd ? ", `costUsd`, and `--max-budget-usd`" : ", and `costUsd` when the provider reports it"}
- Routing: \`--model\`, \`--effort\` (${connector.effortValues.join(", ")}), \`--stream\`
- State: \`AGENT_CONNECTOR_HOME\`, or the OS temporary directory under \`agent-connectors/${connector.id}\`
- Authentication: inherited from the target CLI; never stored by this plugin

Run \`node bin/agent-bridge.mjs help\` for the machine-readable command summary, and \`node bin/agent-bridge.mjs doctor\` to verify every declared flag against the installed CLI.
`;
}

async function buildConnector(connector) {
  const root = join(repositoryRoot, "plugins", connector.pluginName);
  for (const stale of ["bin", "commands", "agents", "skills", "hooks"]) {
    await rm(join(root, stale), { recursive: true, force: true });
  }

  await writeJson(join(root, ".codex-plugin", "plugin.json"), codexManifest(connector));
  await writeJson(join(root, ".claude-plugin", "plugin.json"), claudeManifest(connector));
  await writeJson(join(root, "plugin.json"), antigravityManifest(connector));
  await writeJson(join(root, "connector.json"), connectorConfig(connector));
  await writeJson(join(root, "hooks", "hooks.json"), hooksConfig(connector));
  // Antigravity reads hooks.json from the plugin root.
  await writeJson(join(root, "hooks.json"), hooksConfig(connector));

  await mkdir(join(root, "bin"), { recursive: true });
  await cp(join(repositoryRoot, "src", "bridge.mjs"), join(root, "bin", "agent-bridge.mjs"));
  await cp(join(repositoryRoot, "src", "session-hook.mjs"), join(root, "bin", "session-hook.mjs"));
  await cp(join(repositoryRoot, "src", "lib"), join(root, "bin", "lib"), { recursive: true });
  await cp(join(repositoryRoot, "src", "schemas"), join(root, "bin", "schemas"), { recursive: true });

  for (const [name, body] of Object.entries(commandFiles(connector))) {
    await writeText(join(root, "commands", name), body);
  }
  await writeText(join(root, "agents", `delegate-to-${connector.id}.md`), agentFile(connector));
  await writeText(join(root, "skills", `delegate-to-${connector.id}`, "SKILL.md"), skillFile(connector));
  await writeText(
    join(root, "skills", `delegate-to-${connector.id}`, "references", "reporting.md"),
    skillReference(connector),
  );
  await writeText(join(root, "README.md"), pluginReadme(connector));
  await cp(join(repositoryRoot, "LICENSE"), join(root, "LICENSE"));
}

const catalogEntry = (connector) => ({
  name: connector.pluginName,
  description: description(connector),
  version,
  author,
  source: `./plugins/${connector.pluginName}`,
  policy: { installation: "AVAILABLE", authentication: "ON_USE" },
  category: "Developer Tools",
});

for (const connector of connectors) {
  await buildConnector(connector);
}

const sharedMetadata = {
  description: "Cross-host local CLI connectors for Codex, Grok Build, Antigravity and Claude Code.",
  version,
};

await writeJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"), {
  name: marketplaceName,
  owner: author,
  metadata: sharedMetadata,
  interface: { displayName: "Polyglot Agent Connectors" },
  plugins: connectors.map(catalogEntry),
});

await writeJson(join(repositoryRoot, "marketplace.json"), {
  name: marketplaceName,
  interface: { displayName: "Polyglot Agent Connectors" },
  plugins: connectors.map((connector) => ({
    name: connector.pluginName,
    source: { source: "local", path: `./plugins/${connector.pluginName}` },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Developer Tools",
  })),
});

// Generated rather than hand-maintained: the previous hand-written copy had
// already drifted from the other two.
await writeJson(join(repositoryRoot, ".agents", "plugins", "marketplace.json"), {
  name: marketplaceName,
  owner: author,
  metadata: sharedMetadata,
  plugins: connectors.map(catalogEntry),
});

await writeJson(join(repositoryRoot, "build-manifest.json"), {
  version,
  builtFrom: ["src/bridge.mjs", "src/session-hook.mjs", "src/lib", "src/schemas"],
  connectors: connectors.map((connector) => ({
    id: connector.id,
    pluginName: connector.pluginName,
    resultAdapter: connector.resultAdapter,
    capabilities: connector.capabilities,
  })),
});

process.stdout.write(`Built ${connectors.length} cross-host connector plugins at ${version}.\n`);
