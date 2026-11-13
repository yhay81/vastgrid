"""DuckDB sessions and the lifetime and cancellation of their running requests."""

from __future__ import annotations

import itertools
import shutil
import tempfile
import threading
import uuid
import weakref
from collections.abc import Callable
from typing import Any

import duckdb

from ._errors import _cancelled


class Running:
    """A request that runs: its cursor, which `cancel` interrupts."""

    def __init__(self) -> None:
        self.cancelled = False
        self.cursors: list[duckdb.DuckDBPyConnection] = []
        self.lock = threading.Lock()

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            for cursor in self.cursors:
                try:
                    cursor.interrupt()
                except duckdb.Error:
                    pass

    def check(self) -> None:
        if self.cancelled:
            raise _cancelled()


def new_database() -> duckdb.DuckDBPyConnection:
    """A DuckDB database in memory, which spills what does not fit into a folder of its own (DuckDB's default is a
    folder `.tmp` in the working directory, the notebook's)."""
    folder = tempfile.mkdtemp(prefix="vastgrid-spill-")
    database = duckdb.connect(":memory:", config={"temp_directory": folder})
    weakref.finalize(database, shutil.rmtree, folder, True)
    return database


class Session:
    """The engine's DuckDB database, with a cursor for each query and names for the objects it creates."""

    def __init__(self, database: duckdb.DuckDBPyConnection | None = None) -> None:
        self.database = database or new_database()
        self._names = itertools.count(1)
        self._prefix = uuid.uuid4().hex[:8]
        self.folder = tempfile.mkdtemp(prefix="vastgrid-")
        self._finalizer = weakref.finalize(self, shutil.rmtree, self.folder, True)

    def name(self, prefix: str) -> str:
        return f"{prefix}_{self._prefix}_{next(self._names)}"

    def run(self, running: Running | None, task: Callable[[duckdb.DuckDBPyConnection], Any]) -> Any:
        """Runs a task on a cursor of its own, which `running.cancel` interrupts."""
        cursor = self.cursor()
        if running is not None:
            with running.lock:
                running.check()
                running.cursors.append(cursor)
        try:
            return task(cursor)
        except duckdb.InterruptException as error:
            raise _cancelled() from error
        finally:
            if running is not None:
                with running.lock:
                    running.cursors.remove(cursor)
            cursor.close()

    def cursor(self) -> duckdb.DuckDBPyConnection:
        """A connection of its own to the database. Timestamps with time zone are read in UTC, as §2.2 writes them."""
        cursor = self.database.cursor()
        cursor.execute("SET TimeZone = 'UTC'")
        return cursor

    def drop(self, objects: list[str]) -> None:
        cursor = self.database.cursor()
        try:
            for item in objects:
                kind, name = item.split(" ", 1)
                try:
                    cursor.execute(f"DROP {kind} IF EXISTS {name}")
                except duckdb.Error:
                    pass
        finally:
            cursor.close()

    def close(self) -> None:
        self._finalizer()
        try:
            self.database.close()
        except duckdb.Error:
            pass
