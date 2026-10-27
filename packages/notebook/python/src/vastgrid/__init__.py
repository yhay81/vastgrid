"""vastgrid in notebooks: tables of any size in vastgrid's grid, with the engine in the kernel (docs/notebook.md)."""

from ._engine import Engine, EngineError, Source
from ._widget import Grid, show

__all__ = ["Engine", "EngineError", "Grid", "Source", "show"]
