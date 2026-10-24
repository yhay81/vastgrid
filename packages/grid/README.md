# vastgrid-grid

vastgrid v2 for React, as [v2-react.md](../../docs/v2-react.md) describes it. It is a draft, is not published yet,
and becomes `vastgrid` when v1 is removed.

- **`DataGrid`** draws a table of any size on a canvas and reads its rows through a transport as you scroll. It
  takes the document and the session of the [specification](../../docs/v2-spec.md) (§5), controlled or not, and
  every change is a command of §6.
- **Hooks**: `useGridSelector(selector, isEqual?)` reads a part of the store's immutable snapshot and renders
  again only when it changes; `useGridDispatch()` dispatches typed commands (`GridCommand`); `useGridRows` reads
  rows for cells that React renders; `useCreateGridStore` and `GridProvider` build your own UI around the grid.
- **`vastgrid-grid/core`** is the store without React: `createGridStore`, the client of the messages (§8) and the
  transports (`localTransport`, `workerTransport` with `serveEngine`, `httpTransport`, `serverFunctionTransport`).
- **`vastgrid-grid/server`** reads the first rows on a server (`readInitialView`), which `DataGrid` sends as HTML
  before the canvas takes over in the browser.

It needs React 19.3 or later. Scrolling, drawing and dragging a selection render no React; moving the active cell
commits once and renders only what selects the session. Every component and hook compiles with React Compiler 1.0
(the build fails otherwise), and the package ships compiled.

```tsx
import { DataGrid } from "vastgrid-grid";
import "vastgrid-grid/styles.css";
import { localTransport } from "vastgrid-grid/core";
import { memoryEngine } from "vastgrid-js";

const transport = localTransport(memoryEngine({ tables: { orders: { columns, rows } } }));

export function Orders() {
  return <DataGrid transport={transport} table="orders" style={{ height: 480 }} />;
}
```

The tests run on the sources (`npm test`); [`e2e`](../../e2e) runs the bench of [`examples/bench`](../../examples/bench)
in Chromium against the build (`npm run build && npm run e2e`).
