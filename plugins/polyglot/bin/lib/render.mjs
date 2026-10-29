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

function ago(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return `${seconds}s ago`;
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
  if (typeof result.stdoutBytes === "number" || typeof result.stderrBytes === "number") {
    facts.push(`streamed ${result.stdoutBytes ?? 0}+${result.stderrBytes ?? 0}B`);
  }
  if (result.lastStreamAt && (result.status === "RUNNING" || result.status === "QUEUED")) {
    const silentMs = Date.now() - new Date(result.lastStreamAt).getTime();
    facts.push(silentMs < 10_000 ? "stream active" : `silent ${Math.round(silentMs / 1000)}s`);
  }
  const usage = formatUsage(result.usage, result.costUsd);
  if (usage) facts.push(usage);
  lines.push(facts.join(" · "));

  if (result.timeoutSnapshot) {
    const snap = result.timeoutSnapshot;
    const parts = [
      `killed after ${snap.timeoutMs}ms`,
      typeof snap.stdoutBytes === "number" ? `${snap.stdoutBytes}+${snap.stderrBytes ?? 0}B received` : null,
      snap.lastStreamAt ? `last stream ${snap.lastStreamAt}` : "no output ever received",
    ].filter(Boolean);
    lines.push("", `**Timeout snapshot:** ${parts.join(" — ")}`);
  }

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

  const running = result.status === "RUNNING" || result.status === "QUEUED";
  const progress = result.progress;
  if (running && progress?.lastAction) {
    const facts = [`${progress.actions} action${progress.actions === 1 ? "" : "s"}`, ago(progress.lastActionAt)];
    lines.push("", `**Now:** \`${progress.lastAction}\` (${facts.filter(Boolean).join(", ")})`);
    const earlier = progress.recent.slice(0, -1);
    if (earlier.length) lines.push("", "Before that:", ...earlier.map((action) => `- \`${action}\``));
  }
  if (running && progress && (progress.outputTokens !== null || progress.costUsd !== null)) {
    const sofar = [
      progress.outputTokens !== null ? `${progress.outputTokens} output tokens` : null,
      progress.costUsd !== null ? `$${progress.costUsd.toFixed(4)}` : null,
    ].filter(Boolean).join(" · ");
    lines.push("", `So far: ${sofar}`);
  }
  if (!result.error && running) {
    lines.push("", `Live state: \`status ${result.jobId}\` refreshes this; \`status ${result.jobId} --tail 40\` adds raw output.`);
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
    lines.push("", `### Files changed on branch \`${result.branch}\` (working tree untouched)`);
    for (const file of result.filesChanged) lines.push(`- \`${file}\``);
    if (result.branch && result.baseRef) {
      lines.push(
        "",
        `Inspect: \`git diff ${result.baseRef.slice(0, 12)} ${result.branch}\``,
        `Apply to the working tree: bridge \`apply ${result.jobId}\` · Second opinion: \`review --to <other> --job ${result.jobId}\` · Drop: \`discard ${result.jobId}\``,
      );
    }
  } else if (result.mode === "write" && Array.isArray(result.filesChanged)) {
    lines.push("", "The target agent changed no file.");
  } else if (result.branch) {
    lines.push("", `Branch \`${result.branch}\` was kept, but its changed files could not be listed.`);
  }
  if (result.sourceTreeModified) {
    lines.push("", "**Warning:** the source working tree changed while the job ran. The target agent may have written outside its worktree; check `git status`.");
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
  // A session can only be resumed where it ran: in place, not in a removed worktree.
  if (result.nativeSessionId && !running && result.executionCwd && result.executionCwd === result.sourceCwd) {
    lines.push("", `Follow up in the same session: \`continue ${result.jobId} --prompt "..." --background\`.`);
  }
  if (!running && result.jobId && !["COMPLETED", "EMPTY_SCOPE"].includes(result.status)) {
    lines.push("", `Run it again: \`retry ${result.jobId} --background\`, or on another provider: \`retry ${result.jobId} --to <other> --background\`.`);
  }
  return lines.join("\n");
}

// One markdown table cell: a single line, pipes escaped, clipped.
function cell(text, max) {
  const flat = String(text).replace(/[\r\n\t]+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function renderStats(stats) {
  if (!stats.length) return "No runs recorded.";
  const rows = stats.map((entry) => `| ${[
    entry.provider,
    entry.jobs,
    entry.completed,
    `${Math.round(entry.successRate * 100)}%`,
    formatDuration(entry.medianDurationMs) || "—",
    entry.costUsd ? `$${entry.costUsd.toFixed(4)}` : "—",
    entry.topFailure ? `${entry.topFailure.status} ×${entry.topFailure.count}` : "—",
  ].join(" | ")} |`);
  return [
    "| provider | jobs | completed | success | median time | cost | top failure |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderTotals(runs) {
  const byStatus = {};
  let cost = 0;
  for (const job of runs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    if (typeof job.costUsd === "number") cost += job.costUsd;
  }
  const counts = Object.entries(byStatus).map(([status, count]) => `${status} ${count}`).join(" · ");
  return `**${runs.length} jobs** — ${counts}${cost ? ` · $${cost.toFixed(4)}` : ""}`;
}

export function renderRunsDashboard(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return "No runs recorded.";
  }

  const header = "| provider | job | status | pid | model | duration | cost | activity | scope | prompt |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

  const rows = runs.map((job) => {
    const duration = formatDuration(job.liveDurationMs ?? job.durationMs) || "—";
    const pid = job.hostPid ? String(job.hostPid) : "—";
    const model = job.model || "—";
    const scope = job.scopeKind || job.scope?.kind || job.mode || "—";
    const truncatedPrompt = cell(job.promptSummary || job.prompt || "—", 50);

    // What the agent is doing now, or how much it did; silence flags a stuck job.
    let activity = job.progress?.actions ? `${job.progress.actions} actions` : "—";
    if (job.status === "RUNNING") {
      const silentMs = job.lastStreamAt ? Date.now() - new Date(job.lastStreamAt).getTime() : null;
      const now = job.progress?.lastAction ? cell(job.progress.lastAction, 40) : "working";
      activity = silentMs !== null && silentMs >= 10_000 ? `${now}, silent ${Math.round(silentMs / 1000)}s` : now;
    }

    return `| ${[
      job.connector || "—",
      `\`${job.jobId}\``,
      job.status || "—",
      pid,
      model,
      duration,
      typeof job.costUsd === "number" ? `$${job.costUsd.toFixed(4)}` : "—",
      activity,
      scope,
      truncatedPrompt || "—",
    ].join(" | ")} |`;
  });

  return [renderTotals(runs), "", header, divider, ...rows].join("\n");
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
