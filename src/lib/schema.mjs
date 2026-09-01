import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILT_IN_SCHEMAS = { review: "review-output.schema.json" };

function schemaDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
}

export function isBuiltInSchema(nameOrPath) {
  return Object.hasOwn(BUILT_IN_SCHEMAS, nameOrPath);
}

export async function loadSchema(nameOrPath) {
  const builtIn = BUILT_IN_SCHEMAS[nameOrPath];
  const path = builtIn ? join(schemaDirectory(), builtIn) : resolve(nameOrPath);
  const raw = await readFile(path, "utf8");
  return { path, schema: JSON.parse(raw), raw };
}

// A dependency-free validator for the JSON Schema subset this project uses.
// Constructs outside the subset are accepted rather than silently rejected.
export function validate(schema, value, pointer = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [`${pointer}: expected an object`];
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${pointer}.${key}: is required`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          errors.push(`${pointer}.${key}: is not an allowed property`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      errors.push(...validate(subSchema, value[key], `${pointer}.${key}`));
    }
    return errors;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${pointer}: expected an array`];
    value.forEach((entry, index) => {
      errors.push(...validate(schema.items, entry, `${pointer}[${index}]`));
    });
    return errors;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") return [`${pointer}: expected a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: must be at least ${schema.minLength} characters`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return [`${pointer}: expected an integer`];
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [`${pointer}: expected a number`];
    }
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    return [`${pointer}: expected a boolean`];
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer}: must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${pointer}: must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${pointer}: must be <= ${schema.maximum}`);
  }
  return errors;
}

const VERDICT_OUTCOMES = {
  approve: { completed: true, attention: false },
  "needs-attention": { completed: true, attention: true },
  "could-not-review": { completed: false, attention: true },
};

// The verdict, not the exit code, decides whether the delegation succeeded.
export function interpretVerdict(structured) {
  const verdict = structured?.verdict;
  if (!verdict || !Object.hasOwn(VERDICT_OUTCOMES, verdict)) return null;
  return { verdict, ...VERDICT_OUTCOMES[verdict] };
}
