import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { checkEvent } from "vastgrid-spec";
import { setUp } from "./client.ts";

for (const materializeRows of [0, 100_000]) {
  test(`saved views (${materializeRows === 0 ? "row order" : "all columns"}) preserve ties, IDs, derived values and positions`, async () => {
    const context = await setUp({ materializeRows, viewPreviewMinRows: 0, viewPreviewRows: 7, maxViews: 2 });
    const { client, engine, workspace } = context;
    try {
      await writeFile(
        path.join(workspace, "views.csv"),
        "id,score,rowid,vg_position\n" +
          Array.from({ length: 5000 }, (_, i) => `${i},${i % 13},row ${i},${i * 2}`).join("\n"),
      );
      const info = await client.open("views.csv");
      assert.equal(info.capabilities.preview, true);
      const events: Record<string, unknown>[] = [];
      engine.subscribe((event) => {
        checkEvent(event);
        events.push(event);
      });
      const plan = {
        derive: [{ name: "twice", expr: { fn: "mul", args: [{ col: "id" }, { lit: 2 }] } }],
        where: { fn: "ge", args: [{ col: "id" }, { lit: 100 }] },
        sort: [{ column: "score", direction: "desc" }],
      };
      const ids = Array.from({ length: 4900 }, (_, i) => i + 100).sort((a, b) => (b % 13) - (a % 13) || a - b);
      const head = await client.rows(info, {
        plan,
        end: 20,
        preview: true,
        columns: ["id", "twice", "rowid", "vg_position"],
      });
      assert.deepEqual(head.rowIds, ids.slice(0, 7));
      assert.equal(head.view.status, "building");
      assert.equal(head.view.rowCount, ids.length);
      assert.equal(head.view.rowCountExact, true);
      assert.equal(head.view.readableRows, 7);
      for (const start of [0, 2450, 4895, 5000, 0]) {
        const rows = await client.rows(info, {
          plan,
          start,
          end: start + 20,
          columns: ["id", "twice", "rowid", "vg_position"],
        });
        const expected = ids.slice(start, start + 20);
        assert.deepEqual(rows.rowIds, expected);
        assert.deepEqual(
          rows.rows,
          expected.map((id) => [id, id * 2, `row ${id}`, id * 2]),
        );
        assert.equal(rows.view.status, "ready");
      }
      assert.ok(
        events.some((event) => event.event === "view" && event.hash === head.view.hash && event.status === "ready"),
      );
      assert.equal((await client.rows(info, { plan, end: 1, preview: true })).view.status, "ready");
      const members = { table: info.table, revision: info.revision, plan };
      assert.deepEqual(await client.result("locate", { ...members, keys: [{ rowId: ids[2450] }, { rowId: 0 }] }), {
        rows: [2450, null],
      });
      const summary = await client.result("summarize", { ...members, columns: ["id"], ranges: [[2450, 2453]] });
      assert.equal(
        summary.sum,
        ids.slice(2450, 2453).reduce((a, b) => a + b, 0),
      );
      assert.deepEqual(
        await client.result("find", {
          ...members,
          columns: ["rowid"],
          text: `row ${ids[2450]}`,
          caseSensitive: true,
          direction: 1,
          from: { row: 2449, column: 0 },
        }),
        { row: 2450, column: 0 },
      );
      // A second handle shares the build, and closing/reopening keeps the same row order.
      await client.result("close", { table: info.table });
      const again = await client.open("views.csv");
      assert.deepEqual((await client.rows(again, { plan, start: 2450, end: 2453 })).rowIds, ids.slice(2450, 2453));
      // Eviction does not change the result when a plan is revisited.
      await client.rows(again, { plan: { sort: [{ column: "id", direction: "asc" }] }, end: 1 });
      await client.rows(again, { plan: { sort: [{ column: "id", direction: "desc" }] }, end: 1 });
      assert.deepEqual((await client.rows(again, { plan, end: 7 })).rowIds, head.rowIds);
    } finally {
      await context.tearDown();
    }
  });
}

test("cancelling one of two sort requests keeps the other reader alive and allows a later plan", async () => {
  const context = await setUp({ materializeRows: 0 });
  try {
    const { engine, client, workspace } = context;
    await writeFile(
      path.join(workspace, "cancel.csv"),
      `id\n${Array.from({ length: 200_000 }, (_, i) => i).join("\n")}`,
    );
    const info = await client.open("cancel.csv");
    const request = {
      v: 2,
      op: "rows",
      table: info.table,
      revision: info.revision,
      plan: { sort: [{ column: "id", direction: "desc" }] },
      start: 0,
      end: 5,
      columns: ["id"],
    };
    const first = engine.handle({ ...request, id: 9000 });
    const second = engine.handle({ ...request, id: 9001 });
    await engine.handle({ v: 2, id: 9002, op: "cancel", request: 9000 });
    assert.equal(((await first) as { error: { code: string } }).error.code, "cancelled");
    const answer = (await second) as { result: { rowIds: number[] } };
    assert.deepEqual(answer.result.rowIds, [199999, 199998, 199997, 199996, 199995]);
    const next = await client.rows(info, { plan: { sort: [{ column: "id", direction: "asc" }] }, end: 3 });
    assert.deepEqual(next.rowIds, [0, 1, 2]);
  } finally {
    await context.tearDown();
  }
});
