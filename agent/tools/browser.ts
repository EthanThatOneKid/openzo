// Zo's browser, openzo edition: the user's own persistent Chromium (the same
// one they see and log into on the Browser page), driven over CDP. The host
// starts it on demand and tells us where to dial (POST /internal/browser/ensure).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import * as cdp from "../lib/cdp";
import { hostApi } from "../lib/host-api";

async function endpoint(): Promise<string> {
  const r = await hostApi<{ endpoint: string }>("POST", "/browser/ensure", {}, 60_000);
  return r.endpoint;
}

export default defineTool({
  description: [
    "Drive the user's persistent web browser (a real Chromium; the user can watch it and log into sites on the Browser page, and those logins are yours too).",
    "Actions: open (url — navigate the current tab; new_tab:true opens another), snapshot (title, URL, readable text and numbered interactive elements),",
    "click (index from the latest snapshot, or selector, or x/y in CSS px), type (text into element index/selector, or the focused element; submit:true presses Enter),",
    "press (key like Enter, Tab, Escape, ArrowDown, Control+a), scroll (dy pixels, negative = up), back, forward, reload,",
    "screenshot (saves a PNG under /workspace/.openzo/browser/ and returns its path — use `look` on it to see the page), eval (JavaScript expression, JSON result),",
    "tabs (list), switch_tab (tab id), close_tab (tab id).",
    "Snapshot after navigating or clicking before choosing the next element: indexes change with the page. If a site needs a login you don't have, ask the user to sign in on the Browser page.",
  ].join(" "),
  inputSchema: z.object({
    action: z.enum(["open", "snapshot", "click", "type", "press", "scroll", "back", "forward", "reload", "screenshot", "eval", "tabs", "switch_tab", "close_tab"]),
    url: z.string().optional().describe("open: URL (or search words)."),
    new_tab: z.boolean().optional().describe("open: in a new tab."),
    index: z.number().int().min(0).optional().describe("click/type: element index from the latest snapshot."),
    selector: z.string().optional().describe("click/type: CSS selector instead of an index."),
    x: z.number().optional().describe("click: viewport x in CSS pixels."),
    y: z.number().optional().describe("click: viewport y in CSS pixels."),
    text: z.string().optional().describe("type: text to enter."),
    submit: z.boolean().optional().describe("type: press Enter afterwards."),
    key: z.string().optional().describe("press: key name, optionally with modifiers (Control+a)."),
    dy: z.number().optional().describe("scroll: vertical pixels (default 600)."),
    expression: z.string().optional().describe("eval: JavaScript expression evaluated in the page."),
    tab: z.string().optional().describe("Tab id to act on (default: the current tab)."),
    max_chars: z.number().int().min(500).max(50_000).optional().describe("snapshot: max text chars (default 8000)."),
  }),
  async execute(a) {
    const ep = await endpoint();

    if (a.action === "tabs") return { tabs: await cdp.listTabs(ep) };
    if (a.action === "switch_tab" || a.action === "close_tab") {
      if (!a.tab) throw new Error("tab is required");
      if (a.action === "switch_tab") await cdp.activateTab(ep, a.tab);
      else await cdp.closeTab(ep, a.tab);
      return { tabs: await cdp.listTabs(ep) };
    }
    if (a.action === "open" && a.new_tab) {
      const t = await cdp.newTab(ep, "about:blank");
      await cdp.activateTab(ep, t.id);
      a.tab = t.id;
    }

    const { session: s, tab } = await cdp.CdpSession.page(ep, a.tab);
    const brief = async () => {
      const info = await cdp.evaluate<{ title: string; url: string }>(s, "({ title: document.title, url: location.href })");
      return { tab: tab.id, ...info };
    };
    try {
      switch (a.action) {
        case "open":
          if (!a.url) throw new Error("url is required");
          await cdp.navigate(s, a.url);
          return { ...(await brief()), hint: "snapshot to read the page and get element indexes" };
        case "snapshot":
          return { tab: tab.id, ...(await cdp.snapshot(s, a.max_chars ?? 8000)) };
        case "click": {
          if ((a.x === undefined || a.y === undefined) && a.index === undefined && !a.selector) throw new Error("give index, selector, or x and y");
          const pt = a.index === undefined && !a.selector ? { x: a.x!, y: a.y! } : await cdp.locate(s, { index: a.index, selector: a.selector });
          await cdp.clickAt(s, pt.x, pt.y);
          await new Promise((r) => setTimeout(r, 400));
          return await brief();
        }
        case "type": {
          if (a.text === undefined) throw new Error("text is required");
          if (a.index !== undefined || a.selector) {
            const pt = await cdp.locate(s, { index: a.index, selector: a.selector });
            await cdp.clickAt(s, pt.x, pt.y);
          }
          await cdp.typeText(s, a.text);
          if (a.submit) {
            await cdp.pressKey(s, "Enter");
            await new Promise((r) => setTimeout(r, 800));
          }
          return await brief();
        }
        case "press":
          if (!a.key) throw new Error("key is required");
          await cdp.pressKey(s, a.key);
          return await brief();
        case "scroll":
          await cdp.scroll(s, 0, a.dy ?? 600);
          return { ...(await brief()), scrollY: await cdp.evaluate<number>(s, "scrollY") };
        case "back":
        case "forward": {
          const moved = await cdp.history(s, a.action);
          return { moved, ...(await brief()) };
        }
        case "reload":
          await cdp.reload(s);
          return await brief();
        case "screenshot": {
          const png = await cdp.screenshot(s, "png");
          const dir = join(process.env.OPENZO_WORKSPACE ?? "/workspace", ".openzo", "browser");
          mkdirSync(dir, { recursive: true });
          const name = `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
          writeFileSync(join(dir, name), png);
          return { path: `/workspace/.openzo/browser/${name}`, ...(await brief()), hint: "use the look tool on this path to see it" };
        }
        case "eval": {
          if (!a.expression) throw new Error("expression is required");
          const value = await cdp.evaluate(s, a.expression);
          const text = JSON.stringify(value) ?? "undefined";
          return { value: text.length > 20_000 ? `${text.slice(0, 20_000)}… (truncated)` : text };
        }
      }
    } finally {
      s.close();
    }
  },
});
