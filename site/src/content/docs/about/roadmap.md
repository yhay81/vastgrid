---
title: Roadmap
description: What is planned for vastgrid after version 2, and what is left out.
---

Version 2 rebuilt vastgrid around a specification: a document and a session as JSON, commands as the API, and
engines that answer the same messages. Its roadmap, [#33](https://github.com/yhay81/vastgrid/issues/33), is done
but for the release itself: every feature of vastgrid 0.1 is in it, or left out with a reason
([v2-from-v1.md](https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md)).

## Next

- **The release.** vastgrid 2.0.0 on npm, the VS Code extension on the Marketplace and the Python package on
  PyPI, all at one version ([#45](https://github.com/yhay81/vastgrid/issues/45)).
- **The memory engine.** The first rows of a large text file while it loads, as the DuckDB engine shows them.
- **The apps.** Exports downloaded from the MCP App, the view kept when the command's page loads again, `.xlsm`
  workbooks in notebooks, and the VS Code extension in Open VSX.
- **The specification.** Its open questions
  ([§12](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#12-open-questions)): lists, structs and maps
  as their own types instead of their text, collations such as the reading order of Japanese, and `quantile` and
  `count_distinct` over dates and times.

## Left out

- A tree of rows: data whose hierarchy is in columns is shown by grouping by several keys.
- Charts inside the grid: a chart reads the grid's view instead ([Charts](/guides/charts/)).
- Resizing several columns at once: each column is resized, or fitted to its values from its menu.

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one before a
larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) describes.
