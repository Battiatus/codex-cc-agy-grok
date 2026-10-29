import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 20_000;
// Checkout and staging scale with the repository (LFS smudge, large trees).
const GIT_HEAVY_TIMEOUT_MS = 5 * 60 * 1000;

export const REVIEW_SCOPES = ["auto", "uncommitted", "staged", "branch", "commit", "workspace"];

function git(cwd, args, { input, timeout = GIT_TIMEOUT_MS } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
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
    // With a base, every commit from it up to `commit` (a job branch the agent
    // may have committed to itself); without, that one commit.
    const range = base ? `${base}..${commit}` : `${commit}^!`;
    const stat = parseNumstat(git(cwd, ["diff", "--numstat", range]).stdout);
    return {
      kind: "commit",
      requested: scope,
      isGit: true,
      commit,
      base,
      range,
      ...stat,
      untracked: [],
      empty: stat.files.length === 0,
      diffCommand: `git diff ${range}`,
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
  if (scope.kind === "commit") return scope.base ? `commits ${scope.base}..${scope.commit}` : `commit ${scope.commit}`;
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

export function addWorktree(cwd, destination, ref, branch = null) {
  return git(
    cwd,
    ["worktree", "add", ...(branch ? ["-b", branch] : ["--detach"]), destination, ref],
    { timeout: GIT_HEAVY_TIMEOUT_MS },
  );
}

export function removeWorktree(cwd, destination) {
  return git(cwd, ["worktree", "remove", "--force", destination]);
}

export function pruneWorktrees(cwd) {
  return git(cwd, ["worktree", "prune"]);
}

// Commits whatever the target agent left in its worktree, so the branch alone
// carries the change. Returns null on success (including "nothing to commit")
// or the git error: the caller must then keep the worktree, or the work is lost.
// Hooks and signing are disabled: they belong to the user, not the agent, and a
// broken gpg setup must not discard the agent's work.
export function commitAll(cwd, message) {
  const added = git(cwd, ["add", "-A"], { timeout: GIT_HEAVY_TIMEOUT_MS });
  if (!added.ok) return added.stderr || added.error || "git add failed";
  const committed = git(cwd, [
    "-c", "user.name=polyglot", "-c", "user.email=polyglot@localhost",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.polyglot-no-hooks",
    "commit", "-q", "--no-verify", "-m", message,
  ]);
  if (committed.ok) return null;
  const status = git(cwd, ["status", "--porcelain"]);
  if (status.ok && !status.stdout.trim()) return null;
  return committed.stderr || committed.error || "git commit failed";
}

export function changedFiles(cwd, from, to) {
  const result = git(cwd, ["diff", "--name-only", "--no-renames", from, to]);
  return result.ok ? result.stdout.split(/\r?\n/).filter(Boolean) : null;
}

// Fingerprint of the user's tracked changes and untracked file list, to detect
// a provider that ignored its workspace root and edited the source tree.
export function treeFingerprint(cwd) {
  const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff"]);
  return status.ok && diff.ok ? `${status.stdout}\0${diff.stdout}` : null;
}

const MAX_PATCH_BYTES = 1024 * 1024 * 1024;

// Brings a job branch's change into the working tree. git apply is
// all-or-nothing: a hunk that clashes with local edits leaves every file as it
// was. Run from the repository root, or paths outside cwd are skipped. The
// patch stays a Buffer end to end: decoding it would corrupt non-UTF-8 text.
// Returns null on success, or {clash, message}.
export function applyBranch(cwd, baseRef, branch) {
  const run = (args, input) => spawnSync("git", args, {
    cwd, input, windowsHide: true, timeout: GIT_HEAVY_TIMEOUT_MS, maxBuffer: MAX_PATCH_BYTES,
  });
  const failure = (result) => result.error?.message || result.stderr?.toString("utf8").trim() || `exit ${result.status}`;
  const diff = run(["diff", "--binary", "--no-color", "--no-ext-diff", baseRef, branch]);
  if (diff.error || diff.status !== 0) return { clash: false, message: `git diff failed: ${failure(diff)}` };
  if (!diff.stdout.length) return { clash: false, message: "the branch holds no change" };
  const applied = run(["apply", "--whitespace=nowarn"], diff.stdout);
  return applied.error || applied.status !== 0 ? { clash: true, message: failure(applied) } : null;
}

export function branchExists(cwd, branch) {
  return git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function deleteBranch(cwd, branch) {
  return git(cwd, ["branch", "-D", branch]);
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
    parts.push(git(cwd, ["diff", ...common, scope.range || `${scope.commit}^!`]).stdout);
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
