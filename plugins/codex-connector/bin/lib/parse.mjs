import { StringDecoder } from "node:string_decoder";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

// Codex reports unrelated environment problems as `item.type === "error"`
// (skills budget, plugin hook parsing, MCP auth). Those are notices, not
// denials, and must never downgrade a clean review.
const BENIGN_NOTICE = /skills context budget|plugin hooks config|clamping \w+ hook timeout|transport channel closed|failed to load skill|skills scan reached/i;
const DENIAL_NOTICE = /sandbox|approval|not permitted|denied|read-only file system|erofs|operation not permitted/i;

// Keeps the last `limitBytes` bytes of a string, advancing past any UTF-8
// continuation byte so the cut never splits a character.
function byteSafeTail(text, limitBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= limitBytes) return text;
  let offset = buffer.byteLength - limitBytes;
  while (offset < buffer.byteLength && (buffer[offset] & 0b1100_0000) === 0b1000_0000) {
    offset += 1;
  }
  return buffer.subarray(offset).toString("utf8");
}

// A StringDecoder keeps multi-byte characters intact across pipe boundaries, and
// the tail budget is enforced in bytes rather than characters.
export function createCapture(limitBytes = MAX_CAPTURE_BYTES) {
  const decoder = new StringDecoder("utf8");
  const segments = [];
  let bytes = 0;
  let dropped = false;
  return {
    push(chunk) {
      const decoded = decoder.write(chunk);
      if (!decoded) return;
      const size = Buffer.byteLength(decoded, "utf8");
      segments.push({ decoded, size });
      bytes += size;
      while (bytes > limitBytes && segments.length > 1) {
        bytes -= segments.shift().size;
        dropped = true;
      }
      // A single chunk larger than the whole budget still has to be trimmed,
      // and the cut must land on a character boundary.
      if (bytes > limitBytes) {
        const trimmed = byteSafeTail(segments[0].decoded, limitBytes);
        bytes = Buffer.byteLength(trimmed, "utf8");
        segments[0] = { decoded: trimmed, size: bytes };
        dropped = true;
      }
    },
    end() {
      const tail = decoder.end();
      if (tail) {
        segments.push({ decoded: tail, size: Buffer.byteLength(tail, "utf8") });
      }
    },
    text() {
      return segments.map((segment) => segment.decoded).join("");
    },
    truncated() {
      return dropped;
    },
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function lastJsonObject(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Providers may prepend log lines; fall back to the last parseable line.
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? null;
  const cachedInputTokens = usage.cache_read_input_tokens
    ?? usage.cached_input_tokens
    ?? usage.cache_read_tokens
    ?? null;
  const reasoningTokens = usage.reasoning_tokens
    ?? usage.reasoning_output_tokens
    ?? usage.thinking_tokens
    ?? null;
  const totalTokens = usage.total_tokens
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens };
}

function parseClaude(stdout) {
  const envelope = lastJsonObject(stdout);
  if (!envelope) return null;
  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [];
  return {
    adapter: "claude",
    text: firstString(envelope.result),
    structured: envelope.structured_output ?? null,
    nativeSessionId: firstString(envelope.session_id) || null,
    usage: normalizeUsage(envelope.usage),
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    numTurns: envelope.num_turns ?? null,
    denials: denials.map((entry) => ({
      tool: entry?.tool_name ?? entry?.tool ?? null,
      reason: entry?.message ?? entry?.reason ?? null,
    })),
    providerError: envelope.is_error === true || envelope.subtype === "error_during_execution"
      ? firstString(envelope.error, envelope.subtype, "provider reported an error")
      : null,
    notices: [],
  };
}

function parseGrok(stdout) {
  const envelope = lastJsonObject(stdout);
  if (!envelope) return null;
  const stopReason = firstString(envelope.stopReason, envelope.stop_reason);
  const abnormalStop = stopReason && !["end_turn", "stop", "stop_sequence"].includes(stopReason);
  return {
    adapter: "grok",
    text: firstString(envelope.text, envelope.response),
    structured: envelope.structuredOutput ?? envelope.structured_output ?? null,
    nativeSessionId: firstString(envelope.sessionId, envelope.session_id) || null,
    usage: normalizeUsage(envelope.usage),
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    numTurns: envelope.num_turns ?? null,
    denials: [],
    providerError: envelope.error ? firstString(envelope.error) : null,
    notices: abnormalStop ? [`provider stopped with stopReason=${stopReason}`] : [],
  };
}

function parseAgy(stdout) {
  const envelope = lastJsonObject(stdout);
  if (!envelope) return null;
  const status = firstString(envelope.status);
  const abnormal = status && status.toUpperCase() !== "SUCCESS";
  return {
    adapter: "agy",
    text: firstString(envelope.response, envelope.text),
    structured: envelope.structured_output ?? null,
    nativeSessionId: firstString(envelope.conversation_id, envelope.conversationId) || null,
    usage: normalizeUsage(envelope.usage),
    costUsd: null,
    numTurns: envelope.num_turns ?? null,
    denials: [],
    providerError: abnormal ? `provider status=${status}` : null,
    notices: [],
  };
}

// Codex streams NDJSON. The authoritative final message comes from
// --output-last-message, so the stream is only mined for session id, usage and
// control notices.
function parseCodexStream(stdout, finalMessage) {
  let nativeSessionId = null;
  let usage = null;
  let lastAgentMessage = "";
  let providerError = null;
  const notices = [];
  const denials = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event.thread_id === "string" && !nativeSessionId) nativeSessionId = event.thread_id;
    if (event.type === "turn.completed" && event.usage) usage = normalizeUsage(event.usage);
    if (event.type === "turn.failed") providerError = firstString(event.error?.message, "turn failed");
    const item = event.item;
    if (!item) continue;
    if (item.type === "agent_message" && typeof item.text === "string") lastAgentMessage = item.text;
    if (item.type !== "error") continue;
    const message = firstString(item.message);
    if (!message || BENIGN_NOTICE.test(message)) {
      if (message) notices.push(message);
    } else if (DENIAL_NOTICE.test(message)) {
      denials.push({ tool: null, reason: message });
    } else {
      notices.push(message);
    }
  }
  return {
    adapter: "codex",
    text: firstString(finalMessage, lastAgentMessage),
    structured: null,
    nativeSessionId,
    usage,
    costUsd: null,
    numTurns: null,
    denials,
    providerError,
    notices,
  };
}

const ADAPTERS = {
  claude: (stdout) => parseClaude(stdout),
  grok: (stdout) => parseGrok(stdout),
  agy: (stdout) => parseAgy(stdout),
  codex: (stdout, finalMessage) => parseCodexStream(stdout, finalMessage),
  qwen: (stdout) => parseClaude(stdout),
  opencode: (stdout) => parseClaude(stdout),
  copilot: (stdout) => parseClaude(stdout),
};

export function parseProviderOutput(adapterName, { stdout = "", finalMessage = "" } = {}) {
  const adapter = ADAPTERS[adapterName];
  if (!adapter) throw new Error(`Unknown result adapter: ${adapterName}`);
  const parsed = adapter(stdout, finalMessage);
  if (!parsed) {
    return {
      adapter: adapterName,
      text: (finalMessage || "").trim(),
      structured: null,
      nativeSessionId: null,
      usage: null,
      costUsd: null,
      numTurns: null,
      denials: [],
      providerError: stdout.trim()
        ? "provider output was not parseable"
        : "provider produced no output",
      notices: [],
    };
  }
  // A schema-constrained provider returns its payload as the message text; if
  // the native structured field is absent, recover it from the text.
  if (!parsed.structured && parsed.text) {
    const recovered = lastJsonObject(parsed.text);
    if (recovered && !Array.isArray(recovered)) parsed.structured = recovered;
  }
  parsed.text = (parsed.text || "").trim();
  return parsed;
}
