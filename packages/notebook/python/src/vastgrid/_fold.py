"""The folding of `fold` (§3.4, §4.4): fixed tables of code points, not NFKC, the same as vastgrid-spec's."""

from __future__ import annotations

FOLDS: tuple[str, ...] = ("width", "kana")

_HALF_KATAKANA = (
    "ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン"
)


def _range(start: int, end: int, shift: int) -> tuple[str, str]:
    codes = range(start, end + 1)
    return "".join(chr(code) for code in codes), "".join(chr(code + shift) for code in codes)


def _half(letter: str) -> str:
    return chr(0xFF66 + _HALF_KATAKANA.index(letter))


def _marked() -> list[tuple[str, str]]:
    """Half-width katakana followed by its voiced or semi-voiced mark, and the full-width letter they make."""
    pairs = [(_half(letter) + "ﾞ", chr(ord(letter) + 1)) for letter in "カキクケコサシスセソタチツテトハヒフヘホ"]
    pairs += [(_half("ウ") + "ﾞ", "ヴ"), (_half("ワ") + "ﾞ", "ヷ"), (_half("ヲ") + "ﾞ", "ヺ")]
    pairs += [(_half(letter) + "ﾟ", chr(ord(letter) + 2)) for letter in "ハヒフヘホ"]
    return pairs


def _width() -> tuple[list[tuple[str, str]], str, str]:
    ascii_from, ascii_to = _range(0xFF01, 0xFF5E, -0xFEE0)
    source = ascii_from + "　" + _range(0xFF61, 0xFF9F, 0)[0]
    target = ascii_to + " 。「」、・" + _HALF_KATAKANA + "゙゚"
    return _marked(), source, target


# The tables of each fold: `pairs` are replaced first (two code points to one), then each code point of the
# first text becomes the code point at the same place in the second.
FOLD_TABLES: dict[str, tuple[list[tuple[str, str]], str, str]] = {
    "width": _width(),
    "kana": ([], *_range(0x3041, 0x3096, 0x60)),
}

_FOLD_MAPS: dict[str, tuple[frozenset[str], dict[str, str], dict[int, int]]] = {
    fold: (frozenset(pair[0] for pair, _ in pairs), dict(pairs), str.maketrans(source, target))
    for fold, (pairs, source, target) in FOLD_TABLES.items()
}


def fold_text(text: str, fold: str) -> str:
    """`fold(text, fold)` (§4.4), by code point: a pair first where one starts, then each code point."""
    pair_starts, pair_map, trans = _FOLD_MAPS[fold]
    if not pair_starts or not any(char in pair_starts for char in text[:-1]):
        return text.translate(trans)
    result: list[str] = []
    index = 0
    while index < len(text):
        pair = pair_map.get(text[index : index + 2])
        if pair is not None:
            result.append(pair)
            index += 2
            continue
        code = ord(text[index])
        mapped = trans.get(code)
        result.append(chr(mapped) if mapped is not None else text[index])
        index += 1
    return "".join(result)


def fold_all(text: str, folds: list[str] | tuple[str, ...]) -> str:
    """Each fold of a list in turn."""
    for fold in folds:
        text = fold_text(text, fold)
    return text


FoldPart = tuple[list[tuple[str, str]], list[tuple[str, str]]]
"""Parts of one fold's table: pairs of two code points to one, then single code points."""


def fold_part(fold: str) -> FoldPart:
    """The whole table of a fold, as its part."""
    pairs, source, target = FOLD_TABLES[fold]
    return list(pairs), list(zip(source, target, strict=True))


def search_folds(text: str, folds: list[str] | tuple[str, ...]) -> list[FoldPart]:
    """The parts of a search's folds that can change whether a value holds its text (§3.5), as vastgrid-sql's
    `searchFolds`: the entries that make one of the folded text's code points, after the later folds and `lower`, and
    those whose own code points are among them. Any other entry makes a code point that no occurrence of the folded
    text holds, folded or not."""
    wanted: set[str] = set()
    for char in fold_all(text, folds):
        wanted.add(char)
        wanted.update(char.lower())
    parts: list[FoldPart] = []
    for index, fold in enumerate(folds):
        after = folds[index + 1 :]
        rest = folds[index:]
        pairs, singles = fold_part(fold)
        parts.append(
            (
                [
                    (source, target)
                    for source, target in pairs
                    if _reaches(source, wanted)
                    or _reaches(fold_all(target, after), wanted)
                    or any(_reaches(fold_all(char, rest), wanted) for char in source)
                ],
                [
                    (source, target)
                    for source, target in singles
                    if _reaches(source, wanted) or _reaches(fold_all(target, after), wanted)
                ],
            )
        )
    return parts


def _reaches(value: str, wanted: set[str]) -> bool:
    """Whether a text or its lowercase holds one of the code points looked for."""
    return any(char in wanted for char in value + value.lower())
