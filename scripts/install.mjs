import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = "polyglot";
const marketplace = "polyglot-agent-connectors";
const HOSTS = ["codex", "claude", "grok", "agy", "qwen", "opencode", "copilot"];
// The 0.3 layout shipped one plugin per provider; polyglot replaces them all.
const LEGACY_PLUGINS = ["codex", "claude", "grok", "agy", "qwen", "opencode", "copilot"]
  .map((id) => `${id}-connector`);

function parse(argv) {
  const options = { host: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--host") options.host = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!options.host) throw new Error(`--host ${HOSTS.join("|")}|all is required`);
  return options;
}

function commandsFor(host) {
  if (host === "codex") {
    return [
      ["codex", ["plugin", "marketplace", "add", root]],
      ["codex", ["plugin", "add", `${plugin}@${marketplace}`]],
    ];
  }
  if (host === "claude") {
    return [
      ...LEGACY_PLUGINS.map((name) => ["claude", ["plugin", "uninstall", `${name}@${marketplace}`], { optional: true }]),
      ["claude", ["plugin", "marketplace", "add", root]],
      ["claude", ["plugin", "install", `${plugin}@${marketplace}`]],
    ];
  }
  if (HOSTS.includes(host)) {
    return [[host, ["plugin", "install", join(root, "plugins", plugin), "--trust"]]];
  }
  throw new Error(`Unsupported host: ${host}`);
}

const options = parse(process.argv.slice(2));
const hosts = options.host === "all" ? HOSTS : [options.host];
const plan = hosts.flatMap((host) => commandsFor(host).map(([command, args, extra]) => ({
  host,
  command,
  args,
  optional: Boolean(extra?.optional),
})));

if (!options.apply) {
  process.stdout.write(`${JSON.stringify({ apply: false, plan }, null, 2)}\n`);
  process.exit(0);
}

// The shell is needed on Windows to reach .cmd shims, and it splits on spaces,
// so a repository path with a space must be quoted.
const shell = process.platform === "win32";
const quote = (arg) => (shell && /\s/.test(arg) ? `"${arg}"` : arg);

for (const step of plan) {
  const result = spawnSync(step.command, step.args.map(quote), { stdio: "inherit", windowsHide: true, shell });
  if (step.optional) continue;
  if (result.error) {
    console.error(`\nFailed to start command '${step.command}':`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nCommand '${step.command}' exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
