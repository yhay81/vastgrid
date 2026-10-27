/** DuckDB is the independent reference for the specification's date, time and interval text forms. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { dateText, intervalText, timestampText, timeText } from "vastgrid-spec";

let instance: DuckDBInstance;
let connection: DuckDBConnection;
before(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
});
after(() => {
  connection.closeSync();
  instance.closeSync();
});

test("text forms of dates, times, timestamps and intervals are DuckDB's (§2.4)", async () => {
  const one = async (sql: string) => (await connection.runAndReadAll(sql)).getRowsJS()[0];
  for (const text of ["1969-12-31 23:59:59.999999999", "2200-01-01 00:00:00.123456789", "2024-01-31 12:00:00.5"]) {
    const [cast, count] = await one(`SELECT CAST(TIMESTAMP_NS '${text}' AS VARCHAR), epoch_ns(TIMESTAMP_NS '${text}')`);
    assert.equal(timestampText(BigInt(count as bigint), "ns"), cast);
  }
  for (const text of ["0001-01-01 00:00:00", "1969-12-31 23:59:59.999999", "9999-12-31 23:59:59.25"]) {
    const [cast, count] = await one(`SELECT CAST(TIMESTAMP '${text}' AS VARCHAR), epoch_us(TIMESTAMP '${text}')`);
    assert.equal(timestampText(BigInt(count as bigint), "us"), cast);
  }
  const [ms, msCount] = await one(
    "SELECT CAST(TIMESTAMP_MS '1969-12-31 23:59:59.5' AS VARCHAR), epoch_ms(TIMESTAMP_MS '1969-12-31 23:59:59.5')",
  );
  assert.equal(timestampText(BigInt(msCount as bigint), "ms"), ms);
  const [s, sCount] = await one(
    "SELECT CAST(TIMESTAMP_S '1900-03-01 00:00:01' AS VARCHAR), CAST(epoch(TIMESTAMP_S '1900-03-01 00:00:01') AS BIGINT)",
  );
  assert.equal(timestampText(BigInt(s === null ? 0 : (sCount as bigint)), "s"), s);
  for (const text of ["0001-01-01", "1969-12-31", "2000-02-29", "9999-12-31"]) {
    const [cast, days] = await one(
      `SELECT CAST(DATE '${text}' AS VARCHAR), date_diff('day', DATE '1970-01-01', DATE '${text}')`,
    );
    assert.equal(dateText(Number(days)), cast);
  }
  for (const text of ["00:00:00", "23:59:59.999999", "12:00:00.25"]) {
    const [cast, micros] = await one(
      `SELECT CAST(TIME '${text}' AS VARCHAR), date_diff('microsecond', TIME '00:00:00', TIME '${text}')`,
    );
    assert.equal(timeText(BigInt(micros as bigint)), cast);
  }
  const intervals: [number, number, number][] = [
    [14, 3, 14_706_789_000],
    [0, 0, -5_400_000_000],
    [0, 0, 0],
    [0, 0, 129_600_000_000],
    [1, 1, 0],
    [-14, -1, 0],
    [12, 0, 1],
    [-1, 2, -1],
  ];
  for (const [months, days, micros] of intervals) {
    const [cast] = await one(
      `SELECT CAST(to_months(${months}) + to_days(${days}) + to_microseconds(${micros}) AS VARCHAR)`,
    );
    assert.equal(intervalText({ months, days, nanos: BigInt(micros) * 1000n }), cast, `${months} ${days} ${micros}`);
  }
});
