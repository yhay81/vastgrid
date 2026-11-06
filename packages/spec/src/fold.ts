/**
 * The folding of `fold` (§3.4, §4.4): fixed tables of code points, not NFKC, so that no Unicode version changes a
 * result. Every engine applies the same tables: JavaScript by code point, DuckDB with `replace` and `translate`.
 */

export const FOLDS = ["width", "kana"] as const;
export type Fold = (typeof FOLDS)[number];

const HALF_KATAKANA =
  "ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";

function range(from: number, to: number, shift: number): [string, string] {
  let source = "";
  let target = "";
  for (let code = from; code <= to; code++) {
    source += String.fromCodePoint(code);
    target += String.fromCodePoint(code + shift);
  }
  return [source, target];
}

/** Half-width katakana followed by its voiced or semi-voiced mark, and the full-width letter they make. */
function marked(): [string, string][] {
  const pairs: [string, string][] = [];
  const voiced = "カキクケコサシスセソタチツテトハヒフヘホ";
  const half = (letter: string) => String.fromCodePoint(0xff66 + [...HALF_KATAKANA].indexOf(letter));
  for (const letter of voiced) pairs.push([`${half(letter)}ﾞ`, String.fromCodePoint(letter.codePointAt(0)! + 1)]);
  pairs.push([`${half("ウ")}ﾞ`, "ヴ"], [`${half("ワ")}ﾞ`, "ヷ"], [`${half("ヲ")}ﾞ`, "ヺ"]);
  for (const letter of "ハヒフヘホ") pairs.push([`${half(letter)}ﾟ`, String.fromCodePoint(letter.codePointAt(0)! + 2)]);
  return pairs;
}

function widthTable(): { pairs: [string, string][]; from: string; to: string } {
  const [ascii, asciiTo] = range(0xff01, 0xff5e, -0xfee0);
  // U+FF61–FF65 (。「」、・), U+FF66–FF9D (katakana and the prolonged sound mark), and the marks on their own.
  const from = `${ascii}　${range(0xff61, 0xff9f, 0)[0]}`;
  const to = `${asciiTo} 。「」、・${HALF_KATAKANA}゙゚`;
  return { pairs: marked(), from, to };
}

/**
 * The tables of each fold: `pairs` are replaced first (two code points to one), then each code point of `from`
 * becomes the code point at the same place in `to`.
 */
export const FOLD_TABLES: Record<Fold, { pairs: [string, string][]; from: string; to: string }> = {
  width: widthTable(),
  kana: (() => {
    const [from, to] = range(0x3041, 0x3096, 0x60);
    return { pairs: [], from, to };
  })(),
};

const maps = new Map<Fold, { pairs: Map<string, string>; single: Map<number, number> }>();

function mapOf(fold: Fold) {
  let map = maps.get(fold);
  if (!map) {
    const table = FOLD_TABLES[fold];
    const from = [...table.from];
    const to = [...table.to];
    map = {
      pairs: new Map(table.pairs),
      single: new Map(from.map((char, index) => [char.codePointAt(0)!, to[index].codePointAt(0)!])),
    };
    maps.set(fold, map);
  }
  return map;
}

/** `fold(text, fold)` (§4.4). */
export function foldText(text: string, fold: Fold): string {
  const { pairs, single } = mapOf(fold);
  const chars = [...text];
  let result = "";
  for (let index = 0; index < chars.length; index++) {
    if (pairs.size > 0 && index + 1 < chars.length) {
      const pair = pairs.get(chars[index] + chars[index + 1]);
      if (pair !== undefined) {
        result += pair;
        index++;
        continue;
      }
    }
    const code = chars[index].codePointAt(0)!;
    const mapped = single.get(code);
    result += mapped === undefined ? chars[index] : String.fromCodePoint(mapped);
  }
  return result;
}

/** Each fold of a list in turn. */
export function foldAll(text: string, folds: readonly Fold[] | undefined): string {
  let result = text;
  for (const fold of folds ?? []) result = foldText(result, fold);
  return result;
}

/**
 * Whether every row that a search finds is found by another, the view's (§5.2.1): both fold the same, and the
 * folded text of the one is contained in that of the view's, since `lower` and the folds map the text of a value
 * in the same way.
 */
export function searchImplies(view: { search: string; fold?: Fold[] }, part: { search: string; fold?: Fold[] }) {
  const folds = view.fold ?? [];
  const partFolds = part.fold ?? [];
  if (folds.length !== partFolds.length || folds.some((fold, index) => partFolds[index] !== fold)) return false;
  return foldAll(view.search, folds).includes(foldAll(part.search, folds));
}
