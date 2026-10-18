// A minimal Chrome DevTools Protocol client, zero dependencies: the global
// fetch + WebSocket that both Node 24 (the agent runtime) and Bun (the host)
// ship. The host's browser routes (host/browser.ts) and the agent's `browser`
// tool both drive openzo's per-user Chromium through this file, so the UI and
// the agent see exactly the same tabs, cookies and logins.
//
// `endpoint` is the CDP HTTP base (http://127.0.0.1:9222). The websocket URLs
// Chromium reports carry *its* idea of the address (loopback); we rebuild them
// on the endpoint's host so a forwarded port (gVisor: container IP) works.

export interface Tab {
  id: string;
  title: string;
  url: string;
}

export interface PageElement {
  i: number;
  tag: string;
  role?: string;
  label: string;
  type?: string;
  href?: string;
  value?: string;
}

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
  truncated: boolean;
}

const strip = (e: string) => e.replace(/\/+$/, "");

async function cdpHttp<T>(endpoint: string, path: string, method = "GET"): Promise<T> {
  const res = await fetch(`${strip(endpoint)}${path}`, { method, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function browserAlive(endpoint: string): Promise<boolean> {
  try {
    await cdpHttp(endpoint, "/json/version");
    return true;
  } catch {
    return false;
  }
}

export async function listTabs(endpoint: string): Promise<Tab[]> {
  const all = await cdpHttp<any[]>(endpoint, "/json/list");
  return all.filter((t) => t.type === "page").map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

export async function newTab(endpoint: string, url = "about:blank"): Promise<Tab> {
  const t = await cdpHttp<any>(endpoint, `/json/new?${encodeURIComponent(url)}`, "PUT");
  return { id: t.id, title: t.title, url: t.url };
}

export async function activateTab(endpoint: string, id: string): Promise<void> {
  await cdpHttp(endpoint, `/json/activate/${encodeURIComponent(id)}`);
}

export async function closeTab(endpoint: string, id: string): Promise<void> {
  await cdpHttp(endpoint, `/json/close/${encodeURIComponent(id)}`);
}

// The tab to act on: the one asked for, else the most recently activated page
// (Chromium lists pages most-recent first), else a fresh one.
export async function pickTab(endpoint: string, id?: string): Promise<Tab> {
  const tabs = await listTabs(endpoint);
  if (id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) throw new Error(`no such tab: ${id}`);
    return t;
  }
  return tabs[0] ?? (await newTab(endpoint));
}

export async function closeBrowser(endpoint: string): Promise<void> {
  const v = await cdpHttp<any>(endpoint, "/json/version");
  const s = await CdpSession.connect(rebase(endpoint, v.webSocketDebuggerUrl));
  await s.send("Browser.close").catch(() => {});
  s.close();
}

function rebase(endpoint: string, ws: string): string {
  const e = new URL(strip(endpoint));
  const u = new URL(ws);
  u.protocol = e.protocol === "https:" ? "wss:" : "ws:";
  u.host = e.host;
  return u.toString();
}

export class CdpSession {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => (ws.close(), reject(new Error("CDP connect timed out"))), timeoutMs);
      ws.onopen = () => (clearTimeout(t), resolve(new CdpSession(ws)));
      ws.onerror = () => (clearTimeout(t), reject(new Error(`CDP connect failed: ${url}`)));
    });
  }

  static async page(endpoint: string, tabId?: string): Promise<{ session: CdpSession; tab: Tab }> {
    const tab = await pickTab(endpoint, tabId);
    const session = await CdpSession.connect(`${strip(endpoint).replace(/^http/, "ws")}/devtools/page/${tab.id}`);
    return { session, tab };
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: (params: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ------------------------------------------------------------------ actions

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitLoaded(s: CdpSession, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < deadline) {
    const r = await s.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
    if (r?.result?.value === "complete") return;
    await sleep(200);
  }
}

export async function evaluate<T = unknown>(s: CdpSession, expression: string): Promise<T> {
  const r = await s.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
  return r.result?.value as T;
}

export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s/]+\.[^\s/]+(\/.*)?$/.test(s) || s.startsWith("localhost")) return `https://${s}`.replace("https://localhost", "http://localhost");
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

export async function navigate(s: CdpSession, url: string): Promise<void> {
  const r = await s.send("Page.navigate", { url: normalizeUrl(url) });
  if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
  await waitLoaded(s);
}

export async function history(s: CdpSession, dir: "back" | "forward"): Promise<boolean> {
  const h = await s.send("Page.getNavigationHistory");
  const target = h.entries[h.currentIndex + (dir === "back" ? -1 : 1)];
  if (!target) return false;
  await s.send("Page.navigateToHistoryEntry", { entryId: target.id });
  await waitLoaded(s);
  return true;
}

export async function reload(s: CdpSession): Promise<void> {
  await s.send("Page.reload");
  await waitLoaded(s);
}

export async function screenshot(s: CdpSession, format: "jpeg" | "png" = "jpeg", quality = 70): Promise<Uint8Array<ArrayBuffer>> {
  const r = await s.send("Page.captureScreenshot", format === "jpeg" ? { format, quality } : { format });
  const bin = atob(r.data as string);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function viewport(s: CdpSession): Promise<{ width: number; height: number }> {
  return evaluate(s, "({ width: innerWidth, height: innerHeight })");
}

export async function clickAt(s: CdpSession, x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount = 1) {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
  await sleep(120);
}

export async function typeText(s: CdpSession, text: string) {
  await s.send("Input.insertText", { text });
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

// `key` is a DOM key name ("Enter", "a", "ArrowDown"), optionally with
// modifiers: "Control+a", "Shift+Tab".
export async function pressKey(s: CdpSession, combo: string) {
  const parts = combo.split("+");
  const key = parts.pop() || "+";
  let modifiers = 0;
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === "alt") modifiers |= 1;
    else if (l === "control" || l === "ctrl") modifiers |= 2;
    else if (l === "meta" || l === "cmd") modifiers |= 4;
    else if (l === "shift") modifiers |= 8;
  }
  const known = KEYS[key === "Space" ? " " : key];
  const single = key.length === 1;
  const info = known ?? {
    code: single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : "") : key,
    keyCode: single ? key.toUpperCase().charCodeAt(0) : 0,
    text: single ? key : undefined,
  };
  const text = modifiers & ~8 ? undefined : info.text;
  await s.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key: known ? (key === "Space" ? " " : key) : key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers });
  await sleep(80);
}

export async function scroll(s: CdpSession, dx: number, dy: number, x?: number, y?: number) {
  const vp = x === undefined || y === undefined ? await viewport(s) : null;
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: x ?? Math.round(vp!.width / 2),
    y: y ?? Math.round(vp!.height / 2),
    deltaX: dx,
    deltaY: dy,
  });
  await sleep(200);
}

// ------------------------------------------------------------- page reading

// Injected into the page: numbers every visible interactive element with a
// data-oz-idx attribute (so a later click/type can find it again) and returns
// the readable text. Indexes are only valid until the next snapshot.
const SNAPSHOT_JS = (maxText: number, maxEls: number) => `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-oz-idx]').forEach(e => e.removeAttribute('data-oz-idx'));
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const els = [];
  let i = 0;
  for (const e of document.querySelectorAll(sel)) {
    if (els.length >= ${maxEls}) break;
    if (!visible(e) || e.disabled) continue;
    const tag = e.tagName.toLowerCase();
    const type = e.getAttribute('type') || undefined;
    if (tag === 'input' && type === 'hidden') continue;
    const id = e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
    const label = clean(e.getAttribute('aria-label') || (id && id.innerText) || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') || e.value || '').slice(0, 100);
    e.setAttribute('data-oz-idx', String(i));
    const out = { i, tag, label };
    const role = e.getAttribute('role'); if (role) out.role = role;
    if (type) out.type = type;
    if (tag === 'a') out.href = e.href;
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && type !== 'password' && e.value) out.value = String(e.value).slice(0, 80);
    els.push(out);
    i++;
  }
  const text = clean(document.body ? document.body.innerText : '');
  return { title: document.title, url: location.href, text: text.slice(0, ${maxText}), truncated: text.length > ${maxText}, elements: els };
})()`;

export async function snapshot(s: CdpSession, maxText = 8000, maxElements = 150): Promise<PageSnapshot> {
  return evaluate<PageSnapshot>(s, SNAPSHOT_JS(maxText, maxElements));
}

// Centre of an element (by snapshot index or CSS selector), scrolled into view.
export async function locate(s: CdpSession, target: { index?: number; selector?: string }): Promise<{ x: number; y: number }> {
  const sel = target.selector ?? `[data-oz-idx="${target.index}"]`;
  const r = await evaluate<{ x: number; y: number } | null>(
    s,
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!r) throw new Error(target.selector ? `no element matches ${target.selector}` : `no element with index ${target.index} — take a fresh snapshot`);
  return r;
}
