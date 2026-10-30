import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import { createGridStore, localTransport } from "../src/core.ts";
import { DataGrid } from "../src/index.ts";
import { ja } from "../src/locales/ja.ts";
import { readInitialView } from "../src/server.ts";
import { fakeEngine, numbers } from "./fake-engine.ts";

async function html(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

test("on the server, the canvas is left out and the first rows of `initial` are sent as an HTML table", async () => {
  const transport = localTransport(fakeEngine(numbers(500)));
  const initial = await readInitialView(transport, { table: "numbers", rows: 30 });
  const store = createGridStore({ transport, table: "numbers", initial });
  const markup = renderToString(createElement(DataGrid, { store, locale: "en" }));
  assert.ok(!markup.includes("<canvas"), "no canvas on the server");
  assert.match(markup, /<table class="vg-static" aria-label="Data table" aria-rowcount="501">/);
  assert.equal(markup.match(/<tr>/g)?.length, 31, "a header row and 30 rows");
  assert.match(markup, /<td>name 29<\/td>/);
  assert.match(markup, /<th scope="col" class="vg-static__number">id<\/th>/);
  assert.match(markup, /500 rows/);
});

test("without `initial`, the server sends a busy body of the same size", () => {
  const store = createGridStore({ transport: localTransport(fakeEngine(numbers(5))), table: "numbers" });
  const markup = renderToString(createElement(DataGrid, { store, locale: "ja", messages: ja }));
  assert.match(markup, /<div class="vg-body" aria-busy="true"><\/div>/);
  assert.match(markup, /読み込み中…/);
});

test("`initial` as a promise streams: the rows arrive in the prerendered HTML", async () => {
  const transport = localTransport(fakeEngine(numbers(50)));
  const initial = readInitialView(transport, { table: "numbers", rows: 10 });
  const { prelude } = await prerender(createElement(DataGrid, { transport, table: "numbers", initial, locale: "en" }));
  const markup = await html(prelude);
  assert.match(markup, /<td>name 9<\/td>/);
  assert.ok(!markup.includes("<canvas"));
});
