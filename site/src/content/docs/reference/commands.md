---
title: Commands
description: Every command that changes the grid's state, by group, how to dispatch one and why one fails.
---

A command is a JSON object, `{ command: name, …arguments }`
([§6.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#61-applying-a-command)). The grid's keys,
menus and toolbar do everything with commands, and a host or an agent dispatches the same ones: a sort, a filter,
a selection, a write and an export are each one command. Applied to the document and the session, a command gives
the new state, the requests that the store then sends to the engine, and for some commands an output. Commands
are deterministic, and one that fails changes nothing.

```ts
{ command: "sort.set", keys: [{ column: "total", direction: "desc" }] }
{ command: "filter.column", column: "region", where: { fn: "eq", args: [{ col: "region" }, { lit: "EU" }] } }
{ command: "select", row: 0, column: "total" }
{ command: "export", format: "csv", rows: "view" }
```

## Dispatching

```tsx
import { DataGrid, type DataGridHandle } from "vastgrid";
import { useRef } from "react";

const grid = useRef<DataGridHandle>(null);
// …
<DataGrid ref={grid} transport={transport} table="orders.csv" />;
// …
const outcome = await grid.current?.dispatch({ command: "search.set", text: "Tokyo" });
```

- `dispatch` of the grid's handle, `useGridDispatch()` inside the grid, and `store.dispatch` of a store are the
  same function ([vastgrid/core](/reference/core/#dispatching)). It resolves to a `CommandOutcome` once the
  command's requests are answered, and never rejects: `{ ok: true, output? }` or `{ ok: false, error }`.
- `copy` gives `{ tsv, html, markdown }` as its output, and `edit.paste` `{ cutRows, cutColumns }`
  (`CommandOutputs` of `vastgrid-spec`).
- A command that needs rows that are not read yet reads them and is applied again, so a host need not read rows
  first.
- `GridCommand` (the union of every command), `CommandName` and `CommandOutputs` are types of `vastgrid`.

## When a command fails

A command that cannot be applied fails with a `CommandError` of `vastgrid-spec`:
`{ code: "invalid_command", path, reason, message, details? }`, where `path` is a JSON Pointer into the command
(`""` for the command as a whole). When several reasons apply, the first of this table wins:

| `reason` | When |
| --- | --- |
| `unknown_command` | There is no such command. |
| `syntax` | An argument of the wrong form, a missing argument, or a member the command does not take. |
| `unknown_column` | A column that the view does not have, or that is not displayed where a displayed one is needed. |
| `no_editor` | An editor command without an editor. |
| `nothing` | Undo or redo with nothing to undo or redo. |
| `unsupported` | The engine does not offer it ([capabilities](/reference/engines/#capabilities)). |
| `unknown_state` | Checking or unchecking rows whose state is not known yet. |
| `last_column` | Hiding every column of the view. |
| `type` | A total that does not fit the column's type. |
| `copy_layout` | Ranges that cannot be copied together. |
| `paste_ranges` | Several values pasted into several ranges. |
| `read_only` | Writing a cell that cannot be written; `details.column` names its column. |
| `too_many_cells` | A write of more than 100,000 cells (`WRITE_LIMIT`), or a copy of more than 1,000,000 (`COPY_LIMIT`). |
| `not_loaded` | Rows the command needs are not read: `details.rows` has the spans `[start, end)` and `details.columns` the columns. The store reads them and applies the command again. |
| `invalid_value` | Text that does not read as its column's type; `details` has the `row`, `column` and `error` of the first such cell. |
| `invalid_plan` | The plan the command would make does not check; `details` has the plan error's `path` and `reason`. |

A command can also fail with a `GridError` from the engine, such as `read_only` or `edit_conflict` for a write
([errors](/reference/core/#errors)).

## The plan

[§6.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#62-the-plan). These change the document's
`plan`; the store then reads the new view and keeps the active row where it can.

| Command | Arguments | Effect |
| --- | --- | --- |
| `sort.set` | `keys`: `{ column, direction: "asc" \| "desc" }[]` | The sort becomes `keys`; no keys remove it. |
| `sort.toggle` | `column`; `add`: boolean | Without `add`, none → ascending → descending → none, replacing the other keys. With `add`, the column's key changes in its place or is added at the end. |
| `sort.clear` | | Removes the sort. |
| `filter.set` | `where`: an expression or null | The conditions become the parts of `where`, after the search. |
| `filter.column` | `column`; `where`: an expression or null | The conditions of that column become the parts of `where`; every part refers to that column only. |
| `filter.clear` | | Removes the conditions and keeps the search. |
| `search.set` | `text` | The search becomes `text`, first among the parts of `where`; blank text removes it. |
| `derive.add` | `name`, `expr`; `before`: a derived column | Adds a derived column at the end, or before `before`. |
| `derive.update` | `name`; `expr`; `rename` | Changes the expression, or renames the column everywhere it is used. |
| `derive.remove` | `name` | Removes the derived column and what uses it. |
| `group.set` | `aggregate`: `{ keys, measures, pivot? }` | Groups the rows; parts of `having` and sort keys that no longer fit are removed. |
| `group.clear` | | Removes the groups and `having`. |
| `having.set` | `having`: an expression or null | Sets or removes the condition on groups. |

Expressions are JSON (`{ col }`, `{ lit }`, `{ fn, args }`,
[§4.3](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#43-expressions)); formulas typed in the grid
compile to them ([Formulas](/guides/formulas/)).

## Columns

[§6.3](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#63-columns). These change the document's
`columns`.

| Command | Arguments | Effect |
| --- | --- | --- |
| `column.resize` | `name`; `width`: pixels or null | Sets the width, or fits the column to its values again. |
| `column.move` | `names`: displayed columns; `before`: a displayed column or null | Moves the columns before `before`, with its pin; with null, after the last column without pin. |
| `column.hide` | `names` | Hides the columns and unpins them; fails with `last_column` when none would be left. |
| `column.show` | `names`, or `all: true` | Shows the columns, or every column of the view. |
| `column.pin` | `name`; `side`: `"left"`, `"right"` or null | Pins the column at that side, or unpins it. |
| `column.format` | `name`; `format`: a format or null | Sets or removes the format: `label`, `number`, `date`, `align`, `wrap`, `copy` and conditional `styles`. |
| `column.total` | `name`; `total`: `{ fn, p? }` or null | Sets or removes the column's total in the totals row. |

## Selection, scrolling and checked rows

[§6.4](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#64-selection-scrolling-and-checked-rows).
These change the session. Rows are positions in the view, and columns are names of displayed columns.

| Command | Arguments | Effect |
| --- | --- | --- |
| `select` | `row`, `column`; `mode`: `replace` (default), `extend` or `add` | Makes the cell active and the only range; `extend` stretches the last range to it, `add` adds a range. |
| `select.rows` | `from`, `to`; `mode` | Selects whole rows. |
| `select.columns` | `from`, `to`: displayed columns; `mode` | Selects whole columns. |
| `select.all` | | Selects every cell. |
| `move` | `direction`: `up`, `down`, `left`, `right`; `extend`, `jump`, `page`: booleans | Moves the active cell (or extends the selection) by one, by a page, or to the edge. |
| `move.home`, `move.end` | `extend`, `jump`: booleans | Moves to the first or last column of the row; with `jump`, also to the first or last row. |
| `advance` | `axis`: `row` or `column`; `back`: boolean | Enter and Tab: walks through a selection of several cells, or moves like `move`. |
| `scroll.to` | `row`; `column` | Scrolls to the row and column. |
| `check`, `uncheck` | `keys`: row keys | Checks or unchecks rows by key. |
| `check.all` | | Checks every row of the view. |
| `check.clear` | | Unchecks every row. |
| `detail.open`, `detail.close` | | Opens or closes the detail panel. |

## Editing

[§6.5](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#65-editing). Writes go to the engine as one
`write` request, with each cell's previous value, and become one step of the undo history.

| Command | Arguments | Effect |
| --- | --- | --- |
| `edit.begin` | `text` | Opens an editor on the active cell, with `text` or the cell's value. |
| `edit.change` | `text` | Changes the editor's text. |
| `edit.cancel` | | Closes the editor. |
| `edit.commit` | `move`: `up`, `down`, `left`, `right` or null | Reads the text as the column's type and writes it; the active cell then moves. |
| `edit.clear` | | Writes null into the selected cells that can be written. |
| `edit.paste` | | Pastes the clipboard (`DispatchOptions.clipboard`, TSV or an HTML table) into the selection. |
| `edit.fill` | `direction`: `down` or `right` | Copies the first row (or column) of each range into the rest of it. |
| `history.undo`, `history.redo` | | Writes the values before (or after) the last step. |

A person's write is `select`, `edit.begin` with the text, then `edit.commit`; an agent writes cells the same way.
See [Editing](/guides/editing/).

## Copying, exporting and saving

[§6.6](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#66-copying-and-exporting).

| Command | Arguments | Effect |
| --- | --- | --- |
| `copy` | `headers`: boolean; `values`: `raw` (default) or `formatted` | Gives the selected cells as `{ tsv, html, markdown }`. |
| `export` | `format`; `columns`: `displayed` (default) or `all`; `rows`: `view` (default) or `table`; `target` | Exports the view (or the whole table, with written values) in a format of the engine's `export.formats`. |
| `save` | | Saves written cells into the table's file, when the engine can. |

See [Export and save](/guides/export/).

## Commands of the core

`view.update`, `history.push`, `history.undone`, `history.redone` and `history.clear`
([§6.7](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#67-commands-of-the-core)) are applied by the
store itself as answers arrive; hosts and agents do not need them.

## The document and the session

Commands change two parts of the state, both plain JSON with their own versions:

- The **document** ([§5.1](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#51-document)) is what a
  person saves, shares or gives an agent: `rowKey`, the `plan` (derived columns, conditions, groups, sort) and the
  column settings (`width`, `hidden`, `pin`, `format`, `total`).
- The **session** ([§5.2](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#52-session)) is where the
  person is: the active cell, the selection, the scroll position, the checked rows, the detail panel, an editor
  and the undo history.

```json
{
  "kind": "vastgrid/document",
  "version": 2,
  "plan": { "sort": [{ "column": "price", "direction": "desc" }] },
  "columns": [{ "name": "id", "pin": "left" }, { "name": "price", "width": 120, "total": { "fn": "sum" } }]
}
```

A grid controls either part or leaves it to itself ([State](/guides/state/)). A document of another version is
refused; `migrateGridState` of `vastgrid-spec` turns a saved state of 0.1 into a document
([§5.6](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#56-versions-and-migration),
[Migrating from 0.1](/migrating-from-0-1/)).

## For agents and hosts

- `vastgrid-spec/schema/commands.schema.json` gives the form of every command (`$defs/command`), for agents and
  hosts that send them; `state.schema.json` gives the document and the session.
- `COMMANDS` of `vastgrid-spec` lists the names, and `applyCommand(state, command, context)` applies a command
  without a store, as the specification defines it.
- The MCP App's `grid_command` tool applies these commands to the grid that the person sees
  ([MCP App](/apps/mcp/)); the VS Code extension's API does the same for a file open in vastgrid
  ([VS Code](/apps/vscode/)).
