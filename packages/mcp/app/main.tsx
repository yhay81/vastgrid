/**
 * The App of vastgrid's MCP server (docs/mcp-app.md): the grid that `open_grid` opened, in the host's frame. Its
 * rows come through the host's tool calls; the person's changes go to the grid on the server, and the agent's
 * come back, so that both see one state. Plain JavaScript and canvas: no WebAssembly, no workers, no network.
 */
import { App, applyDocumentTheme, type McpUiDisplayMode, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataGrid } from "vastgrid";
import { messagesFor } from "vastgrid/locales";
import "vastgrid/styles.css";
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
/** Pixels of the App's height in the conversation, unless the host allows less. */
const INLINE_HEIGHT = 520;
/** The icons of the full screen button: four corners out, and four corners in. */
const ENTER_FULLSCREEN = "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4";
const EXIT_FULLSCREEN = "M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4";

function isOpened(value: unknown): value is Opened {
  const opened = value as Partial<Opened> | null;
  return typeof opened?.grid === "string" && typeof opened.file === "string" && typeof opened.version === "number";
}

/** The App's height: its frame's in full screen or when the host fixes it, else 520 pixels or the host's most. */
function heightOf(host: McpUiHostContext | undefined): string {
  const size = host?.containerDimensions;
  if ((host?.displayMode ?? "inline") !== "inline" || (size && "height" in size)) return "100vh";
  const most = size && "maxHeight" in size ? size.maxHeight : undefined;
  return `${Math.min(INLINE_HEIGHT, most ?? INLINE_HEIGHT)}px`;
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
  /** Takes the display mode that the host set. */
  onDisplayMode: (mode: McpUiDisplayMode) => void;
}

function GridApp({ app, opened, host, onReopen, onDisplayMode }: GridAppProps) {
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

  const locale = host?.locale ?? "en";
  const fullscreen = host?.displayMode === "fullscreen";
  const toggles = host?.availableDisplayModes?.includes(fullscreen ? "inline" : "fullscreen") === true;
  const toggle = () => {
    app.requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" }).then(
      (result) => onDisplayMode(result.mode),
      () => {},
    );
  };
  return (
    <div className={toggles ? "vastgrid-app vastgrid-app--modes" : "vastgrid-app"} style={{ height: heightOf(host) }}>
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
        messages={messagesFor(locale)}
        aria-label={opened.file}
        style={{ height: "100%" }}
      />
      {toggles && (
        <button
          type="button"
          className="vastgrid-app-mode"
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={toggle}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d={fullscreen ? EXIT_FULLSCREEN : ENTER_FULLSCREEN}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      )}
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
const app = new App(
  { name: "vastgrid", version: VASTGRID_VERSION },
  { availableDisplayModes: ["inline", "fullscreen"] },
);
let host: McpUiHostContext | undefined;
let opened: Opened | null = null;

function reopened(again: Opened) {
  opened = again;
  render();
}

function displayed(mode: McpUiDisplayMode) {
  host = { ...host, displayMode: mode };
  render();
}

function render() {
  root.render(
    opened ? (
      <GridApp key={opened.grid} app={app} opened={opened} host={host} onReopen={reopened} onDisplayMode={displayed} />
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
