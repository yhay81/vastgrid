import { expect, test } from "@playwright/test";

type NotebookWindow = Window & { jupyterapp?: { started: Promise<void>; restored: Promise<void> } };

// Both supported front ends, a real kernel and the built anywidget module. No mocked comm or grid transport.
for (const [name, route] of [
  ["lab", "lab/tree"],
  ["notebook", "notebooks"],
]) {
  test(`${name}: edits reach Python, keys stay in the grid, and rerunning closes the old grid`, async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    const session = await request.post("http://127.0.0.1:5188/api/sessions?token=vastgrid-notebook-e2e", {
      data: { path: `${name}.ipynb`, name: `${name}.ipynb`, type: "notebook", kernel: { name: "vastgrid-e2e" } },
    });
    expect(session.status()).toBe(201);
    await page.goto(`http://127.0.0.1:5188/${route}/${name}.ipynb?token=vastgrid-notebook-e2e`);
    await page.waitForFunction(() => !!(window as NotebookWindow).jupyterapp);
    await page.evaluate(async () => {
      const app = (window as NotebookWindow).jupyterapp!;
      await app.started;
      await app.restored;
    });
    const cells = page.locator(".jp-Notebook .jp-CodeCell");
    await expect(cells).toHaveCount(2, { timeout: 60_000 });
    // Observe errors from loading and using the widget, after the host's own startup plugins have initialized.
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    const run = async (index: number) => {
      await cells.nth(index).locator(".cm-content").click();
      await page.keyboard.press("Shift+Enter");
    };
    await run(0);
    const grid = page.getByRole("grid", { name: "cities" });
    await expect(grid).toHaveAttribute("aria-rowcount", "4", { timeout: 60_000 });
    const firstCity = grid.locator('[role="gridcell"][id$="-r0-c1"]');
    await expect(firstCity).toHaveText("Tokyo");
    await grid.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("Nara");
    await expect(page.locator(".vg-editor-input")).toHaveValue("Nara");
    await page.keyboard.press("Enter");
    await expect(firstCity).toHaveText("Nara");
    await expect(grid).toBeFocused();
    await expect(cells).toHaveCount(2); // Notebook command-mode A/B must not add a code cell while typing.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(firstCity).toHaveText("Tokyo");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(firstCity).toHaveText("Nara");
    await run(1);
    await expect(cells.nth(1).locator(".jp-OutputArea")).toContainText("Python received the edit");
    await run(0);
    await expect(firstCity).toHaveText("Tokyo");
    await expect(grid).toHaveCount(1);
    await expect(page.locator(".jp-OutputArea-error")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
