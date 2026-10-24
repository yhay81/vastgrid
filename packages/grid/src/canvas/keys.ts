import type { GridCommand } from "vastgrid-spec";

/** The members of a keyboard event that the grid reads. */
export interface KeyInput {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Whether the platform's primary modifier is ⌘ (Apple platforms) rather than Ctrl. */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /mac|iphone|ipad|ipod/i.test(platform ?? navigator.platform ?? "");
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * The command of a key on the grid (§6.4 of the specification, the grid pattern of the ARIA Authoring
 * Practices): arrows move, with Shift extend and with the primary modifier jump to the end; Page Up and Page
 * Down move by a page; Home and End go to the first and last column (with the modifier, also row); Tab and
 * Enter walk through the selection; the modifier and A selects everything. Null for other keys.
 */
export function keyCommand(event: KeyInput, apple: boolean): GridCommand | null {
  const primary = apple ? event.metaKey : event.ctrlKey;
  if (event.altKey) return null;
  const flags = (extend: boolean, jump: boolean) => ({
    ...(extend ? { extend: true } : {}),
    ...(jump ? { jump: true } : {}),
  });
  const direction = ARROWS[event.key];
  if (direction) return { command: "move", direction, ...flags(event.shiftKey, primary) };
  switch (event.key) {
    case "PageUp":
    case "PageDown":
      return {
        command: "move",
        direction: event.key === "PageUp" ? "up" : "down",
        page: true,
        ...flags(event.shiftKey, false),
      };
    case "Home":
      return { command: "move.home", ...flags(event.shiftKey, primary) };
    case "End":
      return { command: "move.end", ...flags(event.shiftKey, primary) };
    case "Tab":
      return primary ? null : { command: "advance", axis: "column", ...(event.shiftKey ? { back: true } : {}) };
    case "Enter":
      return primary ? null : { command: "advance", axis: "row", ...(event.shiftKey ? { back: true } : {}) };
    case "a":
    case "A":
      return primary && !event.shiftKey ? { command: "select.all" } : null;
    default:
      return null;
  }
}
