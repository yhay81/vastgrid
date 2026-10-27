---
title: Roadmap
description: What is planned for vastgrid after version 0.2, and what is left out.
---

Version 0.2 rebuilt vastgrid around a specification: a document and a session as JSON, commands as the API, and
engines that answer the same messages. Its roadmap, [#33](https://github.com/yhay81/vastgrid/issues/33), is done
apart from Marketplace publication: every feature of vastgrid 0.1 is in it, or left out with a reason
([migrating-from-0.1.md](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md)).

## Next

- **Marketplace publication.** Version 0.2.0 uses npm, PyPI and GitHub, with the VS Code extension installed from
  GitHub's VSIX files. Its Marketplace listing remains ([#45](https://github.com/yhay81/vastgrid/issues/45)).
- **The memory engine.** The first rows of a large text file while it loads, as the DuckDB engine shows them.
- **The apps.** Exports downloaded from the MCP App, the view kept when the command's page loads again, `.xlsm`
  workbooks in notebooks, and the VS Code extension in Open VSX.
- **The specification.** Its open questions
  ([§12](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#12-open-questions)): lists, structs and maps
  as their own types instead of their text, collations such as the reading order of Japanese, and `quantile` and
  `count_distinct` over dates and times.

## Left out

- A tree of rows: data whose hierarchy is in columns is shown by grouping by several keys.
- Charts inside the grid: a chart reads the grid's view instead ([Charts](/guides/charts/)).
- Resizing several columns at once: each column is resized, or fitted to its values from its menu.

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one before a
larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) describes.
