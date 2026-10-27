---
title: DataGrid
description: Every prop of DataGrid, controlled and uncontrolled state, the handle, GridProvider, the hooks and the cells' hooks.
---

```tsx
import { DataGrid, localTransport } from "vastgrid";
import "vastgrid/styles.css";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders } }));

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

`DataGrid` draws a table on a canvas, reads rows through a transport as it scrolls, and does everything with the
[commands](/reference/commands/) of the specification. It renders on the server too (the canvas only in the
browser). [§5 of the React specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-react.md#5-components-and-hooks)
is the source of this page.

## Props

### Data

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `transport` | `Transport` | | Where the engine is ([transports](/reference/core/#transports)). With `table`. |
| `table` | `string` | | The `ref` of the table to open: a name of the memory engine's `tables`, or a file of the DuckDB engine. |
| `open` | `OpenOptions` | | The `read` options of `open`: `sheet`, `headerRow`, `keepEmptyRows`, `keepEmptyColumns`. |
| `store` | `GridStore` | | A store made outside, instead of `transport` and `table`. |

The grid makes its own store from `transport`, `table` and `open`, once, and connects it while it is mounted; a
new transport or table makes a new store. Without `store`, or `transport` and `table`, it throws. A `store` that is
given is not connected by the grid: make it with `useCreateGridStore`, which connects it, or call its
`connect()` in an effect.

### State

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `document` | `GridDocument` | | The view and its columns ([§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#51-document)), controlled. |
| `defaultDocument` | `GridDocument` | the empty document | The document to start with, uncontrolled. |
| `onDocumentChange` | `(document: GridDocument) => void` | | Called with the document that a command makes. |
| `session` | `GridSession` | | Where the person is ([§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#52-session)), controlled. |
| `defaultSession` | `GridSession` | the empty session | The session to start with, uncontrolled. |
| `onSessionChange` | `(session: GridSession) => void` | | Called with the session that a command makes, on every move of the active cell. |
| `initial` | `InitialView \| Promise<InitialView>` | | Rows read on the server ([`readInitialView`](/reference/core/#vastgridserver)), drawn in the first frame. A promise suspends the grid until it resolves, with a busy placeholder of the grid's size. |

### Interface

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `toolbar` | `boolean` | `true` | The toolbar: search, conditions, columns, groups, formulas, details, export and save, as the engine's capabilities allow. |
| `statusBar` | `boolean` | `true` | The status bar: the row count, loading, the selection's count, sum and average, checked rows, and writes that are unsaved or failed. |
| `checkboxes` | `boolean` | `false` | A check box for each row in the gutter and one for every row in the corner; Space checks the active row. |
| `columnGroups` | `readonly ColumnGroup[]` | | Groups of columns named in header rows above the column names; nested groups add rows. |
| `groupHeaderHeight` | `number` | `--vg-group-header-height` (24) | The height of each row of groups, in CSS pixels. |
| `wrapLines` | `number` | `2` | How many lines rows have while a displayed column wraps its text (`format.wrap`). |
| `detailPanel` | `ComponentType<DetailPanelProps>` | a list of the row's columns | The content of the detail panel, for the active row. |

### Cells

These are functions, not state: they win over the document's formats and styles, run for every loaded cell on
screen at every frame that draws it, and must be cheap and stable (module functions, or `useCallback`).

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `cellText` | `(cell: GridCell) => string \| null \| undefined` | | The text of a cell instead of the grid's; null or undefined keeps the grid's. |
| `cellStyle` | `(cell: GridCell) => CellStyle \| null \| undefined` | | The colors of a cell instead of the column's style rules; null or undefined keeps them. |
| `drawCell` | `(args: DrawCellArgs) => void` | | Draws a cell on the canvas, with `drawDefault()` at hand; the canvas's state is restored afterwards. |
| `cellAction` | `(cell: GridCell) => CellAction \| null \| undefined` | | Makes cells links or buttons. |
| `onCellAction` | `(event: CellActionEvent) => void` | | Called on a click, or Space, on a cell that `cellAction` made a link or a button. |

### Sizes

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `rowHeight` | `number` | `--vg-row-height` (24) | The height of a row, in CSS pixels. |
| `headerHeight` | `number` | `--vg-header-height` (32) | The height of the header row, in CSS pixels. |

The CSS variables of `vastgrid/styles.css` set the colors, fonts and sizes ([Theming](/guides/theming/)).

### Language

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `locale` | `string` | the browser's language | A BCP 47 tag for the UI's texts and numbers. English and Japanese are built in. |
| `messages` | `Partial<GridMessages>` | | Texts that replace those of `locale`'s messages. |

See [Localization](/guides/localization/).

### Events

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `onError` | `(error: GridError) => void` | | Failures that belong to no command: a read that fails, a table that cannot be read ([errors](/reference/core/#errors)). A command's own failure is its `CommandOutcome`. |

### Root element

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `ref` | `Ref<DataGridHandle>` | | The handle. |
| `className` | `string` | | Added to `vg-root`. |
| `style` | `CSSProperties` | | The root's style. The root is `height: 100%`: give it, or its parent, a height. |
| `aria-label` | `string` | `messages.grid` ("Data table") | The grid's accessible name. |

## Controlled and uncontrolled state

[§5.2 of the React specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-react.md#52-controlled-and-uncontrolled-state).

- `defaultDocument` and `defaultSession` give the state to start with; the grid then keeps it.
- With `document` (or `session`), the grid shows the prop. A command reports the state the grid would have to
  `onDocumentChange` (`onSessionChange`), and the grid shows it once the parent passes it back. A parent that passes
  back something else, or nothing, wins.
- Commands dispatched before the parent renders again apply to the last state reported, so two commands in one
  event both take effect.
- A new prop reaches the store in a layout effect of the commit that brings it, so the canvas never shows the state
  of an earlier render.
- `onSessionChange` is called on every move of the active cell. A parent that keeps the session in state should
  render little with it, or read it through `useDeferredValue`.

```tsx
const [document, setDocument] = useState<GridDocument>(saved);

<DataGrid transport={transport} table="orders" document={document} onDocumentChange={setDocument} />;
```

See [State](/guides/state/).

## The handle

```ts
interface DataGridHandle {
  store: GridStore;
  dispatch: GridStore["dispatch"];
  focus(): void; // moves the focus to the grid
}
```

`ref` gives the handle; everything else goes through the store ([vastgrid/core](/reference/core/)) and commands.

## Hooks and `GridProvider`

`GridProvider` gives a store to the components inside it, so that a host builds its own controls beside the grid.
`DataGrid` gives its store to its own children the same way.

```tsx
import { DataGrid, GridProvider, useCreateGridStore, useGridDispatch, useGridSelector } from "vastgrid";

function Workbench() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <ClearSort />
      <DataGrid store={store} toolbar={false} />
    </GridProvider>
  );
}

function ClearSort() {
  const sort = useGridSelector((snapshot) => snapshot.document.plan?.sort);
  const dispatch = useGridDispatch();
  return (
    <button type="button" disabled={!sort} onClick={() => dispatch({ command: "sort.clear" })}>
      Clear sort
    </button>
  );
}
```

| Hook | Gives |
| --- | --- |
| `useGridStore()` | The store of the nearest `DataGrid` or `GridProvider`; throws without one. |
| `useGridSelector(selector, isEqual?)` | `selector(snapshot)`. The component renders again only when it changes by `isEqual` (`Object.is` by default). |
| `useGridDispatch()` | The store's `dispatch`, the same function on every render. |
| `useGridRows({ start, end, columns })` | The values of rows `[start, end)` of the view on screen, one array per row, `undefined` for values not read yet. Reads them when they are missing, and renders again when they arrive. |
| `useCreateGridStore(options)` | A store for the life of the component, made once from the first `GridStoreOptions` and connected while it is mounted. |

- Selectors run on every change of the store: they must be cheap and make no new objects, unless `isEqual`
  compares them. `shallowEqual(a, b)` compares the members of two objects or arrays with `Object.is`:
  `useGridSelector((snapshot) => [snapshot.status, snapshot.view?.rowCount], shallowEqual)`.
- Rows are not in snapshots; they change inside the store's cache. `useGridRows` follows them. A function that reads
  them during render takes the rows' version as an argument, `readRows(store, version, start, end, columns)` with
  `version` from `store.getRowsVersion()`, so that memoization (React Compiler's included) reads them again when
  it changes.

## The cells' types

```ts
interface GridCell {
  row: number; // the view position of its row
  column: Column; // { name, type, … }
  value: JsonValue;
  text: string; // the text the grid shows, by the column's format
}

interface CellStyle {
  color?: string;
  background?: string;
  description?: string; // what the colors mean, for screen readers
}

interface CellAction {
  kind: "link" | "button";
  label?: string; // the name for screen readers, instead of the cell's text
  cursor?: string; // the CSS cursor over the cell, "pointer" by default
}

interface DrawCellArgs extends GridCell {
  ctx: CanvasRenderingContext2D; // in CSS pixels, with the cell font, textBaseline "middle" and the column's alignment
  rect: { x: number; y: number; width: number; height: number };
  style: CellStyle | null;
  theme: GridTheme; // the grid's colors and fonts
  drawDefault(): void; // draws the cell as the grid does
}

interface CellActionEvent extends GridCell {
  action: CellAction;
  key: RowKey | undefined; // the key of the cell's row, when it is read
}

interface ColumnGroup {
  name: string;
  children: (string | ColumnGroup)[]; // column names of the view, and groups
}

interface DetailPanelProps {
  row: number; // the active row's position
  columns: readonly Column[]; // the view's columns
  values: readonly JsonValue[]; // its values, in the order of `columns`
  rowKey: RowKey | undefined;
}
```

`CellHooks` groups `cellText`, `cellStyle`, `drawCell` and `cellAction` with these types.

## Examples

### Column groups

```tsx
import type { ColumnGroup } from "vastgrid";

const groups: ColumnGroup[] = [
  { name: "Customer", children: ["name", "email"] },
  { name: "Order", children: ["date", { name: "Amount", children: ["net", "tax", "total"] }] },
];

<DataGrid transport={transport} table="orders" columnGroups={groups} />;
```

Groups change only the header. A group is drawn over the run of its columns that are next to each other, so one
whose columns are moved apart, hidden or pinned apart is split, and each part shows its name. Clicking a group's
header selects its columns.

### Cell styles and actions

```tsx
import type { CellAction, CellActionEvent, CellStyle, GridCell } from "vastgrid";

function cellStyle({ column, value }: GridCell): CellStyle | null {
  if (column.name === "balance" && typeof value === "number" && value < 0) {
    return { color: "#b42318", description: "Negative" };
  }
  return null;
}

function cellAction({ column }: GridCell): CellAction | null {
  return column.name === "url" ? { kind: "link" } : null;
}

function onCellAction({ value }: CellActionEvent) {
  if (typeof value === "string") window.open(value, "_blank", "noopener");
}

<DataGrid transport={transport} table="accounts" cellStyle={cellStyle} cellAction={cellAction} onCellAction={onCellAction} />;
```

Links are drawn underlined in the link color; screen readers hear links and buttons with their `label`. Space on
other cells still checks rows.

### A detail panel of your own

```tsx
import { Fragment } from "react";
import type { DetailPanelProps } from "vastgrid";

function OrderDetail({ columns, values }: DetailPanelProps) {
  return (
    <dl>
      {columns.map((column, index) => (
        <Fragment key={column.name}>
          <dt>{column.name}</dt>
          <dd>{String(values[index])}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

<DataGrid transport={transport} table="orders" detailPanel={OrderDetail} />;
```

The panel opens with the toolbar's Details button, Alt+Enter or `detail.open`, beside the body (below it in a
grid narrower than 640 pixels). It follows the active row; the component renders once all the row's values are read.

### Checked rows

```tsx
function Orders() {
  const store = useCreateGridStore({ transport, table: "orders" });
  return (
    <GridProvider store={store}>
      <DataGrid store={store} checkboxes />
      <CheckedCount />
    </GridProvider>
  );
}

function CheckedCount() {
  const checked = useGridSelector((snapshot) => snapshot.session.checked);
  if (!checked) return <p>No rows checked</p>;
  return <p>{checked.mode === "include" ? `${checked.keys.length} checked` : `All but ${checked.keys.length}`}</p>;
}
```

Rows are checked by key (`{ rowId }`, or `{ value }` of the document's `rowKey`), so the same records stay checked
when the view is sorted or filtered. The corner's box checks every row of the view (`check.all`), or unchecks them
once all are checked (`check.clear`). Rows whose state is unknown show a dash.

## Messages and keys

- `messagesFor(locale)` gives the built-in texts of a locale: Japanese for tags that start with `ja`, English
  otherwise. `GridMessages` is their type: a string for each text (`grid`, `loading`, `search`, `save`, …),
  functions for texts with numbers (`rows(count)`), and records for lists (`operators`, `exportFormats`,
  `measureNames`, `statisticNames`, `numberStyles`, `alignments`, `pinned`). `messages` replaces members whole.
- `keyCommand(event, apple)` gives the command that a key press means in the grid, or null, and `isApple()` tells
  whether the platform's primary modifier is ⌘.
