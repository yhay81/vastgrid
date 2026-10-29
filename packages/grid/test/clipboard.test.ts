import assert from "node:assert/strict";
import { test } from "node:test";
import { countCells } from "../src/react/grid-body.tsx";

test("the cells of a copy are the fields of its TSV, quoted ones and a last empty row too (§6.6)", () => {
  assert.equal(countCells({ tsv: "" }), 0);
  assert.equal(countCells({ tsv: "\n" }), 1);
  assert.equal(countCells({ tsv: "Tokyo\n\n" }), 2);
  assert.equal(countCells({ tsv: 'a\t"b\tc"\n"x\ny"\t' }), 4);
});
