/**
 * Checked rows (§5.2.1 of the specification) as the grid shows them: whether a row of the view is checked, not
 * checked or unknown, and how many rows of the view are checked.
 */
import { type Checked, canonicalJson, keyText, type Plan, partsOf, type RowKey } from "vastgrid-spec";

export type CheckState = "checked" | "unchecked" | "unknown";

/** Whether the view's `where` implies the `where` of checked rows, so that every row of it is known (§5.2.1). */
function coversView(checked: Checked | undefined, plan: Plan | undefined): boolean {
  if (!checked || checked.mode === "include" || checked.where === undefined) return true;
  const view = partsOf(plan?.where).map((part) => ({ part, json: canonicalJson(part) }));
  return partsOf(checked.where).every((part) => {
    const json = canonicalJson(part);
    return view.some(
      (item) =>
        item.json === json || ("search" in part && "search" in item.part && item.part.search.includes(part.search)),
    );
  });
}

const keySets = new WeakMap<Checked, Set<string>>();

/** The keys of checked rows by their text (`keyText`, which is the same for the same keys, §5.3), made once. */
function keysOf(checked: Checked): Set<string> {
  let set = keySets.get(checked);
  if (!set) {
    set = new Set(checked.keys.map(keyText));
    keySets.set(checked, set);
  }
  return set;
}

/** Whether a row of the view, by its key, is checked. */
export function checkState(checked: Checked | undefined, plan: Plan | undefined, key: RowKey): CheckState {
  if (!checked) return "unchecked";
  const listed = keysOf(checked).has(keyText(key));
  if (checked.mode === "include") return listed ? "checked" : "unchecked";
  if (!coversView(checked, plan)) return "unknown";
  return listed ? "unchecked" : "checked";
}

/**
 * How many rows of the view are checked, or null when it is not known: rows of `exclude` that the view does not
 * cover, and keys of `include` and `exclude` that are not rows of the view (filtered out) are counted as if they
 * were, so the count is exact when every key is a row of the view.
 */
export function checkedCount(checked: Checked | undefined, plan: Plan | undefined, rowCount: number): number | null {
  if (!checked) return 0;
  if (checked.mode === "include") return checked.keys.length;
  if (!coversView(checked, plan)) return null;
  return Math.max(0, rowCount - checked.keys.length);
}

/**
 * The state of the header's check box: every row of the view checked (`exclude` without keys, covering the view),
 * none, some, or unknown. Keys of `include` may be rows of other views, so they make "some", never "all".
 */
export function allState(checked: Checked | undefined, plan: Plan | undefined, rowCount: number) {
  if (!checked || (checked.mode === "include" && checked.keys.length === 0)) return "none";
  if (checked.mode === "include") return "some";
  if (!coversView(checked, plan)) return "unknown";
  return checked.keys.length === 0 ? "all" : checked.keys.length >= rowCount ? "none" : "some";
}
