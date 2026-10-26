import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type Ref,
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GridDocument, GridSession } from "vastgrid-spec";
import type { CellHooks, ColumnGroup } from "../canvas/hooks.js";
import type { Transport } from "../core/client.js";
import { createGridStore, type GridStore } from "../core/store.js";
import type { GridError, InitialView, OpenOptions } from "../core/types.js";
import { GridContext, LocaleContext, SaveContext } from "./context.js";
import { DetailPanel, type DetailPanelProps } from "./detail-panel.js";
import { FindBar } from "./find-bar.js";
import { type CellActionEvent, GridBody } from "./grid-body.js";
import { type GridMessages, messagesFor } from "./messages.js";
import { useSaveAction } from "./save.js";
import { StaticRows } from "./static-rows.js";
import { StatusBar } from "./status-bar.js";
import { Toolbar } from "./toolbar.js";

/** What `ref` gives (§5.5 of v2-react.md). */
export interface DataGridHandle {
  store: GridStore;
  dispatch: GridStore["dispatch"];
  /** Moves the focus to the grid. */
  focus(): void;
}

export interface DataGridProps {
  /** Where the rows come from, with `table`; a new transport or table makes a new store. */
  transport?: Transport;
  /** The `ref` of the table to open (§8.2). */
  table?: string;
  /** The `read` options of `open`. */
  open?: OpenOptions;
  /** A store made outside, instead of `transport` and `table`. */
  store?: GridStore;
  /** The view and its columns (§5.1), controlled. */
  document?: GridDocument;
  defaultDocument?: GridDocument;
  onDocumentChange?: (document: GridDocument) => void;
  /** Where the person is (§5.2), controlled. */
  session?: GridSession;
  defaultSession?: GridSession;
  onSessionChange?: (session: GridSession) => void;
  /** Rows read on a server, shown before the first read; a promise streams them (§7). */
  initial?: InitialView | Promise<InitialView>;
  toolbar?: boolean;
  statusBar?: boolean;
  /** A check box for each row in the gutter, and Space to check the active row (§5.2.1). */
  checkboxes?: boolean;
  /** Groups of columns named in header rows above the column names; nested groups add rows. */
  columnGroups?: readonly ColumnGroup[];
  /** The height of each row of groups, instead of `--vg-group-header-height`. */
  groupHeaderHeight?: number;
  /** How many lines rows have while a displayed column wraps its text (2 by default). */
  wrapLines?: number;
  /** The text of a cell instead of the grid's (§5.1: functions win over the document's formats). */
  cellText?: CellHooks["cellText"];
  /** The colors of a cell instead of the column's style rules. */
  cellStyle?: CellHooks["cellStyle"];
  /** Draws cells on the canvas, with the grid's drawing at hand (`drawDefault`). */
  drawCell?: CellHooks["drawCell"];
  /** Makes cells links or buttons; a click or Space on them calls `onCellAction`. */
  cellAction?: CellHooks["cellAction"];
  onCellAction?: (event: CellActionEvent) => void;
  /** Shows the active row in the detail panel your own way, instead of a list of its columns. */
  detailPanel?: ComponentType<DetailPanelProps>;
  rowHeight?: number;
  headerHeight?: number;
  /** The language of the UI, a BCP 47 tag; the browser's by default. */
  locale?: string;
  messages?: Partial<GridMessages>;
  /** Failures that belong to no command (§4.2). */
  onError?: (error: GridError) => void;
  ref?: Ref<DataGridHandle>;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

const transportIds = new WeakMap<object, number>();
let nextTransportId = 1;

/** A number for each transport, for the key that makes a new store when the transport changes. */
function transportId(transport: object) {
  let id = transportIds.get(transport);
  if (id === undefined) {
    id = nextTransportId++;
    transportIds.set(transport, id);
  }
  return id;
}

function isPromise<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

const noSubscription = () => () => {};
const browserLocale = () => navigator.language;
const serverLocale = () => undefined;

/**
 * A data grid for tables of any size (§5.1 of v2-react.md): it draws on a canvas, reads rows through a
 * transport as you scroll, and is driven by the commands of the specification.
 */
export function DataGrid(props: DataGridProps) {
  if (props.store) return <Frame {...props} store={props.store} />;
  const { transport, table } = props;
  if (!transport || table === undefined) throw new Error("DataGrid needs a store, or a transport and a table.");
  const key = `${transportId(transport)}\u0000${table}`;
  if (isPromise(props.initial)) {
    return (
      <Suspense fallback={<div className="vg-root" aria-busy="true" />}>
        <OwnStore key={key} {...props} transport={transport} table={table} />
      </Suspense>
    );
  }
  return <OwnStore key={key} {...props} transport={transport} table={table} />;
}

/** A grid with a store of its own, made once and connected while it is mounted. */
function OwnStore(props: DataGridProps & { transport: Transport; table: string }) {
  const initial = isPromise(props.initial) ? use(props.initial) : props.initial;
  const [store] = useState(() =>
    createGridStore({
      transport: props.transport,
      table: props.table,
      ...(props.open ? { open: props.open } : {}),
      ...((props.document ?? props.defaultDocument) ? { document: props.document ?? props.defaultDocument } : {}),
      ...((props.session ?? props.defaultSession) ? { session: props.session ?? props.defaultSession } : {}),
      ...(initial ? { initial } : {}),
    }),
  );
  useEffect(() => store.connect(), [store]);
  return <Frame {...props} store={store} />;
}

/** Makes a part of the state controlled by a prop (§5.2), and reports the changes that commands make. */
function useControlled<T extends GridDocument | GridSession>(
  store: GridStore,
  part: "document" | "session",
  value: T | undefined,
  onChange: ((value: T) => void) | undefined,
) {
  const controlled = value !== undefined;
  const report = useEffectEvent((next: T) => onChange?.(next));
  useLayoutEffect(() => {
    store.control(part, controlled);
  }, [store, part, controlled]);
  // In the commit that brings the prop, before the canvas draws.
  useLayoutEffect(() => {
    if (value === undefined) return;
    if (part === "document") store.setDocument(value as GridDocument);
    else store.setSession(value as GridSession);
  }, [store, part, value]);
  useEffect(() => store.on(part, (next) => report(next as T)), [store, part]);
}

function Frame({
  store,
  toolbar = true,
  statusBar = true,
  checkboxes = false,
  columnGroups,
  groupHeaderHeight,
  wrapLines,
  cellText,
  cellStyle,
  drawCell,
  cellAction,
  onCellAction,
  detailPanel,
  className,
  style,
  ref,
  rowHeight,
  headerHeight,
  locale: given,
  messages: replaced,
  document,
  onDocumentChange,
  session,
  onSessionChange,
  onError,
  "aria-label": ariaLabel,
}: DataGridProps & { store: GridStore }) {
  const detected = useSyncExternalStore(noSubscription, browserLocale, serverLocale);
  const locale = given ?? detected;
  const base = messagesFor(locale);
  const messages = replaced ? { ...base, ...replaced } : base;
  const language = { messages, locale, number: new Intl.NumberFormat(locale) };
  const label = ariaLabel ?? messages.grid;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const [finding, setFinding] = useState(false);
  const saving = useSaveAction(store, language, setNotice);
  const status = useGridSelectorOf(store, (snapshot) => snapshot.status);
  useControlled(store, "document", document, onDocumentChange);
  useControlled(store, "session", session, onSessionChange);
  const reportError = useEffectEvent((error: GridError) => onError?.(error));
  useEffect(() => store.on("error", (error) => reportError(error)), [store]);
  useImperativeHandle(
    ref,
    () => ({
      store,
      dispatch: store.dispatch,
      focus: () => scrollerRef.current?.focus(),
    }),
    [store],
  );
  return (
    <GridContext value={store}>
      <LocaleContext value={language}>
        <SaveContext value={saving}>
          <div className={className ? `vg-root ${className}` : "vg-root"} style={style} data-status={status}>
            {toolbar && <Toolbar announce={setNotice} />}
            {finding && <FindBar onClose={() => setFinding(false)} scrollerRef={scrollerRef} />}
            <div className="vg-main">
              <Suspense fallback={<StaticRows label={label} />}>
                <GridBody
                  rowHeight={rowHeight}
                  headerHeight={headerHeight}
                  checkboxes={checkboxes}
                  columnGroups={columnGroups}
                  groupHeaderHeight={groupHeaderHeight}
                  wrapLines={wrapLines}
                  hooks={{ cellText, cellStyle, drawCell, cellAction }}
                  onCellAction={onCellAction}
                  onFind={() => setFinding(true)}
                  label={label}
                  scrollerRef={scrollerRef}
                  announce={setNotice}
                />
              </Suspense>
              <DetailPanel custom={detailPanel} />
            </div>
            {statusBar && <StatusBar />}
            <div className="vg-sr-only" aria-live="polite">
              {notice}
            </div>
          </div>
        </SaveContext>
      </LocaleContext>
    </GridContext>
  );
}

/** `useGridSelector` for a store given directly, before the context holds it. */
function useGridSelectorOf<T>(store: GridStore, selector: (snapshot: ReturnType<GridStore["getSnapshot"]>) => T): T {
  const read = () => selector(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Gives a store to the hooks of the components inside (§5.4 of v2-react.md). */
export function GridProvider({ store, children }: { store: GridStore; children?: ReactNode }) {
  return <GridContext value={store}>{children}</GridContext>;
}
