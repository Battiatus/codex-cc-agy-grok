import { rmSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  addWorktree,
  deleteBranch,
  head,
  ignoredPaths,
  isGitRepository,
  pruneWorktrees,
  removeWorktree,
  stashCreate,
} from "./git.mjs";

const ISOLATION_ROOT_NAME = "polyglot-agent-isolation";
const GC_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLEANUP_RETRY_DELAYS_MS = [0, 50, 150, 400];

const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".hg",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".svn",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  "Pods",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "out",
  "target",
  "venv",
  "vendor",
]);

// Deny-by-default credential patterns for the copy fallback. Anything matching
// never leaves the machine.
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^\.htpasswd$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
  /^credentials?$/i,
  /credentials?[.\-_][^\\/]*\.(json|ya?ml|toml|ini|txt)$/i,
  /^credentials?\.(json|ya?ml|toml|ini|txt)$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|txt)$/i,
  /secrets?[.\-_][^\\/]*\.(json|ya?ml|toml|ini|env|txt)$/i,
  /service[-_]?account[^\\/]*\.json$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|asc|gpg|ppk|crt|cer|der)$/i,
  /\.tfvars(\.json)?$/i,
  /\.tfstate(\.backup)?$/i,
  /\.kdbx?$/i,
];

const SECRET_DIRECTORIES = new Set([".aws", ".ssh", ".gnupg", ".docker", ".kube"]);
const ALLOWED_ENV_SAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function isSecretName(name) {
  const lower = name.toLowerCase();
  if (ALLOWED_ENV_SAMPLES.has(lower)) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(lower));
}

function isolationRoot() {
  return join(tmpdir(), ISOLATION_ROOT_NAME);
}

async function removeWithRetry(path) {
  let lastError = null;
  for (const delay of CLEANUP_RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      return null;
    } catch (error) {
      lastError = error;
    }
  }
  return lastError?.message || "cleanup failed";
}

// Runs that could not clean up (antivirus, open handles) would otherwise leave
// workspace copies in the temp directory forever.
export async function collectGarbage() {
  const root = isolationRoot();
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed = [];
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  for (const name of names) {
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    if (!(await removeWithRetry(path))) removed.push(name);
  }
  return removed;
}

async function copyFiltered(source, destination) {
  const omitted = [];
  const candidates = [];

  async function visit(from, relativePath) {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        omitted.push({ path: nextRelative, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SECRET_DIRECTORIES.has(entry.name.toLowerCase())) {
          omitted.push({ path: nextRelative, reason: "credential-directory" });
        } else if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          omitted.push({ path: nextRelative, reason: "generated-directory" });
        } else {
          await visit(join(from, entry.name), nextRelative);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretName(entry.name)) {
        omitted.push({ path: nextRelative, reason: "credential-file" });
        continue;
      }
      candidates.push(nextRelative);
    }
  }

  await visit(source, "");

  const ignored = isGitRepository(source) ? ignoredPaths(source, candidates) : new Set();
  for (const relativePath of candidates) {
    if (ignored.has(relativePath)) {
      omitted.push({ path: relativePath, reason: "gitignored" });
      continue;
    }
    const parts = relativePath.split("/");
    const target = join(destination, ...parts);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, ...parts), target);
  }
  return omitted;
}

// Derived from the job id alone, so cancel can clean up a write job even when
// it was killed before job.json recorded the branch.
export function writeTarget(jobId) {
  return { branch: `polyglot/${jobId}`, destination: join(isolationRoot(), jobId, "workspace") };
}

// Returns the branch deletion's git result.
export function discardWriteTarget(cwd, jobId) {
  const { branch, destination } = writeTarget(jobId);
  if (!removeWorktree(cwd, destination).ok) {
    // A worker killed mid `worktree add` leaves a half-registered worktree.
    try {
      rmSync(dirname(destination), { recursive: true, force: true });
    } catch {
      // Still locked; collectGarbage retries later.
    }
    pruneWorktrees(cwd);
  }
  return deleteBranch(cwd, branch);
}

// A write job never touches the user's working tree: it runs in a worktree on
// its own branch, based on the current state (uncommitted tracked changes
// included), and the user decides whether to apply the branch.
async function prepareWriteBranch({ cwd, jobId }) {
  if (!isGitRepository(cwd)) {
    throw new Error("Write mode needs a git repository: changes land on a polyglot/<job> branch, never in the working tree.");
  }
  const baseRef = stashCreate(cwd) || head(cwd);
  if (!baseRef) throw new Error("Write mode needs at least one commit to branch from.");
  const { branch, destination } = writeTarget(jobId);
  const jobRoot = dirname(destination);
  await rm(jobRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(jobRoot, { recursive: true });
  const created = addWorktree(cwd, destination, baseRef, branch);
  if (!created.ok) {
    // -b creates the branch before the checkout that failed.
    discardWriteTarget(cwd, jobId);
    throw new Error(`git worktree add failed: ${created.stderr || created.error}`);
  }
  return {
    executionCwd: destination,
    strategy: "git-worktree-branch",
    exported: true,
    omitted: [],
    gitHistoryAvailable: true,
    branch,
    baseRef,
    cleanup: async () => {
      if (removeWorktree(cwd, destination).ok) return null;
      return removeWithRetry(jobRoot);
    },
  };
}

/**
 * Decides where the target agent runs.
 *
 * review without --isolate (default): no copy at all. Read-only enforcement
 * comes from the provider profile, git history stays available, and nothing
 * leaves the machine.
 * review with --isolate: a detached git worktree when possible, otherwise a
 * filtered copy that refuses credentials and gitignored files. `ref` checks
 * out that commit instead of the current state (reviewing another job's branch).
 * write: a worktree on a polyglot/<job> branch.
 */
export async function prepareExecutionRoot({ mode, cwd, jobId, isolate = false, ref: explicitRef = null }) {
  if (mode === "write") return prepareWriteBranch({ cwd, jobId });
  if (!isolate) {
    return {
      executionCwd: cwd,
      strategy: "in-place-read-only",
      exported: false,
      omitted: [],
      gitHistoryAvailable: isGitRepository(cwd),
      cleanup: async () => null,
    };
  }

  const jobRoot = join(isolationRoot(), jobId);
  const destination = join(jobRoot, "workspace");
  await rm(jobRoot, { recursive: true, force: true }).catch(() => {});

  if (isGitRepository(cwd)) {
    const stashRef = explicitRef ? null : stashCreate(cwd);
    const ref = explicitRef || stashRef || head(cwd);
    if (ref) {
      await mkdir(jobRoot, { recursive: true });
      const created = addWorktree(cwd, destination, ref);
      if (!created.ok && explicitRef) throw new Error(`git worktree add ${explicitRef} failed: ${created.stderr || created.error}`);
      if (created.ok) {
        return {
          executionCwd: destination,
          strategy: "git-worktree",
          exported: true,
          worktreeRef: ref,
          omitted: explicitRef || stashRef ? [] : [{ path: "*", reason: "uncommitted-changes-not-in-HEAD" }],
          gitHistoryAvailable: true,
          cleanup: async () => {
            if (removeWorktree(cwd, destination).ok) return null;
            return removeWithRetry(jobRoot);
          },
        };
      }
    }
  }

  // A copy of the working tree is not the requested ref: reviewing it would
  // review the wrong files.
  if (explicitRef) throw new Error(`Cannot check out ${explicitRef}: ${cwd} is not a git repository.`);
  await mkdir(destination, { recursive: true });
  const omitted = await copyFiltered(cwd, destination);
  return {
    executionCwd: destination,
    strategy: "filtered-copy",
    exported: true,
    omitted,
    gitHistoryAvailable: false,
    cleanup: async () => removeWithRetry(jobRoot),
  };
}

export function isInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}
