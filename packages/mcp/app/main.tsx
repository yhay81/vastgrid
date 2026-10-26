/**
 * The App of vastgrid's MCP server (docs/mcp-app.md): the grid that `open_grid` opened, in the host's frame. Its
 * rows come through the host's tool calls; the person's changes go to the grid on the server, and the agent's
 * come back, so that both see one state. Plain JavaScript and canvas: no WebAssembly, no workers, no network.
 */
import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataGrid } from "vastgrid-grid";
import "vastgrid-grid/styles.css";
import "./app.css";
import type { GridDocument, GridSession } from "vastgrid-spec";
import { callTool, type GridLink, mcpTransport, sync, ToolCallError } from "./transport.js";

/** What `open_grid` answers (`GridState` of the server). */
interface Opened {
  grid: string;
  file: string;
  version: number;
  document: GridDocument;
  session: GridSession;
}

/** Milliseconds that the person's changes wait to go out together, and between retries after a failure. */
const PUSH_DELAY = 250;
const RETRY_DELAY = 2000;

function isOpened(value: unknown): value is Opened {
  const opened = value as Partial<Opened> | null;
  return typeof opened?.grid === "string" && typeof opened.file === "string" && typeof opened.version === "number";
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface GridAppProps {
  app: App;
  opened: Opened;
  host: McpUiHostContext | undefined;
  /** Shows the grid that `open_grid` gave again, for a server that lost this one. */
  onReopen: (opened: Opened) => void;
}

function GridApp({ app, opened, host, onReopen }: GridAppProps) {
  const link = useMemo<GridLink>(() => ({ grid: opened.grid, client: crypto.randomUUID() }), [opened.grid]);
  const transport = useMemo(() => mcpTransport(app, link), [app, link]);
  const [document, setDocument] = useState(opened.document);
  const [session, setSession] = useState(opened.session);
  const version = useRef(-1);
  const latest = useRef({ document: opened.document, session: opened.session });
  const outgoing = useRef<{ document?: GridDocument; session?: GridSession }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const stop = new AbortController();
    /** Takes what the grid on the server has and the App does not. */
    const adopt = (answer: Awaited<ReturnType<typeof sync>>) => {
      transport.deliver(answer.events);
      if (answer.version < version.current) return;
      version.current = answer.version;
      if (answer.document) {
        latest.current.document = answer.document;
        setDocument(answer.document);
      }
      if (answer.session) {
        latest.current.session = answer.session;
        setSession(answer.session);
      }
    };
    /** The server lost the grid (it started again): the file opens again with the App's document. */
    const reopen = async () => {
      const again = await callTool(app, "open_grid", { file: opened.file, document: latest.current.document });
      if (!isOpened(again)) throw new Error("open_grid answered no grid.");
      stop.abort();
      onReopen(again);
    };
    const follow = async () => {
      while (!stop.signal.aborted) {
        try {
          adopt(await sync(app, link, { version: version.current }, stop.signal));
          setStatus(null);
        } catch (error) {
          if (stop.signal.aborted) return;
          if (error instanceof ToolCallError && error.code === "grid_not_found") {
            await reopen().catch(() => setStatus("The server does not answer."));
          } else {
            setStatus("The server does not answer.");
            await delay(RETRY_DELAY, stop.signal);
          }
        }
      }
    };
    void follow();
    const push = () => {
      timer.current = null;
      const parts = outgoing.current;
      outgoing.current = {};
      sync(app, link, { version: version.current, ...parts }).then(adopt, () =>
        setStatus("The server does not answer."),
      );
    };
    pushRef.current = () => {
      if (timer.current === null) timer.current = setTimeout(push, PUSH_DELAY);
    };
    return () => {
      stop.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [app, link, transport, opened.file, onReopen]);

  const locale = host?.locale?.toLowerCase().startsWith("ja") ? "ja" : "en";
  return (
    <div className="vastgrid-app">
      <DataGrid
        transport={transport}
        table={opened.file}
        document={document}
        session={session}
        onDocumentChange={(next) => {
          latest.current.document = next;
          outgoing.current.document = next;
          setDocument(next);
          pushRef.current();
        }}
        onSessionChange={(next) => {
          latest.current.session = next;
          outgoing.current.session = next;
          setSession(next);
          pushRef.current();
        }}
        toolbar
        statusBar
        checkboxes
        locale={locale}
        aria-label={opened.file}
        style={{ height: "100%" }}
      />
      {status && (
        <p className="vastgrid-app-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

const element = document.getElementById("root");
if (!element) throw new Error("There is no #root.");
const root: Root = createRoot(element);
const app = new App({ name: "vastgrid", version: "0.0.0" }, {});
let host: McpUiHostContext | undefined;
let opened: Opened | null = null;

function reopened(again: Opened) {
  opened = again;
  render();
}

function render() {
  root.render(
    opened ? (
      <GridApp key={opened.grid} app={app} opened={opened} host={host} onReopen={reopened} />
    ) : (
      <p className="vastgrid-app-status">Opening the file…</p>
    ),
  );
}

app.ontoolresult = (params) => {
  if (params.isError || !isOpened(params.structuredContent)) {
    root.render(<p className="vastgrid-app-status">The file did not open.</p>);
    return;
  }
  opened = params.structuredContent;
  render();
};
app.onhostcontextchanged = (context) => {
  host = { ...host, ...context };
  if (context.theme) applyDocumentTheme(context.theme);
  render();
};
app.onteardown = async () => {
  root.unmount();
  return {};
};
render();
await app.connect();
host = app.getHostContext();
if (host?.theme) applyDocumentTheme(host.theme);
render();
