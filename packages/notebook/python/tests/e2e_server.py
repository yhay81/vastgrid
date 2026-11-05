"""An isolated Jupyter server for both real notebook UIs, with a tiny editable table and this environment's kernel."""

import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

SETUP = """import pyarrow as pa
from vastgrid import Grid
previous = globals().get("grid")
grid = Grid(pa.table({"id": [1, 2, 3], "city": ["Tokyo", "Osaka", "Kobe"]}), name="cities", height=240)
if previous is not None:
    assert previous._closed, "Running the cell again must close the previous grid"
display(grid)
"""
VERIFY = """assert grid.to_arrow().to_pydict()["city"] == ["Nara", "Osaka", "Kobe"]
print("Python received the edit")
"""


def main() -> None:
    with TemporaryDirectory(prefix="vastgrid-notebook-e2e-") as temporary:
        root = Path(temporary)
        # No user settings, workspaces or kernels are changed by this server.
        for variable, folder in [
            ("JUPYTER_CONFIG_DIR", "config"),
            ("JUPYTER_RUNTIME_DIR", "runtime"),
            ("JUPYTER_DATA_DIR", "data"),
            ("JUPYTERLAB_SETTINGS_DIR", "settings"),
            ("JUPYTERLAB_WORKSPACES_DIR", "workspaces"),
        ]:
            directory = root / folder
            directory.mkdir()
            os.environ[variable] = str(directory)
        data = root / "data"
        kernel = data / "kernels" / "vastgrid-e2e"
        kernel.mkdir(parents=True)
        os.environ["JUPYTER_PATH"] = str(data)
        (kernel / "kernel.json").write_text(
            json.dumps(
                {
                    "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                    "display_name": "Python (vastgrid tests)",
                    "language": "python",
                }
            )
        )
        for name in ["lab", "notebook"]:
            (root / f"{name}.ipynb").write_text(
                json.dumps(
                    {
                        "nbformat": 4,
                        "nbformat_minor": 5,
                        "metadata": {
                            "kernelspec": {
                                "name": "vastgrid-e2e",
                                "display_name": "Python (vastgrid tests)",
                                "language": "python",
                            }
                        },
                        "cells": [
                            {
                                "id": f"{name}-{index}",
                                "cell_type": "code",
                                "metadata": {},
                                "source": code,
                                "outputs": [],
                                "execution_count": None,
                            }
                            for index, code in enumerate([SETUP, VERIFY])
                        ],
                    }
                )
            )
        from jupyterlab.labapp import LabApp

        settings = {"page_config_data": {"buildCheck": False, "buildAvailable": False}}
        LabApp.launch_instance(
            argv=[
                "--no-browser",
                "--ServerApp.ip=127.0.0.1",
                "--ServerApp.port=5188",
                "--ServerApp.port_retries=0",
                f"--ServerApp.root_dir={root}",
                "--IdentityProvider.token=vastgrid-notebook-e2e",
                "--ServerApp.open_browser=False",
                "--LabApp.expose_app_in_browser=True",
                "--JupyterNotebookApp.expose_app_in_browser=True",
                f"--ServerApp.tornado_settings={settings}",
            ]
        )


if __name__ == "__main__":
    main()
