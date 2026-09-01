import { runProbe } from "./exec.mjs";

const MAX_DETAIL_CHARS = 200;

// Auth probes answer in prose (codex, grok) or JSON (claude), so collapse
// whitespace and keep a bounded single-line excerpt either way.
function summarise(text) {
  const collapsed = (text || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_DETAIL_CHARS
    ? `${collapsed.slice(0, MAX_DETAIL_CHARS)}…`
    : collapsed;
}

// Reports what the connector can actually do on this machine. A caller must be
// able to tell "installed but logged out" from "ready", which the previous
// hardcoded authenticated:"unknown" made impossible.
export function inspectConnector(config, { timeoutMs = 25_000 } = {}) {
  const mock = process.env.AGENT_CONNECTOR_MOCK;
  const version = mock
    ? runProbe(process.execPath, [mock, "--connector", config.id, ...config.versionArgs], timeoutMs)
    : runProbe(config.binary, config.versionArgs, timeoutMs);

  const installed = version.ok;
  let authenticated = "unknown";
  let authDetail = null;

  if (installed && mock) {
    authenticated = true;
    authDetail = "mock provider";
  } else if (installed && config.authProbe) {
    const probe = runProbe(config.binary, config.authProbe.args, timeoutMs);
    const haystack = `${probe.stdout}\n${probe.stderr}`;
    const pattern = config.authProbe.successPattern
      ? new RegExp(config.authProbe.successPattern, "i")
      : null;
    authenticated = probe.ok && (!pattern || pattern.test(haystack));
    authDetail = summarise(probe.ok ? probe.stdout : probe.stderr) || probe.error;
  }

  return {
    connector: config.id,
    displayName: config.displayName,
    binary: config.binary,
    installed,
    version: installed ? (version.stdout || version.stderr).split(/\r?\n/).find(Boolean) : null,
    authenticated,
    authDetail,
    resolvedFrom: version.resolvedFrom,
    invocationStrategy: version.strategy,
    capabilities: config.capabilities,
    error: installed ? null : (version.error || version.stderr || "executable not available"),
    remediation: installed
      ? (authenticated === true ? null : config.authProbe?.remediation || null)
      : config.installHint || null,
    note: "The connector inherits the target CLI authentication and never stores provider credentials.",
  };
}

// Verifies the declared flags still exist in the installed CLI, so a vendor
// rename fails loudly instead of silently producing a broken command line.
export function auditFlags(config, { timeoutMs = 30_000 } = {}) {
  const declared = new Set();
  for (const group of Object.values(config.invocation)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (typeof entry === "string" && entry.startsWith("--")) declared.add(entry.split("=")[0]);
    }
  }

  const helpText = (config.helpProbes || [])
    .map((args) => {
      const probe = runProbe(config.binary, args, timeoutMs);
      return `${probe.stdout}\n${probe.stderr}`;
    })
    .join("\n");

  if (!helpText.trim()) {
    return {
      connector: config.id,
      checked: false,
      ok: false,
      reason: "no help output available",
      missing: [],
    };
  }

  const hiddenAllowed = config.knownHiddenFlags || [];
  const missing = [...declared]
    .filter((flag) => !hiddenAllowed.includes(flag) && !helpText.includes(flag))
    .sort();

  return {
    connector: config.id,
    checked: true,
    declaredCount: declared.size,
    hiddenAllowed,
    missing,
    ok: missing.length === 0,
  };
}
