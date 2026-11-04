import { useEffect, useState } from "react";
import { DataGrid, type GridDocument, type Transport, workerTransport } from "vastgrid";
import { ja } from "vastgrid/locales/ja";
import "vastgrid/styles.css";

/** The order number stays at the left as the grid scrolls sideways. */
const pinned: GridDocument = { kind: "vastgrid/document", version: 2, columns: [{ name: "order_id", pin: "left" }] };

interface Props {
  locale?: "en" | "ja";
  rows?: number;
}

/** The home page's grid: made-up orders, made and held by the memory engine in a Web Worker. */
export function LiveGrid({ locale = "en", rows = 100_000 }: Props) {
  const [transport, setTransport] = useState<Transport>();
  useEffect(() => {
    const worker = new Worker(new URL("./orders-worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ rows });
    const opened = workerTransport(worker);
    // oxlint-disable-next-line react/set-state-in-effect -- the transport is the Worker's, made and closed with it.
    setTransport(opened);
    return () => {
      opened.close();
      worker.terminate();
    };
  }, [rows]);
  if (!transport) return null;
  return (
    <DataGrid
      transport={transport}
      table="orders"
      defaultDocument={pinned}
      locale={locale}
      messages={locale === "ja" ? ja : undefined}
      statusBar
      aria-label={locale === "ja" ? "架空の注文" : "Made-up orders"}
    />
  );
}
