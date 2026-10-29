"""The text forms of floats (§2.4.1), with the vectors of packages/spec/test/values.test.ts."""

from __future__ import annotations

from vastgrid._values import float_text, fround


def test_32_bit_floats_have_the_shortest_digits_of_32_bits():
    assert float_text(0.1, 32) == "0.1"
    assert float_text(16777217, 32) == "16777216.0"
    assert float_text(5525.71875, 32) == "5525.7188"
    assert float_text(3.4028234663852886e38, 32) == "3.4028235e+38"
    assert float_text(2.0**-149, 32) == "1e-45"
    assert float_text(2.0**-126, 32) == "1.1754944e-38"
    assert float_text(fround(0.1), 64) == "0.10000000149011612"


def test_32_bit_powers_of_two_take_the_shortest_digits_on_the_far_side_of_their_nearer_neighbor():
    # The float below a power of two is twice as near as the float above it: the nearest eight digits of 2^-96 read
    # back as the float below, and the other eight digits as 2^-96 itself.
    assert float_text(2.0**-96, 32) == "1.2621775e-29"
    assert float_text(2.0**87, 32) == "1.5474251e+26"
    assert float_text(2.0**90, 32) == "1.2379401e+27"
    assert float_text(-(2.0**90), 32) == "-1.2379401e+27"
    for power in range(-149, 128):
        text = float_text(2.0**power, 32)
        assert fround(float(text)) == 2.0**power, text
