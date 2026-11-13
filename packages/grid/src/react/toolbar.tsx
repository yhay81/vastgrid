import { lazy, use, useDeferredValue, useEffect, useState, useTransition } from "react";
import { type Expr, type Fold, type GridCommand, partsOf, type Search } from "vastgrid-spec";
import { isApple } from "../canvas/keys.js";
import { offers } from "../core/measures.js";
import { LocaleContext, SaveContext } from "./context.js";
import { ExportMenu } from "./export-menu.js";
import { useGridSelector, useGridStore } from "./hooks.js";
import { ToolbarPopover } from "./toolbar-popover.js";

// The menus load when they first open (§10 of react.md).
const ConditionsPanel = lazy(() => import("./conditions-menu.js"));
const ColumnsPanel = lazy(() => import("./columns-menu.js"));
const GroupPanel = lazy(() => import("./group-menu.js"));
const FormulaPanel = lazy(() => import("./formula-menu.js"));

/** How long typing must pause before the search is set. */
const SEARCH_DELAY = 200;

/** The search part of a plan's `where` (§6.2.1). */
function searchPartOf(where: Expr | undefined): Search | undefined {
  for (const part of partsOf(where)) if ("search" in part) return part;
  return undefined;
}

/** The folds of the search box's switch (§3.5 of the specification). */
const FOLDS: Fold[] = ["width", "kana"];

/** `search.set` with the text of the box, folding width and kana when the switch is on. */
function searchSet(text: string, fold: boolean): GridCommand {
  return fold ? { command: "search.set", text, fold: FOLDS } : { command: "search.set", text };
}

/**
 * The toolbar: a search box when the engine searches (§3.5), the conditions menu when it filters (§6.2.1), the
 * columns menu (§6.3), the group menu when it groups rows (§4.5), the formula
 * menu when it derives columns (§4.11), a
 * button that saves the written cells when the engine saves (§7.5), and one that reads the file again when it
 * changed on disk while cells were written (§7.6). The
 * search's text is React state, which updates as the person types; `search.set` follows through
 * `useDeferredValue` once typing pauses. A switch beside the box folds width and kana in the search.
 */
export function Toolbar({ announce }: { announce: (text: string) => void }) {
  const store = useGridStore();
  const { messages } = use(LocaleContext);
  const fileChanged = useGridSelector((snapshot) => snapshot.table?.fileChanged === true);
  const [reloading, startReload] = useTransition();
  const reload = () =>
    startReload(async () => {
      try {
        await store.reload();
      } catch (error) {
        announce(messages.failed(error instanceof Error ? error.message : String(error)));
      }
    });
  const searches = useGridSelector(
    (snapshot) => snapshot.table !== null && snapshot.table.capabilities.plan?.search !== false,
  );
  const saving = use(SaveContext);
  const saves = useGridSelector((snapshot) => snapshot.table?.capabilities.save === true);
  const unsaved = useGridSelector((snapshot) => snapshot.table?.edits.cells ?? 0);
  const current = useGridSelector((snapshot) => searchPartOf(snapshot.document.plan?.where)?.search ?? "");
  const currentFolds = useGridSelector(
    (snapshot) => (searchPartOf(snapshot.document.plan?.where)?.fold?.length ?? 0) > 0,
  );
  const [text, setText] = useState(current);
  const [folds, setFolds] = useState(currentFolds);
  const [shown, setShown] = useState(current);
  const [shownFolds, setShownFolds] = useState(currentFolds);
  const [sent, setSent] = useState<{ text: string; folds: boolean } | null>(null);
  // A search set elsewhere (an agent, a saved view) replaces the text, and the switch when it has text.
  if (shown !== current || shownFolds !== currentFolds) {
    const ownEcho = sent !== null && sent.text === current && (current === "" || sent.folds === currentFolds);
    setShown(current);
    setShownFolds(currentFolds);
    setSent(null);
    if (!ownEcho) {
      setText(current);
      if (current !== "") setFolds(currentFolds);
    }
  }
  const deferred = useDeferredValue(text);
  useEffect(() => {
    if (deferred === current) return;
    const timer = setTimeout(() => {
      setSent({ text: deferred, folds });
      void store.dispatch(searchSet(deferred, folds));
    }, SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [store, deferred, current, folds]);
  const toggleFolds = () => {
    const next = !folds;
    setFolds(next);
    // A search that is set changes at once; the switch alone waits for text.
    if (current !== "" && deferred === current) {
      setSent({ text: current, folds: next });
      void store.dispatch(searchSet(current, next));
    }
  };
  const showsSave = saves && saving !== null;
  const exports = useGridSelector((snapshot) => (snapshot.table?.capabilities.export?.formats.length ?? 0) > 0);
  const derives = useGridSelector(
    (snapshot) => snapshot.table !== null && snapshot.table.capabilities.plan?.derive !== false,
  );
  const groups = useGridSelector((snapshot) => snapshot.table !== null && offers(snapshot.table.capabilities, "count"));
  const grouped = useGridSelector((snapshot) => snapshot.document.plan?.aggregate !== undefined);
  const filters = useGridSelector(
    (snapshot) => snapshot.table !== null && snapshot.table.capabilities.plan?.where !== false,
  );
  const conditions = useGridSelector(
    (snapshot) => partsOf(snapshot.document.plan?.where).filter((part) => !("search" in part)).length,
  );
  const opened = useGridSelector((snapshot) => snapshot.view !== null);
  const detail = useGridSelector((snapshot) => snapshot.session.detail?.open === true);
  if (!searches && !showsSave && !fileChanged && !exports && !derives && !groups && !opened) return null;
  return (
    <div className="vg-toolbar">
      {searches && (
        <input
          type="search"
          className="vg-input vg-toolbar__search"
          aria-label={messages.search}
          placeholder={messages.search}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {searches && (
        <button
          type="button"
          className="vg-button vg-toolbar__fold"
          aria-pressed={folds}
          aria-label={messages.searchFold}
          title={messages.searchFold}
          onClick={toggleFolds}
        >
          ｱ=ア
        </button>
      )}
      <span className="vg-toolbar__spacer" />
      {fileChanged && (
        <button type="button" className="vg-button" disabled={reloading} onClick={reload}>
          {unsaved > 0 ? messages.discardAndReload : messages.reload}
        </button>
      )}
      {opened && (
        <button
          type="button"
          className="vg-button"
          aria-pressed={detail}
          onClick={() => void store.dispatch({ command: detail ? "detail.close" : "detail.open" })}
        >
          {messages.details}
        </button>
      )}
      {filters && (
        <ToolbarPopover
          label={conditions > 0 ? messages.conditionsCount(String(conditions)) : messages.conditions}
          title={messages.conditionsTitle}
          className="vg-conditions"
          pressed={conditions > 0}
        >
          {(close) => <ConditionsPanel close={close} />}
        </ToolbarPopover>
      )}
      {opened && (
        <ToolbarPopover label={messages.columns} title={messages.columns} className="vg-columns">
          {() => <ColumnsPanel />}
        </ToolbarPopover>
      )}
      {groups && (
        <ToolbarPopover label={messages.groups} title={messages.groups} className="vg-groups" pressed={grouped}>
          {() => <GroupPanel />}
        </ToolbarPopover>
      )}
      {derives && (
        <ToolbarPopover label={messages.formulas} title={messages.formulas} className="vg-formulas">
          {() => <FormulaPanel />}
        </ToolbarPopover>
      )}
      <ExportMenu announce={announce} />
      {showsSave && (
        <button
          type="button"
          className="vg-button"
          aria-keyshortcuts={isApple() ? "Meta+S" : "Control+S"}
          disabled={unsaved === 0 || saving.pending}
          onClick={saving.save}
        >
          {messages.save}
        </button>
      )}
    </div>
  );
}
