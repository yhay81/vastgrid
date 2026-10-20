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
