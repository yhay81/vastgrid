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
