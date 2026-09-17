const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const STATUS_HINT = {
  COMPLETED: "the target agent finished and returned a valid payload",
  COMPLETED_WITH_DENIALS: "the target agent was blocked from part of the work",
  COULD_NOT_REVIEW: "the target agent reported it could not assess the change",
  EMPTY_SCOPE: "there was nothing in scope to review",
  SCHEMA_VIOLATION: "the target agent did not return the required payload",
  SEMANTIC_MISMATCH: "the response did not match the expected exact text",
  TIMEOUT: "the target agent was terminated at the timeout",
  FAILED: "the target agent failed",
  CANCELED: "the job was canceled",
  STALE: "the worker disappeared before finishing",
  RUNNING: "in progress",
  QUEUED: "queued",
};

function formatUsage(usage, costUsd) {
  const parts = [];
  if (usage?.inputTokens !== null && usage?.inputTokens !== undefined) {
    parts.push(`in ${usage.inputTokens}`);
  }
  if (usage?.outputTokens !== null && usage?.outputTokens !== undefined) {
    parts.push(`out ${usage.outputTokens}`);
  }
  if (usage?.cachedInputTokens) parts.push(`cached ${usage.cachedInputTokens}`);
  if (typeof costUsd === "number") parts.push(`$${costUsd.toFixed(4)}`);
  return parts.length ? parts.join(" · ") : null;
}

function formatDuration(durationMs) {
  if (!durationMs) return null;
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

export function renderResult(result) {
  if (!result) return "No result available.";
  const lines = [];
  const hint = STATUS_HINT[result.status] || "";
  lines.push(`## ${result.connector} · ${result.status}${hint ? ` — ${hint}` : ""}`);

  const facts = [`job \`${result.jobId}\``, `mode ${result.mode}`];
  if (result.verdict) facts.push(`verdict **${result.verdict}**`);
  if (result.hostPid) facts.push(`pid ${result.hostPid}`);
  if (result.model) facts.push(`model ${result.model}`);
  if (result.scope) {
    facts.push(`scope ${result.scope.kind} (${result.scope.fileCount} files, +${result.scope.added}/-${result.scope.removed})`);
  }
  if (result.isolationStrategy) facts.push(`isolation ${result.isolationStrategy}`);
  if (result.sourceCommit) facts.push(`commit ${result.sourceCommit.slice(0, 12)}`);
  const duration = formatDuration(result.durationMs ?? result.liveDurationMs);
  if (duration) facts.push(result.liveDurationMs && !result.durationMs ? `${duration} (live)` : duration);
  const usage = formatUsage(result.usage, result.costUsd);
  if (usage) facts.push(usage);
  lines.push(facts.join(" · "));

  if (result.prompt && !result.review && !result.response) {
    lines.push("", `**Prompt:** ${result.prompt}`);
  }

  if (result.error) {
    lines.push("", `**Error:** ${result.error}`);
    if (result.phase) lines.push(`**Failed during phase:** \`${result.phase}\``);
    if (result.stderrTail) lines.push("", "**stderr (tail):**", "```", result.stderrTail.trimEnd().slice(-2_000), "```");
  }

  // R1: make failure self-diagnosable — always point at the forensic artifacts.
  const artifacts = [
    result.stdoutPath ? `stdout: \`${result.stdoutPath}\`` : null,
    result.stderrPath ? `stderr: \`${result.stderrPath}\`` : null,
    result.invocationPath ? `invocation: \`${result.invocationPath}\`` : null,
    result.promptComposedPath ? `prompt: \`${result.promptComposedPath}\`` : null,
  ].filter(Boolean);
  if (artifacts.length && (result.error || result.providerError || result.status === "TIMEOUT")) {
    lines.push("", `Artifacts — ${artifacts.join(" · ")}`);
  }

  if (!result.error && (result.status === "RUNNING" || result.status === "QUEUED")) {
    lines.push("", `Live state: \`status ${result.jobId}\` shows stdout/stderr tails.`);
  }
  if (result.providerError) lines.push("", `**Provider error:** ${result.providerError}`);
  if (result.scope?.empty) lines.push("", "Nothing was in scope. This is not an approval.");

  if (Array.isArray(result.schemaErrors) && result.schemaErrors.length) {
    lines.push("", "**Payload did not satisfy the schema:**");
    for (const error of result.schemaErrors.slice(0, 10)) lines.push(`- ${error}`);
  }

  if (Array.isArray(result.permissionDenials) && result.permissionDenials.length) {
    lines.push("", "**Permission denials:**");
    for (const denial of result.permissionDenials) {
      lines.push(`- ${denial.tool ? `${denial.tool}: ` : ""}${denial.reason || "denied"}`);
    }
  }

  const review = result.review;
  if (review?.summary) lines.push("", review.summary);

  const findings = Array.isArray(review?.findings) ? [...review.findings] : [];
  if (findings.length) {
    findings.sort((left, right) =>
      (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9));
    lines.push("", `### Findings (${findings.length})`);
    for (const finding of findings) {
      const range = finding.line_start === finding.line_end
        ? `${finding.line_start}`
        : `${finding.line_start}-${finding.line_end}`;
      const confidence = typeof finding.confidence === "number"
        ? ` · confidence ${finding.confidence.toFixed(2)}`
        : "";
      lines.push(`- **${String(finding.severity).toUpperCase()}** \`${finding.file}:${range}\`${confidence} — ${finding.title}`);
      if (finding.body) lines.push(`  ${finding.body}`);
      if (finding.recommendation) lines.push(`  _Recommendation:_ ${finding.recommendation}`);
    }
  } else if (review) {
    lines.push("", "No findings were reported.");
  }

  if (Array.isArray(review?.next_steps) && review.next_steps.length) {
    lines.push("", "### Next steps");
    for (const step of review.next_steps) lines.push(`- ${step}`);
  }

  if (!review && result.response) lines.push("", "### Response", result.response);

  if (Array.isArray(result.filesChanged) && result.filesChanged.length) {
    lines.push("", "### Files changed by the target agent");
    for (const file of result.filesChanged) lines.push(`- \`${file}\``);
    if (result.rollbackRef) {
      lines.push("", `Rollback reference: \`git checkout ${result.rollbackRef} -- .\``);
    }
  }

  if (result.stdoutTail) {
    lines.push("", "### Recent stdout", "```", result.stdoutTail, "```");
  }
  if (result.stderrTail) {
    lines.push("", "### Recent stderr", "```", result.stderrTail, "```");
  }

  if (result.isolationCleanupFailed) {
    lines.push("", `**Isolation cleanup failed:** ${result.isolationCleanupFailed} (${result.executionCwd})`);
  }
  if (result.outputTruncated) {
    lines.push("", `Provider output exceeded the capture budget; the full stream is at \`${result.stdoutPath}\`.`);
  }
  if (Array.isArray(result.providerNotices) && result.providerNotices.length) {
    lines.push("", "<details><summary>Provider notices</summary>", "");
    for (const notice of result.providerNotices.slice(0, 20)) lines.push(`- ${notice}`);
    lines.push("", "</details>");
  }
  if (result.nativeSessionId) {
    lines.push("", `Native session: \`${result.nativeSessionId}\` (resume is provider-specific).`);
  }
  return lines.join("\n");
}

export function renderRunsDashboard(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return "No runs recorded across connectors.";
  }

  const header = "| connector | job | status | pid | model | duration | scope | prompt |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";

  const rows = runs.map((job) => {
    const duration = formatDuration(job.liveDurationMs ?? job.durationMs) || "—";
    const pid = job.hostPid ? String(job.hostPid) : "—";
    const model = job.model || "—";
    const scope = job.scopeKind || job.scope?.kind || job.mode || "—";
    const promptPreview = (job.promptSummary || job.prompt || "—")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
    const truncatedPrompt = promptPreview.length > 50
      ? `${promptPreview.slice(0, 47)}...`
      : promptPreview;

    return `| ${[
      job.connector || "—",
      `\`${job.jobId}\``,
      job.status || "—",
      pid,
      model,
      duration,
      scope,
      truncatedPrompt || "—",
    ].join(" | ")} |`;
  });

  return [header, divider, ...rows].join("\n");
}

export function renderJobTable(jobs) {
  if (jobs.length === 0) return "No jobs recorded for this repository.";
  const header = "| job | status | verdict | mode | scope | duration | created |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- |";
  const rows = jobs.map((job) => `| ${[
    `\`${job.jobId}\``,
    job.status,
    job.verdict || "—",
    job.mode || "—",
    job.scopeKind || (job.scope?.kind) || "—",
    formatDuration(job.durationMs ?? job.liveDurationMs) || "—",
    job.createdAt || "—",
  ].join(" | ")} |`);
  return [header, divider, ...rows].join("\n");
}

export function renderSetup(report) {
  const authLabel = report.authenticated === true
    ? "ok"
    : report.authenticated === false ? "missing" : "unknown";
  const lines = [
    `## ${report.displayName} · ${report.installed ? "installed" : "missing"}`,
    [
      `binary \`${report.binary}\``,
      report.version ? `version ${report.version}` : null,
      `auth ${authLabel}`,
      report.invocationStrategy ? `launch ${report.invocationStrategy}` : null,
    ].filter(Boolean).join(" · "),
  ];
  if (report.authDetail) lines.push("", report.authDetail);
  if (report.error) lines.push("", `**Error:** ${report.error}`);
  if (report.remediation) lines.push("", `**Next step:** ${report.remediation}`);
  const capabilities = Object.entries(report.capabilities || {})
    .map(([name, value]) => `${name}=${value}`)
    .join(" · ");
  if (capabilities) lines.push("", `Capabilities: ${capabilities}`);
  return lines.join("\n");
}
