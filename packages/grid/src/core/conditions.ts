/**
 * The conditions of a plan's `where` (§6.2.1 of the specification) as a tree that the conditions menu edits: groups
 * whose items all hold (`and`) or one of which holds (`or`), conditions on one column in the column menu's terms
 * (`ColumnFilter`), and expressions that it does not take apart, kept as they are.
 */
import { type Column, columnsOf, type Expr, type FunctionName, joinParts, partsOf } from "vastgrid-spec";
import { type ColumnFilter, FilterTextError, filterParts, readFilter } from "./filters.js";

export type ConditionNode =
  | { kind: "group"; id: number; op: "and" | "or"; items: ConditionNode[] }
  | { kind: "condition"; id: number; column: string; filter: ColumnFilter & { kind: "condition" } }
  | { kind: "expression"; id: number; expr: Expr };

let nextId = 1;

/** A new id for a node, for React's keys. */
export function nodeId() {
  return nextId++;
}

function nodeOf(expr: Expr): ConditionNode {
  const names = columnsOf(expr);
  if (names.size === 1) {
    const [name] = names;
    const filter = readFilter(partsOf(expr), name);
    if (filter !== null && filter !== "other" && filter.kind === "condition") {
      return { kind: "condition", id: nodeId(), column: name, filter };
    }
  }
  if ("fn" in expr && (expr.fn === "and" || expr.fn === "or")) {
    return { kind: "group", id: nodeId(), op: expr.fn, items: expr.args.map(nodeOf) };
  }
  return { kind: "expression", id: nodeId(), expr };
}

/**
 * The conditions of `where` as a group of its parts that are not the search (`and`); a `where` that is one `or`
 * is that group.
 */
export function readConditions(where: Expr | undefined): ConditionNode & { kind: "group" } {
  const parts = partsOf(where).filter((part) => !("search" in part));
  if (parts.length === 1) {
    const only = nodeOf(parts[0]);
    if (only.kind === "group") return only;
  }
  return { kind: "group", id: nodeId(), op: "and", items: parts.map(nodeOf) };
}

/** A condition that does not compile: the node, and which of its texts. */
export class ConditionError extends Error {
  constructor(
    readonly node: number,
    readonly side: "first" | "second",
  ) {
    super("The text is not a value of the column.");
  }
}

function exprOf(node: ConditionNode, columns: ReadonlyMap<string, Column>): Expr | undefined {
  switch (node.kind) {
    case "expression":
      return node.expr;
    case "condition": {
      const column = columns.get(node.column);
      if (!column) return undefined;
      try {
        return joinParts(filterParts(node.filter, column));
      } catch (error) {
        if (error instanceof FilterTextError) throw new ConditionError(node.id, error.side);
        throw error;
      }
    }
    case "group": {
      const items = node.items.flatMap((item) => exprOf(item, columns) ?? []);
      if (items.length <= 1) return items[0];
      return { fn: node.op as FunctionName, args: items };
    }
  }
}

/**
 * The `where` of `filter.set` for a tree (the search is kept by the command): an `and` group gives its items as
 * parts; conditions without text keep every row and are left out. Text that is not a value of its column throws a
 * `ConditionError`.
 */
export function writeConditions(group: ConditionNode & { kind: "group" }, columns: readonly Column[]): Expr | null {
  const byName = new Map(columns.map((column) => [column.name, column]));
  return exprOf(group, byName) ?? null;
}
