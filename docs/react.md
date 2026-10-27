# vastgrid 0.2 for React

Status: **draft** (2026-10-24). This document is normative for [`vastgrid`](../packages/grid), the React
package of 0.2 (and its `vastgrid/core` and `vastgrid/server`). It builds on
[the 0.2 specification](spec.md): the state, the commands and the messages are those of the specification,
and this document says how React holds, shows and changes them. Why React comes first is in
[the reconsideration of the rebuild](https://github.com/yhay81/vastgrid/blob/507862d/docs/rebuild-decision.ja.md#react-を中心に据える) (Japanese).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

The code implements this draft: the store (§4), `DataGrid` and the hooks (§5), the canvas with scrolling, keys,
pointers, sorting, resizing and moving columns, copying and pasting (§6), editing with an IME, undo and saving
(§6.6), the menus, the totals row and the panels (§6.7–§6.13), the toolbar and the status bar, the accessibility
rows, server rendering (§7) and the checks of §10 and §11.

## 1. Principles

1. **React renders the DOM, and nothing on the hot path renders React.** Scrolling, drawing cells and
   dragging a selection run in the store and the canvas at the frame rate, without rendering components.
   React renders what is DOM (the toolbar, the status bar, panels, menus, the cell editor, the accessibility
   tree), and only the parts whose data changed.
2. **One state, read through selectors.** The state of §5 of the specification lives in a store as immutable
   snapshots. Components read slices of it with `useGridSelector`, so that moving the active cell re-renders
   the status bar and not the toolbar. What a command does not change keeps its identity.
3. **Commands are the API.** Everything the grid does is a command of §6 of the specification, typed in
   TypeScript. The built-in UI dispatches the same commands that a host, an agent or a custom toolbar does.
4. **The latest React, and nothing it discourages.** The package requires React 19.3 and uses its features
   where they fit (§3). Every component and hook follows the Rules of React: it compiles with React
   Compiler 1.0 without bailing out and passes `eslint-plugin-react-hooks` `recommended-latest`, and the
   package ships compiled (§11).
5. **Wherever React runs.** Client rendering, streaming server rendering, Server Components, Strict Mode and
   concurrent rendering, in Vite, Next.js, React Router and Astro.

## 2. Entry points

| Entry | Holds | Imports React |
| --- | --- | --- |
| `vastgrid` | the components and hooks, marked `"use client"` | yes |
| `vastgrid/core` | the store, the client of the messages (§8 of the specification) and the transports | no |
| `vastgrid/server` | what a Server Component or a server render calls: reading the first rows for `initial` (§7) | no |
| `vastgrid/styles.css` | the styles, themed by CSS custom properties | — |

`react` and `react-dom` `^19.3.0` are peer dependencies. Engines are other packages:
[`vastgrid-js`](../packages/js) in memory and in the browser, `vastgrid-duckdb` on Node.js.

## 3. React features used

| Feature | Since | Where | In the code |
| --- | --- | --- | --- |
| `useSyncExternalStore` | 18 | `useGridSelector` reads the store without tearing; the browser's language, with the server's value during hydration | yes |
| `ref` as a prop | 19.0 | the handle of `DataGrid` (§5.5); no `forwardRef` | yes |
| `<Context value>` | 19.0 | `GridProvider` and the grid's own contexts | yes |
| `use` | 19.0 | contexts, and `initial` given as a promise, streamed from a Server Component (§7) | yes |
| `useDeferredValue` | 18 | the accessibility rows and the search box (§6.2) | yes |
| Actions (`useTransition` with an async function) | 19.0 | saving and exporting, with their pending state | with saving |
| `useEffectEvent` | 19.2 | every callback prop (`onDocumentChange`, `onSessionChange`, `onError`) and the clipboard's announcements: read when called, never a dependency | yes |
| `<Activity>` | 19.2 | panels keep their state while they are closed | with the panels |
| Performance Tracks | 19.2 | React's own tracks, next to the grid's (§9) | yes |
| `<ViewTransition>`, `addTransitionType` | 19.3 | panels opening and closing and switching between rows and groups, only inside Transitions and never with `prefers-reduced-motion: reduce` | with the panels |
| Fragment refs | 19.3 | focus moves into and out of panels and menus (`focus`, `focusLast`) without wrapper elements | with the panels |
| `browser()` | 19.3 | the canvas renders only in the browser; the server sends the first rows as HTML instead (§7) | yes |

The package does not use `forwardRef`, `defaultProps`, class components, string refs, legacy context or
`findDOMNode`; it does not read or write refs during render, and it uses `useLayoutEffect` only to measure
and to bring the canvas up to date before paint.

## 4. The store

`createGridStore(options)` from `vastgrid/core` makes a store; `DataGrid` makes one when it is not given
one.

```ts
interface GridStore {
  getSnapshot(): GridSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(command: GridCommand, options?: DispatchOptions): Promise<CommandOutcome>;
  dispatchSync(command: GridCommand, options?: DispatchOptions): CommandOutcome;
  connect(): () => void;
  setDocument(document: GridDocument): void;
  setSession(session: GridSession): void;
  reload(): Promise<void>;
  retryWrite(): Promise<CommandOutcome>;
  discardWrite(): void;
  exportUrl(target: string): string | null;
  values(
    column: string,
    options?: { search?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ values: { value: JsonValue; count: number }[]; truncated: boolean }>;
  aggregate(
    measures: Measure[],
    signal?: AbortSignal,
  ): Promise<{ values: Record<string, JsonValue>; columns: Record<string, Column> }>;
}
```

`values` lists a column's values with how many rows have each, the most common first, for the column menu (§6.7).
`aggregate` reads measures (§4.5 of the specification) over the rows of the document's plan, as an `aggregate`
without keys; it fails for a plan that groups rows.

`exportUrl` gives where the file of an `export` without a target can be downloaded, from the transport
(`Transport.exportUrl`; `httpTransport` gives `<url>/exports/<target>`), or null.

`retryWrite` sends the last write that failed (`failedWrite` of the snapshot) again, and `discardWrite` forgets it
(§6.6).

`reload` reads the table's file as it is now (`reload`, §7.6 of the specification), for a file that changed on disk
while the table had written cells (`fileChanged` of the table); a new revision is applied as an engine's `changed`
event is (§5.4 of the specification).

### 4.1 Snapshots

```ts
interface GridSnapshot {
  document: GridDocument; // §5.1 of the specification
  session: GridSession; // §5.2
  table: TableInfo | null; // §8.2, null until the table is open
  view: ViewInfo | null; // the view on screen: its hash, columns, row count and status
  displayed: DisplayedColumn[]; // §5.1.1, for the view on screen
  pending: { plan: Plan } | null; // a plan whose view is being read to replace the one on screen
  status: "idle" | "opening" | "ready" | "error";
  error: GridError | null;
  failedWrite: FailedWrite | null; // the last write that failed (§6.6)
  totals: { values: Record<string, JsonValue>; columns: Record<string, Column> } | null; // the totals row (§6.8)
}
```

- A snapshot is never changed. `getSnapshot` returns the same object until the state changes.
- **Structural sharing.** A command keeps the identity of every member of the document and of the session
  that it does not change, and of the document or the session as a whole when it changes none of their
  members. `move` gives a session with new `active`, `anchor`, `focus` and `selection`, and the same
  `document`, `checked` and `history`. Selectors stay cheap, and React Compiler's memoization holds.
- The cost of a command MUST NOT grow with the parts of the state it does not change: moving the active cell
  takes the same time with an empty undo history and with one of a million updates.
- Rows are not in snapshots. They live in the store's cache of blocks, which the canvas reads directly;
  components read them with `useGridRows` (§5.3), which follows the rows it shows.

### 4.2 Dispatching

`dispatch` applies a command with `applyCommand` (§6.1 of the specification) and a context made by the store:
the table, the view on screen and the rows of it in the cache, the rows of a page of the viewport, the
engine's capabilities, and the clipboard given in `options` for `edit.paste`. Then:

1. The snapshot changes at once and subscribers are told, so that a key press shows in the same frame.
2. The requests that the command gives are sent; the commands of §6.7 are applied as their answers arrive.
3. When the plan changed, the store reads the new view while the old one stays on screen with `pending` set.
   When the first rows of the new view arrive, it applies `view.update` (§5.4) with the positions that
   `locate` gives for the session's keys, and shows the new rows in one step. This is what a React Transition
   does (the old content stays until the new is ready), done in the store, so that the canvas, the host and
   an agent see the same thing. A newer plan cancels the reads of an older one (§8.6).
4. A command that fails with `not_loaded` reads the rows it names and is applied once more.

`dispatchSync` applies a command without reading rows first, for handlers that must answer at once: a `copy`
event writes the clipboard before it returns, so the grid copies with `dispatchSync` and, when the rows are not
read (`not_loaded`), reads them and writes the clipboard through the asynchronous Clipboard API.

The store tells views apart by the normal form of their plans (§4.8 of the specification) and takes their hashes
from the engine's answers, so that it needs no SHA-256 of its own (WebCrypto's is asynchronous, and missing on
pages that are not secure contexts).

The promise resolves to `{ ok: true, output }` once the command and its requests are done, or to
`{ ok: false, error }`, and never rejects: a command that fails changes nothing (§6.1), and the built-in UI
tells the person why. Failures that belong to no command (a read that fails, a revision that changes) go to
`onError` and to `snapshot.error`.

### 4.3 Lifecycle

- Making a store has no side effects: it opens nothing, starts no timer and subscribes to nothing.
- `connect()` opens the table (`open`, §8.2), follows its events and starts reading; the function it returns
  undoes all of it and closes the table. A store MUST be able to connect again after it disconnects, since
  Strict Mode runs effects twice in development, on mount and, since React 19.3, during hydration.
- A disconnected store keeps its last snapshot and reads nothing.

### 4.4 Engines and transports

A transport carries messages (§8 of the specification) to an engine:

```ts
interface Transport {
  send(request: Request, options: { signal?: AbortSignal }): Promise<Response>;
  subscribe?(listener: (event: Event) => void): () => void;
}
```

| Transport | Engine | Blocks (§8.8) |
| --- | --- | --- |
| `localTransport(engine)` | in the same thread, such as `vastgrid-js`'s memory engine | structured |
| `workerTransport(worker)` | in a Web Worker, where `serveEngine(engine, self)` answers, or behind anything that carries messages as a worker does (`WorkerLike`: a `MessagePort`, VS Code's webview, a notebook widget's messages); buffers are transferred | structured |
| `httpTransport(url, { events })` | on a server, with `accept: application/vnd.vastgrid.v2+arrow`; while its stream of `events` connects, requests wait, so that no event of a table it opens is missed | attached |
| `serverFunctionTransport(action)` | a `"use server"` function (§7) | structured |

The client gives ids, checks every response and event (`checkResponse`, `checkEvent`), and sends `cancel` when
a signal aborts.

A host with a channel of its own implements `Transport` itself: the MCP App sends each request as a call of its
tool (docs/mcp-app.md). The site's overview of the apps shows which transport each entry uses.

## 5. Components and hooks

### 5.1 `DataGrid`

```tsx
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders } }));

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

| Prop | Value | Meaning |
| --- | --- | --- |
| `transport`, `table`, `open` | a transport, the `ref` to open, the `read` options of `open` | where the rows come from; a new transport or table makes a new store |
| `store` | a store | instead of `transport` and `table`, for a store made outside (§5.4) |
| `document`, `defaultDocument`, `onDocumentChange` | §5.1 of the specification | the view and its columns (§5.2) |
| `session`, `defaultSession`, `onSessionChange` | §5.2 of the specification | where the person is (§5.2) |
| `initial` | an `InitialView` or a promise of one | rows read on the server, shown before the first read (§7) |
| `toolbar`, `statusBar` | booleans | the built-in toolbar and status bar |
| `checkboxes` | boolean (default false) | a check box for each row in the gutter (§6.11) |
| `columnGroups`, `groupHeaderHeight` | `ColumnGroup[]`, CSS pixels | groups of columns in header rows above the names (§6.12) |
| `wrapLines` | a number (default 2) | the lines of a row while a displayed column wraps (§6.10) |
| `cellText`, `cellStyle`, `drawCell`, `cellAction`, `onCellAction` | functions | the text, colors, drawing and actions of cells (§6.12) |
| `detailPanel` | a component of `DetailPanelProps` | the detail panel's content (§6.11) |
| `rowHeight`, `headerHeight` | CSS pixels | instead of `--vg-row-height` and `--vg-header-height` |
| `locale`, `messages` | a BCP 47 tag, texts | the language of the UI; English and Japanese are built in |
| `onError` | `(error: GridError) => void` | failures that belong to no command (§4.2) |
| `ref` | a ref | the handle (§5.5) |
| `className`, `style`, `aria-label` | | on the root element |

### 5.2 Controlled and uncontrolled state

- `defaultDocument` and `defaultSession` give the state to start with; the grid then keeps it.
- With `document` (or `session`), the grid shows the prop. A command reports the state that the grid would
  have with `onDocumentChange` (`onSessionChange`), and the grid shows it once the parent passes it back. A
  parent that passes back something else, or nothing, wins.
- Commands dispatched before the parent renders again apply to the last state reported, so that two commands
  in one event both take effect.
- A new prop is given to the store in a layout effect, in the commit that brings it, so that the canvas never
  shows the state of an earlier render. Props that the parent updates in a Transition reach the grid when
  React commits that Transition.
- `onSessionChange` is called on every move of the active cell. A parent that keeps the session in state
  SHOULD render little with it, or read it through `useDeferredValue`.

### 5.3 Hooks

| Hook | Gives |
| --- | --- |
| `useGridStore()` | the store of the nearest `DataGrid` or `GridProvider` |
| `useGridSelector(selector, isEqual?)` | `selector(snapshot)`; renders again only when it changes by `isEqual` (default `Object.is`; `shallowEqual` is exported) |
| `useGridDispatch()` | `dispatch`, the same function on every render |
| `useGridRows({ start, end, columns })` | the values of rows of the view on screen for cells that React renders (a detail panel, an overlay); reads them when they are missing and renders again when they arrive |
| `useCreateGridStore(options)` | a store for the life of the component: made once, connected in an effect |

Selectors run on every change of the store, so they MUST be cheap and MUST NOT make new objects unless they
pass an `isEqual` that compares them.

Rows change inside the store's cache, not in snapshots. A component that reads them during render gets them
through `useGridRows`, or passes the version of the rows to the function that reads them (`readRows(store,
version, …)`): memoization, React Compiler's included, keys on its arguments, and would otherwise keep the rows
it read first. This is the interior mutability that React Compiler's `incompatible-library` rule warns about, kept
out of components.

### 5.4 Building your own UI

```tsx
function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <SortButtons />
      <DataGrid store={store} toolbar={false} />
    </GridProvider>
  );
}

function SortButtons() {
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const dispatch = useGridDispatch();
  return (
    <button type="button" disabled={!sort} onClick={() => dispatch({ command: "sort.clear" })}>
      Clear sort
    </button>
  );
}
```

`GridCommand` is the union of the commands of §6 of the specification, so that `dispatch` completes and
checks command names and arguments.

### 5.5 Handle

`ref` gives `{ store, dispatch, focus }`. Everything else goes through the store and commands.

## 6. Rendering and updates

### 6.1 What renders when

| Event | Store | Canvas | React renders |
| --- | --- | --- | --- |
| Scrolling (wheel, scroll bar, keys) | the viewport; blocks are read for new rows | the next frame | nothing while scrolling; the accessibility rows and `session.scroll` follow when scrolling pauses (150 ms) |
| A key, a click, a drag | one command | the same frame | the components whose selected state changed, such as the status bar |
| Rows arrive | the cache | the next frame, when they are on screen | the `useGridRows` of those rows |
| Sort, filter, search | the document; the new view is read | the old view until the first rows of the new | the header's sort state and the pending state at once; the rest when the new view is shown |
| Typing in the editor | `edit.change` | | the editor |
| A resize | the viewport | the next frame | nothing |

The canvas draws at most once per frame (`requestAnimationFrame`) and only the cells on screen. Columns' x
positions are computed when the document or the view changes, not per frame.

### 6.2 Concurrent features

- React-rendered views that follow the active cell while they are open (the detail panel, statistics) read it
  through `useDeferredValue`, so that holding an arrow key never waits for them. A deferred value costs a second
  commit at a lower priority, so the grid itself defers nothing that changes with each key: it commits once per
  key (§10), and the sum of the selection waits until the selection stays for 150 ms instead.
- The accessibility rows follow the rows on screen through `useDeferredValue` once scrolling pauses.
- Panels are code-split with `lazy`, open inside `startTransition`, and keep their state in `<Activity>` while
  closed.
- `save` and `export` run as Actions: `useTransition` gives their pending state, and errors reach the UI as
  outcomes (§4.2).
- The search box keeps its text in React state, which updates at once, and dispatches `search.set` with the
  text from `useDeferredValue`; the store cancels the reads of views it no longer needs.

### 6.3 Scrolling

The body is a native scroller with a sizer, so that wheels, trackpads, scroll bars, keys and assistive
technology scroll as on any page. Browsers cap the size of an element (about 16.7 million pixels in Chromium),
so `ScrollAxis` maps the native position onto the virtual one: small movements move by the same amount at any
depth, and jumps of the scroll bar map proportionally. A hundred million rows of 24 pixels scroll to the end.

### 6.4 Accessibility

- The scroller has `role="grid"`, `aria-rowcount` and `aria-colcount` of the whole view (with the header row),
  `aria-multiselectable`, and a label.
- Under the canvas, React renders the rows on screen as `row`s of `gridcell`s with `aria-rowindex` and
  `aria-colindex` and the cells' text, placed over the cells they stand for and transparent. They follow the
  canvas in a Transition once scrolling pauses: one commit at a low priority, never during scrolling.
- The row of the active cell is always among them, also when it is not on screen, so that the active cell is
  always `aria-activedescendant`; `aria-selected` follows the selection. Each row is a component of its own, so
  that moving the selection renders again only the rows whose selected cells changed.
- The keyboard follows §6.4 of the specification (the grid pattern of the ARIA Authoring Practices), and adds:
  Space (a cell's link or button, or checking the row), Alt+Enter (the detail panel), Alt+↓ (the column menu),
  Shift+F10 and the context menu key (the cell menu), ⌘/Ctrl+F (find), ⌘/Ctrl+D and R (fill) and ⌘/Ctrl+S (save).
  While an IME composes, its keys are its own: none of these act. Menus and panels give the focus back to the grid
  when they close from the keyboard.
- Results and failures are announced in a polite live region.

### 6.6 Editing

- A cell is edited through the session's `editor` (§5.2 and §6.5 of the specification): `edit.begin`,
  `edit.change`, `edit.commit` and `edit.cancel`. The editor is a text field over the cell, which follows the cell
  at every frame the canvas draws.
- The text field stays in the page, hidden, while no cell is edited. A key that types text, the start of an IME
  composition included (`Process`, 229), opens the editor and gives it the focus before the browser handles the
  key, so that the key's text, or the IME's composition, goes into it whole. F2 and a double click open it with
  the cell's value.
- The text reaches the session when the person types it, not while an IME composes: keys that end a composition
  are the IME's. Enter writes and moves down (Shift+Enter up), Tab right (Shift+Tab left), Esc cancels, and
  Alt+Enter (⌃↩ on Apple platforms) starts a new line. Leaving the editor for another place of the page writes it.
  Text that is not a value of the column (§7.3) keeps the editor open and tells why.
- Delete clears the selected cells (`edit.clear`), pasting writes the clipboard into the selection
  (`edit.paste`), and the primary modifier with Z undoes (with Shift, or Ctrl+Y off Apple platforms, redoes).
- When the engine saves the table's file (`capabilities.save`), the primary modifier with S saves (`save`), also
  from the editor, which writes its text first; otherwise the key is the browser's. The toolbar has a Save button
  while cells are not saved. The status bar counts the cells not saved, and shows the save while it runs and then
  its outcome (the rows saved, or why not: `file_changed` keeps the written cells) until the cells change.
- A file that changes on disk (§7.6 of the specification) is shown as it is now once the engine has read it again.
  When the table has written cells, it stays as it was: the status bar says that the file changed and the edits
  are kept, and the toolbar's "Discard edits and reload" button calls `reload`.
- When the engine exports (`capabilities.export`), the toolbar has an Export menu: the rows of the view or the
  whole table, with the hidden columns or not, in each format the engine offers. The export runs as an Action;
  its file is downloaded from `exportUrl`, and the rows exported are announced.
- When the engine derives columns (`capabilities.plan.derive`), the toolbar has a Formulas menu: a row per derived
  column with its name and its expression written as a formula (§4.11 of the specification), and a row for a new
  one. A formula compiles against the columns before it; one that does not compile is not dispatched, and its error
  is shown with the characters at fault selected. Otherwise the row dispatches `derive.add` or `derive.update`
  (with `rename` when the name changed), and Remove dispatches `derive.remove`, which removes what uses the column.
- The store shows a written value at once, before the engine answers, and shows the cell's value again when the
  write fails; commands read the written values too. It drops them once the rows of the new edits version are on
  screen (§4.2). An undo or a redo waits for the writes sent before it, so that it takes the step of the last one.
- A write that fails stays in the snapshot's `failedWrite` (its command, updates, revision and error) until it is sent
  again or discarded, and the status bar says why, with buttons. After a lost connection or an engine's failure
  (`internal`, `cancelled`, `not_ready`, `table_not_found`), Retry (`retryWrite`) sends the same write. After an
  `edit_conflict` the cells show their values now, and Overwrite sends the write without `previous`, so that it
  writes over them; the history keeps the values the person wrote over. Discard (`discardWrite`) forgets it. A write
  that the engine refused for its values or cells, or whose table has another revision now, is only discarded. A
  write sent again succeeds as its command would have: the history gets its step, and an undo or a redo whose step
  is still the last moves it. Both buttons give the focus back to the grid. These are 0.1's Retry, Overwrite and
  Discard (#13).

### 6.7 The column menu

- Each header has an arrow at its right that opens the column's menu, as do a right click on the header and Alt+↓
  on a cell of the column. The menu is a popover: Esc and a click outside close it, and the focus goes back to the
  grid. Its items are commands: sorting by the column alone or after the other keys (`sort.set`), `sort.clear`,
  fitting the width (`column.resize`), pinning at either side (`column.pin`), `column.hide` and `column.show`.
- Filter… (when the engine filters and the view is not grouped) shows the column's filter: the column's values with
  how many rows have each, the most common first, with check boxes and a search box, and a condition on typed text
  (comparisons, a range, text matching that ignores letter case, blank). Applying dispatches `filter.column` with
  the parts it makes (`in`, `is_blank`, `not(coalesce(…, false))` to exclude, `ge` and `le` for a range), and reads
  them back when the menu opens again; conditions of the column that it did not write are said to be replaced.
  Typed text is read as a cell's text is (§7.3 of the specification), digit grouping included.
- The list is read by `GridStore.values(column, { search, limit })`: a `rows` request whose plan keeps the
  derived columns and the other parts of `where`, and groups by the column with a `count` (§4.5), so the engine
  does the work and nothing is added to the messages. Engines that do not group rows offer the condition only.
- Headers of columns with conditions of their own show a funnel instead of the arrow.
- Statistics… (when the engine groups rows and the view does not) shows the column's statistics over the rows of the
  view, read by `GridStore.aggregate`: the rows, the values and the empty ones, the distinct values, and the
  minimum, maximum, sum, average, median (`quantile` 0.5) and standard deviation when they take the column's type
  and the engine evaluates them.
- Total… sets the column's total in the totals row (`column.total`): a measure that takes its type, or none.
- Group by this column dispatches `group.set` with the column as the only key and `count(*)`; on a grouped view,
  a key's menu stops grouping by it, and Ungroup dispatches `group.clear`.

### 6.8 The totals row and the group menu

- When displayed columns have a total (§5.1 of the specification) and the view does not group rows, a row at the
  bottom of the body shows them, drawn by the canvas like the headers and pinned while the rows scroll. The store
  reads them as one `rows` request of an `aggregate` without keys over the plan's rows (Appendix A of the
  specification), into the snapshot's `totals`, again when the view, its edits or the totals change; the totals on
  screen stay until the new ones come. Columns are widened to fit them, and the accessibility rows end with them
  (`aria-rowcount` counts them). Totals of a grouped view are not shown: one plan cannot aggregate groups again.
- When the engine groups rows, the toolbar has a Group menu: the keys, with a list to add a column of the rows,
  and the measures, each with a measure, a column (none for counting rows) and an Add button that names it as 0.1
  did (`sum(qty)`, `count(*)`). Each change dispatches `group.set` with the whole aggregate, or `group.clear` when
  nothing is left; rows grouped for the first time are counted.
- When the engine pivots (`capabilities.plan.pivot`), the group menu also lists the columns whose values become
  columns (§4.6 of the specification); a pivot without measures counts rows. A view that fails to read, such as a
  pivot that would make more columns than `maxColumns`, leaves the view before on screen and puts the failure in the
  snapshot's `error`, which the status bar shows until a view comes on screen.

### 6.9 The conditions and columns menus

- When the engine filters, the toolbar has a Conditions menu (with their number when there are some): every
  condition of the plan, those across columns included, as a group whose items all hold (AND) or one of which holds
  (OR), with groups nested in it. A condition is a column, an operator and texts, as in the column's filter (§6.7);
  parts of `where` that are not such conditions (an agent's expression) are shown as formulas (§4.11), and kept or
  removed. The menu reads `where` when it opens; Apply dispatches `filter.set` with the tree, which keeps the
  search, and conditions without text are left out. Text that is not a value of its column marks that condition and
  is not dispatched.
- The toolbar's Columns menu lists every column of the view: the displayed ones in display order with a check box
  that hides them and buttons that move them by one place (`column.move`), then the hidden ones with a check box
  that shows them, a box that finds columns by name, and Show all.

### 6.10 Formats

- The canvas shows a column's values by its `format` (§5.1 of the specification): `number` and `date` as 0.1's
  `NumberFormat` and `DateFormat` do (Intl formats in the grid's `locale`, the exact digits of decimals, date patterns
  such as `yyyy/MM/dd`, `timestamptz` values moved to `timeZone`), `align`, and `label` in the header. A format that
  Intl refuses (an unknown currency or time zone) shows the text form (§2.4). Columns are fitted to the formatted
  text.
- `styles` are evaluated in the grid, cell by cell, over the row's values: the first rule whose `when` is true gives
  the cell's text color and background, and its `description` becomes the cell's `aria-description`. The grid
  evaluates the logic and comparisons that the menus write (`and`, `or`, `not`, `coalesce`, comparisons, `in`,
  `is_null`, `is_blank`, and `contains`, `starts_with` and `ends_with` over `lower` and `text`) with the order of §3.1
  and the nulls of §3.6; a rule whose `when` uses anything else, or a column the view does not have, is skipped.
  The columns that the rules read are read with the rows on screen.
- `wrap` wraps a column's text at spaces and between CJK characters, ending with "…" when it needs more lines. Rows
  keep one height, so that a view of any size scrolls (§6.3): while a displayed column wraps, every row has room
  for `wrapLines` lines (two by default).
- Format… in the column menu edits the label, the alignment, wrapping, the number format (number, percent or
  currency, decimal places and digit grouping) of number columns, the date pattern of dates and times, and the rules
  of conditional colors: a condition on a column of the view as in the column's filter (§6.7), a text color and a
  background, and what they mean. Rules it does not take apart are shown as formulas and kept. Apply dispatches
  `column.format`, and Clear format removes the format.

### 6.11 Checked rows and the detail panel

- With `checkboxes`, the gutter has a check box for each row and the corner one for every row of the view, drawn by
  the canvas. A row's box, and Space on the grid, check the active row or uncheck it (`check`, `uncheck` by its key,
  §5.2.1 of the specification), so the same records stay checked when the view is sorted or filtered. The corner's
  box dispatches `check.all` (with the view's `where`), or `check.clear` once every row is checked. Rows whose state
  is unknown (checked under a `where` that the view's does not imply) show a dash, and checking one is refused with
  `unknown_state`, which the grid announces.
- The status bar shows how many rows are checked: the keys of `include`, or the rows of the view less the keys of
  `exclude`; it says when the view's rows are unknown.
- When the session's `detail` is open, a panel beside the body (below it in a grid narrower than 640 pixels,
  `--vg-detail-width` and `--vg-detail-height`) shows every column of the view for the active row, hidden ones
  included, with labels and formats, the text in full; it follows the active cell and reads the row's values that
  the canvas did not (`useGridRows`). The toolbar's Details button dispatches `detail.open` and `detail.close`.
  Alt+Enter on the grid opens and closes it too. `detailPanel` shows the row with a component of the host's, which
  gets the row's position, the view's columns, its values once they are all read, and its key.
  Only an open panel follows the rows, so a closed one keeps scrolling free of commits (§10); an open one renders
  again when rows of the view arrive.

### 6.12 Column groups and the cells' hooks

- `columnGroups` names groups of columns, `{ name, children }` with column names and nested groups, in header rows
  above the names (`groupHeaderHeight` or `--vg-group-header-height` high each, the innermost just above the
  names). Groups change only the header: a group is drawn over the run of its columns that are next to each other
  in one region, so a group whose columns are moved apart, hidden or pinned apart is split and each part shows its
  name. Clicking a group's header selects its columns (`select.columns`, with Shift and the primary modifier as for
  cells), and screen readers hear a column's groups as its header's description.
- Functions are props, not state (§5.1 of the specification), and win over the document: `cellText` gives a
  cell's text, `cellStyle` its colors instead of the style rules, and `drawCell` draws it on the canvas with
  `drawDefault` at hand (the canvas's state is restored after it). `cellAction` makes cells links (drawn
  underlined, in the link color) or buttons: the pointer changes over them, screen readers hear them as links or
  buttons with their `label`, and a click or Space calls `onCellAction` with the cell and its row's key; Space on
  other cells keeps checking rows. The hooks run for the loaded cells on screen, at every frame that draws them:
  they must be cheap, and stable (module functions, or `useCallback`) so that the canvas does not measure again.
- ⌘/Ctrl+D and ⌘/Ctrl+R fill the selection down and right from its first row or column (`edit.fill`, §6.5).

### 6.13 Find, the cell menu and moving columns

- ⌘F or Ctrl+F on the grid opens a find bar under the toolbar when the engine finds (`capabilities.find`): Enter
  finds the next cell after the active cell whose text contains what is typed (ignoring letter case unless Match
  case is on), Shift+Enter the one before, in the displayed columns, wrapping around (`GridStore.find`, `find` of
  §8.2), and the cell found becomes the active cell. Esc closes the bar and gives the focus back to the grid.
- A right click on a cell (selecting it first when it is outside the selection), Shift+F10 and the context menu
  key open the cell menu: Copy (the selection, through the asynchronous clipboard), Filter to this value and
  Exclude this value (`filter.column` with the column's values filter, replacing its conditions; not on a grouped
  view), Show full value (read again without the text limit when the engine cut it, `GridStore.fullValue`), and
  Details.
- A click on a column's name sorts by it (on the pointer's release, Shift adding a key). Dragging the name moves
  the column, or every column of a selection of whole columns that holds it, and dragging a group's header moves
  the group's columns (`column.move`): a line shows where they go, before the column under the pointer or after it
  past its middle, and they take the pin of where they go.

### 6.5 Theming

Colors, fonts and sizes are CSS custom properties on `.vg-root`, which the canvas reads (and reads again when the
page's or the grid's class or style, or the color scheme, changes). Colors are `light-dark()` pairs, and the
stylesheet declares `color-scheme: light dark` on `.vg-root` without specificity, so the grid follows the system's
light or dark mode; `.vg-root { color-scheme: light }` keeps it light. The declaration also makes the colors work
where a bundler turns `light-dark()` into variables for older browsers (Lightning CSS in Vite), which need it.

## 7. Server rendering and Server Components

- `vastgrid` is a client entry (`"use client"`); `vastgrid/core` and `vastgrid/server` run in
  Server Components and on servers.
- On the server, `DataGrid` renders its toolbar and status bar from the document and `initial`. The body
  renders its canvas only in the browser (`use(browser())`): the server sends the fallback, the first rows of
  `initial` as an accessible grid in HTML, or without `initial` an empty body with `aria-busy`. The body has
  the size it will have, so hydration moves nothing.
- `readInitialView(transport, { table, document, rows })` from `vastgrid/server` reads the `TableInfo`,
  the view and its first rows as a block (a `Uint8Array`, which Server Components pass to client components).
  Given as a promise, `initial` streams: the shell is sent at once and the rows when they are read.
- In the browser, the store starts from `initial`, so the first frame of the canvas draws the rows the server
  sent, and the first read starts after them.
- `serverFunctionTransport(action)` carries messages through a `"use server"` function, which passes each to
  an engine. The function receives what any client can send: it MUST check the request (`checkRequest`), and
  the engine MUST refuse `ref`s and `target`s that the host does not allow (`not_allowed`, §8.7). Frameworks
  may run Server Functions one at a time, so `httpTransport` scrolls faster.

## 8. Strict Mode and concurrency

- Rendering has no side effects: stores are made in `useState` initializers, which run without side effects,
  and connect in effects.
- Effects can run twice (Strict Mode in development, on mount and during hydration) and are undone completely.
- `useSyncExternalStore` keeps components that read the same store from tearing.
- A grid in a hidden `<Activity>` loses its effects (its canvas stops drawing and observing) and keeps its
  store; shown again, it draws the store's current state.

## 9. Developer tools

- React's Performance Tracks show the grid's components and their renders.
- In development, the grid adds the track group "vastgrid" (requests, commands, canvas frames) with
  `console.timeStamp`, which costs little when nothing records.
- Failed commands and requests carry the `code`, `reason` and `path` of the specification.

## 10. Performance budgets

The bench ([`examples/bench`](../examples/bench)) mounts the grid on a generated table, with the memory engine in
the page or in a Web Worker, built for production with React's profiling build, and the end-to-end tests ([`e2e`](../e2e)) measure it in Chromium with
Playwright (`npm run e2e:performance`, after `npm run build`, with no other tests or benchmarks running).
CI runs these in the dedicated performance job, separately from functional and large-file E2E. The tests fail
when 0.2 exceeds a budget:

| Measure | Budget |
| --- | --- |
| React commits per arrow key | at most 1 |
| React commits while scrolling for 100 frames | 0 |
| The gap between frames while scrolling, at the 95th percentile | under 25 ms: no frame dropped at 60 Hz |
| From a key press to the next frame, at the 95th percentile | under 25 ms |
| From mount to the first rows on screen (1,000,000 rows in memory) | under 300 ms |

Counts of commits are exact; times allow for the machine. What a page loads first of `DataGrid` with an in-memory
table and their dependencies, minified and compressed with gzip, stays under 200 KB, measured with esbuild as in
Appendix A by `npm run size` ([`scripts/bundle-size.mjs`](../scripts/bundle-size.mjs), after `npm run build`),
which CI runs and which fails over the budget. The column and cell menus, the toolbar's menus, the find bar and the
detail panel load when they first open, so that the first load is the grid itself. The budget was 60 KB until
2026-10-26, set before editing, saving, exports and formulas, and 100 KB until 2026-10-27, when the first load had
reached it; it was raised to 200 KB so that features are not shaped by the budget before the grid is complete.
Appendix A gives what was measured.

## 11. Compiler and lint

- The package is built with Babel and `babel-plugin-react-compiler` 1.0 (`target: "19"`,
  [`scripts/compile-react.mjs`](../scripts/compile-react.mjs)), so that every app gets its memoization without
  configuring anything; tsc writes only the types. The build fails when the compiler gives up on a function.
- The tests compile every file of the package with React Compiler and fail on any function that it does not
  compile. ESLint runs `eslint-plugin-react-hooks` `recommended-latest` on the package, parsing TypeScript with
  `@babel/eslint-parser` (`typescript-eslint` does not support TypeScript 7 yet); Biome lints everything else.
- Unit tests run on the sources; the bench and the end-to-end tests run on the build.

## Appendix A. Measurements

Measured on 2026-10-24 on an Apple M2 Pro with Node.js 24, React 19.3.1, React Compiler 1.0.0,
`eslint-plugin-react-hooks` 7.1.1 and, in the browser, Chromium 156 (Playwright 1.64.1, headless, 60 Hz). 0.1 is
main at `a925cb3`, when the bench mounted both (0.1 was removed later, at 0.2.0).

### A.1 The React layer

| Measure | 0.1 (`packages/react`) | 0.2 (`packages/grid`) |
| --- | --- | --- |
| React Compiler | compiles 13 functions and gives up on 16 places, among them `DataGrid` itself (a `try` with `finally`, `throw` inside `try`, getters in an object literal) and 5 other components | compiles all 17 components and hooks, and the build fails if it gives up on one |
| `eslint-plugin-react-hooks` `recommended-latest` | 51 problems: `refs` 20, `immutability` 17, `preserve-manual-memoization` 9, `exhaustive-deps` 3, `set-state-in-effect` 2 | none |
| How the state reaches React | a mutable `GridController` with a version counter: every change renders all of `DataGrid` (63 hooks); 13 effects copy props into the controller after render | immutable snapshots and selectors (§4) |
| API | `forwardRef`; the handle has getters | `ref` as a prop; typed commands |
| `DataGrid` and an in-memory table, minified (esbuild) | 300.9 KB, 92.6 KB with gzip, all of it whatever is used | On 2026-10-24, before editing, saving, exports, formulas and the panels: 170.7 KB, 57.0 KB with gzip. On 2026-10-26: 289.9 KB and 98.7 KB with gzip loaded first, 350.9 KB and 123.0 KB in all; the menus and panels (61 KB minified) load when they open. On 2026-10-27, with the memory engine's expressions and groups: 291.7 KB and 99.9 KB with gzip loaded first, 368.3 KB and 129.9 KB in all; the code of plans other than sorts (17 KB minified) loads with the first such plan. Then, with tables as Arrow kept in typed columns: 293.0 KB and 100.9 KB with gzip loaded first, 374.9 KB and 133.2 KB in all; the code that reads Arrow loads with the first such table. Of the first load, `vastgrid-spec` is one chunk of 181 KB minified (esbuild keeps a package's files together when they are shared, so its formula compiler comes too), the canvas, the store and the grid's body 59 KB, and Flechette 31 KB |
| Server rendering | an empty canvas and "Loading…", with `aria-rowcount="1"`, also for a table in memory | the first rows as an HTML table, streamed when `initial` is a promise |

### A.2 In the browser

The bench of §10 on a table of 1,000,000 rows and 8 columns (integers, strings, floats, dates, booleans), 0.1 with
its `ArraySource` and 0.2 with `vastgrid-js`'s memory engine in the page or in a Web Worker; ranges are those of
the last four runs.

| Measure | 0.1 | 0.2 | 0.2, engine in a worker |
| --- | ---: | ---: | ---: |
| From mount to the first rows on screen | 46–65 ms | 43–49 ms | 36–49 ms |
| React commits per arrow key | 1 | 1 | 1 |
| Time React renders for an arrow key (Profiler, p50 / p95) | 0.2 / 0.4–0.5 ms | 0.3 / 0.4–0.8 ms | 0.3–0.4 / 0.4–0.7 ms |
| From a key press to the next frame, p95 | 13.8–14.1 ms | 13.4–14.1 ms | 13.5–13.9 ms |
| React commits while scrolling for 100 frames | 0 | 0 | 0 |
| The gap between frames while scrolling, p95 | 16.7–16.8 ms | 16.7–16.8 ms | 16.7–16.8 ms |
| Sorting by a float column until the sorted rows are on screen | 494–516 ms | 85–98 ms | 112–113 ms |
| The longest task of the page meanwhile | 490–512 ms | 81–93 ms | none |
| JavaScript heap of the page | 190 MB | 202 MB | 10 MB |

Both draw on a canvas and keep scrolling out of React, so both scroll without dropping frames and commit once per
key on this screen. 0.2 sorts six times faster, and with its engine in a worker the page never stops while a million
rows are sorted. The accessibility rows render each row as a component of its own, so that a key renders again only
the rows whose selection changed (§6.4).

### A.3 The core of the specification and the engine

- `applyCommand` of `vastgrid-spec` copied the whole state for each command (`structuredClone`): a `move` took
  8.8 µs with an empty state and 74 ms with an undo history of 100,000 updates. It now copies only what a command
  changes (§4.1): 6.0 µs and 2.8 µs. A context of 1,000 loaded blocks costs 194 µs per move through `rows`; the
  store gives `lookup` instead (§6.1 of the specification).
- `vastgrid-js` checked every value of a table when it opened it: 238 ms for the bench's table, most of it reading
  dates with a regular expression and an array per date. It now checks the values it reads (a column whole before
  it sorts or sums it), and dates and times are read character by character (215 ms to 22 ms for a million dates):
  opening the table takes 4 ms.
- Vite 8 turns `light-dark()` into variables that need a `color-scheme` declaration (Lightning CSS); 0.1's styles
  have none, so in such a build every color of the canvas is invalid and it draws black. 0.2's styles declare
  `color-scheme` (§6.5), and the end-to-end tests check the canvas's pixels.
