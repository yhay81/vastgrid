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
