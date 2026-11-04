"""Failures that the notebook engine reports through the protocol."""

from __future__ import annotations

from typing import Any


class EngineError(Exception):
    """An error of §8.7 that the engine answers a request with, with its `path`, `reason` or `details`."""

    def __init__(self, code: str, message: str, **members: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.members = members


def _cancelled() -> EngineError:
    return EngineError("cancelled", "The request was cancelled.")


def _revision_changed() -> EngineError:
    return EngineError("revision_changed", "The table has another revision: read its TableInfo again.")
