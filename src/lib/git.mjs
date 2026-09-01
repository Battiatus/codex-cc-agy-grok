import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 20_000;

export const REVIEW_SCOPES = ["auto", "uncommitted", "staged", "branch", "commit", "workspace"];

function git(cwd, args, { input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    input,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null,
  };
}

export function isGitRepository(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

export function repositoryRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : null;
}

export function head(cwd) {
  const result = git(cwd, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

export function currentBranch(cwd) {
  const result = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

function parseNumstat(stdout) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const addedCount = addedRaw === "-" ? 0 : Number(addedRaw) || 0;
    const removedCount = removedRaw === "-" ? 0 : Number(removedRaw) || 0;
    added += addedCount;
    removed += removedCount;
    files.push({ path, added: addedCount, removed: removedCount, binary: addedRaw === "-" });
  }
  return { files, added, removed };
}

function untrackedFiles(cwd) {
  const result = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function mergeBase(cwd, base) {
  const result = git(cwd, ["merge-base", base, "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

export function defaultBaseRef(cwd) {
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const result = git(cwd, ["rev-parse", "--verify", "--quiet", candidate]);
    if (!result.ok || !result.stdout.trim()) continue;
    if (candidate !== "origin/HEAD") return candidate;
    const symbolic = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic.ok && symbolic.stdout.trim()) return symbolic.stdout.trim();
  }
  return null;
}

// Resolves what the target agent should actually look at. Returning an explicit
// empty scope matters: a review with nothing to review must never be reported
// as an approval.
export function resolveScope(cwd, { scope = "auto", base = null, commit = null } = {}) {
  if (!isGitRepository(cwd)) {
    return {
      kind: "workspace",
      requested: scope,
      isGit: false,
      files: [],
      added: 0,
      removed: 0,
      untracked: [],
      empty: false,
      diffCommand: null,
      note: "not a git repository",
    };
  }

  let effective = scope;
  if (scope === "auto") {
    const staged = parseNumstat(git(cwd, ["diff", "--numstat", "--cached"]).stdout);
    const unstaged = parseNumstat(git(cwd, ["diff", "--numstat"]).stdout);
    const untracked = untrackedFiles(cwd);
    effective = staged.files.length || unstaged.files.length || untracked.length
      ? "uncommitted"
      : "branch";
  }

  if (effective === "commit") {
    if (!commit) throw new Error("--scope commit requires --commit <sha>.");
    const stat = parseNumstat(git(cwd, ["diff", "--numstat", `${commit}^!`]).stdout);
    return {
      kind: "commit",
      requested: scope,
      isGit: true,
      commit,
      ...stat,
      untracked: [],
      empty: stat.files.length === 0,
      diffCommand: `git diff ${commit}^!`,
    };
  }

  if (effective === "branch") {
    const baseRef = base || defaultBaseRef(cwd);
    if (!baseRef) {
      return {
        kind: "workspace",
        requested: scope,
        isGit: true,
        files: [],
        added: 0,
        removed: 0,
        untracked: [],
        empty: false,
        diffCommand: null,
        note: "no base branch could be resolved",
      };
    }
    const mergePoint = mergeBase(cwd, baseRef) || baseRef;
    const stat = parseNumstat(git(cwd, ["diff", "--numstat", `${mergePoint}...HEAD`]).stdout);
    return {
      kind: "branch",
      requested: scope,
      isGit: true,
      base: baseRef,
      mergeBase: mergePoint,
      ...stat,
      untracked: [],
      empty: stat.files.length === 0,
      diffCommand: `git diff ${mergePoint}...HEAD`,
    };
  }

  if (effective === "staged") {
    const stat = parseNumstat(git(cwd, ["diff", "--numstat", "--cached"]).stdout);
    return {
      kind: "staged",
      requested: scope,
      isGit: true,
      ...stat,
      untracked: [],
      empty: stat.files.length === 0,
      diffCommand: "git diff --cached",
    };
  }

  if (effective === "workspace") {
    return {
      kind: "workspace",
      requested: scope,
      isGit: true,
      files: [],
      added: 0,
      removed: 0,
      untracked: [],
      empty: false,
      diffCommand: null,
    };
  }

  const staged = parseNumstat(git(cwd, ["diff", "--numstat", "--cached"]).stdout);
  const unstaged = parseNumstat(git(cwd, ["diff", "--numstat"]).stdout);
  const untracked = untrackedFiles(cwd);
  const byPath = new Map();
  for (const entry of [...staged.files, ...unstaged.files]) {
    const existing = byPath.get(entry.path);
    if (existing) {
      existing.added += entry.added;
      existing.removed += entry.removed;
    } else {
      byPath.set(entry.path, { ...entry });
    }
  }
  return {
    kind: "uncommitted",
    requested: scope,
    isGit: true,
    files: [...byPath.values()],
    added: staged.added + unstaged.added,
    removed: staged.removed + unstaged.removed,
    untracked,
    empty: byPath.size === 0 && untracked.length === 0,
    diffCommand: "git diff HEAD",
  };
}

export function describeScope(scope) {
  if (scope.kind === "workspace") {
    return scope.note ? `the whole workspace (${scope.note})` : "the whole workspace";
  }
  if (scope.kind === "commit") return `commit ${scope.commit}`;
  if (scope.kind === "branch") return `branch changes against ${scope.base}`;
  if (scope.kind === "staged") return "staged changes";
  return "uncommitted changes (staged, unstaged and untracked)";
}

// Used by the copy-based isolation fallback so ignored files never leave the
// machine. Returns the subset of paths git would ignore.
export function ignoredPaths(cwd, relativePaths) {
  if (relativePaths.length === 0) return new Set();
  const result = git(cwd, ["check-ignore", "--stdin"], { input: `${relativePaths.join("\n")}\n` });
  if (!result.stdout) return new Set();
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

export function trackedAndUntrackedFiles(cwd) {
  const result = git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!result.ok) return null;
  return result.stdout.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

export function addWorktree(cwd, destination, ref) {
  return git(cwd, ["worktree", "add", "--detach", destination, ref]);
}

export function removeWorktree(cwd, destination) {
  return git(cwd, ["worktree", "remove", "--force", destination]);
}

export function porcelainStatus(cwd) {
  const result = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!result.ok) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3) }));
}

// The bridge embeds this diff in the prompt so the target agent sees the change
// even when it holds no shell or git tools.
export function diffText(cwd, scope) {
  if (!scope?.isGit || scope.kind === "workspace") return "";
  const common = ["--no-color", "--no-ext-diff", "--find-renames"];
  const parts = [];
  if (scope.kind === "commit") {
    parts.push(git(cwd, ["diff", ...common, `${scope.commit}^!`]).stdout);
  } else if (scope.kind === "branch") {
    parts.push(git(cwd, ["diff", ...common, `${scope.mergeBase}...HEAD`]).stdout);
  } else if (scope.kind === "staged") {
    parts.push(git(cwd, ["diff", ...common, "--cached"]).stdout);
  } else {
    parts.push(git(cwd, ["diff", ...common, "HEAD"]).stdout);
    for (const path of scope.untracked || []) {
      const added = git(cwd, ["diff", ...common, "--no-index", "/dev/null", path]).stdout;
      if (added) parts.push(added);
    }
  }
  return parts.filter(Boolean).join("\n");
}

export function stashCreate(cwd) {
  const result = git(cwd, ["stash", "create"]);
  const sha = result.stdout.trim();
  return result.ok && sha ? sha : null;
}
