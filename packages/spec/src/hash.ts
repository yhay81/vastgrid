/**
 * The normal form and the hash of plans (docs/spec.md §4.8).
 */
import type { Plan } from "./plan.js";

/** The plan without `derive` and `sort` when they are empty; everything else stays as it is. */
export function normalizePlan(plan: Plan): Plan {
  const normal: Plan = {};
  if (plan.derive && plan.derive.length > 0) normal.derive = plan.derive;
  if (plan.where !== undefined) normal.where = plan.where;
  if (plan.aggregate !== undefined) normal.aggregate = plan.aggregate;
  if (plan.having !== undefined) normal.having = plan.having;
  if (plan.sort && plan.sort.length > 0) normal.sort = plan.sort;
  return normal;
}

/** Orders strings by their code points, as the members of the normal form are. */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * JSON with the members of every object sorted by name in code point order and no white space; strings and
 * numbers as `JSON.stringify` writes them. Members whose value is undefined are left out.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON has no numbers that are not finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError(`JSON has no ${typeof value} values.`);
}

/** `sha256:` and the lowercase hex SHA-256 of the plan's normal form in UTF-8. */
export async function planHash(plan: Plan): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(normalizePlan(plan)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
