/** The JSON Schemas of the package, loaded into one validator so that they refer to each other. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const directory = fileURLToPath(new URL("../schema/", import.meta.url));
const BASE = "https://vastgrid.yhay81.com/schema/v2/";

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
}

/** The problems of a value against a schema, or a definition of one (`state.schema.json#/$defs/session`). */
export function schemaProblems(ref: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${BASE}${ref}`);
  if (!validate) throw new Error(`There is no schema ${ref}.`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`);
}
