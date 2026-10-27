"""The engine over standard input and output, for the tests of vastgrid-notebook in Node.js
(packages/notebook/test): one JSON message per line, bytes as `{"base64"}` (docs/spec.md §8.8). A line
`{"tables": {ref: {"arrow"}}}` adds tables, each a block (§8.4) in base64, as the conformance corpus gives them.
JSON would not carry all of their values: `-0` is `0` in it."""

import base64
import json
import sys

import pyarrow as pa

from vastgrid import Engine, Source


def encoded(value):
    if isinstance(value, dict) and len(value) == 1 and isinstance(value.get("bytes"), bytes):
        return {"base64": base64.b64encode(value["bytes"]).decode("ascii")}
    if isinstance(value, dict):
        return {key: encoded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [encoded(item) for item in value]
    return value


def main() -> None:
    engine = Engine()
    engine.subscribe(lambda event: None)
    for line in sys.stdin:
        message = json.loads(line)
        if isinstance(message, dict) and "tables" in message:
            errors = {}
            for ref, table in message["tables"].items():
                try:
                    block = base64.b64decode(table["arrow"])
                    engine.add(ref, Source(data=pa.ipc.open_stream(block).read_all()))
                except Exception as error:  # noqa: BLE001 - a table that Arrow does not hold is reported
                    errors[ref] = str(error)
            response = {"added": sorted(message["tables"]), "errors": errors}
        else:
            response = engine.handle(message)
        if response is not None:
            sys.stdout.write(json.dumps(encoded(response), allow_nan=False) + "\n")
            sys.stdout.flush()
    engine.close()


if __name__ == "__main__":
    main()
