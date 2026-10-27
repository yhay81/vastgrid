/** The commands of the plan (docs/spec.md §6.2): sort keys, filters, search, derived columns and groups. */
import { checkPlan } from "../check.js";
import type { Expr, Plan, Search, SortKey } from "../plan.js";
import { columnsOf, joinParts, partsOf } from "../state.js";
import { isObject, trimSpaces } from "../values.js";
import {
  booleanArgument,
  type Command,
  expressionArgument,
  fail,
  optionalString,
  stringArgument,
  takes,
} from "./command.js";
import type { Handlers } from "./run.js";

export function isSearch(expr: Expr): expr is Search {
  return "search" in expr;
}

function renameExpr(expr: Expr, from: string, to: string): Expr {
  if ("col" in expr) return expr.col === from ? { col: to } : expr;
  if ("fn" in expr) return { fn: expr.fn, args: expr.args.map((arg) => renameExpr(arg, from, to)) };
  return expr;
}

function wherePartsArgument(command: Command, column?: string): Expr[] {
  const where = expressionArgument(command, "where");
  const parts = partsOf(where ?? undefined);
  for (const part of parts) {
    if (isSearch(part)) fail("/where", "syntax", "Conditions hold no search: search.set sets it.");
    if (column !== undefined) {
      const names = columnsOf(part);
      if (names.size !== 1 || !names.has(column)) {
        fail("/where", "syntax", `The conditions of "${column}" use that column and no other.`);
      }
    }
  }
  return parts;
}

export const PLAN_HANDLERS = {
  "sort.set"(run, command) {
    takes(command, ["keys"]);
    if (!Array.isArray(command.keys)) fail("/keys", "syntax", "keys is a list of sort keys.");
    run.setPlan({ ...run.draft(), sort: command.keys as SortKey[] });
  },

  "sort.toggle"(run, command) {
    takes(command, ["column", "add"]);
    const column = run.viewName(command, "column");
    const add = booleanArgument(command, "add");
    const plan = run.draft();
    const sort = plan.sort ?? [];
    const at = sort.findIndex((key) => key.column === column);
    const current = at >= 0 ? sort[at].direction : null;
    if (!add) {
      plan.sort =
        current === "asc" ? [{ column, direction: "desc" }] : current === "desc" ? [] : [{ column, direction: "asc" }];
    } else if (current === "asc") {
      sort[at] = { column, direction: "desc" };
      plan.sort = sort;
    } else if (current === "desc") {
      sort.splice(at, 1);
      plan.sort = sort;
    } else {
      plan.sort = [...sort, { column, direction: "asc" }];
    }
    run.setPlan(plan);
  },

  "sort.clear"(run, command) {
    takes(command, []);
    const { sort: _sort, ...plan } = run.draft();
    run.setPlan(plan);
  },

  "filter.set"(run, command) {
    takes(command, ["where"]);
    const parts = wherePartsArgument(command);
    const plan = run.draft();
    plan.where = joinParts([...partsOf(plan.where).filter(isSearch), ...parts]);
    run.setPlan(plan);
  },

  "filter.column"(run, command) {
    takes(command, ["column", "where"]);
    const column = stringArgument(command, "column");
    const rows = [...run.context.table.map((item) => item.name), ...(run.plan.derive ?? []).map((item) => item.name)];
    if (!rows.includes(column)) fail("/column", "unknown_column", `The rows have no column "${column}".`);
    const parts = wherePartsArgument(command, column);
    const plan = run.draft();
    const current = partsOf(plan.where);
    const ofColumn = (part: Expr) => {
      const names = columnsOf(part);
      return !isSearch(part) && names.size === 1 && names.has(column);
    };
    const first = current.findIndex(ofColumn);
    const kept = current.filter((part) => !ofColumn(part));
    // The parts before the first condition of the column are kept, so it is also its place among them.
    kept.splice(first < 0 ? kept.length : first, 0, ...parts);
    plan.where = joinParts(kept);
    run.setPlan(plan);
  },

  "filter.clear"(run, command) {
    takes(command, []);
    const plan = run.draft();
    plan.where = joinParts(partsOf(plan.where).filter(isSearch));
    run.setPlan(plan);
  },

  "search.set"(run, command) {
    takes(command, ["text"]);
    const text = stringArgument(command, "text");
    const plan = run.draft();
    const conditions = partsOf(plan.where).filter((part) => !isSearch(part));
    plan.where = joinParts(trimSpaces(text) === "" ? conditions : [{ search: text }, ...conditions]);
    run.setPlan(plan);
  },

  "derive.add"(run, command) {
    takes(command, ["name", "expr", "before"]);
    const name = stringArgument(command, "name");
    const expr = expressionArgument(command, "expr");
    if (expr === null) fail("/expr", "syntax", "expr is an expression (§4.3).");
    const before = optionalString(command, "before");
    const plan = run.draft();
    const derive = plan.derive ?? [];
    const at = before === undefined ? derive.length : run.derivedIndex("before", before);
    derive.splice(at, 0, { name, expr });
    plan.derive = derive;
    run.setPlan(plan);
  },

  "derive.update"(run, command) {
    takes(command, ["name", "expr", "rename"]);
    const name = stringArgument(command, "name");
    const index = run.derivedIndex("name", name);
    let expr: Expr | undefined;
    if (command.expr !== undefined) {
      const value = expressionArgument(command, "expr");
      if (value === null) fail("/expr", "syntax", "expr is an expression (§4.3).");
      expr = value;
    }
    const rename = optionalString(command, "rename");
    const plan = run.draft();
    const derive = plan.derive ?? [];
    if (expr !== undefined) derive[index] = { name, expr };
    if (rename === undefined || rename === name) {
      run.setPlan(plan);
      return;
    }
    const aggregate = plan.aggregate;
    const keyed = aggregate?.keys.includes(name) ?? false;
    // `{ col }` in having, sort keys of an aggregated view and styles name the view's columns.
    const viewScope = aggregate === undefined || keyed;
    plan.derive = derive.map((item) => ({
      name: item.name === name ? rename : item.name,
      expr: renameExpr(item.expr, name, rename),
    }));
    if (plan.where) plan.where = renameExpr(plan.where, name, rename);
    if (aggregate) {
      plan.aggregate = {
        ...aggregate,
        keys: aggregate.keys.map((key) => (key === name ? rename : key)),
        measures: aggregate.measures.map((measure) =>
          measure.column === name ? { ...measure, column: rename } : measure,
        ),
      };
      if (aggregate.pivot) {
        plan.aggregate.pivot = {
          ...aggregate.pivot,
          columns: aggregate.pivot.columns.map((column) => (column === name ? rename : column)),
        };
      }
      if (keyed && plan.having) plan.having = renameExpr(plan.having, name, rename);
    }
    if (plan.sort && viewScope) {
      plan.sort = plan.sort.map((key) => (key.column === name ? { ...key, column: rename } : key));
    }
    run.setPlan(plan);
    if (run.document.columns) {
      const ownSetting = viewScope || !run.viewColumn(name);
      run.document.columns = run.document.columns
        .filter((setting) => !(ownSetting && setting.name === rename))
        .map((setting) => {
          const next = ownSetting && setting.name === name ? { ...setting, name: rename } : setting;
          if (!viewScope || !next.format?.styles) return next;
          return {
            ...next,
            format: {
              ...next.format,
              styles: next.format.styles.map((rule) => ({ ...rule, when: renameExpr(rule.when, name, rename) })),
            },
          };
        });
    }
    const session = run.session;
    if (session.checked?.where) run.own("checked").where = renameExpr(session.checked.where, name, rename);
    if (viewScope) {
      for (const member of ["active", "anchor", "focus", "editor"] as const) {
        if (session[member]?.column === name) run.own(member).column = rename;
      }
      if (session.scroll?.column === name) run.own("scroll").column = rename;
      if (session.selection) {
        for (const range of run.own("selection")) {
          if (range.columns !== "all")
            range.columns = range.columns.map((column) => (column === name ? rename : column));
        }
      }
    }
  },

  "derive.remove"(run, command) {
    takes(command, ["name"]);
    const name = stringArgument(command, "name");
    run.derivedIndex("name", name);
    const plan = run.draft();
    const removed = new Set([name]);
    for (const item of plan.derive ?? []) {
      if ([...columnsOf(item.expr)].some((column) => removed.has(column))) removed.add(item.name);
    }
    const uses = (expr: Expr) => [...columnsOf(expr)].some((column) => removed.has(column));
    plan.derive = (plan.derive ?? []).filter((item) => !removed.has(item.name));
    plan.where = joinParts(partsOf(plan.where).filter((part) => !uses(part)));
    if (plan.aggregate) {
      const { keys, measures, pivot } = plan.aggregate;
      plan.aggregate = {
        keys: keys.filter((key) => !removed.has(key)),
        measures: measures.filter((measure) => measure.column === undefined || !removed.has(measure.column)),
      };
      if (pivot && !pivot.columns.some((column) => removed.has(column))) plan.aggregate.pivot = pivot;
      if (plan.aggregate.keys.length === 0 && plan.aggregate.measures.length === 0) {
        delete plan.aggregate;
        delete plan.having;
      }
    }
    run.setPlan(run.keepValid(plan));
    if (run.document.columns) {
      const view = new Set(checkPlan(run.plan, run.context.table).columns.map((column) => column.name));
      run.document.columns = run.document.columns.filter(
        (setting) => !removed.has(setting.name) || view.has(setting.name),
      );
    }
  },

  "group.set"(run, command) {
    takes(command, ["aggregate"]);
    if (!isObject(command.aggregate)) fail("/aggregate", "syntax", "aggregate is an object (§4.1).");
    const { having, sort, ...plan } = run.draft();
    plan.aggregate = command.aggregate as unknown as Plan["aggregate"];
    run.checkPlan(plan);
    run.setPlan(run.keepValid({ ...plan, having, sort }));
  },

  "group.clear"(run, command) {
    takes(command, []);
    const { aggregate: _aggregate, having: _having, ...plan } = run.draft();
    run.setPlan(run.keepValid(plan));
  },

  "having.set"(run, command) {
    takes(command, ["having"]);
    const having = expressionArgument(command, "having");
    const plan = run.draft();
    if (having === null) delete plan.having;
    else plan.having = having;
    run.setPlan(plan);
  },
} satisfies Handlers;
