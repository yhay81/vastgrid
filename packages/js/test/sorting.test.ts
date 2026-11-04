import { test } from "vite-plus/test";
import { sortFloats } from "./workloads.ts";

for (const form of ["rows", "Arrow"] as const) {
  test(`generated floats as ${form} sort in both directions, with NaN, nulls and stable row IDs`, async () => {
    await sortFloats(30_000, form);
  });
}
