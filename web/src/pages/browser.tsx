import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { AppWindow, ArrowLeft, ArrowRight, Keyboard, Loader2, Plus, Power, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { api, authFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Tab {
  id: string;
  title: string;
  url: string;
}
interface State {
  state: "running" | "stopped";
  tabs: Tab[];
  active?: string | null;
}

// Keys forwarded as key presses rather than text.
const SPECIAL = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export default function BrowserPage() {
  const [st, setSt] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [typeBox, setTypeBox] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<string | null>(null);
  const textBuf = useRef("");
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef({ dy: 0, timer: null as ReturnType<typeof setTimeout> | null });
  const running = st?.state === "running";
  const active = st?.tabs.find((t) => t.id === st.active) ?? st?.tabs[0];

  const apply = useCallback((s: State) => {
    setSt(s);
    const a = s.tabs.find((t) => t.id === s.active) ?? s.tabs[0];
    if (a) setUrl((u) => (editingUrlRef.current ? u : a.url === "about:blank" ? "" : a.url));
  }, []);
  const editingUrlRef = useRef(false);
  editingUrlRef.current = editingUrl;

  const refresh = useCallback(() => api<State>("/api/browser").then(apply).catch(() => {}), [apply]);

  const shoot = useCallback(async () => {
    try {
      const r = await authFetch("/api/browser/screenshot");
      if (!r.ok) return;
      const next = URL.createObjectURL(await r.blob());
      if (frameRef.current) URL.revokeObjectURL(frameRef.current);
      frameRef.current = next;
      setFrame(next);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live view: ~1 frame/s while the page is visible; tabs/title every few s.
  useEffect(() => {
    if (!running) return;
    let n = 0;
    shoot();
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      shoot();
      if (++n % 3 === 0) refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [running, shoot, refresh]);

  useEffect(() => () => {
    if (frameRef.current) URL.revokeObjectURL(frameRef.current);
  }, []);

  const act = useCallback(
    async (body: Record<string, unknown>, quiet = false) => {
      try {
        const r = await api<State & { ok: boolean }>("/api/browser/action", { method: "POST", json: { tab: active?.id, ...body } });
        apply({ state: "running", tabs: r.tabs, active: r.active });
        shoot();
      } catch (e) {
        if (!quiet) toast.error((e as Error).message);
      }
    },
    [active?.id, apply, shoot],
  );

  const start = async () => {
    setBusy(true);
    try {
      apply(await api<State>("/api/browser/start", { method: "POST" }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    await api("/api/browser/stop", { method: "POST" }).catch(() => {});
    setFrame(null);
    setBusy(false);
    refresh();
  };

  const flushText = useCallback(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = null;
    const text = textBuf.current;
    textBuf.current = "";
    if (text) return act({ action: "type", text }, true);
  }, [act]);

  const onClick = (e: MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) * img.naturalWidth) / r.width);
    const y = Math.round(((e.clientY - r.top) * img.naturalHeight) / r.height);
    void (flushText() ?? Promise.resolve()).then(() => act({ action: "click", x, y }));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (!mod && e.key.length === 1) {
      e.preventDefault();
      textBuf.current += e.key;
      if (textTimer.current) clearTimeout(textTimer.current);
      textTimer.current = setTimeout(flushText, 250);
      return;
    }
    if (SPECIAL.has(e.key) || (mod && e.key.length === 1)) {
      e.preventDefault();
      const combo = [e.ctrlKey && "Control", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && e.key.length > 1 && "Shift", e.key].filter(Boolean).join("+");
      void (flushText() ?? Promise.resolve()).then(() => act({ action: "press", key: combo }, true));
    }
  };

  const onWheel = (e: WheelEvent<HTMLImageElement>) => {
    const w = wheel.current;
    w.dy += e.deltaY;
    if (w.timer) return;
    w.timer = setTimeout(() => {
      const dy = Math.round(w.dy);
      w.dy = 0;
      w.timer = null;
      if (dy) act({ action: "scroll", dy }, true);
    }, 150);
  };

  const go = (e: FormEvent) => {
    e.preventDefault();
    setEditingUrl(false);
    if (url.trim()) act({ action: "goto", url: url.trim() });
  };

  const sendTypeBox = async (e: FormEvent) => {
    e.preventDefault();
    if (!typeBox) return;
    await act({ action: "type", text: typeBox });
    setTypeBox("");
  };

  if (!st) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (!running) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AppWindow className="mx-auto mb-3 size-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Your browser</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A real Chromium that lives with your workspace. Log into sites here and your agent browses with the same session — cookies and logins persist
            between visits. It stops itself after 20 minutes idle.
          </p>
          <Button className="mt-5" onClick={start} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />} Start browser
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b px-2 pt-2 pl-14 md:pl-2">
        {st.tabs.map((t) => (
          <div
            key={t.id}
            className={cn(
              "group flex max-w-52 min-w-28 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs",
              t.id === active?.id ? "bg-card font-medium" : "bg-muted/40 text-muted-foreground hover:bg-muted",
            )}
            onClick={() => t.id !== active?.id && act({ action: "activate", tab: t.id })}
            title={t.url}
          >
            <span className="min-w-0 flex-1 truncate">{t.title || t.url || "New tab"}</span>
            <button
              className="rounded p-0.5 opacity-50 hover:bg-accent hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                act({ action: "closetab", tab: t.id });
              }}
              title="Close tab"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => act({ action: "newtab" })} title="New tab">
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-1 border-b bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => act({ action: "back" })} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => act({ action: "forward" })} title="Forward">
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => act({ action: "reload" })} title="Reload">
          <RotateCw className="size-4" />
        </Button>
        <form onSubmit={go} className="min-w-0 flex-1">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={(e) => (setEditingUrl(true), e.target.select())}
            onBlur={() => setEditingUrl(false)}
            placeholder="Search or enter address"
            className="h-8 text-sm"
          />
        </form>
        <Button variant="ghost" size="sm" onClick={stop} disabled={busy} title="Stop the browser (your logins are kept)">
          <Power className="size-4" /> Stop
        </Button>
      </div>

      <div
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => (setFocused(false), void flushText())}
        className={cn("relative min-h-0 flex-1 overflow-auto bg-muted/30 p-3 outline-none", focused && "ring-2 ring-primary/40 ring-inset")}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={frame}
            alt={active?.title ?? "browser"}
            draggable={false}
            onClick={onClick}
            onWheel={onWheel}
            className="mx-auto w-full max-w-[1280px] cursor-pointer rounded-md border bg-white shadow-sm select-none"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <Keyboard className="size-3.5" />
        <span className="hidden sm:inline">{focused ? "Typing goes to the page." : "Click the page, then type — or paste text here:"}</span>
        <form onSubmit={sendTypeBox} className="flex min-w-48 flex-1 items-center gap-2">
          <Input value={typeBox} onChange={(e) => setTypeBox(e.target.value)} placeholder="Text to type into the focused field" className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="outline" className="h-7">
            Send
          </Button>
        </form>
        <span className="w-full sm:w-auto">Log into sites here — your agent uses the same browser and session.</span>
      </div>
    </div>
  );
}
