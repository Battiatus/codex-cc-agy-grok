import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "polyglot";
const pluginRoot = join(root, "plugins", pluginName);
const failures = [];

const REQUIRED_COMMANDS = [
  "review.md",
  "adversarial-review.md",
  "rescue.md",
  "runs.md",
  "delegate.md",
  "handoff.md",
  "status.md",
  "wait.md",
  "result.md",
  "cancel.md",
  "setup.md",
  "apply.md",
  "discard.md",
  "retry.md",
  "continue.md",
];

const REQUIRED_INVOCATION_GROUPS = [
  "baseArgs",
  "reviewArgs",
  "writeArgs",
  "modelArgs",
  "effortArgs",
  "schemaArgs",
  "promptArgs",
];

function fail(message) {
  failures.push(message);
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${relative(root, path)}: ${error.message}`);
    return {};
  }
}

async function text(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail(`${relative(root, path)}: ${error.message}`);
    return "";
  }
}

const bridgeSource = await text(join(pluginRoot, "bin", "agent-bridge.mjs"));
const bridgeVersion = /const BRIDGE_VERSION = "([^"]+)"/.exec(bridgeSource)?.[1];
if (!bridgeVersion) fail("agent-bridge.mjs: BRIDGE_VERSION not found");

// Manifests: one name and one version across every host.
const manifests = {
  codex: await json(join(pluginRoot, ".codex-plugin", "plugin.json")),
  claude: await json(join(pluginRoot, ".claude-plugin", "plugin.json")),
  agy: await json(join(pluginRoot, "plugin.json")),
};
for (const [host, manifest] of Object.entries(manifests)) {
  if (manifest.name !== pluginName) fail(`${host} manifest name must be "${pluginName}"`);
}
for (const host of ["codex", "claude"]) {
  if (manifests[host].version !== bridgeVersion) {
    fail(`${host} manifest version ${manifests[host].version} != bridge ${bridgeVersion}`);
  }
}
if (manifests.agy.$schema !== "https://antigravity.google/schemas/v1/plugin.json") {
  fail("Antigravity manifest $schema is missing");
}
if (!Array.isArray(manifests.codex.interface?.defaultPrompt) || manifests.codex.interface.defaultPrompt.length > 3) {
  fail("invalid Codex defaultPrompt");
}
// Components live in the canonical directories and are auto-discovered.
// Declaring them as manifest keys replaces the defaults, and
// `claude plugin validate` rejects a directory path for `agents`.
for (const key of ["skills", "commands", "agents", "hooks"]) {
  if (manifests.claude[key] !== undefined) fail(`Claude manifest must not declare "${key}"`);
}

// Provider contracts.
const providerFiles = (await readdir(join(pluginRoot, "bin", "providers"))).filter((name) => name.endsWith(".json"));
if (providerFiles.length === 0) fail("no provider configs in bin/providers");
for (const file of providerFiles) {
  const id = file.slice(0, -".json".length);
  const provider = await json(join(pluginRoot, "bin", "providers", file));
  const label = `providers/${file}`;
  if (provider.id !== id) fail(`${label}: id must be "${id}"`);
  if (!provider.binary) fail(`${label}: binary is missing`);
  if (!provider.resultAdapter) fail(`${label}: resultAdapter is missing`);
  // Not every CLI has an auth status command; without one, setup reports "unknown".
  if (provider.authProbe && !provider.authProbe.args?.length) fail(`${label}: authProbe has no args`);
  if (!provider.helpProbes?.length) fail(`${label}: helpProbes are missing`);
  if (!provider.effortValues?.length) fail(`${label}: effortValues are missing`);
  for (const capability of ["structuredOutput", "model", "effort", "resume", "readOnlyEnforcement"]) {
    if (provider.capabilities?.[capability] === undefined) fail(`${label}: capability "${capability}" is not declared`);
  }
  // "prompt": the CLI has no schema flag, so the contract travels in the prompt
  // and the payload is recovered from the text and validated by the bridge.
  const structuredOutput = provider.capabilities?.structuredOutput;
  if (!["file", "inline", "prompt"].includes(structuredOutput)) {
    fail(`${label}: structuredOutput must be file, inline or prompt for the review contract`);
  }
  for (const group of REQUIRED_INVOCATION_GROUPS) {
    if (!Array.isArray(provider.invocation?.[group])) fail(`${label}: invocation.${group} must be an array`);
  }
  if (structuredOutput !== "prompt") {
    const placeholder = structuredOutput === "inline" ? "{schemaInline}" : "{schemaPath}";
    if (!provider.invocation?.schemaArgs?.some((entry) => entry.includes(placeholder))) {
      fail(`${label}: schemaArgs must use ${placeholder}`);
    }
  }
  if (provider.capabilities?.finalMessageFile && !provider.invocation?.finalMessageArgs?.length) {
    fail(`${label}: finalMessageFile is declared without finalMessageArgs`);
  }
  // A stdin provider must not also receive the prompt as an argument, or a
  // large diff brings back the command-line length limit stdin exists to avoid.
  const promptVia = provider.invocation?.promptVia ?? "arg";
  if (!["stdin", "file", "arg"].includes(promptVia)) fail(`${label}: promptVia must be stdin, file or arg`);
  const argsCarry = (token) => Object.values(provider.invocation || {})
    .some((group) => Array.isArray(group) && group.some((entry) => String(entry).includes(token)));
  if (promptVia !== "arg" && argsCarry("{prompt}")) fail(`${label}: promptVia is ${promptVia} but {prompt} appears in the args`);
  if (promptVia === "arg" && !argsCarry("{prompt}")) fail(`${label}: promptVia is arg but no group carries {prompt}`);
  if (promptVia === "file" && !argsCarry("{promptFile}")) fail(`${label}: promptVia is file but no group carries {promptFile}`);
  if (provider.invocation?.stdinTemplate && !JSON.stringify(provider.invocation.stdinTemplate).includes('"{prompt}"')) {
    fail(`${label}: stdinTemplate must contain a "{prompt}" value`);
  }
}

// Hooks: Claude Code and Codex read hooks/hooks.json. Antigravity reads only the
// root hooks.json, in its own shape ({name: {Event: [spec]}}), runs it from the
// plugin folder without ${CLAUDE_PLUGIN_ROOT}, and has no SessionEnd event.
const hooks = await json(join(pluginRoot, "hooks", "hooks.json"));
for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
  if (!hooks.hooks?.[event]?.length) fail(`hooks/hooks.json: ${event} hook is missing`);
}
if (hooks.$schema) fail("hooks.json must not declare $schema — Codex rejects it");
const agyHooks = Object.values(await json(join(pluginRoot, "hooks.json")));
const agyStart = agyHooks.flatMap((hook) => hook.SessionStart || []);
if (!agyStart.some((spec) => spec.command?.includes("./bin/session-hook.mjs SessionStart"))) {
  fail("hooks.json (Antigravity): SessionStart must run ./bin/session-hook.mjs");
}

// Claude rejects a $schema reference in --json-schema, so the shared contract
// must not carry one.
const schema = await json(join(pluginRoot, "bin", "schemas", "review-output.schema.json"));
if (schema.$schema) fail("review schema must not declare $schema — claude --json-schema rejects it");
for (const required of ["verdict", "summary", "findings", "next_steps"]) {
  if (!schema.required?.includes(required)) fail(`review schema must require "${required}"`);
}
if (!schema.properties?.verdict?.enum?.includes("could-not-review")) {
  fail('review schema verdict must allow "could-not-review"');
}

// Authored markdown: every host injects the plugin root; telling the model to
// guess it is a bug.
const authored = [
  join(pluginRoot, "skills", "delegate", "SKILL.md"),
  join(pluginRoot, "agents", "delegate.md"),
  ...REQUIRED_COMMANDS.map((command) => join(pluginRoot, "commands", command)),
];
for (const path of authored) {
  const body = await text(path);
  if (/directories above this|<plugin-root>|parent directory of this/.test(body)) {
    fail(`${relative(root, path)}: instructs the model to guess the plugin root`);
  }
  if (!body.includes("${CLAUDE_PLUGIN_ROOT}")) fail(`${relative(root, path)}: does not reference \${CLAUDE_PLUGIN_ROOT}`);
  if (body.includes("TODO")) fail(`${relative(root, path)}: TODO placeholder found`);
  if (!/^---\r?\n/.test(body)) fail(`${relative(root, path)}: missing frontmatter`);
  if (!/\ndescription:/.test(body)) fail(`${relative(root, path)}: missing description`);
}
for (const command of REQUIRED_COMMANDS) {
  const body = await text(join(pluginRoot, "commands", command));
  if (!/\nallowed-tools:/.test(body)) fail(`commands/${command}: missing allowed-tools`);
}
const agent = await text(join(pluginRoot, "agents", "delegate.md"));
if (/\n(hooks|mcpServers|permissionMode):/.test(agent)) {
  fail("plugin agents may not declare hooks, mcpServers or permissionMode");
}

// Marketplaces: every catalog lists the plugin at the bridge version.
const marketplaces = {
  claude: await json(join(root, ".claude-plugin", "marketplace.json")),
  codex: await json(join(root, "marketplace.json")),
  agents: await json(join(root, ".agents", "plugins", "marketplace.json")),
};
for (const [host, marketplace] of Object.entries(marketplaces)) {
  const entry = marketplace.plugins?.find((candidate) => candidate.name === pluginName);
  if (!entry) {
    fail(`missing from the ${host} marketplace`);
    continue;
  }
  if (entry.policy?.authentication !== "ON_USE") fail(`${host} marketplace authentication policy must be ON_USE`);
  if (entry.category !== "Developer Tools") fail(`${host} marketplace category must be "Developer Tools"`);
  if (entry.version && entry.version !== bridgeVersion) {
    fail(`${host} marketplace version ${entry.version} != ${bridgeVersion}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n\n${failures.length} validation failure(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated ${pluginName} ${bridgeVersion}: manifests, ${providerFiles.length} provider contracts, commands, agent, hooks, review schema and marketplaces.\n`,
  );
}
