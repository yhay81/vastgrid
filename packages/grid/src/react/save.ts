import { useRef, useState, useTransition } from "react";
import { CommandError } from "vastgrid-spec";
import type { GridStore } from "../core/store.js";
import type { GridLocale, GridSave } from "./context.js";

/**
 * Saves the written cells into the engine's file (the `save` command, §7.5 of the specification) as an Action:
 * `useTransition` gives its pending state, and its outcome (the records saved, a file changed by someone else, or
 * why it failed) is shown and announced.
 */
export function useSaveAction(store: GridStore, language: GridLocale, announce: (text: string) => void): GridSave {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<GridSave["outcome"]>(null);
  const running = useRef<Promise<unknown>>(Promise.resolve());
  const save = () => {
    startTransition(async () => {
      const previous = running.current;
      const run = previous.then(() => store.dispatch({ command: "save" }));
      running.current = run;
      const result = await run;
      const { messages, number } = language;
      const table = store.getSnapshot().table;
      const revision = table?.revision ?? null;
      const version = table?.edits.version ?? 0;
      let next: NonNullable<GridSave["outcome"]>;
      if (result.ok) {
        const saved = result.output as { records: number; edits: { version: number } };
        const text = messages.saved(number.format(saved.records));
        next = { text, failed: false, revision, version: saved.edits.version };
      } else if (result.error instanceof CommandError && result.error.reason === "unsupported") {
        next = { text: messages.saveUnsupported, failed: true, revision, version };
      } else if (result.error.code === "file_changed") {
        next = { text: messages.fileChanged, failed: true, revision, version };
      } else {
        next = { text: messages.failed(result.error.message), failed: true, revision, version };
      }
      startTransition(() => setOutcome(next));
      announce(next.text);
    });
  };
  return { save, pending, outcome };
}
