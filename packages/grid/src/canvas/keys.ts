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
 * Enter walk through the selection; the modifier and A selects everything. Delete and Backspace clear the selected
 * cells, F2 edits the active cell, the modifier and Z undoes (with Shift, or Ctrl+Y off Apple platforms,
 * redoes), and the modifier and S saves. Null for other keys: a key that types text starts editing (`typesText`).
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
    case "Delete":
    case "Backspace":
      return primary ? null : { command: "edit.clear" };
    case "F2":
      return { command: "edit.begin" };
    case "z":
    case "Z":
      if (!primary) return null;
      return event.shiftKey ? { command: "history.redo" } : { command: "history.undo" };
    case "y":
    case "Y":
      return primary && !apple ? { command: "history.redo" } : null;
    case "s":
    case "S":
      return primary && !event.shiftKey ? { command: "save" } : null;
    default:
      return null;
  }
}

/** Whether a key types text, a character or the start of an IME composition, which starts editing the cell. */
export function typesText(event: KeyInput & { keyCode?: number; isComposing?: boolean }): boolean {
  if (event.key === "Process" || event.keyCode === 229 || event.isComposing === true) return true;
  // AltGr gives Ctrl+Alt on Windows; Option gives characters on Apple platforms.
  const shortcut = event.metaKey || (event.ctrlKey && !event.altKey);
  return [...event.key].length === 1 && event.key !== " " && !shortcut;
}
