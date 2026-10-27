/**
 * The grid's tracks in the Performance panel of Chrome's DevTools, next to React's (§9 of react.md):
 * requests, commands and canvas frames, in development builds only. `console.timeStamp` costs little when
 * nothing records.
 */
declare const process: { env: { NODE_ENV?: string } };

/** Whether this is a development build: bundlers replace `process.env.NODE_ENV`, as they do for React. */
function development(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

type Color = "primary" | "secondary" | "tertiary" | "error";

const stamp =
  typeof console !== "undefined" && typeof console.timeStamp === "function" && development()
    ? (console.timeStamp as unknown as (
        label: string,
        start: number,
        end: number,
        track: string,
        group: string,
        color: Color,
      ) => void)
    : null;

/** The time to give `track` as the start of an entry. */
export function now(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

/** Adds an entry from `start` to now to one of the grid's tracks. */
export function track(
  label: string,
  start: number,
  lane: "requests" | "commands" | "canvas",
  color: Color = "primary",
) {
  stamp?.(label, start, now(), lane, "vastgrid", color);
}
