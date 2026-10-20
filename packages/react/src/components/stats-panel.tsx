import { useEffect, useState } from "react";
import { type ColumnSchema, type ColumnStats, isAbortError, isTemporalType, type ValueFormatter } from "vastgrid-core";
import type { Messages } from "../messages.js";

function temporalLabel(seconds: number, type: ColumnSchema["type"]) {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return String(seconds);
  const iso = date.toISOString();
  return type === "date" ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

/** Statistics of one column: counts, range, distribution and the most common values. */
export function StatsPanel({
  schema,
  messages,
  formatter,
  count,
  number,
  load,
}: {
  schema: ColumnSchema;
  messages: Messages;
  formatter: ValueFormatter;
  count: (value: number) => string;
  number: (value: number) => string;
  load: (signal: AbortSignal) => Promise<ColumnStats> | null;
}) {
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      ?.then((result) => {
        if (!controller.signal.aborted) setStats(result);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [load]);

  const s = messages.stats;
  const value = (item: ColumnStats["min"]) =>
    item === undefined || item === null ? "—" : formatter.format(item, schema.type);
  const percent = (part: number, whole: number) =>
    whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(part === 0 || part === whole ? 0 : 1)}%`;
  const histogram = stats?.histogram ?? null;
  const peak = histogram ? Math.max(1, ...histogram.map((bin) => bin.count)) : 1;
  const topPeak = stats?.top?.length ? Math.max(1, ...stats.top.map((item) => item.count)) : 1;
  const edge = (point: number) => (isTemporalType(schema.type) ? temporalLabel(point, schema.type) : number(point));

  return (
    <div className="vg-stats">
      <p className="vg-panel__title">
        {schema.name}
        <span className="vg-panel__muted">
          {" "}
          · {messages.types[schema.type] ?? schema.type}
          {schema.sourceType ? ` (${schema.sourceType})` : ""}
        </span>
      </p>
      {error && <p className="vg-panel__error">{error}</p>}
      {!stats && !error && <p className="vg-panel__muted">{messages.loading}</p>}
      {stats && (
        <>
          <dl className="vg-stats__list">
            <dt>{s.rows}</dt>
            <dd>{count(stats.rows)}</dd>
            <dt>{s.nulls}</dt>
            <dd>
              {count(stats.nulls)} ({percent(stats.nulls, stats.rows)})
            </dd>
            <dt>{s.distinct}</dt>
            <dd>
              {stats.distinct === null ? "—" : `${stats.distinctApproximate ? "≈ " : ""}${count(stats.distinct)}`}
            </dd>
            <dt>{s.min}</dt>
            <dd>{value(stats.min)}</dd>
            <dt>{s.max}</dt>
            <dd>{value(stats.max)}</dd>
            {stats.mean !== undefined && stats.mean !== null && !isTemporalType(schema.type) && (
              <>
                <dt>{s.mean}</dt>
                <dd>{number(stats.mean)}</dd>
              </>
            )}
            {stats.stddev !== undefined && stats.stddev !== null && !isTemporalType(schema.type) && (
              <>
                <dt>{s.stddev}</dt>
                <dd>{number(stats.stddev)}</dd>
              </>
            )}
            {stats.quantiles && (
              <>
                <dt>{s.quartiles}</dt>
                <dd>
                  {stats.quantiles.map((item) => (typeof item === "number" ? number(item) : value(item))).join(" / ")}
                </dd>
              </>
            )}
            {stats.minLength !== undefined && stats.minLength !== null && (
              <>
                <dt>{s.length}</dt>
                <dd>
                  {count(stats.minLength)} – {count(stats.maxLength ?? stats.minLength)}
                </dd>
              </>
            )}
          </dl>
          {histogram && histogram.length > 1 && (
            <figure className="vg-stats__histogram">
              <figcaption>{s.histogram}</figcaption>
              <div className="vg-stats__bars">
                {histogram.map((bin) => (
                  <span
                    key={bin.start}
                    className="vg-stats__bar"
                    style={{ height: `${Math.max(bin.count > 0 ? 3 : 0, (bin.count / peak) * 100)}%` }}
                    title={`${edge(bin.start)} – ${edge(bin.end)}: ${count(bin.count)}`}
                  />
                ))}
              </div>
              <div className="vg-stats__axis">
                <span>{edge(histogram[0].start)}</span>
                <span>{edge(histogram[histogram.length - 1].end)}</span>
              </div>
            </figure>
          )}
          {stats.top && stats.top.length > 0 && (
            <figure className="vg-stats__top">
              <figcaption>{s.top}</figcaption>
              <ul>
                {stats.top.map((item) => (
                  <li key={`${typeof item.value}:${String(item.value)}`}>
                    <span className="vg-stats__top-bar" style={{ width: `${(item.count / topPeak) * 100}%` }} />
                    <span className="vg-stats__top-label">
                      {item.value === null || item.value === ""
                        ? messages.blank
                        : formatter.format(item.value, schema.type)}
                    </span>
                    <span className="vg-stats__top-count">{count(item.count)}</span>
                  </li>
                ))}
              </ul>
            </figure>
          )}
        </>
      )}
    </div>
  );
}
