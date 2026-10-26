import { createContext } from "react";
import type { GridStore } from "../core/store.js";
import { type GridMessages, messagesFor } from "./messages.js";

/** The store of the nearest `DataGrid` or `GridProvider`. */
export const GridContext = createContext<GridStore | null>(null);

/** The UI's texts and number formats of the nearest `DataGrid`. */
export interface GridLocale {
  messages: GridMessages;
  locale: string | undefined;
  number: Intl.NumberFormat;
}

export const LocaleContext = createContext<GridLocale>({
  messages: messagesFor(undefined),
  locale: undefined,
  number: new Intl.NumberFormat("en"),
});

/** Saving in the nearest `DataGrid` (§6.2 of v2-react.md): an Action, with its pending state and last outcome. */
export interface GridSave {
  /** Saves the written cells (the `save` command); a save asked for while one runs waits for it. */
  save: () => void;
  pending: boolean;
  /** The text of the last save's outcome, and the edits version it is about: shown until the cells change. */
  outcome: { text: string; failed: boolean; version: number } | null;
}

export const SaveContext = createContext<GridSave | null>(null);
