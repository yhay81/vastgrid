import assert from "node:assert/strict";
import { test } from "node:test";
import { readMessageCorpus, runMessageCase } from "../src/conformance.ts";
import {
  ARROW_MEDIA_TYPE,
  checkRequest,
  decodeBlock,
  ERROR_STATUS,
  encodeBlock,
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
