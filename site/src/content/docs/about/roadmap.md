---
title: Roadmap
description: What is planned for vastgrid.
---

Cell editing and byte-preserving CSV write-back are implemented in v1. The unreleased v2 rebuild is tracked in [#33](https://github.com/yhay81/vastgrid/issues/33).

v2 rejects out-of-range typed values and malformed Unicode instead of silently changing them in Arrow conversion. Float32 text input is rounded before writing, and numeric overflow is rejected. The [v2 specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md#22-values-in-json) defines these rules.

Ideas and use cases are welcome in [the issues](https://github.com/yhay81/vastgrid/issues). Open one
before a larger pull request, as [CONTRIBUTING.md](https://github.com/yhay81/vastgrid/blob/main/CONTRIBUTING.md)
describes.
