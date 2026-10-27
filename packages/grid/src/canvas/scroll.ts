/**
 * Browsers cap the size of an element (about 16.7M px in Chromium, 17.9M px in Firefox, 33.5M px
 * in Safari). With 24 px rows that is well under a million rows, so a native scrollbar cannot
 * cover the content of a large table. `ScrollAxis` maps a native scroll position, kept below
 * `maxNative`, onto a much larger virtual position:
 *
 * - Small movements (wheel, trackpad, arrow keys) move the virtual position by the same amount, so
 *   scrolling feels exactly like a normal page at any depth.
 * - Large jumps (dragging the thumb, clicking the track) and the two ends map proportionally, so the
 *   scrollbar still tells where you are and reaches the first and the last row.
 *
 * Content smaller than `maxNative` is never scaled.
 */
const MAX_NATIVE_SCROLL = 8_000_000;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export class ScrollAxis {
  private contentSize = 0;
  private viewportSize = 0;
  private nativeSize = 0;
  private virtual = 0;
  private lastNative = 0;
  private expectedNative: number | null = null;
  private expectedVirtual = 0;

  constructor(private readonly maxNative = MAX_NATIVE_SCROLL) {}

  /** Updates the sizes and returns the size to give the native scroll content. */
  resize(contentSize: number, viewportSize: number): number {
    this.contentSize = Math.max(0, contentSize);
    this.viewportSize = Math.max(0, viewportSize);
    this.nativeSize = Math.min(this.contentSize, this.maxNative);
    this.virtual = clamp(this.virtual, 0, this.virtualRange);
    return this.nativeSize;
  }

  /** Whether the native position is mapped (the content is larger than `maxNative`). */
  get scaled() {
    return this.contentSize > this.maxNative;
  }

  get virtualRange() {
    return Math.max(0, this.contentSize - this.viewportSize);
  }

  get nativeRange() {
    return Math.max(0, this.nativeSize - this.viewportSize);
  }

  /** The current virtual position. */
  get position() {
    return this.virtual;
  }

  /** The native position that corresponds to the current state. */
  get native() {
    return this.lastNative;
  }

  private jumpThreshold() {
    return Math.max(this.viewportSize * 2, 1000);
  }

  /** Handles a native scroll event and returns the new virtual position. */
  onNativeScroll(nativePosition: number): number {
    const nativeRange = this.nativeRange;
    const native = clamp(nativePosition, 0, nativeRange);
    if (this.expectedNative !== null && Math.abs(native - this.expectedNative) <= 1) {
      // The event caused by `scrollTo`. Browsers may round the position, so keep the requested one.
      this.expectedNative = null;
      this.lastNative = native;
      this.virtual = this.expectedVirtual;
      return this.virtual;
    }
    this.expectedNative = null;
    if (!this.scaled) {
      this.lastNative = native;
      this.virtual = native;
      return native;
    }
    const delta = native - this.lastNative;
    this.lastNative = native;
    const virtualRange = this.virtualRange;
    if (native <= 0) this.virtual = 0;
    else if (native >= nativeRange) this.virtual = virtualRange;
    else if (Math.abs(delta) > this.jumpThreshold()) this.virtual = (native / nativeRange) * virtualRange;
    else this.virtual = clamp(this.virtual + delta, 0, virtualRange);
    return this.virtual;
  }

  /**
   * Moves to a virtual position and returns the native position to assign to the scroll element.
   * Nearby targets move the native position by the same amount, so a following wheel scroll
   * continues smoothly; distant targets map proportionally.
   */
  scrollTo(target: number): number {
    const virtualRange = this.virtualRange;
    const virtual = clamp(target, 0, virtualRange);
    let native: number;
    if (!this.scaled) {
      native = virtual;
    } else {
      const nativeRange = this.nativeRange;
      const delta = virtual - this.virtual;
      const local = this.lastNative + delta;
      if (virtual === 0) native = 0;
      else if (virtual === virtualRange) native = nativeRange;
      else if (Math.abs(delta) <= this.jumpThreshold() && local > 0 && local < nativeRange) native = local;
      else native = virtualRange === 0 ? 0 : (virtual / virtualRange) * nativeRange;
    }
    this.virtual = virtual;
    this.expectedVirtual = virtual;
    this.expectedNative = native;
    this.lastNative = native;
    return native;
  }
}
