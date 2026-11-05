import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { memoryEngine } from "../src/index.ts";
import type { HttpFetch, HttpResponse } from "../src/table.ts";
import { Client } from "./client.ts";

// Broad type/plan comparisons live in duckdb-engine/test/memory-engine.test.ts. These HTTP cases use a 334-byte
// fixture, with no server or DuckDB startup. Recreate it with DuckDB:
// COPY (SELECT * FROM (VALUES (1, 'Tokyo'), (2, 'Osaka')) AS t(id, city))
// TO 'cities.parquet' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED);
const bytes = new Uint8Array(readFileSync(new URL("./fixtures/cities.parquet", import.meta.url)));
const url = "https://files.invalid/cities.parquet";
type Request = Parameters<HttpFetch>[1];

function head(headers: Record<string, string> = {}) {
  return new Response(null, { headers: { "content-length": String(bytes.length), ...headers } });
}

function range(request: Request, headers: Record<string, string> = {}) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.Range);
  assert.ok(match, "The file must be read with a byte range");
  const start = Number(match[1]);
  const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end - 1}/${bytes.length}`, ...headers },
  });
}

function remote(answer: (request: Request) => HttpResponse | Promise<HttpResponse>) {
  const requests: Request[] = [];
  const client = new Client({
    t: {
      parquet: url,
      headers: { Authorization: "Bearer fixture-token" },
      fetch: async (requestedUrl, request) => {
        assert.equal(requestedUrl, url);
        assert.equal(request.headers.Authorization, "Bearer fixture-token");
        requests.push(request);
        return answer(request);
      },
    },
  });
  return { client, requests };
}

async function read(client: Client) {
  const info = await client.open("t");
  try {
    assert.equal(info.rowCount, 2);
    assert.deepEqual((await client.rows(info, {})).rows, [
      [1, "Tokyo"],
      [2, "Osaka"],
    ]);
    assert.deepEqual((await client.rows(info, {})).rows, [
      [1, "Tokyo"],
      [2, "Osaka"],
    ]);
  } finally {
    await client.result("close", { table: info.table });
  }
}

for (const [name, response] of [
  ["HEAD refused", () => new Response(null, { status: 405 })],
  ["missing Content-Length", () => new Response(null)],
  ["compressed HEAD", () => head({ "content-encoding": "gzip", "content-length": "1" })],
] as const) {
  test(`reads Parquet with a one-byte size probe when ${name}`, async () => {
    const { client, requests } = remote((request) => (request.method === "HEAD" ? response() : range(request)));
    await read(client);
    assert.equal(requests[0].method, "HEAD");
    assert.equal(requests[1].headers.Range, "bytes=0-0");
  });
}

for (const status of [401, 403, 404]) {
  test(`stops after HEAD answers ${status}`, async () => {
    const { client, requests } = remote(() => new Response(null, { status }));
    const error = await client.error("open", { ref: "t" });
    assert.equal(error.code, "load_failed");
    assert.match(error.message, new RegExp(String(status)));
    assert.equal(requests.length, 1);
  });
}

test("reports network failure with CORS guidance", async () => {
  const { client } = remote(() => {
    throw new Error("offline");
  });
  const error = await client.error("open", { ref: "t" });
  assert.equal(error.code, "load_failed");
  assert.match(error.message, /offline/);
  assert.match(error.message, /Access-Control-Expose-Headers/);
});

test("requires an exposed Content-Range when HEAD cannot tell the size", async () => {
  const { client } = remote((request) => new Response(null, { status: request.method === "HEAD" ? 405 : 206 }));
  const error = await client.error("open", { ref: "t" });
  assert.equal(error.code, "load_failed");
  assert.match(error.message, /Content-Range/);
});

for (const [status, code] of [
  [416, "file_changed"],
  [500, "load_failed"],
] as const) {
  test(`reports ${code} when a range request answers ${status}`, async () => {
    const { client } = remote((request) => (request.method === "HEAD" ? head() : new Response(null, { status })));
    assert.equal((await client.error("open", { ref: "t" })).code, code);
  });
}

test("reports a failed size probe", async () => {
  const { client } = remote((request) => new Response(null, { status: request.method === "HEAD" ? 405 : 503 }));
  const error = await client.error("open", { ref: "t" });
  assert.equal(error.code, "load_failed");
  assert.match(error.message, /503/);
});

for (const validator of ["etag", "last-modified"]) {
  test(`rejects a file whose ${validator} changes between HEAD and its bytes`, async () => {
    const { client } = remote((request) =>
      request.method === "HEAD" ? head({ [validator]: "original" }) : range(request, { [validator]: "replacement" }),
    );
    assert.equal((await client.error("open", { ref: "t" })).code, "file_changed");
  });
}

test("rejects a truncated range response", async () => {
  const { client } = remote((request) =>
    request.method === "HEAD" ? head() : new Response(bytes.slice(0, -1), { status: 206 }),
  );
  assert.equal((await client.error("open", { ref: "t" })).code, "file_changed");
});

for (const supportsHead of [true, false]) {
  test(`downloads a small file only once when ranges are ignored (HEAD: ${supportsHead})`, async () => {
    const { client, requests } = remote((request) =>
      request.method === "HEAD" ? (supportsHead ? head() : new Response(null, { status: 405 })) : new Response(bytes),
    );
    await read(client);
    assert.equal(requests.length, 2, "Repeated reads must reuse the downloaded file");
  });
}

test("rejects a full download whose size changed since HEAD", async () => {
  const { client } = remote((request) => (request.method === "HEAD" ? head() : new Response(bytes.slice(0, -1))));
  assert.equal((await client.error("open", { ref: "t" })).code, "file_changed");
});

for (const declaredSize of [true, false]) {
  test(`bounds downloads without range support (Content-Length: ${declaredSize})`, async () => {
    let bodyRead = false;
    const { client } = remote((request) =>
      request.method === "HEAD"
        ? head()
        : {
            status: 200,
            ok: true,
            headers: new Headers(declaredSize ? { "content-length": String(16 * 1024 * 1024 + 1) } : {}),
            async arrayBuffer() {
              bodyRead = true;
              return new ArrayBuffer(16 * 1024 * 1024 + 1);
            },
          },
    );
    const error = await client.error("open", { ref: "t" });
    assert.equal(error.code, "load_failed");
    assert.match(error.message, /16 MiB/);
    assert.equal(bodyRead, !declaredSize, "Reject a declared large response before buffering it");
  });
}

test("rejects a local file whose slice is shorter than its advertised size", async () => {
  const client = new Client({ t: { parquet: { size: bytes.length, slice: () => new Blob([bytes.slice(0, -1)]) } } });
  assert.equal((await client.error("open", { ref: "t" })).code, "file_changed");
});

test("answers load_failed for a file that is not Parquet, and for what is not a file", async () => {
  const engine = memoryEngine({
    tables: {
      text: { parquet: new Blob(["id,name\n1,a\n"]) },
      nothing: { parquet: 42 as unknown as Blob },
    },
  });
  for (const ref of ["text", "nothing"]) {
    const response = (await engine.handle({ v: 2, id: 1, op: "open", ref })) as {
      error?: { code: string; message: string };
    };
    assert.equal(response.error?.code, "load_failed", ref);
    assert.match(response.error?.message ?? "", /\/parquet/);
  }
});
