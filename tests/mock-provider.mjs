import { writeFile } from "node:fs/promises";

// Emits the real wire format of each provider, captured from live CLI runs, so
// the adapter tests exercise the shapes the bridge actually has to parse.
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const connector = flag("--connector") || "unknown";

if (args.includes("--version")) {
  process.stdout.write(`mock-${connector} 1.0.0\n`);
  process.exit(0);
}
if (args.includes("status") || args.includes("models")) {
  process.stdout.write('You are logged in. {"loggedIn": true}\n');
  process.exit(0);
}

const delay = Number(process.env.MOCK_DELAY_MS || 0);
if (delay > 0) await new Promise((done) => setTimeout(done, delay));

if (process.env.MOCK_WRITE === "1") {
  await writeFile("mutated-by-provider.txt", connector, "utf8");
}
if (process.env.MOCK_ECHO_CHAIN === "1") {
  process.stderr.write(`CHAIN=${process.env.AGENT_CONNECTOR_CHAIN || ""}\n`);
}
if (process.env.MOCK_ECHO_ARGV === "1" && process.env.MOCK_ARGV_PATH) {
  await writeFile(process.env.MOCK_ARGV_PATH, JSON.stringify(args), "utf8");
}
// Benign provider noise that must never be read as a permission denial.
if (process.env.MOCK_FS_WARNING === "1") {
  process.stderr.write("Error: permission denied while opening provider cache\n");
}

const verdict = process.env.MOCK_VERDICT || "needs-attention";
const payload = {
  verdict,
  summary: process.env.MOCK_SUMMARY || "mock review summary",
  findings: verdict === "needs-attention"
    ? [{
      severity: "high",
      title: "mock finding",
      body: "mock finding body",
      file: "math.js",
      line_start: 2,
      line_end: 2,
      confidence: 0.9,
      recommendation: "restore addition",
    }]
    : [],
  next_steps: verdict === "approve" ? [] : ["fix the finding"],
};

function finalText() {
  if (process.env.MOCK_TEXT) return process.env.MOCK_TEXT;
  if (process.env.MOCK_MALFORMED === "1") return JSON.stringify({ verdict: "maybe", summary: 42 });
  if (process.env.MOCK_NOT_JSON === "1") return "I finished but produced prose instead of JSON.";
  if (process.env.MOCK_UNICODE === "1") return "→é漢字🚀".repeat(4_000);
  return JSON.stringify(payload);
}

function structured() {
  const text = finalText();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const usage = {
  input_tokens: 1_234,
  output_tokens: 56,
  cache_read_input_tokens: 78,
  total_tokens: 1_290,
};
const denials = process.env.MOCK_DENIAL === "1"
  ? [{ tool_name: "Write", message: "Permission to use Write has been denied" }]
  : [];

if (connector === "codex") {
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" })}\n`);
  // Environment noise Codex reports as an error item; these are notices.
  process.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "n1", type: "error", message: "Exceeded skills context budget of 2%." },
  })}\n`);
  if (process.env.MOCK_DENIAL === "1") {
    process.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: { id: "n2", type: "error", message: "write blocked by sandbox: read-only file system" },
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "intermediate chatter that must not win" },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { id: "i2", type: "agent_message", text: finalText() },
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage })}\n`);
  const outputPath = flag("-o");
  if (outputPath) await writeFile(outputPath, finalText(), "utf8");
} else if (connector === "claude") {
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-session-1",
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage,
    permission_denials: denials,
    result: finalText(),
    structured_output: structured(),
  })}\n`);
} else if (connector === "grok") {
  process.stdout.write(`${JSON.stringify({
    text: finalText(),
    stopReason: process.env.MOCK_ABNORMAL_STOP === "1" ? "max_tokens" : "end_turn",
    sessionId: "grok-session-1",
    usage,
    num_turns: 2,
    total_cost_usd: 0.0456,
    structuredOutput: structured(),
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    conversation_id: "agy-session-1",
    status: process.env.MOCK_ABNORMAL_STATUS === "1" ? "ERROR" : "SUCCESS",
    response: finalText(),
    duration_seconds: 1.5,
    num_turns: 1,
    usage,
    structured_output: structured(),
  })}\n`);
}

if (process.env.MOCK_EXIT_CODE) process.exitCode = Number(process.env.MOCK_EXIT_CODE);
