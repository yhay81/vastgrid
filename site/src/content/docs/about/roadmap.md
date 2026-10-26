---
title: Roadmap
description: What is planned for vastgrid.
---

Cell editing and byte-preserving CSV write-back are implemented in v1. The unreleased v2 rebuild is tracked in [#33](https://github.com/yhay81/vastgrid/issues/33).

v2 rejects out-of-range typed values and malformed Unicode instead of silently changing them in Arrow conversion. Float32 text input is rounded before writing, and numeric overflow is rejected. The [v2 specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) defines these rules.

v2's DuckDB engine writes cells of files, kept apart from the file, with conflict checks and undo, and saves them into CSV and TSV files with the bytes that were not edited kept as they are; the grid saves with ⌘S or Ctrl+S. Files that change on disk are read again, and unsaved edits are kept until you discard them ([#37](https://github.com/yhay81/vastgrid/issues/37)). Views and whole tables are exported as CSV, TSV, Parquet, JSON and Excel on the server ([#38](https://github.com/yhay81/vastgrid/issues/38)). Next: the standard panels and menus ([#42](https://github.com/yhay81/vastgrid/issues/42)) and formulas ([#39](https://github.com/yhay81/vastgrid/issues/39)).

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one
before a larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md)
describes.
