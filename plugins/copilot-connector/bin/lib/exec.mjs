import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

const LOOKUP_TIMEOUT_MS = 5_000;

// Node >= 20.12 refuses to spawn .cmd/.bat without shell:true (CVE-2024-27980),
// and an extension-less POSIX shell script is not executable on Windows at all.
// Resolving the executable up front keeps spawn() free of shell quoting.
const resolutionCache = new Map();

function lookupCandidates(binary) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const args = process.platform === "win32" ? [binary] : ["-a", binary];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: LOOKUP_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// npm/pnpm shims embed the real entrypoint. Reading it beats guessing a
// node_modules layout, which differs between npm, pnpm, yarn and bun.
function entrypointFromShim(shimPath) {
  let contents;
  try {
    contents = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const shimDirectory = dirname(shimPath);
  const pattern = /(?:%~?dp0%?|\$basedir|\$\{basedir\})?[\\/]*([\w.@/\\-]+\.(?:js|mjs|cjs))/gi;
  for (const match of contents.matchAll(pattern)) {
    const relative = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const candidate = isAbsolute(relative) ? relative : resolve(shimDirectory, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function shebangInterpreter(filePath) {
  let head;
  try {
    head = readFileSync(filePath, "utf8").slice(0, 256);
  } catch {
    return null;
  }
  if (!head.startsWith("#!")) return null;
  const line = head.split(/\r?\n/, 1)[0];
  if (/\bnode\b/.test(line)) return "node";
  if (/\b(?:ba)?sh\b/.test(line)) return "sh";
  return "other";
}

function resolveExecutableUncached(binary) {
  const candidates = lookupCandidates(binary);
  if (candidates.length === 0) {
    return { command: binary, prefixArgs: [], strategy: "path-fallback", resolvedFrom: null };
  }

  // A native executable is always the safest spawn target.
  const native = candidates.find((candidate) => {
    const extension = extname(candidate).toLowerCase();
    return process.platform === "win32" ? extension === ".exe" : extension === "";
  });
  if (native) {
    return { command: native, prefixArgs: [], strategy: "native", resolvedFrom: native };
  }

  // Otherwise recover the JavaScript entrypoint from a shim.
  for (const candidate of candidates) {
    const extension = extname(candidate).toLowerCase();
    if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") continue;
    const entrypoint = entrypointFromShim(candidate);
    if (entrypoint) {
      return {
        command: process.execPath,
        prefixArgs: [entrypoint],
        strategy: "shim-entrypoint",
        resolvedFrom: candidate,
      };
    }
  }

  // Extension-less files: inspect the shebang, and on Windows try a sibling shim.
  for (const candidate of candidates) {
    if (extname(candidate) !== "") continue;
    if (shebangInterpreter(candidate) === "node") {
      return {
        command: process.execPath,
        prefixArgs: [candidate],
        strategy: "shebang-node",
        resolvedFrom: candidate,
      };
    }
    if (process.platform !== "win32") continue;
    const sibling = `${candidate}.cmd`;
    const entrypoint = existsSync(sibling) ? entrypointFromShim(sibling) : null;
    if (entrypoint) {
      return {
        command: process.execPath,
        prefixArgs: [entrypoint],
        strategy: "sibling-shim-entrypoint",
        resolvedFrom: sibling,
      };
    }
  }

  const first = candidates[0];
  return { command: first, prefixArgs: [], strategy: "unverified", resolvedFrom: first };
}

export function resolveExecutable(binary) {
  if (!resolutionCache.has(binary)) {
    resolutionCache.set(binary, resolveExecutableUncached(binary));
  }
  return resolutionCache.get(binary);
}

export function buildTargetCommand(binary, args) {
  const resolution = resolveExecutable(binary);
  return {
    command: resolution.command,
    args: [...resolution.prefixArgs, ...args],
    strategy: resolution.strategy,
    resolvedFrom: resolution.resolvedFrom,
  };
}

export function runProbe(binary, args, timeoutMs = 20_000) {
  const invocation = buildTargetCommand(binary, args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null,
    strategy: invocation.strategy,
    resolvedFrom: invocation.resolvedFrom,
  };
}
