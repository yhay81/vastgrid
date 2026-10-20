const ELLIPSIS = "…";
const MAX_ENTRIES = 20_000;

/** Measures and shortens text for one font, caching results because the same strings repeat a lot. */
export class TextFitter {
  private readonly widths = new Map<string, number>();
  private readonly fits = new Map<string, string>();
  private ellipsisWidth = -1;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    readonly font: string,
  ) {}

  /** Width of `text`. The caller must have set `context.font` to this fitter's font. */
  width(text: string): number {
    let width = this.widths.get(text);
    if (width === undefined) {
      width = this.context.measureText(text).width;
      if (this.widths.size > MAX_ENTRIES) this.widths.clear();
      this.widths.set(text, width);
    }
    return width;
  }

  /** `text`, shortened with "…" to fit in `maxWidth`. */
  fit(text: string, maxWidth: number): string {
    if (maxWidth <= 0 || text === "") return "";
    // Cells never show more than a few hundred characters; skip measuring the rest.
    const source = text.length > 400 ? text.slice(0, 400) : text;
    if (source === text && this.width(text) <= maxWidth) return text;
    const key = `${Math.floor(maxWidth)}\u0001${source}`;
    const cached = this.fits.get(key);
    if (cached !== undefined) return cached;
    if (this.ellipsisWidth < 0) this.ellipsisWidth = this.context.measureText(ELLIPSIS).width;
    let result = "";
    if (this.ellipsisWidth <= maxWidth) {
      const full = this.context.measureText(source).width;
      let low = 0;
      let high = Math.min(source.length, Math.ceil((source.length * maxWidth) / Math.max(1, full)) + 4);
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (this.context.measureText(source.slice(0, middle)).width + this.ellipsisWidth <= maxWidth) low = middle;
        else high = middle - 1;
      }
      // Do not split a surrogate pair.
      const code = source.charCodeAt(low - 1);
      if (low > 0 && code >= 0xd800 && code <= 0xdbff) low--;
      result = `${source.slice(0, low)}${ELLIPSIS}`;
    }
    if (this.fits.size > MAX_ENTRIES) this.fits.clear();
    this.fits.set(key, result);
    return result;
  }
}
