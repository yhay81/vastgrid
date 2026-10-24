import assert from "node:assert/strict";
import { test } from "node:test";
import { TextFitter } from "../src/text.ts";

/** A context whose text is 10 px per CJK or full-width character and 5 px per other character. */
function fitter() {
  const context = {
    measureText(text: string) {
      let width = 0;
      for (const char of text) width += /[　-鿿＀-￯]|[\u{20000}-\u{3ffff}]/u.test(char) ? 10 : 5;
      return { width };
    },
  } as unknown as CanvasRenderingContext2D;
  return new TextFitter(context, "13px sans-serif");
}

test("text that fits stays on one line", () => {
  assert.deepEqual(fitter().lines("short", 100, 3), ["short"]);
  assert.deepEqual(fitter().lines("", 100, 3), []);
  assert.deepEqual(fitter().lines("text\n\n", 100, 3), ["text"]);
});

test("lines break at spaces, and words longer than a line are cut", () => {
  // 50 px holds 10 Latin characters.
  assert.deepEqual(fitter().lines("the quick brown fox jumps", 50, 5), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(fitter().lines("abcdefghijklmnopqrstuvwxy", 50, 5), ["abcdefghij", "klmnopqrst", "uvwxy"]);
});

test("Japanese text breaks between characters but not before closing punctuation", () => {
  // 50 px holds 5 CJK characters.
  assert.deepEqual(fitter().lines("吾輩は猫である", 50, 3), ["吾輩は猫で", "ある"]);
  // "。" does not start a line, so "る" moves down with it.
  assert.deepEqual(fitter().lines("吾輩は猫る。名前", 50, 3), ["吾輩は猫", "る。名前"]);
  // "「" does not end a line.
  assert.deepEqual(fitter().lines("あいう「えお」", 40, 3), ["あいう", "「えお」"]);
  // Latin words next to Japanese break at the border.
  assert.deepEqual(fitter().lines("東京 Tokyo タワー", 35, 3), ["東京", "Tokyo", "タワー"]);
});

test("line breaks start new lines", () => {
  assert.deepEqual(fitter().lines("first\n\nthird", 100, 3), ["first", "", "third"]);
});

test("text that needs more lines ends with an ellipsis", () => {
  assert.deepEqual(fitter().lines("the quick brown fox jumps", 50, 2), ["the quick", "brown fox…"]);
  assert.deepEqual(fitter().lines("one\ntwo\nthree", 100, 2), ["one", "two…"]);
  assert.deepEqual(fitter().lines("one two three", 100, 1), ["one two three"]);
  assert.deepEqual(fitter().lines("one\ntwo", 100, 1), ["one…"]);
});

test("surrogate pairs are never split", () => {
  const lines = fitter().lines("𠮷𠮷𠮷𠮷𠮷𠮷", 30, 3);
  assert.deepEqual(lines, ["𠮷𠮷𠮷", "𠮷𠮷𠮷"]);
  // Even a column narrower than one character shows whole characters.
  assert.deepEqual(fitter().lines("𠮷𠮷", 5, 2), ["𠮷", "𠮷"]);
});
