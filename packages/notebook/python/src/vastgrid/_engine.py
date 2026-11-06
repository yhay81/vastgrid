"""The notebook engine: request dispatch, table handles and their lifecycle (docs/spec.md §8)."""

from __future__ import annotations

import itertools
import os
import threading
from collections.abc import Callable
from typing import Any

import duckdb

from ._block import BlockValueError
from ._capabilities import CAPABILITIES, EXPORT_FORMATS
from ._engine_types import Json, Source
from ._errors import EngineError, _revision_changed
from ._messages import ProtocolError, answer_id, check_request, error_response
from ._plan import PlanError, SpecError
from ._session import Running, Session
from ._table import Table
from ._views import Views


class Engine:
    """Answers the messages of §8.1 for tables of the sources it was given (`add`), by their refs."""

    def __init__(
        self, database: duckdb.DuckDBPyConnection | None = None, text_limit: int = 2000, max_views: int = 8
    ) -> None:
        self.session = Session(database)
        self.views = Views(self.session, text_limit, max_views)
        self.sources: dict[str, Source] = {}
        self.tables: dict[str, Table] = {}
        self.handles: dict[str, Table] = {}
        self.listeners: list[Callable[[Json], None]] = []
        self.running: dict[int, Running] = {}
        self.lock = threading.Lock()
        self._handles = itertools.count(1)
        self.closed = False

    def add(self, ref: str, source: Source) -> None:
        """Lets `open` read a source by `ref`."""
        self.sources[ref] = source

    def subscribe(self, listener: Callable[[Json], None]) -> Callable[[], None]:
        """Follows the events of the engine's tables (§8.5)."""
        self.listeners.append(listener)
        return lambda: self.listeners.remove(listener) if listener in self.listeners else None

    def _emit(self, event: Json) -> None:
        for listener in list(self.listeners):
            listener(event)

    def _tell_changed(self, table: Table) -> None:
        for handle, item in list(self.handles.items()):
            if item is table:
                self._emit(
                    {
                        "v": 2,
                        "event": "changed",
                        "table": handle,
                        "revision": table.revision,
                        "edits": table.edits.state,
                    }
                )

    def handle(self, message: Any) -> Json | None:
        """Answers a request message (§8.1): with a response, an error response, or None for `cancel`."""
        try:
            request = check_request(message)
        except ProtocolError as error:
            return error_response(answer_id(message), "invalid_request", error.message, error.path, error.reason)
        if request["op"] == "cancel":
            with self.lock:
                running = self.running.get(request["request"])
            if running is not None:
                running.cancel()
            return None
        running = Running()
        with self.lock:
            self.running[request["id"]] = running
        try:
            result = self._answer(request, running)
            running.check()
            return {"v": 2, "id": request["id"], "result": result}
        except Exception as error:  # noqa: BLE001 - every error is answered (§8.7)
            code, text, members = self._error_of(error)
            return error_response(
                request["id"], code, text, members.get("path"), members.get("reason"), members.get("details")
            )
        finally:
            with self.lock:
                if self.running.get(request["id"]) is running:
                    del self.running[request["id"]]

    def _error_of(self, error: Exception) -> tuple[str, str, Json]:
        if isinstance(error, BlockValueError):
            return "invalid_value", str(error), {"path": error.path, "reason": error.reason}
        if isinstance(error, EngineError):
            return error.code, error.message, error.members
        if isinstance(error, PlanError):
            return "invalid_plan", error.message, {"path": error.path, "reason": error.reason}
        if isinstance(error, SpecError):
            return error.code, error.message, {}
        if isinstance(error, duckdb.InterruptException):
            return "cancelled", "The request was cancelled.", {}
        return "internal", str(error) or type(error).__name__, {}

    def _table(self, request: Json) -> Table:
        table = self.handles.get(request["table"])
        if table is None:
            raise EngineError("table_not_found", "The table is closed or unknown.")
        if "revision" in request and request["revision"] != table.revision:
            raise _revision_changed()
        return table

    def _answer(self, request: Json, running: Running) -> Any:
        op = request["op"]
        if op == "open":
            return self._open(request["ref"], request.get("read"), running)
        if op == "info":
            return self._info(request["table"], self._table(request))
        if op == "changes":
            table = self._table(request)
            return {"revision": table.revision, "edits": table.edits.state}
        if op == "reload":
            return self._reload(request["table"], running)
        if op == "close":
            self._close(request["table"])
            return None
        if op == "rows":
            return self.views.rows(self._table(request), request, running)
        if op == "locate":
            return self.views.locate(self._table(request), request, running)
        if op == "summarize":
            return self.views.summarize(self._table(request), request, running)
        if op == "find":
            return self.views.find(self._table(request), request, running)
        if op == "write":
            table = self._table(request)
            result = table.edits.write(request, running)
            if result["updated"] > 0:
                self._tell_changed(table)
            return result
        if op == "save":
            self._table(request)
            raise EngineError(
                "save_unsupported",
                "The notebook does not save files: export the table, or read it "
                "into the notebook (Grid.to_pandas, to_polars, to_arrow).",
            )
        if op == "export":
            return self._export(request, running)
        raise EngineError("internal", f"The engine does not answer {op}.")

    def _open(self, ref: str, read: Any, running: Running) -> Json:
        if self.closed:
            raise EngineError("internal", "The engine was closed.")
        source = self.sources.get(ref)
        if source is None:
            raise EngineError("not_allowed", "The notebook did not give a table by this name.")
        if source.format in ("xlsx", "duckdb") and isinstance(read, dict) and isinstance(read.get("sheet"), str):
            source = Source(path=source.path, format=source.format, sheet=read["sheet"])
        key = f"{ref}\0{source.sheet or ''}"
        with self.lock:
            table = self.tables.get(key)
        if table is None:
            table = Table(self.session, ref, source)
            table.load(running)
            with self.lock:
                self.tables[key] = table
        with self.lock:
            table.handles += 1
            handle = f"t{next(self._handles)}"
            self.handles[handle] = table
        return self._info(handle, table)

    def _info(self, handle: str, table: Table) -> Json:
        info: Json = {
            "table": handle,
            "revision": table.revision,
            "edits": table.edits.state,
            "status": "ready",
            "progress": 1,
            "rowCount": table.row_count,
            "readableRows": table.relation.rows if table.relation else 0,
            "columns": table.columns,
            "capabilities": CAPABILITIES,
        }
        if table.source.format is not None:
            info["format"] = table.source.format
        if table.byte_size is not None:
            info["byteSize"] = table.byte_size
        if table.notes:
            info["notes"] = list(table.notes)
        if table.sheets is not None:
            info["sheets"] = [dict(sheet) for sheet in table.sheets]
        if table.sheet is not None:
            info["sheet"] = table.sheet
        return info

    def _reload(self, handle: str, running: Running) -> Json:
        """Moves a handle to its source as it is now (§7.6): with a new revision and without the written cells, which
        stay with the other handles of the table it leaves."""
        old = self._table({"table": handle})
        fresh = Table(self.session, old.ref, old.source)
        fresh.load(running)
        with self.lock:
            if self.handles.get(handle) is not old:
                fresh.dispose()
                raise EngineError("table_not_found", "The table is closed or unknown.")
            self.handles[handle] = fresh
            fresh.handles = 1
            old.handles -= 1
            key = f"{old.ref}\0{old.source.sheet or ''}"
            if self.tables.get(key) is old:
                self.tables[key] = fresh
            left = old.handles == 0
        if left:
            self._release(old)
        self._tell_changed(fresh)
        return self._info(handle, fresh)

    def _close(self, handle: str) -> None:
        """Takes a handle back (§8.2). Written cells belong to the handles open on the table: once the last one
        closes, they are gone, and the source is read again when it is opened again."""
        with self.lock:
            table = self.handles.pop(handle, None)
            if table is None:
                raise EngineError("table_not_found", "The table is closed or unknown.")
            table.handles -= 1
            left = table.handles == 0
            if left:
                for key in [key for key, item in self.tables.items() if item is table]:
                    del self.tables[key]
        if left:
            self._release(table)

    def _release(self, table: Table) -> None:
        self.views.forget(table)
        table.dispose()

    def _export(self, request: Json, running: Running) -> Json:
        """The view's rows as a file (§8.2), answered as its bytes (`delivery` `data`)."""
        table = self._table(request)
        if request["format"] not in EXPORT_FORMATS:
            raise EngineError(
                "invalid_request",
                f"This engine does not export {request['format']} (§4.10).",
                path="/format",
                reason="syntax",
            )
        if "target" in request:
            raise EngineError(
                "not_allowed", "This engine answers exports as data and writes no files: leave out target."
            )
        file = os.path.join(self.session.folder, f"{self.session.name('export')}.{request['format']}")
        try:
            rows = self.views.export(table, request, running, file)
            running.check()
            with open(file, "rb") as data:
                content = data.read()
        finally:
            if os.path.exists(file):
                os.remove(file)
        return {"target": None, "rows": rows, "data": {"bytes": content}}

    def export_file(self, handle: str, request: Json, file: str) -> int:
        """Writes the view of a plan into a file of the notebook's, as `export` writes it; gives its row count."""
        table = self._table({"table": handle})
        return self.views.export(table, {"plan": {}, **request}, Running(), file)

    def close(self) -> None:
        """Cancels the running requests, drops every table and deletes the engine's files."""
        if self.closed:
            return
        self.closed = True
        with self.lock:
            running = list(self.running.values())
            tables = {id(table): table for table in [*self.tables.values(), *self.handles.values()]}
            self.tables.clear()
            self.handles.clear()
        for item in running:
            item.cancel()
        for table in tables.values():
            self._release(table)
        self.listeners.clear()
        self.session.close()
