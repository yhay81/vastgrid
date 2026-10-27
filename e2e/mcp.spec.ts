import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";

/**
 * vastgrid's MCP App (docs/mcp-app.md) in a host: the page that the server serves, in a sandboxed frame with MCP
 * Apps' default CSP (no WebAssembly, no network), connected by ext-apps' AppBridge to the built server over stdio
 * (`packages/mcp/host/serve.ts`). The test plays the agent with the server's tools.
 */
const site = "http://127.0.0.1:5184";
const folder = path.resolve(".data/mcp-e2e");

test.beforeAll(() => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "orders.csv"), "id,region,price\n1,EU,10.5\n2,US,30\n3,EU,20\n4,JP,5\n");
});

type Json = Record<string, unknown>;

/** Calls a tool of the server as the agent, and gives its structured content. */
async function agent(page: Page, name: string, args: Json): Promise<Json> {
  const result = (await page.evaluate(([tool, values]) => window.host.call(tool, values), [name, args] as const)) as {
    isError?: boolean;
    structuredContent?: Json;
  };
  expect(result.isError ?? false, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent ?? {};
}

async function openApp(page: Page): Promise<{ app: Frame; grid: string }> {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || /Content Security Policy|WebAssembly/i.test(message.text())) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${site}/?file=orders.csv`);
  // Each test opens its own grid; a reload in a test shows the one it opened.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const app = page.frameLocator("iframe");
  await expect(app.getByRole("grid", { name: "orders.csv" })).toHaveAttribute("aria-rowcount", "5", {
    timeout: 30_000,
  });
  await expect(app.getByRole("gridcell", { name: "US", exact: true })).toBeAttached();
  const grid = await page.evaluate(() => window.host.opened?.structuredContent?.grid);
  expect(grid).toBeTruthy();
  expect(problems).toEqual([]);
  const frame = page.frames().find((item) => item !== page.mainFrame());
  if (!frame) throw new Error("There is no App frame.");
  return { app: frame, grid: grid as string };
}

/** The values of a column in the App's grid, in the order of its rows on screen. */
async function columnValues(page: Page, column: number) {
  const app = page.frameLocator("iframe");
  return app.locator(`[role="gridcell"][aria-colindex="${column}"]`).allTextContents();
}

test("the App shows the file in a sandboxed frame with the default CSP, and its rows come by tool calls", async ({
  page,
}) => {
  await openApp(page);
  const calls = await page.evaluate(() => window.host.calls);
  expect(calls).toContain("vastgrid_message");
  expect(calls).toContain("grid_sync");
  // The page is one file: no WebAssembly, no workers, no requests of its own.
  const resource = await page.request.get(`${site}/app`);
  const html = await resource.text();
  expect(html).not.toMatch(/WebAssembly|new Worker|createObjectURL/);
  expect(resource.headers()["content-security-policy"]).toContain("connect-src 'none'");
});

test("the agent's commands show in the App, and the person's selection reaches the agent", async ({ page }) => {
  const { grid } = await openApp(page);
  await agent(page, "grid_command", {
    grid,
    command: { command: "sort.set", keys: [{ column: "price", direction: "desc" }] },
  });
  const app = page.frameLocator("iframe");
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["2", "3", "1", "4"]);
  await agent(page, "grid_command", { grid, command: { command: "search.set", text: "EU" } });
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["3", "1"]);
  await expect(app.locator(".vg-statusbar")).toContainText("2 rows");
  // The person clicks a cell: the agent reads the active cell and the selection.
  // The cells of the accessibility tree lie over the canvas, which takes the click.
  await app.getByRole("gridcell", { name: "EU" }).first().click({ force: true });
  await expect
    .poll(async () => ((await agent(page, "grid_state", { grid })).session as Json).active, { timeout: 30_000 })
    .toMatchObject({ column: "region", row: 0 });
});

test("the agent writes a cell, the App shows it, and both undo it", async ({ page }) => {
  const { grid } = await openApp(page);
  for (const command of [
    { command: "select", row: 1, column: "price" },
    { command: "edit.begin", text: "99.5" },
    { command: "edit.commit" },
  ]) {
    await agent(page, "grid_command", { grid, command });
  }
  const app = page.frameLocator("iframe");
  await expect(app.getByRole("gridcell", { name: "99.5" })).toBeAttached({ timeout: 30_000 });
  const rows = await agent(page, "grid_rows", { grid, columns: ["id", "price"], count: 2 });
  expect(rows.rows).toEqual([
    [1, 10.5],
    [2, 99.5],
  ]);
  // The person undoes it with the keys: the agent reads the value as it was.
  await app.getByRole("grid", { name: "orders.csv" }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(app.getByRole("gridcell", { name: "99.5" })).not.toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => (await agent(page, "grid_rows", { grid, columns: ["price"], count: 2 })).rows, {
      timeout: 30_000,
    })
    .toEqual([[10.5], [30]]);
});

test("an App that loads again shows the grid as it was", async ({ page }) => {
  const { grid } = await openApp(page);
  await agent(page, "grid_command", {
    grid,
    command: { command: "sort.set", keys: [{ column: "id", direction: "desc" }] },
  });
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["4", "3", "2", "1"]);
  // The host renders the App again for the same tool result (a reload, the conversation scrolled back).
  await page.reload();
  expect(await page.evaluate(() => window.host.calls.includes("open_grid"))).toBe(false);
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["4", "3", "2", "1"]);
});

test("an App whose server started again opens the file again, as the person saw it", async ({ page }) => {
  const { grid } = await openApp(page);
  const app = page.frameLocator("iframe");
  await agent(page, "grid_command", {
    grid,
    command: { command: "sort.set", keys: [{ column: "id", direction: "desc" }] },
  });
  await agent(page, "grid_command", { grid, command: { command: "column.hide", names: ["region"] } });
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["4", "3", "2", "1"]);
  await expect(app.getByRole("columnheader", { name: "region" })).toHaveCount(0);
  expect((await page.request.post(`${site}/restart`)).status()).toBe(204);
  // The new server has no grid of that id: the App opens the file again with the document it shows.
  await expect
    .poll(() => page.evaluate(() => window.host.calls.filter((name) => name === "open_grid").length), {
      timeout: 30_000,
    })
    .toBe(1);
  await expect.poll(() => columnValues(page, 1), { timeout: 30_000 }).toEqual(["4", "3", "2", "1"]);
  await expect(app.getByRole("columnheader", { name: "region" })).toHaveCount(0);
  await expect(app.locator(".vastgrid-app-status")).toHaveCount(0, { timeout: 30_000 });
  const old = (await page.evaluate(([name, args]) => window.host.call(name, args), [
    "grid_state",
    { grid },
  ] as const)) as {
    isError?: boolean;
  };
  expect(old.isError).toBe(true);
});
