/**
 * The steps that a grid's undo history (§7.4) took anew between two of its sessions: its writes, which the page
 * gives VS Code as edits of the file. An undo moves a step to the redo list and a redo moves it back: neither adds
 * one. The page imports it.
 */
import type { GridSession } from "vastgrid-spec";

type History = GridSession["history"];

export function newSteps(before: History, after: History): number {
  const known = new Set([...(before?.undo ?? []), ...(before?.redo ?? [])]);
  return (after?.undo ?? []).filter((step) => !known.has(step)).length;
}
