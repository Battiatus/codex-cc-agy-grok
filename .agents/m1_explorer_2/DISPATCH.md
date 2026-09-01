## 2026-08-30T16:35:05Z
You are Milestone 1 Explorer 2 (Bridge Command Router Specialist).
Working directory: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m1_explorer_2

Your task:
1. Read the original request at: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\ORIGINAL_REQUEST.md
2. Read the project scope at: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\PROJECT.md
3. Investigate Milestone 1 (R1: Unified Runs Dashboard & Live Supervision) with focus on:
   - `src/lib/args.mjs`:
     - Adding `"runs"` to `COMMANDS`.
     - Registering any necessary flags for `runs` and `status` (`--tail`, `--all`, etc.).
   - `src/bridge.mjs`:
     - Implementing the `runs` command handler.
     - Enriching the `status` command handler:
       - When inspecting a single `jobId`: load `job.json`, enrich with live status, duration, host PID, model, prompt, and stdout/stderr tail logs.
       - When listing jobs: display the enriched job table.
     - Storing `prompt` string in `createJobRecord` so it is preserved in `job.json`.
4. Produce a detailed implementation plan and code specifications in:
   C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m1_explorer_2\handoff.md
5. Report completion back to the orchestrator via send_message.
