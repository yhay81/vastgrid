---
title: Roadmap
description: What is planned for vastgrid.
---

Cell editing and byte-preserving CSV write-back are implemented in v1. The unreleased v2 rebuild is tracked in [#33](https://github.com/yhay81/vastgrid/issues/33).

v2 rejects out-of-range typed values and malformed Unicode instead of silently changing them in Arrow conversion. Float32 text input is rounded before writing, and numeric overflow is rejected. The [v2 specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) defines these rules.

v2's DuckDB engine writes cells of files, kept apart from the file, with conflict checks and undo, and saves them into CSV and TSV files with the bytes that were not edited kept as they are; the grid saves with ⌘S or Ctrl+S. Files that change on disk are read again, and unsaved edits are kept until you discard them ([#37](https://github.com/yhay81/vastgrid/issues/37)). Views and whole tables are exported as CSV, TSV, Parquet, JSON and Excel on the server ([#38](https://github.com/yhay81/vastgrid/issues/38)). Formulas in v1's language compile to plan expressions, v1's saved formulas migrate, and the toolbar's Formulas menu adds, changes, renames and removes derived columns ([#39](https://github.com/yhay81/vastgrid/issues/39)). The standard panels and menus are under way ([#42](https://github.com/yhay81/vastgrid/issues/42)): each column has a menu that sorts by it, filters it by a list of its values with their counts or by a condition, and fits, freezes and hides it. Next: column statistics, groups and totals, and the columns panel.

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one
before a larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md)
describes.
