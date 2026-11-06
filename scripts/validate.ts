// Validator of the Mission Control data repository, run by repository-db
// before every publish (`validate` in repository-db.yaml) and by CI.
//
// It checks every record against the JSON Schemas in schemas/, which Mission
// Control generates from its Zod schemas; it has no dependencies (Bun parses
// the YAML) and never leaves this checkout or follows a symbolic link. Rules
// across records (references between roadmaps and plans) are checked by the
// App (`bun run validate` in app/v3).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The subset of JSON Schema 2020-12 that the generated schemas use. */
export function check(schema: Schema, value: unknown, at = ""): string[] {
  const here = at || "(record)";
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf ?? [];
    const passing = options.filter((option) => check(option, value, at).length === 0).length;
    if (schema.oneOf ? passing !== 1 : passing === 0) {
      return [`${here}: matches none of the allowed shapes`];
    }
    return [];
  }
  const errors: string[] = [];
  for (const part of schema.allOf ?? []) errors.push(...check(part, value, at));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!ok) return [...errors, `${here}: expected ${types.join(" or ")}, got ${actual}`];
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${here}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${here}: must be one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${here}: must not be empty`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${here}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${here}: must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${here}: must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${here}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...check(schema.items as Schema, item, `${at}/${index}`));
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${at}/${key}: is required`);
    }
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...check(property, item, `${at}/${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}/${key}: is not allowed`);
    }
  }
  return errors;
}

function yamlFiles(root: string, directory: string): string[] {
  const path = join(root, directory);
  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const child = join(directory, name);
    const stat = lstatSync(join(root, child));
    if (stat.isSymbolicLink()) throw new Error(`${child} is a symbolic link; links are refused.`);
    if (stat.isDirectory()) return yamlFiles(root, child);
    return stat.isFile() && /\.ya?ml$/i.test(name) ? [child] : [];
  });
}

export function validateRepository(root: string): string[] {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "schemas", name), "utf8")) as Schema;
  const plan = load("plan.schema.json");
  const roadmap = load("roadmap.schema.json");
  const config = load("config.schema.json");
  const errors: string[] = [];
  const configPath = "data/mission-control/mission-control.config.json";
  try {
    errors.push(
      ...check(config, JSON.parse(readFileSync(join(root, configPath), "utf8"))).map(
        (error) => `${configPath} ${error}`,
      ),
    );
  } catch (error) {
    errors.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [directory, schema, codeKey] of [
    ["data/mission-control/plans", plan, "dev_code"],
    ["data/mission-control/roadmaps", roadmap, "roadmap_code"],
  ] as const) {
    const codes = new Set<string>();
    for (const file of yamlFiles(root, directory)) {
      let value: unknown;
      try {
        value = Bun.YAML.parse(readFileSync(join(root, file), "utf8"));
      } catch (error) {
        errors.push(`${file}: not valid YAML (${error instanceof Error ? error.message : error})`);
        continue;
      }
      errors.push(...check(schema, value).map((error) => `${file} ${error}`));
      const code = (value as Record<string, unknown> | null)?.[codeKey];
      if (typeof code === "string") {
        if (codes.has(code)) errors.push(`${file}: ${code} is used by another record`);
        codes.add(code);
        if (!basename(file).startsWith(code)) {
          errors.push(`${file}: the file name must start with ${code}`);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = validateRepository(process.cwd());
  if (errors.length > 0) {
    console.error(`Mission Control data: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("Mission Control data: OK");
}
