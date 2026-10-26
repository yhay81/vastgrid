/**
 * Migrating v1's `GridState` (version 1) into a v2 document (docs/v2-spec.md §5.6, Appendix A). The
 * document is then repaired for the table (§5.5), which removes what does not validate.
 */
import { checkPlan, valueType } from "./check.js";
import { compileFormula, FormulaError, formulaColumns } from "./formula.js";
import {
  type Aggregate,
  type Derived,
  type Expr,
  type FunctionName,
  type Measure,
  type Plan,
  PlanError,
  type SortKey,
} from "./plan.js";
import { type ColumnSetting, emptyDocument, type GridDocument, StateError } from "./state.js";
import type { Column, JsonValue, LogicalType } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const V1_MEASURES = ["count", "sum", "avg", "min", "max"] as const;
type V1Measure = (typeof V1_MEASURES)[number];

function isV1Measure(value: unknown): value is V1Measure {
  return typeof value === "string" && (V1_MEASURES as readonly string[]).includes(value);
}

const decimalDigits = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const TYPED: readonly LogicalType[] = ["date", "time", "timestamp", "timestamptz", "uuid"];

/** A literal of a v1 value for a column (Appendix A): exact digits stay exact, and dates keep their type. */
function literal(value: unknown, column: Column | undefined): Expr {
  const type = column?.type;
  if (typeof value === "string" && (type === "integer" || type === "bigint" || type === "decimal")) {
    if (decimalDigits.test(value)) return { lit: value, type: value.includes(".") ? "decimal" : "bigint" };
  }
  if (typeof value === "number" && (type === "integer" || type === "bigint" || type === "decimal")) {
    if (Number.isSafeInteger(value)) return { lit: value };
    if (decimalDigits.test(String(value))) return { lit: String(value), type: "decimal" };
  }
  if (typeof value === "string" && type && TYPED.includes(type)) return { lit: value, type };
  if (typeof value === "string" && type === "boolean" && (value === "true" || value === "false")) {
    return { lit: value === "true" };
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { lit: value as JsonValue };
  }
  return { lit: String(value) };
}

function call(fn: FunctionName, ...args: Expr[]): Expr {
  return { fn, args };
}

function notMatching(expr: Expr): Expr {
  return call("not", call("coalesce", expr, { lit: false }));
}

/** v1's text filters (Appendix A). */
const TEXT_FUNCTIONS: Record<string, [FunctionName, boolean]> = {
  contains: ["contains", false],
  notContains: ["contains", true],
  startsWith: ["starts_with", false],
  endsWith: ["ends_with", false],
  equals: ["eq", false],
  notEquals: ["eq", true],
};

const COMPARISONS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;

/** The names of v1's aggregate columns: `count(*)`, `sum(amount)`, and ` (2)`, ` (3)`, … for repeated names. */
function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name} (${n})`;
    used.add(unique);
    return unique;
  });
}

const NOT_MIGRATED = "The column is not in the table, or it is a formula that was not migrated.";

class Migration {
  readonly dropped: string[] = [];
  readonly reasons: Record<string, string> = {};

  drop(path: string, reason: string) {
    this.dropped.push(path);
    this.reasons[path] = reason;
  }

  /** A v1 filter or condition tree as an expression, or null when it is dropped or keeps every row. */
  filter(
    node: unknown,
    path: string,
    names: (index: number) => string | null,
    columns: readonly Column[],
  ): Expr | null {
    if (!isObject(node)) {
      this.drop(path, "This is not a v1 filter.");
      return null;
    }
    if (node.type === "and" || node.type === "or") {
      if (!Array.isArray(node.filters)) {
        this.drop(path, "This is not a v1 filter.");
        return null;
      }
      const parts = node.filters.flatMap(
        (item, index) => this.filter(item, `${path}/filters/${index}`, names, columns) ?? [],
      );
      if (parts.length === 0) return null;
      return parts.length === 1 ? parts[0] : call(node.type, ...parts);
    }
    const name = typeof node.column === "number" ? names(node.column) : null;
    if (name === null) {
      this.drop(path, NOT_MIGRATED);
      return null;
    }
    const column = columns.find((item) => item.name === name);
    const c: Expr = { col: name };
    switch (node.type) {
      case "values": {
        if (!Array.isArray(node.values)) break;
        const values = node.values.filter((value) => value !== null);
        const blank = values.length < node.values.length;
        const parts: Expr[] = [];
        if (values.length > 0) parts.push(call("in", c, ...values.map((value) => literal(value, column))));
        if (blank) parts.push(call("is_blank", c));
        const matching: Expr =
          parts.length === 0 ? { lit: false } : parts.length === 1 ? parts[0] : call("or", ...parts);
        if (node.exclude !== true) return matching;
        return parts.length === 0 ? null : notMatching(matching);
      }
      case "compare":
        if (typeof node.op !== "string" || !(COMPARISONS as readonly string[]).includes(node.op)) break;
        return call(node.op as FunctionName, c, literal(node.value, column));
      case "between": {
        const parts: Expr[] = [];
        if (node.min !== undefined) parts.push(call("ge", c, literal(node.min, column)));
        if (node.max !== undefined) parts.push(call("le", c, literal(node.max, column)));
        if (parts.length === 0) return null;
        return parts.length === 1 ? parts[0] : call("and", ...parts);
      }
      case "text": {
        const text = TEXT_FUNCTIONS[String(node.op)];
        if (!text || typeof node.value !== "string") break;
        const [fn, negated] = text;
        const sensitive = node.caseSensitive === true;
        const value: Expr = { lit: node.value };
        const expr = sensitive
          ? call(fn, call("text", c), value)
          : call(fn, call("lower", call("text", c)), call("lower", value));
        return negated ? notMatching(expr) : expr;
      }
      case "blank":
        return node.blank === false ? call("not", call("is_blank", c)) : call("is_blank", c);
    }
    this.drop(path, "This is not a v1 filter.");
    return null;
  }

  /** v1's `query` as a plan's `where` (search, filters, tree) and `sort`. */
  query(
    query: Record<string, unknown>,
    path: string,
    names: (index: number) => string | null,
    columns: readonly Column[],
    search: boolean,
  ): { where: Expr[]; sort: SortKey[] } {
    const where: Expr[] = [];
    if (typeof query.search === "string" && query.search.trim() !== "") {
      if (search) where.push({ search: query.search });
      else this.drop(`${path}/search`, "A search applies to the table's rows, not to groups.");
    }
    if (Array.isArray(query.filters)) {
      query.filters.forEach((item, index) => {
        const expr = this.filter(item, `${path}/filters/${index}`, names, columns);
        if (expr) where.push(expr);
      });
    }
    if (query.where !== undefined) {
      const expr = this.filter(query.where, `${path}/where`, names, columns);
      if (expr) where.push(...(("fn" in expr && expr.fn === "and" ? expr.args : [expr]) as Expr[]));
    }
    const sort: SortKey[] = [];
    if (Array.isArray(query.sort)) {
      query.sort.forEach((key, index) => {
        const name = isObject(key) && typeof key.column === "number" ? names(key.column) : null;
        if (name === null || !isObject(key) || (key.direction !== "asc" && key.direction !== "desc")) {
          this.drop(`${path}/sort/${index}`, name === null ? NOT_MIGRATED : "This is not a v1 sort key.");
          return;
        }
        sort.push({ column: name, direction: key.direction });
      });
    }
    return { where, sort };
  }

  settings(columns: unknown, path: string, into: ColumnSetting[]) {
    if (!Array.isArray(columns)) return;
    columns.forEach((item, index) => {
      if (!isObject(item) || typeof item.name !== "string") {
        this.drop(`${path}/${index}`, "This is not a v1 column setting.");
        return;
      }
      if (into.some((setting) => setting.name === item.name)) {
        if (path === "/columns") this.drop(`${path}/${index}`, "The column is listed twice.");
        return;
      }
      const setting: ColumnSetting = { name: item.name };
      if (typeof item.width === "number" && Number.isFinite(item.width) && item.width > 0) {
        setting.width = Math.min(100_000, Math.max(1, item.width));
      }
      if (item.hidden === true) setting.hidden = true;
      if (isV1Measure(item.total)) setting.total = { fn: item.total };
      into.push(setting);
    });
  }

  /**
   * v1's formulas as derived columns (§4.11), in an order where each uses only the ones before it: v1's
   * order where it can be. Gives the derived columns and the columns of the rows, and the names of the
   * formulas that were not migrated.
   */
  formulas(value: unknown, table: readonly Column[]): { derive: Derived[]; rows: Column[]; failed: Set<string> } {
    const derive: Derived[] = [];
    const rows = [...table];
    const failed = new Set<string>();
    if (!Array.isArray(value)) return { derive, rows, failed };
    // Reported in the order of v1's formulas.
    const reasons: string[] = [];
    const items = value.map((item, index) => {
      const valid = isObject(item) && typeof item.name === "string" && typeof item.expression === "string";
      if (!valid) reasons[index] = "This is not a v1 formula.";
      return valid ? { index, name: item.name as string, expression: item.expression as string } : null;
    });
    const formulaNames = new Set(items.flatMap((item) => item?.name ?? []));
    const pending = items.flatMap((item) => item ?? []);
    while (pending.length > 0) {
      // The first formula whose formulas are all migrated or dropped; on a cycle, the first one left.
      const ready = pending.findIndex((item) =>
        formulaColumns(item.expression).every(
          (name) => !formulaNames.has(name) || name === item.name || !pending.some((other) => other.name === name),
        ),
      );
      const [item] = pending.splice(Math.max(ready, 0), 1);
      const fail = (reason: string) => {
        failed.add(item.name);
        reasons[item.index] = reason;
      };
      if (ready < 0) {
        fail("The formula uses itself through other formulas.");
        continue;
      }
      if (rows.some((column) => column.name === item.name)) {
        fail(`Another column is named "${item.name}".`);
        continue;
      }
      const missing = formulaColumns(item.expression).find((name) => failed.has(name));
      if (missing !== undefined) {
        fail(`The formula uses "${missing}", which was not migrated.`);
        continue;
      }
      try {
        const { expr, type } = compileFormula(item.expression, rows);
        checkPlan({ derive: [...derive, { name: item.name, expr }] }, table);
        derive.push({ name: item.name, expr });
        rows.push({ name: item.name, ...valueType(type) });
      } catch (error) {
        if (!(error instanceof FormulaError || error instanceof PlanError)) throw error;
        fail(error.message);
      }
    }
    reasons.forEach((reason, index) => {
      this.drop(`/formulas/${index}`, reason);
    });
    return { derive, rows, failed };
  }
}

/**
 * Migrates v1's `GridState` into a document for a table (§5.6). Gives the document and the JSON Pointers,
 * into the v1 state, of what could not be migrated. Throws a `StateError` for a value that is not v1's state.
 */
export function migrateGridState(
  value: unknown,
  table: readonly Column[],
): { document: GridDocument; dropped: string[]; reasons: Record<string, string> } {
  if (!isObject(value)) throw new StateError("", "syntax", "A v1 state is an object.");
  // A plain query, as v1 saved it before states existed, is a state with that query.
  const state =
    value.version === undefined &&
    Object.keys(value).every((key) => ["sort", "filters", "where", "search"].includes(key))
      ? { version: 1, query: value }
      : value;
  if (state.version !== 1) throw new StateError("/version", "version", "This reader migrates version 1.");
  const migration = new Migration();
  const document = emptyDocument();
  const schema =
    Array.isArray(state.schema) && state.schema.every((name) => typeof name === "string")
      ? (state.schema as string[])
      : undefined;
  if (schema) document.schema = schema;
  const { derive, rows, failed: formulas } = migration.formulas(state.formulas, table);
  const v1Formulas = Array.isArray(state.formulas) ? state.formulas : [];
  // Without a schema, v1's views had the table's columns, then the formulas.
  const tableNames = (index: number) => {
    const formula = v1Formulas[index - table.length];
    const name = schema
      ? schema[index]
      : (table[index]?.name ?? (isObject(formula) && typeof formula.name === "string" ? formula.name : undefined));
    return name === undefined || formulas.has(name) ? null : name;
  };
  const plan: Plan = {};
  if (derive.length > 0) plan.derive = derive;
  const group = isObject(state.group) ? state.group : null;
  if (isObject(state.query)) {
    const { where, sort } = migration.query(state.query, "/query", tableNames, rows, true);
    if (where.length > 0) plan.where = where.length === 1 ? where[0] : call("and", ...where);
    if (sort.length > 0) {
      if (group) migration.drop("/query/sort", "With groups, the sort of the groups is migrated.");
      else plan.sort = sort;
    }
  }
  const columns: ColumnSetting[] = [];
  migration.settings(state.columns, "/columns", columns);
  pinColumns(columns, table, state);
  if (group) {
    const keys = Array.isArray(group.keys) ? group.keys.filter((key): key is string => typeof key === "string") : [];
    const aggregates = Array.isArray(group.aggregates) ? group.aggregates : [];
    const used = keys.filter((key) => !formulas.has(key));
    keys.forEach((key, index) => {
      if (formulas.has(key)) migration.drop(`/group/keys/${index}`, NOT_MIGRATED);
    });
    const measures: Measure[] = [];
    const measureNames: string[] = [];
    aggregates.forEach((item, index) => {
      if (!isObject(item) || !isV1Measure(item.fn) || (item.column !== undefined && typeof item.column !== "string")) {
        migration.drop(`/group/aggregates/${index}`, "This is not a v1 aggregate.");
        return;
      }
      const column = item.column as string | undefined;
      if (column !== undefined && formulas.has(column)) {
        migration.drop(`/group/aggregates/${index}`, NOT_MIGRATED);
        return;
      }
      measureNames.push(column === undefined ? `${item.fn}(*)` : `${item.fn}(${column})`);
      measures.push(column === undefined ? { name: "", fn: item.fn } : { name: "", fn: item.fn, column });
    });
    const names = uniqueNames([...used, ...measureNames]).slice(used.length);
    measures.forEach((measure, index) => {
      measure.name = names[index];
    });
    if (used.length > 0 || measures.length > 0) {
      const aggregate: Aggregate = { keys: used, measures };
      if (Array.isArray(group.pivot) && group.pivot.length > 0) {
        const pivot = group.pivot.filter((name): name is string => typeof name === "string" && !formulas.has(name));
        if (pivot.length === group.pivot.length && measures.length > 0) aggregate.pivot = { columns: pivot };
        else migration.drop("/group/pivot", NOT_MIGRATED);
      }
      plan.aggregate = aggregate;
      const inner = isObject(group.state) ? group.state : null;
      if (inner) {
        const innerSchema = Array.isArray(inner.schema) ? (inner.schema as unknown[]) : [];
        const innerNames = (index: number) => {
          const name = innerSchema[index];
          return typeof name === "string" ? name : null;
        };
        let groups: readonly Column[] = [];
        try {
          groups = checkPlan({ derive: plan.derive, where: plan.where, aggregate }, table).columns;
        } catch {
          groups = [];
        }
        if (isObject(inner.query)) {
          const { where, sort } = migration.query(inner.query, "/group/state/query", innerNames, groups, false);
          if (where.length > 0) plan.having = where.length === 1 ? where[0] : call("and", ...where);
          if (sort.length > 0) plan.sort = sort;
        }
        migration.settings(inner.columns, "/group/state/columns", columns);
        for (const member of ["frozenColumns", "frozenRightColumns"]) {
          if (typeof inner[member] === "number" && inner[member] > 0) {
            migration.drop(`/group/state/${member}`, "Frozen columns of groups are not migrated.");
          }
        }
      }
    } else {
      migration.drop("/group", "The groups have no keys or measures left.");
    }
  }
  document.plan = plan;
  if (columns.length > 0) document.columns = columns;
  return { document, dropped: migration.dropped, reasons: migration.reasons };
}

/** `frozenColumns` and `frozenRightColumns` as pins of the first and last shown columns (§5.6). */
function pinColumns(columns: ColumnSetting[], table: readonly Column[], state: Record<string, unknown>) {
  const count = (member: string) => {
    const value = state[member];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const left = count("frozenColumns");
  const right = count("frozenRightColumns");
  if (left === 0 && right === 0) return;
  if (columns.length === 0) {
    // Without columns, v1 froze the table's first and last columns.
    for (const column of table) columns.push({ name: column.name });
  }
  const shown = columns.filter((setting) => !setting.hidden);
  shown.slice(0, Math.min(left, shown.length)).forEach((setting) => {
    setting.pin = "left";
  });
  shown.slice(Math.max(left, shown.length - right)).forEach((setting) => {
    setting.pin = "right";
  });
}
