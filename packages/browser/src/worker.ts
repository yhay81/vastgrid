// The worker that `BrowserSource` starts: it reads one table and answers the source's requests.
import { serveTable } from "./serve.js";

serveTable(globalThis as unknown as Parameters<typeof serveTable>[0]);
