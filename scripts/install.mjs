import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = ["codex-connector", "grok-connector", "agy-connector", "claude-connector", "qwen-connector", "opencode-connector", "copilot-connector"];

function parse(argv) {
  const options = { host: null, plugin: "all", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--host") options.host = argv[++index];
    else if (token === "--plugin") options.plugin = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!options.host) throw new Error("--host codex|claude|grok|agy|qwen|opencode|copilot|all is required");
  return options;
}

function commandsFor(host, selected) {
  if (host === "codex") {
    return [
      ["codex", ["plugin", "marketplace", "add", root]],
      ...selected.map((name) => ["codex", ["plugin", "add", `${name}@polyglot-agent-connectors`]]),
    ];
  }
  if (host === "claude") {
    return [
      ["claude", ["plugin", "marketplace", "add", root]],
      ...selected.map((name) => ["claude", ["plugin", "install", `${name}@polyglot-agent-connectors`]]),
    ];
  }
  if (host === "grok") {
    return selected.map((name) => ["grok", ["plugin", "install", join(root, "plugins", name), "--trust"]]);
  }
  if (host === "agy") {
    return selected.map((name) => ["agy", ["plugin", "install", join(root, "plugins", name), "--trust"]]);
  }
  if (host === "qwen") {
    return selected.map((name) => ["qwen", ["plugin", "install", join(root, "plugins", name), "--trust"]]);
  }
  if (host === "opencode") {
    return selected.map((name) => ["opencode", ["plugin", "install", join(root, "plugins", name), "--trust"]]);
  }
  if (host === "copilot") {
    return selected.map((name) => ["copilot", ["plugin", "install", join(root, "plugins", name), "--trust"]]);
  }
  throw new Error(`Unsupported host: ${host}`);
}

const options = parse(process.argv.slice(2));
const selected = options.plugin === "all" ? plugins : [options.plugin];
for (const name of selected) {
  if (!plugins.includes(name)) throw new Error(`Unknown plugin: ${name}`);
}
const hosts = options.host === "all" ? ["codex", "claude", "grok", "agy", "qwen", "opencode", "copilot"] : [options.host];
const plan = hosts.flatMap((host) => commandsFor(host, selected).map(([command, args]) => ({ host, command, args })));

if (!options.apply) {
  process.stdout.write(`${JSON.stringify({ apply: false, plan }, null, 2)}\n`);
  process.exit(0);
}

for (const step of plan) {
  const result = spawnSync(step.command, step.args, { stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
  if (result.error) {
    console.error(`\nFailed to start command '${step.command}':`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nCommand '${step.command}' exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
