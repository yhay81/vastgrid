// Read-only GitHub measurements. Private traffic data stays in the ignored .data/ directory.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = process.argv[2] ?? "yhay81/vastgrid";

async function github(endpoint) {
  const { stdout } = await exec("gh", ["api", `repos/${repository}${endpoint}`], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function main() {
  if (process.argv.length > 3 || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Usage: pnpm growth:snapshot [owner/repository]");
  }

  // Repository metadata is required. A missing login or inaccessible repository must fail the command.
  const repo = await github("");
  const endpoints = ["views", "clones", "popular/referrers", "popular/paths"];
  const trafficResults = await Promise.allSettled(endpoints.map((endpoint) => github(`/traffic/${endpoint}`)));
  const traffic = Object.fromEntries(
    trafficResults.map((result, index) => [
      endpoints[index],
      result.status === "fulfilled"
        ? { available: true, data: result.value }
        : {
            available: false,
            // Do not turn unavailable measurements into zero, or save command output and credentials.
            error: "Unavailable. Check GitHub authentication, repository push access and API availability.",
          },
    ]),
  );
  const capturedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 1,
    capturedAt,
    repository: repo.full_name,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    description: repo.description,
    homepage: repo.homepage,
    topics: repo.topics,
    trafficWindow: "GitHub rolling 14-day window; windows overlap. Do not sum snapshots.",
    traffic,
  };
  const directory = path.resolve(".data", "growth", repository.replace("/", "--"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${capturedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(filename, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Saved ${filename}`);
  console.log(`Stars: ${snapshot.stars}; forks: ${snapshot.forks}`);
  const views = traffic.views;
  console.log(
    views.available
      ? `Last 14 days: ${views.data.count} views; ${views.data.uniques} unique visitors`
      : "Last 14 days: traffic unavailable (not zero)",
  );
  for (const endpoint of endpoints) {
    if (!traffic[endpoint].available) console.warn(`Traffic ${endpoint}: unavailable`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
