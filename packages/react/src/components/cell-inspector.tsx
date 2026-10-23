import { useEffect, useState } from "react";
import { type CellValue, type ColumnFormatter, isAbortError, plainText } from "vastgrid-core";
import type { Messages } from "../messages.js";

/** Pretty-prints JSON text; returns null when the text is not a JSON object or array. */
function prettyJson(text: string) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * The full value of a cell, with line breaks, JSON formatting and a copy button, and the text the cell
 * shows when the column formats it.
 */
export function CellInspector({
  formatter,
  messages,
  location,
  load,
  onCopy,
}: {
  formatter: ColumnFormatter;
  messages: Messages;
  location: string;
  load: (signal: AbortSignal) => Promise<CellValue>;
  onCopy: (text: string) => void;
}) {
  const [value, setValue] = useState<{ text: string; shown: string; isNull: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setValue({ text: plainText(result), shown: formatter.text(result), isNull: result === null });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [load, formatter]);

  const json = value ? prettyJson(value.text) : null;
  const schema = formatter.schema;
  const { number, date, format } = formatter.settings;
  const formatted = number !== undefined || date !== undefined || format !== undefined;
  return (
    <div className="vg-inspector">
      <p className="vg-panel__title">
        {formatter.label}
        <span className="vg-panel__muted">
          {" "}
          {formatter.label !== schema.name ? `(${schema.name}) ` : ""}· {location} ·{" "}
          {messages.types[schema.type] ?? schema.type}
        </span>
      </p>
      {error && <p className="vg-panel__error">{error}</p>}
      {!value && !error && <p className="vg-panel__muted">{messages.loading}</p>}
      {value && (
        <pre className="vg-inspector__value" data-null={value.isNull || undefined}>
          {value.isNull ? "NULL" : (json ?? value.text)}
        </pre>
      )}
      {value && !value.isNull && formatted && value.shown !== value.text && (
        <p className="vg-panel__muted">
          {messages.shownAs}: {value.shown}
        </p>
      )}
      <div className="vg-panel__actions">
        <button type="button" className="vg-button" disabled={!value} onClick={() => value && onCopy(value.text)}>
          {messages.copy}
        </button>
      </div>
    </div>
  );
}
