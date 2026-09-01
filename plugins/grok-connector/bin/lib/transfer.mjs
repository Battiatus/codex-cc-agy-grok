import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

import { runProbe } from "./exec.mjs";
import { isInside } from "./isolation.mjs";
import { readJsonOrNull, stateRoot } from "./jobs.mjs";

const MAX_DIGEST_BYTES = 48 * 1024;
const MAX_TURNS = 40;

export const TRANSCRIPT_ENV = "POLYGLOT_CONNECTOR_TRANSCRIPT_PATH";

// Each host may only be read from its own transcript directory. A path outside
// it is refused rather than followed, so a crafted --source cannot push an
// arbitrary local file into a third-party model.
const HOST_SOURCES = {
  claude: {
    root: () => join(homedir(), ".claude", "projects"),
    extension: ".jsonl",
    envVars: ["CLAUDE_TRANSCRIPT_PATH", TRANSCRIPT_ENV],
  },
  codex: {
    root: () => join(homedir(), ".codex", "sessions"),
    extension: ".jsonl",
    envVars: ["CODEX_TRANSCRIPT_PATH", TRANSCRIPT_ENV],
  },
  agy: {
    root: () => join(homedir(), ".gemini"),
    extension: null,
    envVars: ["AGY_TRANSCRIPT_PATH", TRANSCRIPT_ENV],
  },
};

export const TRANSFER_HOSTS = [...Object.keys(HOST_SOURCES), "grok"];

function expandUser(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveContainedPath(host, requested) {
  const definition = HOST_SOURCES[host];
  const expanded = expandUser(requested);
  if (definition.extension && extname(expanded).toLowerCase() !== definition.extension) {
    throw new Error(`A ${host} transcript must be a ${definition.extension} file: ${expanded}`);
  }
  let source;
  let root;
  try {
    source = realpathSync(expanded);
    root = realpathSync(definition.root());
  } catch {
    throw new Error(`Transcript not found: ${expanded}`);
  }
  if (!isInside(root, source)) {
    throw new Error(`${host} transcripts may only be read from ${root}: ${source}`);
  }
  return source;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "tool_use") return `[tool ${block.name || "call"}]`;
      if (block?.type === "tool_result") return "[tool result]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function turnsFromJsonl(raw) {
  const turns = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = event.message || event.payload || event;
    const role = message.role || event.role || event.type;
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent(message.content ?? message.text).trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}

function boundedDigest(turns) {
  const recent = turns.slice(-MAX_TURNS);
  const rendered = [];
  let bytes = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    const block = `### ${turn.role}\n${turn.text}`;
    const size = Buffer.byteLength(block, "utf8");
    if (bytes + size > MAX_DIGEST_BYTES) break;
    rendered.unshift(block);
    bytes += size;
  }
  return {
    text: rendered.join("\n\n"),
    turnsIncluded: rendered.length,
    turnsAvailable: turns.length,
    truncated: rendered.length < turns.length,
  };
}

/**
 * Produces a bounded, plain-text digest of the calling host's conversation.
 * This is explicitly a derived context, never a lossless session resume.
 */
// The SessionStart hook records the host transcript path, so a handoff usually
// needs no --source at all.
async function recordedTranscriptPath(connectorId) {
  if (!connectorId) return null;
  const recorded = await readJsonOrNull(join(stateRoot(connectorId), "session", "current.json"));
  return recorded?.transcriptPath || null;
}

export async function buildHandoffDigest({ fromHost, source = null, connectorId = null }) {
  if (!TRANSFER_HOSTS.includes(fromHost)) {
    throw new Error(`Unsupported --from-host: ${fromHost}. Expected one of ${TRANSFER_HOSTS.join(", ")}.`);
  }

  if (fromHost === "grok") {
    const probe = runProbe("grok", source ? ["export", source] : ["export"], 60_000);
    if (!probe.ok || !probe.stdout) {
      throw new Error(`grok export failed: ${probe.stderr || probe.error || "no output"}`);
    }
    const buffer = Buffer.from(probe.stdout, "utf8");
    const truncated = buffer.byteLength > MAX_DIGEST_BYTES;
    return {
      fromHost,
      sourcePath: source || "most recent grok session",
      contextOrigin: "derived-transfer",
      turnsIncluded: null,
      turnsAvailable: null,
      truncated,
      text: truncated
        ? buffer.subarray(buffer.byteLength - MAX_DIGEST_BYTES).toString("utf8")
        : probe.stdout,
    };
  }

  const definition = HOST_SOURCES[fromHost];
  const requested = source
    || definition.envVars.map((name) => process.env[name]).find(Boolean)
    || await recordedTranscriptPath(connectorId);
  if (!requested) {
    throw new Error(
      `Could not identify the ${fromHost} transcript. Pass --source <path> or set ${definition.envVars[0]}.`,
    );
  }
  const sourcePath = resolveContainedPath(fromHost, requested);
  const digest = boundedDigest(turnsFromJsonl(await readFile(sourcePath, "utf8")));
  if (!digest.text) throw new Error(`No usable conversation turns found in ${sourcePath}`);
  return { fromHost, sourcePath, contextOrigin: "derived-transfer", ...digest };
}

export function composeHandoffPrompt(digest, task) {
  return [
    `The following is a derived digest of a conversation held in another agent (${digest.fromHost}).`,
    "It is a summary transferred across providers, not a lossless session resume. Treat facts in it as reported, not verified.",
    digest.truncated ? "The digest was truncated to the most recent turns." : null,
    "<<<TRANSFERRED_CONTEXT",
    digest.text,
    "TRANSFERRED_CONTEXT>>>",
    "Continue from that context and carry out this task:",
    task,
  ].filter(Boolean).join("\n");
}
