import { canonicalJson, type Plan } from "vastgrid-spec";
import { measuresPlan, totalMeasures } from "./measures.js";
import type { View } from "./rows.js";
import type { GridSnapshot } from "./types.js";

type Totals = NonNullable<GridSnapshot["totals"]>;

/**
 * The totals row of the view on screen (§5.1): read again when the view, its edits or the totals change, with
 * `measure`, and shown with `show`. The totals on screen stay until the new ones come.
 */
export class TotalsReader {
  /** The revision, edits and plan of the totals read last; empty without them, null to read them again. */
  private key: string | null = "";
  private abort: AbortController | null = null;

  constructor(
    private readonly measure: (plan: Plan, revision: string | null, signal: AbortSignal) => Promise<Totals>,
    private readonly show: (totals: Totals | null) => void,
  ) {}

  /** Reads the totals row again at the next `follow`, even if nothing it follows changed. */
  reset() {
    this.key = null;
  }

  /** Reads the totals row again if the view on screen, its edits or the totals changed. */
  follow(view: View | null, snapshot: GridSnapshot) {
    const measures = totalMeasures(snapshot.displayed);
    // A view that is being made is totalled once it is ready.
    if (view && measures.length > 0 && snapshot.view?.status !== "ready") return;
    const plan = view && measures.length > 0 ? measuresPlan(view.plan, measures) : null;
    const key = view && plan ? `${view.revision}\u0000${view.edits}\u0000${canonicalJson(plan)}` : "";
    if (key === this.key) return;
    this.key = key;
    this.abort?.abort();
    this.abort = null;
    if (!view || !plan) {
      if (snapshot.totals) this.show(null);
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.measure(plan, view.revision, abort.signal)
      .then((totals) => {
        if (!abort.signal.aborted) this.show(totals);
      })
      .catch(() => {});
  }
}
