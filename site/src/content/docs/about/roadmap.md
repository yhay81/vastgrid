---
title: Roadmap
description: What is planned for vastgrid after version 0.3, and what is left out.
---

Version 0.2 rebuilt vastgrid around a specification: a document and a session as JSON, commands as the API, and
engines that answer the same messages. Its roadmap, [#33](https://github.com/yhay81/vastgrid/issues/33), is done
apart from Marketplace publication: every feature of vastgrid 0.1 is in it, or left out with a reason
([migrating-from-0.1.md](https://github.com/yhay81/vastgrid/blob/main/docs/migrating-from-0.1.md)). Version 0.3
gave the grid's texts in nine languages, each its own import ([Languages and texts](/guides/localization/)).

## Next

- **Marketplace publication.** vastgrid is on npm, PyPI and GitHub, with the VS Code extension installed from
  GitHub's VSIX files; its listings in the Visual Studio Marketplace and Open VSX remain, which the release
  publishes to once they are set up.
- **The specification.** Its open questions
  ([§12](https://github.com/yhay81/vastgrid/blob/main/docs/spec.md#12-open-questions)): lists, structs and maps
  as their own types instead of their text (and a `histogram` measure that gives one), collations such as the
  reading order of Japanese, and DuckDB's dates beyond those of its timestamps.

## Left out

- A tree of rows: data whose hierarchy is in columns is shown by grouping by several keys.
- Charts inside the grid: a chart reads the grid's view instead ([Charts](/guides/charts/)).
- Resizing several columns at once: each column is resized, or fitted to its values from its menu.

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one before a
larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md) describes.
