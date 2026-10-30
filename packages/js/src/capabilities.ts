/** What the memory engine evaluates and answers (docs/spec.md §4.10). */
import { type Capabilities, FUNCTIONS, MEASURES, planOptions } from "vastgrid-spec";

/** The formats that `export` writes (§8.2), answered as the file's bytes. */
export const EXPORT_FORMATS = Object.freeze(["csv", "tsv", "json", "xlsx"]) as unknown as string[];

/**
 * What the engine evaluates (§4.10): every plan of §4.1, with every function of §4.4 and every measure of §4.5;
 * `summarize`, `find`, `locate` and `export` of CSV, TSV, JSON and xlsx as data.
 */
export const MEMORY_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  plan: Object.freeze({
    derive: true,
    where: true,
    aggregate: true,
    pivot: true,
    having: true,
    sort: true,
    search: true,
  }),
  functions: Object.freeze([...FUNCTIONS]) as unknown as string[],
  measures: Object.freeze([...MEASURES]) as unknown as string[],
  summarize: true,
  find: true,
  locate: true,
  write: false,
  save: false,
  export: Object.freeze({ formats: EXPORT_FORMATS, delivery: "data" as const }),
  preview: false,
  partialViews: false,
  changes: "poll",
});

/** A copy of the capabilities, for a message; tables that the host makes editable are written (§7). */
export function capabilities(write = false): Capabilities {
  return {
    ...MEMORY_CAPABILITIES,
    plan: { ...MEMORY_CAPABILITIES.plan },
    export: { formats: [...EXPORT_FORMATS], delivery: "data" },
    functions: [...FUNCTIONS],
    measures: [...MEASURES],
    write,
  };
}

/** The options that plans are checked with (§4.7). */
export const PLAN_OPTIONS = planOptions(capabilities());
