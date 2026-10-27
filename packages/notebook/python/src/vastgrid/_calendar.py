"""Dates and times as integers and as text (docs/v2-spec.md §2.2): days since 1970-01-01 in the proleptic Gregorian
calendar, and counts of seconds, milliseconds, microseconds or nanoseconds. Years are from 1 to 9999, the years that
the text of §2.2 writes. Python ints stand in for JavaScript's bigints."""

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

_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
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


def date_text(days: int) -> str:
    """`YYYY-MM-DD` of a count of days. Raises for years outside 1 to 9999."""
    year, month, day = civil_from_days(days)
    if year < 1 or year > 9999:
        raise ValueError(f"The year {year} is outside 1 to 9999.")
    return f"{_pad(year, 4)}-{_pad(month, 2)}-{_pad(day, 2)}"


def parse_date_text(text: str) -> int | None:
    """The count of days of `YYYY-MM-DD`, or None when the text is not a real day of the years 1 to 9999."""
    match = _DATE.fullmatch(text)
    if not match:
        return None
    year, month, day = int(match[1]), int(match[2]), int(match[3])
    if year < 1 or month < 1 or month > 12 or day < 1:
        return None
    days = days_from_civil(year, month, day)
    return days if civil_from_days(days) == (year, month, day) else None


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
    """The text of a timestamp (§2.2) from a count of its unit since 1970-01-01 00:00:00."""
    per_day = _DAY_SECONDS * UNIT_PER_SECOND[unit]
    days = count // per_day
    return f"{date_text(days)} {_clock(count - days * per_day, unit)}"


def parse_timestamp_text(text: str, unit: str = "us") -> int | None:
    """The count of the unit since 1970-01-01 00:00:00 of the text of a timestamp (§2.2), or None."""
    if text.find(" ") != 10:
        return None
    days = parse_date_text(text[:10])
    time = _parse_clock(text[11:], unit)
    if days is None or time is None:
        return None
    count = days * _DAY_SECONDS * UNIT_PER_SECOND[unit] + time
    return count if _INT64_MIN <= count <= _INT64_MAX else None


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
    """The parts of an interval as DuckDB 1.5 compares them (§3.1): whole days of the nanoseconds go into the days,
    then whole 30-day months of the days into the months, each by a division that truncates toward zero. Intervals
    compare by these months, then days, then nanoseconds; `1 month` equals `30 days`, and `1 month -1 day` is greater
    than `29 days`. None when the text is not an interval."""
    parts = parse_interval_text(text)
    if parts is None:
        return None
    days = parts.days + _trunc_div(parts.nanos, _NANOS_PER_DAY)
    return (parts.months + _trunc_div(days, 30), _trunc_rem(days, 30), _trunc_rem(parts.nanos, _NANOS_PER_DAY))
