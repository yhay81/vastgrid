const ELLIPSIS = "…";
const MAX_ENTRIES = 20_000;
/** Characters that do not start a line (closing brackets, Japanese punctuation and small kana). */
const NO_START = new Set(
  ")]}>,.!?:;%、。，．・：；？！‼⁇⁈⁉ー〜～）」』】〕〉》｝〙〗〟’”ゝゞヽヾ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ",
);
/** Characters that do not end a line (opening brackets). */
const NO_END = new Set("([{<（「『【〔〈《｛〘〖〝‘“");

/** Whether a UTF-16 code unit belongs to a script written without spaces (CJK, kana, Hangul, full width). */
function isWide(code: number) {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) ||
    // Surrogates of the CJK extensions (U+20000–U+3FFFF).
    (code >= 0xd840 && code <= 0xd8bf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether a line may break between `text[index - 1]` and `text[index]`. */
function canBreak(text: string, index: number) {
  const before = text[index - 1];
  const after = text[index];
  if (before === " " || after === " ") return true;
  if (NO_START.has(after) || NO_END.has(before)) return false;
  const code = text.charCodeAt(index - 1);
  if (isHighSurrogate(code)) return false;
  return isWide(code) || isWide(text.charCodeAt(index));
}

/** Measures and shortens text for one font, caching results because the same strings repeat a lot. */
export class TextFitter {
  private readonly widths = new Map<string, number>();
  private readonly fits = new Map<string, string>();
  private readonly wrapped = new Map<string, readonly string[]>();
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

  /**
   * `text` wrapped onto at most `maxLines` lines of `maxWidth`: lines break at spaces and between CJK
   * characters (not before closing punctuation or after opening brackets), words longer than a line
   * are cut, and "\n" starts a new line. When the text needs more lines, the last one ends with "…".
   */
  lines(text: string, maxWidth: number, maxLines: number): readonly string[] {
    if (maxWidth <= 0 || maxLines < 1) return [];
    const source = text.replace(/\n+$/, "");
    if (source === "") return [];
    const key = `${Math.floor(maxWidth)}\u0001${maxLines}\u0001${source}`;
    const cached = this.wrapped.get(key);
    if (cached !== undefined) return cached;
    const result: string[] = [];
    const paragraphs = source.split("\n");
    // The text the last line was taken from, and whether more text follows it.
    let last = "";
    let cut = false;
    let more = false;
    for (const paragraph of paragraphs) {
      if (result.length === maxLines) {
        more = true;
        break;
      }
      let rest = paragraph;
      do {
        if (result.length === maxLines) {
          more = cut = true;
          break;
        }
        last = rest;
        const end = this.breakAt(rest, maxWidth);
        result.push(rest.slice(0, end).replace(/ +$/, ""));
        rest = rest.slice(end).replace(/^ +/, "");
      } while (rest !== "");
      if (more) break;
    }
    if (more) {
      const index = result.length - 1;
      result[index] = this.fit(cut ? last : `${result[index]}${ELLIPSIS}`, maxWidth);
    }
    if (this.wrapped.size > MAX_ENTRIES) this.wrapped.clear();
    this.wrapped.set(key, result);
    return result;
  }

  /** Length of the first line of `text` (one paragraph) in `maxWidth`, at a place where it may break. */
  private breakAt(text: string, maxWidth: number) {
    if (text === "" || this.width(text) <= maxWidth) return text.length;
    // A character is at least a pixel wide, so a line has at most `maxWidth` characters.
    let low = 0;
    let high = Math.min(text.length, Math.ceil(maxWidth));
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.context.measureText(text.slice(0, middle)).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    for (let index = low; index > 0; index--) if (canBreak(text, index)) return index;
    // No place to break: cut the word, keeping surrogate pairs, and place at least one character.
    let end = Math.max(1, low);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end = end > 1 ? end - 1 : end + 1;
    return end;
  }
}
