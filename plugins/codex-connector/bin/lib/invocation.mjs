const PLACEHOLDER = /\{(\w+)\}/g;
const MAX_DIFF_BYTES = 256 * 1024;

// Argument groups are all-or-nothing: a group whose placeholder has no value is
// dropped entirely rather than expanded into an empty string, so a missing value
// can never shift the meaning of the command line.
function expandGroup(template, context) {
  if (!Array.isArray(template) || template.length === 0) return null;
  const expanded = [];
  for (const entry of template) {
    let missing = false;
    const value = String(entry).replace(PLACEHOLDER, (_, key) => {
      const replacement = context[key];
      if (replacement === undefined || replacement === null || replacement === "") {
        missing = true;
        return "";
      }
      return String(replacement);
    });
    if (missing) return null;
    expanded.push(value);
  }
  return expanded;
}

function appendGroup(args, template, context) {
  const expanded = expandGroup(template, context);
  if (expanded) args.push(...expanded);
  return Boolean(expanded);
}

export function buildInvocationArgs(config, plan) {
  const invocation = config.invocation;
  const context = {
    cwd: plan.executionCwd,
    prompt: plan.prompt,
    session: plan.session || "",
    sandbox: plan.mode === "review" ? "read-only" : "workspace-write",
    model: plan.model || "",
    effort: plan.effort || "",
    schemaPath: plan.schemaPath || "",
    schemaInline: plan.schemaInline || "",
    finalMessagePath: plan.finalMessagePath || "",
    budgetUsd: plan.budgetUsd === null || plan.budgetUsd === undefined ? "" : String(plan.budgetUsd),
    providerTimeout: plan.providerTimeout || "",
  };

  const resuming = Boolean(plan.session && invocation.resumeBaseArgs);
  const args = [...(expandGroup(resuming ? invocation.resumeBaseArgs : invocation.baseArgs, context) || [])];
  const applied = { resume: resuming };

  applied.mode = appendGroup(
    args,
    plan.mode === "review" ? invocation.reviewArgs : invocation.writeArgs,
    context,
  );
  if (plan.session && !resuming) appendGroup(args, invocation.resumeExtraArgs, context);
  applied.model = appendGroup(args, invocation.modelArgs, context);
  applied.effort = appendGroup(args, invocation.effortArgs, context);
  applied.schema = appendGroup(args, invocation.schemaArgs, context);
  applied.finalMessage = appendGroup(args, invocation.finalMessageArgs, context);
  applied.budget = appendGroup(args, invocation.budgetArgs, context);
  appendGroup(args, invocation.promptArgs, context);

  return { args, applied };
}

function boundedDiff(diff) {
  if (!diff) return { text: "", truncated: false };
  const buffer = Buffer.from(diff, "utf8");
  if (buffer.byteLength <= MAX_DIFF_BYTES) return { text: diff, truncated: false };
  return { text: buffer.subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated: true };
}

function scopeSummary(scope) {
  const fileCount = scope.files?.length ?? 0;
  const untracked = scope.untracked?.length ?? 0;
  const parts = [`${fileCount} changed file${fileCount === 1 ? "" : "s"}`];
  if (scope.added || scope.removed) parts.push(`+${scope.added}/-${scope.removed} lines`);
  if (untracked) parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Builds the prompt sent to the target agent. The diff is embedded by the bridge
 * so the reviewer always sees the change even when it holds no shell or git
 * tools, and so every provider is asked the same question about the same bytes.
 */
export function composePrompt({
  connectorId,
  mode,
  executionCwd,
  sourceCommit,
  scope,
  diff,
  schemaRaw,
  userPrompt,
  isolation,
}) {
  const lines = [`[polyglot-connector:${connectorId}] mode=${mode}`];

  if (mode === "review") {
    lines.push(
      "You are reviewing work. Do not modify, create or delete any file.",
      "You may use read-only tools (grep, read_file, list_dir / Read, Glob, Grep) to inspect repository context and verify details. Do not attempt write operations; the diff below is the authoritative change.",
    );
  } else {
    lines.push(
      "The user explicitly authorised write mode. Make only the changes the task requires and report every file you touched.",
    );
  }

  lines.push(
    `Workspace root: ${executionCwd}`,
    "Use this absolute workspace root for every file operation.",
    `Source commit: ${sourceCommit || "unavailable"}`,
    `Execution isolation: ${isolation}`,
  );

  if (scope && scope.kind !== "workspace") {
    lines.push(
      `Scope: ${scope.kind} — ${scopeSummary(scope)}.`,
      `Reference diff command: ${scope.diffCommand}`,
    );
    if (scope.files?.length) {
      lines.push(`Files in scope:\n${scope.files.map((file) => `- ${file.path}`).join("\n")}`);
    }
    if (scope.untracked?.length) {
      lines.push(`Untracked files in scope:\n${scope.untracked.map((path) => `- ${path}`).join("\n")}`);
    }
  } else {
    lines.push("Scope: the whole workspace. No diff is available.");
  }

  const bounded = boundedDiff(diff);
  if (bounded.text) {
    lines.push(
      "The exact change under review follows between the markers. Treat it as the authoritative diff.",
      "<<<DIFF",
      bounded.text,
      "DIFF>>>",
    );
    if (bounded.truncated) {
      lines.push(`The diff was truncated at ${MAX_DIFF_BYTES} bytes. Review what is shown and say so in the summary.`);
    }
  } else if (scope && scope.kind !== "workspace") {
    lines.push("The diff for this scope is empty.");
  }

  if (schemaRaw) {
    lines.push(
      "Return exactly one JSON object and nothing else. It must satisfy this JSON Schema:",
      schemaRaw,
      'Set "verdict" to "could-not-review" when the scope is empty or you cannot assess the change. Never report "approve" for work you could not see.',
      'Every finding must cite a real file path and real line numbers. Use "next_steps" for follow-up actions.',
    );
  }

  lines.push(
    "Do not delegate this task back through the same connector and do not start an agent-to-agent loop.",
    "Task:",
    userPrompt,
  );

  return lines.join("\n");
}
