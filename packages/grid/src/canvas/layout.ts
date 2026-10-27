/** Positions of columns laid out side by side. Lookups are O(1) by index and O(log n) by x. */
export class ColumnLayout {
  /** `offsets[i]` is the left edge of column `i`; `offsets[count]` is the total width. */
  readonly offsets: Float64Array;

  constructor(widths: ArrayLike<number>) {
    this.offsets = new Float64Array(widths.length + 1);
    for (let index = 0; index < widths.length; index++) {
      this.offsets[index + 1] = this.offsets[index] + Math.max(0, widths[index]);
    }
  }

  get count() {
    return this.offsets.length - 1;
  }

  get total() {
    return this.offsets[this.count];
  }

  left(index: number) {
    return this.offsets[index];
  }

  right(index: number) {
    return this.offsets[index + 1];
  }

  width(index: number) {
    return this.offsets[index + 1] - this.offsets[index];
  }

  /** The column containing `x`, clamped to the existing columns. Returns -1 when there are none. */
  indexAt(x: number): number {
    const count = this.count;
    if (count === 0) return -1;
    if (x <= 0) return 0;
    if (x >= this.total) return count - 1;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.offsets[middle] <= x) low = middle;
      else high = middle - 1;
    }
    return low;
  }
}

/** Where a column is frozen: at the left, at the right, or not (`null`, it scrolls). */
export type ColumnPin = "left" | "right" | null;

/**
 * Share of the body's width (without the row header) that frozen columns may take together. Columns
 * frozen beyond it scroll with the others until the grid is wide enough again, so that the scrolling
 * columns always keep some room.
 */
const MAX_FROZEN_SHARE = 0.75;

/**
 * The columns drawn frozen at each side: the first `left` and the last `right` columns of `layout`, fewer
 * when together they are wider than `MAX_FROZEN_SHARE` of `available` (the body's width). Columns frozen
 * at the right give way first, then those at the left, each from the scrolling side. With an unknown
 * width (`available` 0 or less) every frozen column stays frozen.
 */
export function fitFrozen(layout: ColumnLayout, left: number, right: number, available: number) {
  const count = layout.count;
  let fittedLeft = Math.max(0, Math.min(Math.floor(left), count));
  let fittedRight = Math.max(0, Math.min(Math.floor(right), count - fittedLeft));
  if (available > 0) {
    const limit = available * MAX_FROZEN_SHARE;
    const width = () => layout.left(fittedLeft) + layout.total - layout.left(count - fittedRight);
    while (fittedRight > 0 && width() > limit) fittedRight--;
    while (fittedLeft > 0 && width() > limit) fittedLeft--;
  }
  return { left: fittedLeft, right: fittedRight };
}
