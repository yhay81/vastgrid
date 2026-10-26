import assert from "node:assert/strict";
import { test } from "node:test";
import { readMessageCorpus, runMessageCase } from "../src/conformance.ts";
import {
  ARROW_MEDIA_TYPE,
  answerId,
  checkRequest,
  checkResponse,
  decodeBlock,
  ERROR_STATUS,
  encodeBlock,
  errorResponse,
  frameAttached,
  ProtocolError,
  readAttached,
  toStructuredEncoding,
  toTextEncoding,
} from "../src/index.ts";
import { schemaProblems } from "./schemas.ts";

const files = readMessageCorpus();

for (const file of files) {
  test(`messages: ${file.file}`, async (t) => {
    for (const item of file.cases) {
      await t.test(item.id, () => {
        assert.deepEqual(runMessageCase(item), []);
      });
    }
  });
}

test("message corpus files follow messages-corpus.schema.json", () => {
  for (const file of files) {
    const { file: name, ...content } = file;
    assert.deepEqual(schemaProblems("messages-corpus.schema.json", content), [], name);
  }
});

test("messages that follow §8 follow messages.schema.json", () => {
  for (const file of files) {
    for (const item of file.cases) {
      if (!("valid" in item.expect)) continue;
      assert.deepEqual(schemaProblems("messages.schema.json", item.message), [], item.id);
      const message = item.message as { result?: unknown };
      if (item.kind === "response" && "result" in message) {
        assert.deepEqual(
          schemaProblems(`messages.schema.json#/$defs/result/properties/${item.op}`, message.result),
          [],
          item.id,
        );
      }
    }
  }
});

function limited(message: unknown, path: string) {
  assert.throws(
    () => checkRequest(message),
    (error: unknown) => error instanceof ProtocolError && error.reason === "limit" && error.path === path,
  );
}

const view = { v: 2, id: 1, table: "t1", revision: null, plan: {} };

test("requests beyond the limits of §8 fail with limit", () => {
  limited({ ...view, op: "locate", keys: Array.from({ length: 10_001 }, (_, rowId) => ({ rowId })) }, "/keys");
  limited({ ...view, op: "summarize", ranges: Array.from({ length: 1001 }, () => [0, 1]), columns: ["a"] }, "/ranges");
  const update = { key: { rowId: 0 }, column: "a", value: 1 };
  limited({ v: 2, id: 1, op: "write", table: "t1", revision: null, updates: Array(100_001).fill(update) }, "/updates");
  limited({ v: 2, id: 1, op: "open", ref: "x".repeat(1_000_001) }, "/ref");
  // Strings are limited by code points: 600,000 astral characters are 1,200,000 UTF-16 units.
  assert.doesNotThrow(() => checkRequest({ v: 2, id: 1, op: "open", ref: "😀".repeat(600_000) }));
});

/** A list in `levels` lists. */
function nested(levels: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < levels; level++) value = [value];
  return value;
}

test("the limits of §8.1 hold inside plans, keys and values, and for names, levels and items", () => {
  const rows = { ...view, op: "rows", start: 0, end: 1, columns: ["a"] };
  limited(
    { ...rows, plan: { where: { fn: "eq", args: [{ col: "a" }, { lit: "x".repeat(1_000_001) }] } } },
    "/plan/where/args/1/lit",
  );
  limited({ ...view, op: "locate", keys: [{ value: "x".repeat(1_000_001) }], rowKey: "a" }, "/keys/0/value");
  const update = { key: { rowId: 0 }, column: "a", value: "x".repeat(1_000_001) };
  limited({ v: 2, id: 1, op: "write", table: "t1", revision: null, updates: [update] }, "/updates/0/value");
  limited({ ...rows, plan: { sort: Array(1_000_001).fill(0) } }, "/plan/sort");
  // The message is the first level: a plan's list 254 levels below the plan is the 257th.
  limited({ ...rows, plan: { where: nested(255) } }, `/plan/where${"/0".repeat(254)}`);
  // One level fewer is within the limit (and the engine's checks of plans, §4.9, refuse it).
  assert.doesNotThrow(() => checkRequest({ ...rows, plan: { where: nested(254) } }));
  // A name beyond the limit cannot be in a path: the error names the object that holds it.
  limited({ ...rows, plan: { ["x".repeat(1_000_001)]: 1 } }, "/plan");
  limited({ ...rows, ["x".repeat(1_000_001)]: 1 }, "");
});

test("errors of requests follow §8.1 themselves, whatever the request quotes", () => {
  const fail = (message: unknown) => {
    try {
      checkRequest(message);
    } catch (error) {
      if (error instanceof ProtocolError) return error;
    }
    throw new Error("The request is valid.");
  };
  // A name of 1,000,000 code points is within the limit; the path to it is not, and the message quotes it cut.
  const named = fail({ v: 2, id: 1, op: "info", table: "t1", ["x".repeat(1_000_000)]: 1 });
  assert.deepEqual([named.path, named.reason], ["", "syntax"]);
  assert.ok(named.message.length < 100, named.message);
  const op = fail({ v: 2, id: 1, op: "y".repeat(1_000_000) });
  assert.deepEqual([op.reason, op.message.length < 100], ["unknown_op", true]);
  // Paths are JSON Pointers: "/" and "~" in names are escaped.
  assert.equal(fail({ v: 2, id: 1, op: "info", table: "t1", "a/b~c": 1 }).path, "/a~1b~0c");
  // An answer to it is checked as a response, with the request's id or null.
  for (const id of [3, null]) {
    const answer = errorResponse(id, "invalid_request", named.message, { path: named.path, reason: named.reason });
    assert.equal(checkResponse(answer, "info").id, id);
  }
  assert.equal(answerId({ v: 2, id: 0 }), 0);
  for (const message of [null, "rows", { id: -1 }, { id: 1.5 }, { id: "1" }]) assert.equal(answerId(message), null);
  const long = errorResponse(1, "internal", "z".repeat(5000), { path: `/${"p".repeat(1_000_001)}` });
  assert.deepEqual(
    [[...(long.error as { message: string }).message].length, (long.error as { path: string }).path],
    [1000, ""],
  );
});

test("every error code of §8.7 has its HTTP status", () => {
  assert.equal(Object.keys(ERROR_STATUS).length, 16);
  assert.equal(ERROR_STATUS.invalid_request, 400);
  assert.equal(ERROR_STATUS.revision_changed, 409);
  assert.equal(ERROR_STATUS.cancelled, 499);
  assert.equal(ARROW_MEDIA_TYPE, "application/vnd.vastgrid.v2+arrow");
});

const columns = [
  { name: "id", type: "bigint" as const },
  { name: "s", type: "string" as const },
];
const block = encodeBlock(columns, [
  ["9223372036854775807", "﻿a"],
  [null, "b"],
]);
const response = {
  v: 2,
  id: 7,
  result: {
    view: {
      hash: `sha256:${"0".repeat(64)}`,
      status: "ready",
      rowCount: 2,
      rowCountExact: true,
      readableRows: 2,
      columns,
      edits: { version: 0, cells: 0 },
    },
    start: 0,
    end: 2,
    rowIds: [0, 1],
    block: { bytes: block },
  },
};

test("the text encoding carries a block as base64 (§8.8)", () => {
  const text = toTextEncoding(response) as typeof response & { result: { block: { base64: string } } };
  assert.equal(typeof text.result.block.base64, "string");
  assert.deepEqual(schemaProblems("messages.schema.json#/$defs/result/properties/rows", text.result), []);
  const back = toStructuredEncoding(JSON.parse(JSON.stringify(text))) as typeof response;
  assert.deepEqual([...back.result.block.bytes], [...block]);
  assert.deepEqual(decodeBlock(back.result.block.bytes).rows, [
    ["9223372036854775807", "﻿a"],
    [null, "b"],
  ]);
});

test("the attached encoding puts the block after the JSON, behind its length (§8.8)", () => {
  const bytes = frameAttached(response);
  const length = new DataView(bytes.buffer).getUint32(0, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  assert.deepEqual(json.result.block, { attached: block.length });
  assert.equal(bytes.length, 4 + length + block.length);
  const back = readAttached(bytes) as typeof response;
  assert.deepEqual([...back.result.block.bytes], [...block]);
  assert.equal(decodeBlock(back.result.block.bytes).rows[0][1], "﻿a");
});

test("a framed response is read only when its parts add up", () => {
  const bytes = frameAttached(response);
  const fails = (value: Uint8Array) =>
    assert.throws(
      () => readAttached(value),
      (error: unknown) => error instanceof ProtocolError && error.code === "invalid_response",
    );
  fails(bytes.subarray(0, 3));
  fails(bytes.subarray(0, 10));
  fails(bytes.subarray(0, bytes.length - 1));
  const message = { v: 2, id: 1, result: null };
  assert.deepEqual(readAttached(frameAttached(message)), message);
});
