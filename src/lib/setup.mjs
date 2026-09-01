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
  const versionArgs = config.versionArgs || ["--version"];
  const version = mock
    ? runProbe(process.execPath, [mock, "--connector", config.id, ...versionArgs], timeoutMs)
    : runProbe(config.binary, versionArgs, timeoutMs);

  const installed = version.ok;
  let authenticated = "unknown";
  let authDetail = null;

  if (installed && mock) {
    authenticated = true;
    authDetail = "mock provider";
  } else if (installed && config.authProbe) {
    const probe = runProbe(config.binary, config.authProbe.args || [], timeoutMs);
    const haystack = `${probe.stdout}\n${probe.stderr}`;
    const pattern = config.authProbe.successPattern
      ? new RegExp(config.authProbe.successPattern, "i")
      : null;
    authenticated = probe.ok && (!pattern || pattern.test(haystack));
    authDetail = summarise(probe.ok ? probe.stdout : (probe.stderr || probe.stdout)) || probe.error;
  }

  const defaultInstallHint = `Install ${config.displayName || config.id} CLI (${config.binary}) and ensure it is on your PATH.`;
  const defaultAuthRemediation = `Run authentication command for ${config.displayName || config.id}.`;

  return {
    connector: config.id,
    displayName: config.displayName || config.id,
    binary: config.binary,
    installed,
    version: installed ? (version.stdout || version.stderr).split(/\r?\n/).find(Boolean) : null,
    authenticated,
    authDetail,
    resolvedFrom: version.resolvedFrom,
    invocationStrategy: version.strategy,
    capabilities: config.capabilities || {},
    error: installed ? null : (version.error || version.stderr || version.stdout || `Executable not found in $PATH: "${config.binary}"`),
    remediation: installed
      ? (authenticated === true ? null : (config.authProbe?.remediation || defaultAuthRemediation))
      : (config.installHint || defaultInstallHint),
    note: "The connector inherits the target CLI authentication and never stores provider credentials.",
  };
}

// Verifies the declared flags still exist in the installed CLI, so a vendor
// rename fails loudly instead of silently producing a broken command line.
export function auditFlags(config, { timeoutMs = 30_000 } = {}) {
  const declared = new Set();
  for (const group of Object.values(config.invocation || {})) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (typeof entry === "string" && entry.startsWith("--")) declared.add(entry.split("=")[0]);
    }
  }

  const helpProbes = config.helpProbes && config.helpProbes.length > 0 ? config.helpProbes : [["--help"]];
  const helpText = helpProbes
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
