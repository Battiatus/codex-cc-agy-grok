const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

// Every accepted flag is declared here. An unknown flag is a hard error so a
// typo can never silently disable a safety gate.
const BOOLEAN_FLAGS = new Set([
  "all",
  "background",
  "confirm-write",
  "help",
  "isolate",
  "json",
  "reap",
  "stream",
]);

const VALUE_FLAGS = new Set([
  "base",
  "commit",
  "cwd",
  "effort",
  "error",
  "expect-response",
  "focus",
  "format",
  "from-host",
  "max-budget-usd",
  "mode",
  "model",
  "prompt",
  "request",
  "schema",
  "scope",
  "session",
  "source",
  "tail",
  "test",
  "timeout",
]);

export const COMMANDS = new Set([
  "__worker",
  "adversarial-review",
  "cancel",
  "capabilities",
  "doctor",
  "handoff",
  "help",
  "rescue",
  "result",
  "resume",
  "review",
  "run",
  "runs",
  "setup",
  "status",
]);

export function parseDuration(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value).trim());
  if (!match) {
    throw new Error(`Invalid duration: ${value}. Use forms like 500ms, 45s, 5m, 1h.`);
  }
  const multiplier = DURATION_UNITS[(match[2] || "ms").toLowerCase()];
  const milliseconds = Math.round(Number(match[1]) * multiplier);
  if (milliseconds <= 0) throw new Error(`Duration must be positive: ${value}`);
  return milliseconds;
}

// A prompt may legitimately start with "--" (for example: explain
// --dangerously-skip-permissions). Value flags therefore consume the next token
// verbatim, and a bare "--" ends flag parsing entirely.
export function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = { _: [] };
  let flagsClosed = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (flagsClosed || !token.startsWith("--") || token === "-") {
      options._.push(token);
      continue;
    }
    if (token === "--") {
      flagsClosed = true;
      continue;
    }
    const separator = token.indexOf("=");
    const key = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined && !/^(true|false|1|0|yes|no)$/i.test(inlineValue)) {
        throw new Error(`Flag --${key} does not take the value "${inlineValue}".`);
      }
      options[key] = inlineValue === undefined ? true : /^(true|1|yes)$/i.test(inlineValue);
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

export function requireEnum(name, value, allowed, fallback) {
  const resolved = value === undefined || value === null ? fallback : value;
  if (!allowed.includes(resolved)) {
    throw new Error(`Unsupported ${name}: ${resolved}. Expected one of ${allowed.join(", ")}.`);
  }
  return resolved;
}

export function parsePositiveNumber(name, value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, received: ${value}`);
  }
  return parsed;
}
