import { use, useDeferredValue, useEffect, useState } from "react";
import { type Expr, partsOf } from "vastgrid-spec";
import { LocaleContext } from "./context.js";
import { useGridSelector, useGridStore } from "./hooks.js";

/** How long typing must pause before the search is set. */
const SEARCH_DELAY = 200;

/** The text of the search part of a plan's `where` (§6.2.1). */
function searchOf(where: Expr | undefined): string {
  for (const part of partsOf(where)) if ("search" in part) return part.search;
  return "";
}

/**
 * The toolbar: a search box when the engine searches (§3.5). Its text is React state, which updates as the
 * person types; `search.set` follows through `useDeferredValue` once typing pauses.
 */
export function Toolbar() {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const searches = useGridSelector(
    (snapshot) => snapshot.table !== null && snapshot.table.capabilities.plan?.search !== false,
  );
  const current = useGridSelector((snapshot) => searchOf(snapshot.document.plan?.where));
  const [text, setText] = useState(current);
  const [shown, setShown] = useState(current);
  // A search set elsewhere (an agent, a saved view) replaces the text.
  if (shown !== current) {
    setShown(current);
    setText(current);
  }
  const deferred = useDeferredValue(text);
  useEffect(() => {
    if (deferred === current) return;
    const timer = setTimeout(() => {
      void store.dispatch({ command: "search.set", text: deferred });
    }, SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [store, deferred, current]);
  if (!searches) return null;
  return (
    <div className="vg-toolbar">
      <input
        type="search"
        className="vg-input vg-toolbar__search"
        aria-label={messages.search}
        placeholder={messages.search}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}
