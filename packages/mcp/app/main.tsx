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
  sheet?: string;
  version: number;
  document: GridDocument;
  session: GridSession;
}

interface AppChrome {
  opening: string;
  openFailed: string;
  noAnswer: string;
  fullscreen: string;
  exitFullscreen: string;
  noDownload: string;
  exportFailed: string;
}

const APP_CHROME: Record<string, AppChrome> = {
  en: {
    opening: "Opening the file…",
    openFailed: "The file did not open.",
    noAnswer: "The server does not answer.",
    fullscreen: "Full screen",
    exitFullscreen: "Exit full screen",
    noDownload: "The host does not download files: ask the agent to export into a folder.",
    exportFailed: "The export could not be read.",
  },
  ja: {
    opening: "ファイルを開いています…",
    openFailed: "ファイルを開けませんでした。",
    noAnswer: "サーバーから応答がありません。",
    fullscreen: "全画面表示",
    exitFullscreen: "全画面表示を終了",
    noDownload:
      "ホストがファイルのダウンロードに対応していません。フォルダへの書き出しをエージェントに依頼してください。",
    exportFailed: "書き出したファイルを読み取れませんでした。",
  },
  "zh-cn": {
    opening: "正在打开文件…",
    openFailed: "无法打开文件。",
    noAnswer: "服务器无响应。",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
    noDownload: "宿主不支持下载文件：请让代理导出到文件夹。",
    exportFailed: "无法读取导出文件。",
  },
  "zh-tw": {
    opening: "正在開啟檔案…",
    openFailed: "無法開啟檔案。",
    noAnswer: "伺服器沒有回應。",
    fullscreen: "全螢幕",
    exitFullscreen: "結束全螢幕",
    noDownload: "宿主不支援下載檔案：請讓代理匯出到資料夾。",
    exportFailed: "無法讀取匯出檔案。",
  },
  ko: {
    opening: "파일을 여는 중…",
    openFailed: "파일을 열지 못했습니다.",
    noAnswer: "서버가 응답하지 않습니다.",
    fullscreen: "전체 화면",
    exitFullscreen: "전체 화면 종료",
    noDownload: "호스트가 파일 다운로드를 지원하지 않습니다. 에이전트에게 폴더로 내보내기를 요청하세요.",
    exportFailed: "내보낸 파일을 읽지 못했습니다.",
  },
  es: {
    opening: "Abriendo el archivo…",
    openFailed: "No se pudo abrir el archivo.",
    noAnswer: "El servidor no responde.",
    fullscreen: "Pantalla completa",
    exitFullscreen: "Salir de pantalla completa",
    noDownload: "El host no descarga archivos: pide al agente que exporte a una carpeta.",
    exportFailed: "No se pudo leer la exportación.",
  },
  fr: {
    opening: "Ouverture du fichier…",
    openFailed: "Le fichier n’a pas pu être ouvert.",
    noAnswer: "Le serveur ne répond pas.",
    fullscreen: "Plein écran",
    exitFullscreen: "Quitter le plein écran",
    noDownload: "L’hôte ne télécharge pas de fichiers : demandez à l’agent d’exporter dans un dossier.",
    exportFailed: "L’exportation n’a pas pu être lue.",
  },
  de: {
    opening: "Datei wird geöffnet…",
    openFailed: "Die Datei konnte nicht geöffnet werden.",
    noAnswer: "Der Server antwortet nicht.",
    fullscreen: "Vollbild",
    exitFullscreen: "Vollbild beenden",
    noDownload: "Der Host lädt keine Dateien herunter: Bitten Sie den Agenten, in einen Ordner zu exportieren.",
    exportFailed: "Der Export konnte nicht gelesen werden.",
  },
  "pt-br": {
    opening: "Abrindo o arquivo…",
    openFailed: "Não foi possível abrir o arquivo.",
    noAnswer: "O servidor não responde.",
    fullscreen: "Tela cheia",
    exitFullscreen: "Sair da tela cheia",
    noDownload: "O host não baixa arquivos: peça ao agente para exportar em uma pasta.",
    exportFailed: "Não foi possível ler a exportação.",
  },
};

function chromeFor(locale = "en"): AppChrome {
  const tag = locale.trim().toLowerCase().replaceAll("_", "-");
  if (APP_CHROME[tag]) return APP_CHROME[tag];
  const base = tag.split("-")[0] ?? "";
  if (base === "zh") {
    return tag.includes("hant") || tag.includes("-tw") || tag.includes("-hk") || tag.includes("-mo")
      ? APP_CHROME["zh-tw"]
      : APP_CHROME["zh-cn"];
  }
  if (base === "pt") return APP_CHROME["pt-br"];
  return APP_CHROME[base] ?? APP_CHROME.en;
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
  const locale = host?.locale ?? "en";
  const chrome = useMemo(() => chromeFor(locale), [locale]);
  const link = useMemo<GridLink>(() => ({ grid: opened.grid, client: crypto.randomUUID() }), [opened.grid]);
  const transport = useMemo(() => mcpTransport(app, link, () => chromeFor(app.getHostContext()?.locale)), [app, link]);
  const [document, setDocument] = useState(opened.document);
  const [session, setSession] = useState(opened.session);
  const version = useRef(-1);
  const latest = useRef({ document: opened.document, session: opened.session });
  const outgoing = useRef<{ document?: GridDocument; session?: GridSession }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushRef = useRef<() => void>(() => {});
  const [unreachable, setUnreachable] = useState(false);

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
      const again = await callTool(app, "open_grid", {
        file: opened.file,
        ...(opened.sheet === undefined ? {} : { sheet: opened.sheet }),
        document: latest.current.document,
      });
      if (!isOpened(again)) throw new Error("open_grid answered no grid.");
      stop.abort();
      onReopen(again);
    };
    const follow = async () => {
      while (!stop.signal.aborted) {
        try {
          adopt(await sync(app, link, { version: version.current }, stop.signal));
          setUnreachable(false);
        } catch (error) {
          if (stop.signal.aborted) return;
          if (error instanceof ToolCallError && error.code === "grid_not_found") {
            await reopen().catch(async () => {
              setUnreachable(true);
              await delay(RETRY_DELAY, stop.signal);
            });
          } else {
            setUnreachable(true);
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
      if (parts.document === undefined && parts.session === undefined) return;
      sync(app, link, { version: version.current, ...parts }).then(adopt, () => {
        if (stop.signal.aborted) return;
        outgoing.current = { ...parts, ...outgoing.current };
        setUnreachable(true);
        timer.current ??= setTimeout(push, RETRY_DELAY);
      });
    };
    pushRef.current = () => {
      if (timer.current === null) timer.current = setTimeout(push, PUSH_DELAY);
    };
    return () => {
      stop.abort();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [app, link, transport, opened.file, opened.sheet, onReopen]);

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
        {...(opened.sheet === undefined ? {} : { open: { sheet: opened.sheet } })}
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
          aria-label={fullscreen ? chrome.exitFullscreen : chrome.fullscreen}
          title={fullscreen ? chrome.exitFullscreen : chrome.fullscreen}
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
      {unreachable && (
        <p className="vastgrid-app-status" role="status">
          {chrome.noAnswer}
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
let openFailed = false;

function reopened(again: Opened) {
  opened = again;
  openFailed = false;
  render();
}

function displayed(mode: McpUiDisplayMode) {
  host = { ...host, displayMode: mode };
  render();
}

function render() {
  const chrome = chromeFor(host?.locale);
  root.render(
    opened ? (
      <GridApp key={opened.grid} app={app} opened={opened} host={host} onReopen={reopened} onDisplayMode={displayed} />
    ) : (
      <p className="vastgrid-app-status">{openFailed ? chrome.openFailed : chrome.opening}</p>
    ),
  );
}

app.ontoolresult = (params) => {
  if (params.isError || !isOpened(params.structuredContent)) {
    opened = null;
    openFailed = true;
    render();
    return;
  }
  opened = params.structuredContent;
  openFailed = false;
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
