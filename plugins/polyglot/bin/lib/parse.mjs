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

export function stripAnsi(text) {
  if (typeof text !== "string") return text;
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

function extractMarkdownBlocks(text) {
  const blocks = [];
  const fenceRegex = /(?:```|~~~)(?:[a-zA-Z0-9_-]+)?\s*\r?\n?([\s\S]*?)\r?\n?(?:```|~~~)/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

function findLastBalancedJsonObject(text) {
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            matchedEnd = j;
            break;
          }
        }
      }
    }

    if (matchedEnd !== -1) {
      const chunk = text.slice(i, matchedEnd + 1);
      try {
        const parsed = JSON.parse(chunk);
        if (parsed && typeof parsed === "object") {
          candidates.push(parsed);
          i = matchedEnd;
        }
      } catch {
        // Not valid JSON at this boundary
      }
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

export function lastJsonObject(text) {
  const clean = stripAnsi(text || "").trim();
  if (!clean) return null;

  // 1. Direct JSON.parse
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Continue
  }

  // 2. Markdown fenced code blocks (from last to first)
  const blocks = extractMarkdownBlocks(clean);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    try {
      const parsed = JSON.parse(block);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      const candidate = findLastBalancedJsonObject(block);
      if (candidate) return candidate;
    }
  }

  // 3. Line-by-line from end to start
  const lines = clean.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      continue;
    }
  }

  // 4. Balanced { ... } extractor across entire clean text
  const balanced = findLastBalancedJsonObject(clean);
  if (balanced) return balanced;

  // 5. Fallback: substring starting with '{' and ending with '}'
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Fallback failed
    }
  }

  return null;
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

function parseClaude(stdout, adapter = "claude") {
  // stream-json: one event per line, the last "result" event is the envelope.
  // Scanning lines first matters: assistant text events can carry fenced JSON
  // that the generic extractor would mistake for the answer. A stream with no
  // result event never finished, so it has no envelope at all.
  const events = jsonLines(stdout);
  const streamed = events.some((event) => ["system", "assistant", "user"].includes(event?.type));
  let envelope = events.findLast((event) => event?.type === "result")
    ?? (streamed ? null : lastJsonObject(stdout));
  // `--output-format json` on qwen prints the whole event list as one array.
  if (Array.isArray(envelope)) envelope = envelope.findLast((event) => event?.type === "result") ?? null;
  if (!envelope) return null;
  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [];
  return {
    adapter,
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
  const last = lastJsonObject(stdout);
  // stream-json wraps the final envelope as {"event":"result","result":{...}}.
  const envelope = last?.event === "result" && last.result ? last.result : last;
  if (!envelope) return null;
  const status = firstString(envelope.status);
  const text = firstString(envelope.response, envelope.text);
  const abnormal = status && status.toUpperCase() !== "SUCCESS";
  return {
    adapter: "agy",
    text,
    structured: envelope.structured_output ?? null,
    nativeSessionId: firstString(envelope.conversation_id, envelope.conversationId) || null,
    usage: normalizeUsage(envelope.usage),
    costUsd: null,
    numTurns: envelope.num_turns ?? null,
    denials: [],
    // agy reports SUCCESS with an empty response when --print-timeout fires.
    providerError: abnormal
      ? firstString(envelope.error, `provider status=${status}`)
      : (text ? null : "provider returned an empty response"),
    notices: [],
  };
}

function jsonLines(stdout) {
  const events = [];
  for (const line of stripAnsi(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Not an event line.
    }
  }
  return events;
}

// opencode streams one event per line: text parts, step_finish with cost and
// tokens, and error events.
function parseOpencode(stdout) {
  const events = jsonLines(stdout);
  if (events.length === 0) return null;
  const texts = [];
  let costUsd = null;
  let usage = null;
  let providerError = null;
  let nativeSessionId = null;
  for (const event of events) {
    nativeSessionId ||= firstString(event.sessionID) || null;
    const part = event.part || {};
    if (event.type === "text" && typeof part.text === "string" && !part.synthetic) texts.push(part.text);
    if (event.type === "step_finish") {
      if (typeof part.cost === "number") costUsd = (costUsd ?? 0) + part.cost;
      if (part.tokens) {
        usage = normalizeUsage({
          input_tokens: part.tokens.input,
          output_tokens: part.tokens.output,
          reasoning_tokens: part.tokens.reasoning,
          cache_read_tokens: part.tokens.cache?.read,
          total_tokens: part.tokens.total,
        });
      }
    }
    if (event.type === "error") {
      providerError = firstString(event.error?.data?.message, event.error?.name, "provider reported an error");
    }
  }
  return {
    adapter: "opencode",
    text: texts.join("\n"),
    structured: null,
    nativeSessionId,
    usage,
    costUsd,
    numTurns: null,
    denials: [],
    providerError,
    notices: [],
  };
}

// ponytail: copilot's JSONL success shape is unverified (no signed-in probe);
// this keeps the last message-like string and the session id. Tighten once a
// real transcript is captured.
function parseCopilot(stdout) {
  const events = jsonLines(stdout);
  if (events.length === 0) return null;
  let text = "";
  let nativeSessionId = null;
  let providerError = null;
  for (const event of events) {
    nativeSessionId ||= firstString(event.sessionId, event.session_id) || null;
    const candidate = firstString(event.result, event.content, event.text, event.data?.content);
    if (candidate) text = candidate;
    if (event.type === "error") providerError = firstString(event.message, event.error?.message, "provider reported an error");
  }
  return {
    adapter: "copilot",
    text,
    structured: null,
    nativeSessionId,
    usage: null,
    costUsd: null,
    numTurns: null,
    denials: [],
    providerError,
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
  for (const line of stripAnsi(stdout || "").split(/\r?\n/)) {
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

const RECENT_ACTIONS = 5;
const MAX_ACTION_CHARS = 120;

function clip(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_ACTION_CHARS ? `${flat.slice(0, MAX_ACTION_CHARS - 3)}...` : flat;
}

function toolAction(name, input) {
  const args = input && typeof input === "object" ? input : {};
  // A search says more by its pattern than by the directory it searched.
  const target = firstString(
    args.command, args.cmd, args.pattern, args.query, args.file_path, args.filePath,
    args.path, args.Path, args.url,
  );
  return target ? `${name || "tool"} ${target}` : String(name || "tool");
}

// One streamed provider event as {actions, outputTokens, outputDelta, costUsd,
// costDelta}, each optional. Shapes were captured from live runs: codex
// `exec --json`, claude/qwen stream-json, opencode `--format json`, agy
// stream-json. Claude's per-message usage is a placeholder until the final
// result event, so assistant events give actions only.
function readProgressEvent(event) {
  if (!event || typeof event !== "object") return null;
  const item = event.item;
  if (event.type === "item.started" && item?.type === "command_execution") return { actions: [`$ ${item.command}`] };
  if (event.type === "item.started" && item?.type === "mcp_tool_call") return { actions: [`${item.server}.${item.tool}`] };
  if (event.type === "item.started" && item?.type === "web_search") return { actions: [`search ${item.query}`] };
  if (event.type === "item.completed" && item?.type === "file_change") {
    return { actions: [`edit ${(item.changes || []).map((change) => change.path).join(", ")}`] };
  }
  if (event.type === "turn.completed") return { outputTokens: event.usage?.output_tokens };
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    return {
      actions: event.message.content
        .filter((part) => part?.type === "tool_use")
        .map((part) => toolAction(part.name, part.input)),
    };
  }
  if (event.type === "result") return { costUsd: event.total_cost_usd, outputTokens: event.usage?.output_tokens };
  if (event.type === "tool_use") return { actions: [toolAction(event.part?.tool, event.part?.state?.input)] };
  if (event.type === "step_finish") return { costDelta: event.part?.cost, outputDelta: event.part?.tokens?.output };
  const step = event.step_update;
  if (event.event === "step_update" && step) {
    if (step.step_type === "tool" && step.state === "ACTIVE") return { actions: [toolAction(step.tool_name, step.tool_info?.parameters)] };
    if (step.state === "DONE") return { outputDelta: step.usage?.output_tokens };
  }
  return null;
}

// Follows a provider's stdout as it streams and keeps what a human watching
// would want: the current action, the last few, and output tokens and cost so
// far. Paths under `root` are shown relative to it.
export function createProgressTracker({ root = null } = {}) {
  const decoder = new StringDecoder("utf8");
  const roots = root ? [...new Set([root, root.replace(/\\/g, "/")])] : [];
  const state = { lastAction: null, lastActionAt: null, actions: 0, recent: [], outputTokens: null, costUsd: null };
  let buffer = "";

  // The workspace root itself reads as ".", anything under it as a relative
  // path; a sibling such as <root>-old is left alone.
  const patterns = roots.map((prefix) => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(`${escaped}[\\\\/]`, "g"), new RegExp(`${escaped}(?=$|[\\s"',;:)\\]])`, "g")];
  });
  const relativize = (text) => patterns.reduce(
    (current, [under, exact]) => current.replace(under, "").replace(exact, "."),
    text,
  );
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

  function apply(event) {
    const progress = readProgressEvent(event);
    if (!progress) return false;
    let changed = false;
    for (const raw of progress.actions ?? []) {
      const action = clip(relativize(raw));
      state.lastAction = action;
      state.lastActionAt = new Date().toISOString();
      state.actions += 1;
      state.recent = [...state.recent, action].slice(-RECENT_ACTIONS);
      changed = true;
    }
    if (num(progress.outputTokens) !== null) {
      state.outputTokens = progress.outputTokens;
      changed = true;
    }
    if (num(progress.outputDelta) !== null) {
      state.outputTokens = (state.outputTokens ?? 0) + progress.outputDelta;
      changed = true;
    }
    if (num(progress.costDelta) !== null) {
      state.costUsd = (state.costUsd ?? 0) + progress.costDelta;
      changed = true;
    }
    if (num(progress.costUsd) !== null) {
      state.costUsd = progress.costUsd;
      changed = true;
    }
    return changed;
  }

  return {
    // Returns true when the snapshot changed.
    push(chunk) {
      buffer += decoder.write(chunk);
      let changed = false;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("{")) {
          try {
            changed = apply(JSON.parse(line)) || changed;
          } catch {
            // A non-JSON line carries no progress.
          }
        }
        index = buffer.indexOf("\n");
      }
      return changed;
    },
    snapshot() {
      return state.actions || state.outputTokens !== null || state.costUsd !== null
        ? { ...state, recent: [...state.recent] }
        : null;
    },
  };
}

const ADAPTERS = {
  claude: (stdout) => parseClaude(stdout),
  grok: (stdout) => parseGrok(stdout),
  agy: (stdout) => parseAgy(stdout),
  codex: (stdout, finalMessage) => parseCodexStream(stdout, finalMessage),
  qwen: (stdout) => parseClaude(stdout, "qwen"),
  opencode: (stdout) => parseOpencode(stdout),
  copilot: (stdout) => parseCopilot(stdout),
};

export function parseProviderOutput(adapterName, { stdout = "", finalMessage = "" } = {}) {
  const adapter = ADAPTERS[adapterName];
  if (!adapter) throw new Error(`Unknown result adapter: ${adapterName}`);
  const parsed = adapter(stdout, finalMessage);
  if (!parsed) {
    return {
      adapter: adapterName,
      text: stripAnsi(finalMessage || "").trim(),
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
  parsed.text = stripAnsi(parsed.text || "").trim();
  return parsed;
}
