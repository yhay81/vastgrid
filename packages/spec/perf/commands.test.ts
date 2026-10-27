import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, type GridState } from "../src/index.ts";
import { bigState, rowsContext } from "../test/command-fixture.ts";

test("moving the active cell costs the same with a large history and many loaded rows", () => {
  const context = rowsContext(1_000);
  const time = (state: GridState) => {
    let current = state;
    const started = performance.now();
    for (let index = 0; index < 200; index++) {
      current = applyCommand(current, { command: "move", direction: index % 2 ? "up" : "down" }, context);
    }
    return (performance.now() - started) / 200;
  };
  time(bigState(1));
  // Copying a history of 100,000 updates took about 74 ms per move; a move now copies nothing of it. The best of
  // three runs, so that a pause of the garbage collector or a busy machine does not count.
  const large = bigState(100_000);
  const best = Math.min(time(large), time(large), time(large));
  assert.ok(best < 1, `a move takes less than 1 ms, not ${best.toFixed(2)} ms`);
});
