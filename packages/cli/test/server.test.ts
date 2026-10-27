import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type Served, serve } from "../src/index.ts";

const TOKEN = "test-token-0123456789";
const PAGE = "<!doctype html><title>vastgrid</title>";

let root: string;
let data: string;
let temp: string;
let served: Served;
let cookie: string;

/** A GET or POST to the server with the given headers, as a browser would make it. */
function send(
  target: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; port?: number } = {},
) {
  const port = options.port ?? served.port;
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path: target,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) {
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify(options.body));
    } else outgoing.end();
  });
}

/** What the engine answers to `open` (§8.2). */
interface Answer {
  result: { columns: unknown[] };
  error: { code: string };
}

let id = 0;
async function post(body: Record<string, unknown>, server = served, given = cookie) {
  const answer = await send("/api", {
    method: "POST",
    headers: { cookie: given },
    body: { v: 2, id: ++id, ...body },
    port: server.port,
  });
  return { status: answer.status, json: JSON.parse(answer.body) as Answer };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vastgrid-cli-test-"));
  data = path.join(root, "data");
  temp = path.join(root, "temp");
  await mkdir(path.join(data, "sub", "deeper", "deepest"), { recursive: true });
  await mkdir(path.join(data, ".hidden"), { recursive: true });
  await writeFile(path.join(data, "orders.csv"), "id,region\n1,EU\n2,US\n");
  await writeFile(path.join(data, "sub", "items.tsv"), "id\tname\n1\tpen\n");
  await writeFile(path.join(data, "sub", "deeper", "deepest", "far.csv"), "id\n1\n");
  await writeFile(path.join(data, ".hidden", "secret.csv"), "id\n1\n");
  await writeFile(path.join(data, "notes.txt"), "not a table\n");
  await writeFile(path.join(root, "outside.csv"), "id\n1\n");
  served = await serve({ paths: ["data"], cwd: root, token: TOKEN, tempDirectory: temp, html: async () => PAGE });
  cookie = `vastgrid-${served.port}=${TOKEN}`;
});

after(async () => {
  await served.close();
  await rm(root, { recursive: true, force: true });
});

test("the address's token opens the page, which keeps it in a cookie and leaves it out of the address", async () => {
  assert.equal(served.url, `http://127.0.0.1:${served.port}/?token=${TOKEN}`);
  const opened = await send(`/?token=${TOKEN}&file=data%2Forders.csv`);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.location, "/?file=data%2Forders.csv");
  assert.equal(opened.headers["set-cookie"]?.toString(), `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
  const page = await send("/?file=data%2Forders.csv", { headers: { cookie: `other=1; ${cookie}` } });
  assert.equal(page.status, 200);
  assert.equal(page.body, PAGE);
  assert.match(String(page.headers["content-security-policy"]), /connect-src 'self'.*frame-ancestors 'none'/);
});

test("without the token, or with another, nothing answers but 401", async () => {
  for (const [target, headers] of [
    ["/", {}],
    ["/?token=test-token-0123456780", {}],
    ["/files", {}],
    ["/files", { cookie: "vastgrid-1=test-token-0123456789" }],
    ["/files", { cookie: `vastgrid-${served.port}=test-token-01234567` }],
    ["/api/events", {}],
  ] as const) {
    assert.equal((await send(target, { headers })).status, 401, `${target} ${JSON.stringify(headers)}`);
  }
  const body = { v: 2, id: ++id, op: "open", ref: "data/orders.csv" };
  assert.equal((await send("/api", { method: "POST", body })).status, 401);
});

test("another name for 127.0.0.1 reaches nothing, with the cookie or without", async () => {
  for (const host of ["attacker.example", `attacker.example:${served.port}`, `127.0.0.1:${served.port + 1}`]) {
    const answer = await send(`/?token=${TOKEN}`, { headers: { host, cookie } });
    assert.equal(answer.status, 403, host);
  }
  assert.equal((await send("/files", { headers: { host: `localhost:${served.port}`, cookie } })).status, 200);
});

test("the list holds the table files of the folders, two folders deep, by their names from the current folder", async () => {
  const answer = await send("/files", { headers: { cookie } });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { files: ["data/orders.csv", "data/sub/items.tsv"], save: false });
  assert.deepEqual(await served.files(), ["data/orders.csv", "data/sub/items.tsv"]);
});

test("the page opens the files of the folders, and no others", async () => {
  const opened = await post({ op: "open", ref: "data/orders.csv" });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.result.columns.length, 2);
  // Deeper than the list goes, but in the folder.
  assert.equal((await post({ op: "open", ref: "data/sub/deeper/deepest/far.csv" })).status, 200);
  for (const ref of ["outside.csv", "data/../outside.csv", path.join(root, "outside.csv"), "data/notes.txt"]) {
    const refused = await post({ op: "open", ref });
    assert.equal(refused.status, 403, `${ref}: ${JSON.stringify(refused.json)}`);
    assert.equal(refused.json.error.code, "not_allowed");
  }
});

test("a file named alone opens, and not the files next to it", async () => {
  const alone = await serve({
    paths: [path.join(data, "sub", "items.tsv")],
    cwd: data,
    token: TOKEN,
    tempDirectory: temp,
    html: async () => PAGE,
  });
  try {
    assert.deepEqual(await alone.files(), ["sub/items.tsv"]);
    const own = `vastgrid-${alone.port}=${TOKEN}`;
    assert.equal((await post({ op: "open", ref: "sub/items.tsv" }, alone, own)).status, 200);
    assert.equal((await post({ op: "open", ref: path.join(data, "sub", "items.tsv") }, alone, own)).status, 200);
    assert.equal((await post({ op: "open", ref: "orders.csv" }, alone, own)).status, 403);
  } finally {
    await alone.close();
  }
});

test("paths that do not exist or are not tables are refused before anything starts", async () => {
  await assert.rejects(serve({ paths: ["missing"], cwd: root, tempDirectory: temp }), /missing does not exist/);
  await assert.rejects(
    serve({ paths: ["data/notes.txt"], cwd: root, tempDirectory: temp }),
    /data\/notes.txt is not a CSV, TSV, Parquet, JSON Lines or Excel file/,
  );
  await assert.rejects(serve({ paths: ["data"], cwd: root, tempDirectory: temp, token: "short" }), /16 or more/);
  await assert.rejects(
    serve({ paths: ["data"], cwd: root, tempDirectory: temp, port: served.port }),
    new RegExp(`Port ${served.port} is in use`),
  );
});

test("a stopped server answers nothing, and the engine leaves no temporary folder", async () => {
  const own = path.join(root, "own-temp");
  const stopping = await serve({
    paths: ["data"],
    cwd: root,
    token: TOKEN,
    tempDirectory: own,
    html: async () => PAGE,
  });
  const header = `vastgrid-${stopping.port}=${TOKEN}`;
  assert.equal((await post({ op: "open", ref: "data/orders.csv" }, stopping, header)).status, 200);
  assert.notDeepEqual(await readdir(own), []);
  // A stream of events, which stays open, does not keep the server running.
  const events = fetch(`http://127.0.0.1:${stopping.port}/api/events`, { headers: { cookie: header } });
  assert.equal((await events).status, 200);
  await Promise.all([stopping.close(), stopping.close()]);
  assert.deepEqual(await readdir(own), []);
  await assert.rejects(send("/files", { headers: { cookie: header }, port: stopping.port }));
});
