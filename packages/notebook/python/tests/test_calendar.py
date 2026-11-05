"""Timestamp count boundaries shared with vastgrid-spec (§2.2)."""

import pytest

from vastgrid._calendar import TIMESTAMP_INFINITY, timestamp_text


def test_timestamp_counts_reject_both_overflows_and_keep_infinities():
    for unit in ("s", "ms", "us", "ns"):
        with pytest.raises(ValueError):
            timestamp_text(TIMESTAMP_INFINITY + 1, unit)
        with pytest.raises(ValueError):
            timestamp_text(-TIMESTAMP_INFINITY - 1, unit)
        assert timestamp_text(TIMESTAMP_INFINITY, unit) == "infinity"
        assert timestamp_text(-TIMESTAMP_INFINITY, unit) == "-infinity"
    assert timestamp_text(TIMESTAMP_INFINITY - 1) == "+294247-01-10 04:00:54.775806"
    assert timestamp_text(-TIMESTAMP_INFINITY + 1, "ns") == "1677-09-21 00:12:43.145224194"
