import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const CONNECTORS = [
  { id: "codex", pluginName: "codex-connector" },
  { id: "grok", pluginName: "grok-connector" },
  { id: "agy", pluginName: "agy-connector" },
  { id: "claude", pluginName: "claude-connector" },
  { id: "qwen", pluginName: "qwen-connector" },
  { id: "opencode", pluginName: "opencode-connector" },
  { id: "copilot", pluginName: "copilot-connector" },
];

const REQUIRED_COMMANDS = [
  "review.md",
  "adversarial-review.md",
  "rescue.md",
  "runs.md",
  "delegate.md",
  "handoff.md",
  "status.md",
  "result.md",
  "cancel.md",
  "setup.md",
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

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    fail(`${relative(root, path)}: missing`);
    return false;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashTree(directory) {
  const hashes = new Map();
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        hashes.set(relative(directory, path).replace(/\\/g, "/"), sha256(await readFile(path)));
      }
    }
  }
  await visit(directory);
  return hashes;
}

// The committed plugin artifacts must already match src/. Validation runs before
// the build in `npm run qa`, so a stale copy fails instead of being silently
// regenerated.
async function checkBuildDrift(pluginRoot, pluginName) {
  const pairs = [
    [join(root, "src", "bridge.mjs"), join(pluginRoot, "bin", "agent-bridge.mjs")],
    [join(root, "src", "session-hook.mjs"), join(pluginRoot, "bin", "session-hook.mjs")],
  ];
  for (const [source, copy] of pairs) {
    try {
      if (sha256(await readFile(source)) !== sha256(await readFile(copy))) {
        fail(`${pluginName}: ${relative(root, copy)} is stale — run npm run build`);
      }
    } catch (error) {
      fail(`${pluginName}: ${error.message}`);
    }
  }
  for (const name of ["lib", "schemas"]) {
    try {
      const expected = await hashTree(join(root, "src", name));
      const actual = await hashTree(join(pluginRoot, "bin", name));
      for (const [file, hash] of expected) {
        if (!actual.has(file)) {
          fail(`${pluginName}: bin/${name}/${file} is missing — run npm run build`);
        } else if (actual.get(file) !== hash) {
          fail(`${pluginName}: bin/${name}/${file} is stale — run npm run build`);
        }
      }
      for (const file of actual.keys()) {
        if (!expected.has(file)) {
          fail(`${pluginName}: bin/${name}/${file} is not produced by src/${name} — run npm run build`);
        }
      }
    } catch (error) {
      fail(`${pluginName}: ${error.message}`);
    }
  }
}

const marketplaces = {
  claude: await json(join(root, ".claude-plugin", "marketplace.json")),
  codex: await json(join(root, "marketplace.json")),
  agents: await json(join(root, ".agents", "plugins", "marketplace.json")),
};
const buildManifest = await json(join(root, "build-manifest.json"));
const expectedVersion = buildManifest.version;
if (!expectedVersion) fail("build-manifest.json: version is missing");

for (const { id, pluginName } of CONNECTORS) {
  const pluginRoot = join(root, "plugins", pluginName);
  const codex = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const agy = await json(join(pluginRoot, "plugin.json"));
  const connector = await json(join(pluginRoot, "connector.json"));

  for (const [host, manifest] of Object.entries({ codex, claude, agy })) {
    if (manifest.name !== pluginName) fail(`${pluginName}: ${host} manifest name mismatch`);
  }
  for (const [host, manifest] of Object.entries({ codex, claude })) {
    if (manifest.version !== expectedVersion) {
      fail(`${pluginName}: ${host} manifest version ${manifest.version} != ${expectedVersion}`);
    }
  }
  if (agy.$schema !== "https://antigravity.google/schemas/v1/plugin.json") {
    fail(`${pluginName}: Antigravity schema is missing`);
  }
  if (!Array.isArray(codex.interface?.defaultPrompt) || codex.interface.defaultPrompt.length > 3) {
    fail(`${pluginName}: invalid Codex defaultPrompt`);
  }
  // Components live in the canonical directories and are auto-discovered.
  // Declaring them as manifest keys replaces the defaults, and
  // `claude plugin validate` rejects a directory path for `agents`.
  for (const key of ["skills", "commands", "agents", "hooks"]) {
    if (claude[key] !== undefined) {
      fail(`${pluginName}: Claude manifest must not declare "${key}" — the default location is used`);
    }
  }

  if (connector.schemaVersion !== 2) fail(`${pluginName}: connector schemaVersion must be 2`);
  if (connector.id !== id) fail(`${pluginName}: connector id mismatch`);
  if (connector.resultAdapter !== id) fail(`${pluginName}: resultAdapter must be "${id}"`);
  if (!connector.authProbe?.args?.length) fail(`${pluginName}: authProbe is missing`);
  if (!connector.helpProbes?.length) fail(`${pluginName}: helpProbes are missing`);
  if (!connector.effortValues?.length) fail(`${pluginName}: effortValues are missing`);
  for (const capability of ["structuredOutput", "model", "effort", "resume", "readOnlyEnforcement"]) {
    if (connector.capabilities?.[capability] === undefined) {
      fail(`${pluginName}: capability "${capability}" is not declared`);
    }
  }
  if (connector.capabilities?.structuredOutput === "none") {
    fail(`${pluginName}: structured output is required for the review contract`);
  }
  for (const group of REQUIRED_INVOCATION_GROUPS) {
    if (!Array.isArray(connector.invocation?.[group])) {
      fail(`${pluginName}: invocation.${group} must be an array`);
    }
  }
  const schemaPlaceholder = connector.capabilities?.structuredOutput === "inline"
    ? "{schemaInline}"
    : "{schemaPath}";
  if (!connector.invocation?.schemaArgs?.some((entry) => entry.includes(schemaPlaceholder))) {
    fail(`${pluginName}: schemaArgs must use ${schemaPlaceholder}`);
  }
  if (connector.capabilities?.finalMessageFile && !connector.invocation?.finalMessageArgs?.length) {
    fail(`${pluginName}: finalMessageFile is declared without finalMessageArgs`);
  }

  await exists(join(pluginRoot, "bin", "agent-bridge.mjs"));
  await exists(join(pluginRoot, "bin", "session-hook.mjs"));
  await exists(join(pluginRoot, "bin", "schemas", "review-output.schema.json"));
  await exists(join(pluginRoot, "skills", `delegate-to-${id}`, "SKILL.md"));
  await exists(join(pluginRoot, "skills", `delegate-to-${id}`, "references", "reporting.md"));
  await exists(join(pluginRoot, "agents", `delegate-to-${id}.md`));
  for (const command of REQUIRED_COMMANDS) {
    await exists(join(pluginRoot, "commands", command));
  }

  // Antigravity reads hooks.json from the plugin root; the other hosts use hooks/.
  const hooks = await json(join(pluginRoot, "hooks", "hooks.json"));
  const rootHooks = await json(join(pluginRoot, "hooks.json"));
  if (JSON.stringify(hooks) !== JSON.stringify(rootHooks)) {
    fail(`${pluginName}: hooks/hooks.json and hooks.json disagree`);
  }
  for (const event of ["SessionStart", "SessionEnd"]) {
    if (!hooks.hooks?.[event]?.length) fail(`${pluginName}: ${event} hook is missing`);
  }
  if (hooks.$schema) fail(`${pluginName}: hooks.json must not declare $schema — Codex rejects it`);

  // Claude rejects a $schema reference in --json-schema, so the shared contract
  // must not carry one.
  const schema = await json(join(pluginRoot, "bin", "schemas", "review-output.schema.json"));
  if (schema.$schema) {
    fail(`${pluginName}: review schema must not declare $schema — claude --json-schema rejects it`);
  }
  for (const required of ["verdict", "summary", "findings", "next_steps"]) {
    if (!schema.required?.includes(required)) {
      fail(`${pluginName}: review schema must require "${required}"`);
    }
  }
  if (!schema.properties?.verdict?.enum?.includes("could-not-review")) {
    fail(`${pluginName}: review schema verdict must allow "could-not-review"`);
  }

  // Every host injects the plugin root; telling the model to guess it is a bug.
  const authored = [
    join(pluginRoot, "skills", `delegate-to-${id}`, "SKILL.md"),
    join(pluginRoot, "agents", `delegate-to-${id}.md`),
    ...REQUIRED_COMMANDS.map((command) => join(pluginRoot, "commands", command)),
  ];
  for (const path of authored) {
    const body = await text(path);
    if (/directories above this|<plugin-root>|parent directory of this/.test(body)) {
      fail(`${relative(root, path)}: instructs the model to guess the plugin root`);
    }
    if (!body.includes("${CLAUDE_PLUGIN_ROOT}")) {
      fail(`${relative(root, path)}: does not reference \${CLAUDE_PLUGIN_ROOT}`);
    }
    if (body.includes("TODO")) fail(`${relative(root, path)}: TODO placeholder found`);
  }
  for (const command of REQUIRED_COMMANDS) {
    const body = await text(join(pluginRoot, "commands", command));
    if (!/^---\r?\n/.test(body)) fail(`${pluginName}/commands/${command}: missing frontmatter`);
    if (!/\ndescription:/.test(body)) fail(`${pluginName}/commands/${command}: missing description`);
    if (!/\nallowed-tools:/.test(body)) fail(`${pluginName}/commands/${command}: missing allowed-tools`);
  }
  const agent = await text(join(pluginRoot, "agents", `delegate-to-${id}.md`));
  if (!/\nname: delegate-to-/.test(agent)) fail(`${pluginName}: agent frontmatter name missing`);
  if (/\n(hooks|mcpServers|permissionMode):/.test(agent)) {
    fail(`${pluginName}: plugin agents may not declare hooks, mcpServers or permissionMode`);
  }

  for (const [host, marketplace] of Object.entries(marketplaces)) {
    const entry = marketplace.plugins?.find((candidate) => candidate.name === pluginName);
    if (!entry) {
      fail(`${pluginName}: missing from the ${host} marketplace`);
      continue;
    }
    if (entry.policy?.authentication !== "ON_USE") {
      fail(`${pluginName}: ${host} marketplace authentication policy must be ON_USE`);
    }
    if (entry.category !== "Developer Tools") {
      fail(`${pluginName}: ${host} marketplace category must be "Developer Tools"`);
    }
    if (entry.version && entry.version !== expectedVersion) {
      fail(`${pluginName}: ${host} marketplace version ${entry.version} != ${expectedVersion}`);
    }
  }

  await checkBuildDrift(pluginRoot, pluginName);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n\n${failures.length} validation failure(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated ${CONNECTORS.length} plugins at ${expectedVersion}: manifests, connector contracts, commands, agents, hooks, review schema, marketplaces and build freshness.\n`,
  );
}
