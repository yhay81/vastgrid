"""Dates and times as integers and as text (docs/spec.md §2.2): days since 1970-01-01 in the proleptic Gregorian
calendar, and counts of seconds, milliseconds, microseconds or nanoseconds. Dates are the days from `-290308-12-22` to
`+294247-01-10`, whose midnights a 64-bit count of microseconds holds; year 0 is 1 BC. DuckDB's `infinity` and
`-infinity` are counts that no date or timestamp has, as DuckDB stores them. Python ints stand in for JavaScript's
bigints."""

from __future__ import annotations

import re
from dataclasses import dataclass

UNIT_PER_SECOND: dict[str, int] = {"s": 1, "ms": 1000, "us": 1_000_000, "ns": 1_000_000_000}
"""Counts of a unit in a second."""

UNIT_DIGITS: dict[str, int] = {"s": 0, "ms": 3, "us": 6, "ns": 9}
"""Digits after the point that each unit keeps."""

_DAY_SECONDS = 86_400
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1
_NANOS_PER_DAY = 86_400_000_000_000

FIRST_DAY = -106_751_991
"""The first day that a date may be (§2.2), as days from 1970-01-01."""
LAST_DAY = 106_751_991
"""The last day that a date may be (§2.2), as days from 1970-01-01."""

DATE_INFINITY = 2_147_483_647
"""DuckDB's `infinity` of dates, as days from 1970-01-01; `-infinity` is its negation."""
TIMESTAMP_INFINITY = _INT64_MAX
"""DuckDB's `infinity` of timestamps, as a count of any unit; `-infinity` is its negation."""
_INFINITIES = {"infinity": 1, "-infinity": -1}


def infinity_of(text: str) -> int:
    """1 for the text `infinity`, -1 for `-infinity`, and 0 for the text of another date or timestamp (§2.2)."""
    return _INFINITIES.get(text, 0)


_DATE = re.compile(r"([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})")
_CLOCK = re.compile(r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?")
_INTERVAL = re.compile(
    r"(?:(-?[0-9]+) years?(?: |\Z))?(?:(-?[0-9]+) months?(?: |\Z))?(?:(-?[0-9]+) days?(?: |\Z))?"
    r"(?:(-?)([0-9]{2,}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?)?"
)


def _trunc_div(a: int, b: int) -> int:
    """`a / b` of bigints: rounded toward zero."""
    quotient = abs(a) // abs(b)
    return quotient if (a < 0) == (b < 0) else -quotient


def _trunc_rem(a: int, b: int) -> int:
    """`a % b` of bigints: the sign of `a`."""
    return a - b * _trunc_div(a, b)


def days_from_civil(year: int, month: int, day: int) -> int:
    """Days from 1970-01-01 to a date (Howard Hinnant's `days_from_civil`)."""
    y = year - 1 if month <= 2 else year
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def civil_from_days(days: int) -> tuple[int, int, int]:
    """The year, month and day of a count of days from 1970-01-01 (Howard Hinnant's `civil_from_days`)."""
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + (3 if mp < 10 else -9)
    return (yoe + era * 400 + (1 if month <= 2 else 0), month, day)


def _pad(value: int, length: int) -> str:
    return str(value).rjust(length, "0")


def _year_text(year: int) -> str:
    """The year of a date's text (§2.2): four digits from 0000 to 9999, and otherwise a sign and six digits."""
    if 0 <= year <= 9999:
        return _pad(year, 4)
    return ("-" if year < 0 else "+") + _pad(abs(year), 6)


def date_text(days: int) -> str:
    """`YYYY-MM-DD` of a count of days, or `±YYYYYY-MM-DD` outside the years 0000 to 9999, and `infinity` or
    `-infinity` for ±`DATE_INFINITY`. Raises outside the dates."""
    if days in (DATE_INFINITY, -DATE_INFINITY):
        return "infinity" if days > 0 else "-infinity"
    if not FIRST_DAY <= days <= LAST_DAY:
        raise ValueError(f"{days} days from 1970-01-01 is not a date.")
    year, month, day = civil_from_days(days)
    return f"{_year_text(year)}-{_pad(month, 2)}-{_pad(day, 2)}"


def parse_date_text(text: str) -> int | None:
    """The count of days of the text of a date (§2.2), or None when it is not a real day that a date may be."""
    infinity = infinity_of(text)
    if infinity != 0:
        return infinity * DATE_INFINITY
    match = _DATE.fullmatch(text)
    if not match:
        return None
    year, month, day = int(match[1]), int(match[2]), int(match[3])
    # The years 0000 to 9999 are written with four digits only; -000000 is not a year.
    if len(match[1]) == 7 and (match[1] == "-000000" or (match[1][0] == "+" and year <= 9999)):
        return None
    if month < 1 or month > 12 or day < 1:
        return None
    days = days_from_civil(year, month, day)
    return days if civil_from_days(days) == (year, month, day) and FIRST_DAY <= days <= LAST_DAY else None


def date_length(text: str) -> int:
    """The length of the date at the start of the text of a date or a timestamp: 13 for a signed year, otherwise
    10. The text is not an infinity."""
    return 13 if text[:1] in ("+", "-") else 10


def temporal_text_form(text: str) -> str:
    """The text form (§2.4) of the text of a date, a timestamp or a timestamptz (§2.2), as DuckDB writes it: years
    after 9999 without a sign or leading zeros (`10000-01-01`), and the years before 1 by their number BC
    (`0001-12-31 (BC)` for year 0), before the time. The infinities are written the same."""
    if (text[:1] not in ("+", "-") and not text.startswith("0000")) or infinity_of(text) != 0:
        return text
    dash = text.index("-", 1)
    year = int(text[:dash])
    date = _pad(year if year > 0 else 1 - year, 4) + text[dash : dash + 6]
    return date + ("" if year > 0 else " (BC)") + text[dash + 6 :]


def _clock(count: int, unit: str) -> str:
    """`HH:MM:SS`, then the fraction of a second without trailing zeros, of a count of a unit within a day."""
    per_second = UNIT_PER_SECOND[unit]
    seconds = _trunc_div(count, per_second)
    fraction = _trunc_rem(count, per_second)
    hours = _trunc_div(seconds, 3600)
    minutes = _trunc_rem(_trunc_div(seconds, 60), 60)
    rest = _trunc_rem(seconds, 60)
    text = f"{_pad(hours, 2)}:{_pad(minutes, 2)}:{_pad(rest, 2)}"
    if fraction != 0:
        text += "." + _pad(fraction, UNIT_DIGITS[unit]).rstrip("0")
    return text


def time_text(micros: int) -> str:
    """The text of a time of day (§2.2) from microseconds since midnight."""
    if micros < 0 or micros >= _DAY_SECONDS * 1_000_000:
        raise ValueError("A time is within one day.")
    return _clock(micros, "us")


def _parse_clock(text: str, unit: str) -> int | None:
    """Reads `HH:MM:SS` with up to the unit's fraction digits as a count of the unit since midnight, or None."""
    match = _CLOCK.fullmatch(text)
    if not match:
        return None
    hours, minutes, seconds = int(match[1]), int(match[2]), int(match[3])
    fraction = match[4] or ""
    if hours > 23 or minutes > 59 or seconds > 59 or len(fraction) > UNIT_DIGITS[unit]:
        return None
    whole = (hours * 3600 + minutes * 60 + seconds) * UNIT_PER_SECOND[unit]
    return whole + (int(fraction.ljust(UNIT_DIGITS[unit], "0")) if fraction else 0)


def parse_time_text(text: str) -> int | None:
    """Microseconds since midnight of the text of a time (§2.2), or None."""
    return _parse_clock(text, "us")


def timestamp_text(count: int, unit: str = "us") -> str:
    """The text of a timestamp (§2.2) from a count of its unit since 1970-01-01 00:00:00, and `infinity` or
    `-infinity` for ±`TIMESTAMP_INFINITY`. Raises for -2^63, which is neither."""
    if count in (TIMESTAMP_INFINITY, -TIMESTAMP_INFINITY):
        return "infinity" if count > 0 else "-infinity"
    if count < -TIMESTAMP_INFINITY:
        raise ValueError("-2^63 is not a timestamp.")
    per_day = _DAY_SECONDS * UNIT_PER_SECOND[unit]
    days = count // per_day
    return f"{date_text(days)} {_clock(count - days * per_day, unit)}"


def parse_timestamp_text(text: str, unit: str = "us") -> int | None:
    """The count of the unit since 1970-01-01 00:00:00 of the text of a timestamp (§2.2), or None. The infinities are
    ±`TIMESTAMP_INFINITY`, which no other timestamp is."""
    infinity = infinity_of(text)
    if infinity != 0:
        return infinity * TIMESTAMP_INFINITY
    space = text.find(" ")
    if space not in (10, 13):
        return None
    days = parse_date_text(text[:space])
    time = _parse_clock(text[space + 1 :], unit)
    if days is None or time is None:
        return None
    count = days * _DAY_SECONDS * UNIT_PER_SECOND[unit] + time
    return count if -TIMESTAMP_INFINITY < count < TIMESTAMP_INFINITY else None


def timestamptz_text(micros: int) -> str:
    """The text of a timestamptz (§2.2) from microseconds since 1970-01-01 00:00:00 UTC."""
    text = timestamp_text(micros, "us")
    return text if infinity_of(text) != 0 else text + "+00"


def parse_timestamptz_text(text: str) -> int | None:
    """Microseconds since 1970-01-01 00:00:00 UTC of the text of a timestamptz (§2.2), or None."""
    if infinity_of(text) != 0:
        return parse_timestamp_text(text, "us")
    timestamp = text[:-3]
    if not text.endswith("+00") or infinity_of(timestamp) != 0:
        return None
    return parse_timestamp_text(timestamp, "us")


@dataclass
class IntervalParts:
    """An interval (§2.1): months, days and nanoseconds."""

    months: int
    days: int
    nanos: int


def _count(value: int, unit: str) -> str:
    return f"{value} {unit}{'' if value in (1, -1) else 's'}"


def interval_text(parts: IntervalParts) -> str:
    """DuckDB's text of an interval (§2.4): years and months, days, then the time as `HH:MM:SS` with the fraction
    without trailing zeros, each left out when it is 0 (`00:00:00` when everything is), as
    `1 year 2 months 3 days 04:05:06.789` or `-01:30:00`. Nanoseconds beyond DuckDB's microseconds add digits."""
    out: list[str] = []
    years = _trunc_div(parts.months, 12)
    rest = parts.months - years * 12
    if years != 0:
        out.append(_count(years, "year"))
    if rest != 0:
        out.append(_count(rest, "month"))
    if parts.days != 0:
        out.append(_count(parts.days, "day"))
    if parts.nanos != 0:
        magnitude = abs(parts.nanos)
        seconds, fraction = divmod(magnitude, 1_000_000_000)
        time = f"{_pad(seconds // 3600, 2)}:{_pad(seconds // 60 % 60, 2)}:{_pad(seconds % 60, 2)}"
        if fraction != 0:
            time += "." + _pad(fraction, 9).rstrip("0")
        out.append(("-" if parts.nanos < 0 else "") + time)
    return " ".join(out) if out else "00:00:00"


def parse_interval_text(text: str) -> IntervalParts | None:
    """The parts of DuckDB's text of an interval, as `interval_text` writes it, or None."""
    match = _INTERVAL.fullmatch(text)
    if not match or text == "" or text.endswith(" "):
        return None
    years, months, days = (int(part or 0) for part in (match[1], match[2], match[3]))
    if int(match[6] or 0) > 59 or int(match[7] or 0) > 59:
        return None
    nanos = 0
    if match[5] is not None:
        seconds = int(match[5]) * 3600 + int(match[6]) * 60 + int(match[7])
        nanos = seconds * 1_000_000_000 + int((match[8] or "").ljust(9, "0"))
        if match[4] == "-":
            nanos = -nanos
    total = years * 12 + months
    if not (-2147483648 <= total <= 2147483647 and -2147483648 <= days <= 2147483647):
        return None
    if not _INT64_MIN <= nanos <= _INT64_MAX:
        return None
    return IntervalParts(total, days, nanos)


def normalize_interval(text: str) -> tuple[int, int, int] | None:
    """The parts of an interval as DuckDB 2.0 compares them (§3.1): its length in nanoseconds, with months of 30 days
    and days of 24 hours, as whole months, then the days (0 to 29) and the nanoseconds (less than a day) of the rest.
    Intervals compare by these months, then days, then nanoseconds; `1 month` equals `30 days`, and `1 month -1 day`
    equals `29 days`. None when the text is not an interval."""
    parts = parse_interval_text(text)
    if parts is None:
        return None
    months, rest = divmod((parts.months * 30 + parts.days) * _NANOS_PER_DAY + parts.nanos, 30 * _NANOS_PER_DAY)
    return (months, *divmod(rest, _NANOS_PER_DAY))
