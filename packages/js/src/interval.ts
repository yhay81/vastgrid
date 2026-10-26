/**
 * Intervals in the order of docs/v2-spec.md §3.1, as DuckDB 1.5 compares them.
 */
import { parseIntervalText } from "vastgrid-spec";

const NANOS_PER_DAY = 86_400_000_000_000n;

/**
 * The parts of an interval as DuckDB 1.5 compares them: whole days of the nanoseconds go into the days, then
 * whole 30-day months of the days into the months, each by a division that truncates toward zero. Intervals
 * compare by these months, then days, then nanoseconds; `1 month` equals `30 days`, and `1 month -1 day` is
 * greater than `29 days`. Null when the text is not an interval.
 */
export function normalizeInterval(text: string): [bigint, bigint, bigint] | null {
  const parts = parseIntervalText(text);
  if (!parts) return null;
  const days = BigInt(parts.days) + parts.nanos / NANOS_PER_DAY;
  return [BigInt(parts.months) + days / 30n, days % 30n, parts.nanos % NANOS_PER_DAY];
}
