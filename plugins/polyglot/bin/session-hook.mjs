import { repositoryRoot } from "./lib/git.mjs";
import { reapStaleJobs, sessionPath, writeJsonAtomic } from "./lib/jobs.mjs";

// SessionStart records the host transcript path so `handoff` can find the
// conversation without the user pasting a path. SessionEnd reaps jobs whose
// worker died, which is otherwise the only way a RUNNING job stays RUNNING
// forever.
const READ_STDIN_TIMEOUT_MS = 3_000;

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(), READ_STDIN_TIMEOUT_MS);
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const event = process.argv[2] || "SessionStart";

  if (event === "SessionEnd") {
    const reaped = await reapStaleJobs();
    if (reaped.length) {
      process.stderr.write(`polyglot reaped ${reaped.length} stale job(s)\n`);
    }
    return;
  }

  const payload = await readStdinJson();
  const transcriptPath = payload.transcript_path
    || payload.transcriptPath
    || process.env.CLAUDE_TRANSCRIPT_PATH
    || null;
  if (!transcriptPath) return;

  const cwd = payload.cwd || process.cwd();
  await writeJsonAtomic(sessionPath(repositoryRoot(cwd) || cwd), {
    transcriptPath,
    cwd,
    sessionId: payload.session_id || payload.sessionId || null,
    source: payload.source || event,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  process.stderr.write(`polyglot session hook failed: ${error.message}\n`);
});
