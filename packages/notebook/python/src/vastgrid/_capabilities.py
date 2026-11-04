"""The operations and plan features that the notebook engine offers."""

from __future__ import annotations

from ._engine_types import Json

EXPORT_FORMATS = ["csv", "tsv", "parquet", "json", "xlsx"]


CAPABILITIES: Json = {
    "plan": {
        "derive": True,
        "where": True,
        "aggregate": True,
        "pivot": True,
        "having": True,
        "sort": True,
        "search": True,
    },
    "summarize": True,
    "find": True,
    "locate": True,
    "write": True,
    # The notebook has the edited table as a DataFrame (`Grid.to_pandas`, …), or exports it: nothing is saved
    # into a file in its place.
    "save": False,
    "export": {"formats": EXPORT_FORMATS, "delivery": "data"},
    "preview": False,
    "partialViews": False,
    "changes": "push",
}
