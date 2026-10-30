import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createGridStore, localTransport } from "../src/core.ts";
import { DataGrid } from "../src/index.ts";
import { de, en, es, fr, ja, ko, messagesFor, ptBR, zhHans, zhHant } from "../src/locales/index.ts";
import { fakeEngine, numbers } from "./fake-engine.ts";

const sets = { de, es, fr, ja, ko, ptBR, zhHans, zhHant };

/** The keys of a set, with those of its records (`operators.eq`), and what kind each text is. */
function shape(messages: object, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "object" ? shape(value, `${prefix}${key}.`) : [`${prefix}${key}:${typeof value}`],
  );
}

test("every set has the texts of the English one, of the same kinds", () => {
  for (const [name, messages] of Object.entries(sets)) assert.deepEqual(shape(messages), shape(en), name);
});

test("`messagesFor` chooses a set by the tag's language", () => {
  assert.equal(messagesFor(undefined), en);
  assert.equal(messagesFor("en-GB"), en);
  assert.equal(messagesFor("it"), en);
  assert.equal(messagesFor("ja-JP"), ja);
  assert.equal(messagesFor("de-AT"), de);
  assert.equal(messagesFor("pt"), ptBR);
  assert.equal(messagesFor("pt-PT"), ptBR);
  assert.equal(messagesFor("zh"), zhHans);
  assert.equal(messagesFor("zh-CN"), zhHans);
  assert.equal(messagesFor("zh-Hans-TW"), zhHant);
  assert.equal(messagesFor("zh-TW"), zhHant);
  assert.equal(messagesFor("zh_hk"), zhHant);
  assert.equal(messagesFor("zh-Hant"), zhHant);
});

test("`locale` sets the formats alone: the texts are English unless `messages` gives others", () => {
  const store = () => createGridStore({ transport: localTransport(fakeEngine(numbers(5))), table: "numbers" });
  assert.match(renderToString(createElement(DataGrid, { store: store(), locale: "ja" })), /Loading…/);
  const korean = renderToString(createElement(DataGrid, { store: store(), locale: "ko", messages: ko }));
  assert.ok(korean.includes(ko.loading) && !korean.includes("Loading…"));
  assert.match(
    renderToString(createElement(DataGrid, { store: store(), messages: { loading: "Chargement…" } })),
    /Chargement…/,
  );
});
