/**
 * The host's page of the test host (`serve.ts`): the App in a sandboxed frame, connected with ext-apps' AppBridge
 * as hosts connect it. Its tool calls go to the server through `/tool`; `?file=` names the file that the "agent"
 * opens first, and `window.host` lets a test act as the agent.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

declare global {
  interface Window {
    host: {
      call(name: string, args: Record<string, unknown>): Promise<unknown>;
      /** The tools that the App called, in order. */
      calls: string[];
      /** What `open_grid` answered the "agent", once the App has it. */
      opened: { structuredContent?: { grid?: string } } | null;
    };
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const response = await fetch("/tool", { method: "POST", body: JSON.stringify({ name, arguments: args }) });
  return response.json();
}

window.host = { call, calls: [], opened: null };
const file = new URLSearchParams(location.search).get("file") ?? "orders.csv";
const frame = document.querySelector("iframe") as HTMLIFrameElement;

async function connect() {
  const bridge = new AppBridge(
    null,
    { name: "vastgrid-test-host", version: "0.0.0" },
    { serverTools: {}, openLinks: {} },
    { hostContext: { theme: "light", locale: "en-US", displayMode: "inline" } },
  );
  bridge.oncalltool = async (params) => {
    window.host.calls.push(params.name);
    return call(params.name, params.arguments ?? {});
  };
  bridge.oninitialized = async () => {
    const args = { file };
    await bridge.sendToolInput({ arguments: args });
    // A host shows the App again with the result it kept (a reload, the conversation scrolled back).
    const kept = sessionStorage.getItem(`opened:${file}`);
    const opened = kept ? JSON.parse(kept) : await call("open_grid", args);
    sessionStorage.setItem(`opened:${file}`, JSON.stringify(opened));
    await bridge.sendToolResult(opened);
    window.host.opened = opened;
  };
  await bridge.connect(new PostMessageTransport(frame.contentWindow as Window, frame.contentWindow as Window));
}

// The bridge listens before the page loads: the App starts the handshake as soon as its script runs. The frame's
// window stays the same object when it navigates.
await connect();
frame.src = "/app";
