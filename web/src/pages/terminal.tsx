import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw } from "lucide-react";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";

export default function TerminalPage() {
  const { boot } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = host.current!;
    const dark = document.documentElement.classList.contains("dark");
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: dark
        ? { background: "#1b1917", foreground: "#e9e6df", cursor: "#e9e6df", selectionBackground: "#4a4540" }
        : { background: "#fbfaf7", foreground: "#2a2622", cursor: "#2a2622", selectionBackground: "#ddd8cf", black: "#2a2622", white: "#9b958c", brightWhite: "#6b655d" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    setStatus("connecting");

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal`);
    ws.binaryType = "arraybuffer";
    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => {
      setStatus("open");
      sendSize();
      term.focus();
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => setStatus("closed");
    const sub = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data: d })));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendSize();
      } catch {}
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, [generation]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2 pl-14 md:pl-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">Terminal</span>
          <span className="text-xs text-muted-foreground">
            {boot?.driver === "gvisor" ? "inside your gVisor container" : "on the host, in your workspace"} · {status}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setGeneration((g) => g + 1)} title="New session">
          <RotateCcw className="size-4" /> Restart
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-[#fbfaf7] p-2 dark:bg-[#1b1917]">
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  );
}
