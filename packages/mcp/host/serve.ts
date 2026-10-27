/**
 * A host for testing the App (docs/mcp-app.md): it starts the built server (`dist/cli.js`) over stdio as an MCP
 * client, serves the App's page with MCP Apps' default CSP in a sandboxed frame, and carries the frame's tool calls
 * to the server; `POST /restart` starts the server again. `node --import tsx packages/mcp/host/serve.ts <folder> [port]`;
 * e2e/mcp.spec.ts uses it.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 5184);
mkdirSync(folder, { recursive: true });

/**
 * MCP Apps' CSP for a page that declares no domains: its own scripts and styles inline, images and media as data,
 * no network, no frames. WebAssembly needs 'wasm-unsafe-eval', which it does not give.
 */
export const APP_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "media-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'";

/** Starts the server and connects to it. */
async function connect() {
  const started = new Client({ name: "vastgrid-test-host", version: "0.0.0" });
  await started.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "cli.js"), folder] }),
  );
  return started;
}

let client = await connect();
const script = await build({
  entryPoints: [path.join(here, "page.ts")],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "warning",
});
const hostPage = `<!doctype html><html><head><meta charset="utf-8"><title>vastgrid test host</title>
<style>body{margin:0;font-family:system-ui}iframe{width:100%;height:560px;border:0}</style></head>
<body><iframe sandbox="allow-scripts" title="vastgrid"></iframe>
<script type="module">${script.outputFiles[0].text}</script></body></html>`;

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(hostPage);
    } else if (url.pathname === "/app") {
      const resource = await client.readResource({ uri: "ui://vastgrid/grid.html" });
      const content = resource.contents[0] as { text: string };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": APP_CSP });
      response.end(content.text);
    } else if (url.pathname === "/tool" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const { name, arguments: args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await client.callTool({ name, arguments: args });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } else if (url.pathname === "/restart" && request.method === "POST") {
      // The server stops and starts again, as a host does when it restarts a server that failed: its grids are gone.
      await client.close();
      client = await connect();
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error));
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`vastgrid test host on http://127.0.0.1:${port}\n`));
