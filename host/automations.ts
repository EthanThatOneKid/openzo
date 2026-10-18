// Automations: a cron line + a prompt. The host's minute ticker starts a fresh
// conversation in the owner's runtime when the expression matches, then
// follows the turn to record ok / failed.
import { continuationFrom, finalText, readEvents, startConversation } from "./agent-client";
import { audit, db, now, users } from "./db";
import { notify, type ChannelId } from "./channels";

// Where results go besides the conversation list: "" (nowhere), "auto" (the
// user's preferred channel) or a channel id.
try {
  db.exec("ALTER TABLE automations ADD COLUMN deliver TEXT NOT NULL DEFAULT ''");
} catch {}

export interface Automation {
  id: number;
  user_id: number;
  name: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled: number;
  last_run: number | null;
  last_status: string | null;
  last_conversation: string | null;
  deliver: string;
  created: number;
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 9 * * *",
  "@weekly": "0 9 * * 1",
  "@monthly": "0 9 1 * *",
};

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepStr ? max : lo) : Number(b);
    }
    if (![lo, hi].every((n) => Number.isInteger(n) && n >= min && n <= max) || lo > hi) throw new Error(`bad range "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const parts = (ALIASES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowSet = field(dow, 0, 7);
  if (dowSet.has(7)) dowSet.add(0);
  return { minute: field(m, 0, 59), hour: field(h, 0, 23), dom: field(dom, 1, 31), month: field(mon, 1, 12), dow: dowSet, domStar: dom === "*", dowStar: dow === "*" };
}

function partsIn(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), month: Number(p.month), dow: wd };
}

export function matches(expr: string, tz: string, date = new Date()): boolean {
  const c = parseCron(expr);
  const t = partsIn(date, tz);
  const dayOk = c.domStar || c.dowStar ? c.dom.has(t.dom) && c.dow.has(t.dow) : c.dom.has(t.dom) || c.dow.has(t.dow);
  return c.minute.has(t.minute) && c.hour.has(t.hour) && c.month.has(t.month) && dayOk;
}

export function nextRun(expr: string, tz: string, from = new Date()): number | null {
  const d = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matches(expr, tz, d)) return d.getTime();
    d.setTime(d.getTime() + 60_000);
  }
  return null;
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const automations = {
  forUser: (userId: number) => db.query("SELECT * FROM automations WHERE user_id = ? ORDER BY created").all(userId) as Automation[],
  get: (id: number, userId: number) => db.query("SELECT * FROM automations WHERE id = ? AND user_id = ?").get(id, userId) as Automation | null,
  enabled: () => db.query("SELECT * FROM automations WHERE enabled = 1").all() as Automation[],
};

export async function runAutomation(a: Automation) {
  const user = users.byId(a.user_id);
  if (!user || user.disabled) return;
  db.query("UPDATE automations SET last_run = ?, last_status = 'running' WHERE id = ?").run(now(), a.id);
  try {
    const { sessionId } = await startConversation(user, a.prompt, `automation:${a.id}`);
    db.query("UPDATE automations SET last_conversation = ? WHERE id = ?").run(sessionId, a.id);
    const events = await readEvents(user, sessionId, { follow: true, timeoutMs: 30 * 60_000 });
    const failed = events.some((e) => e.type === "session.failed" || e.type === "turn.failed");
    const cont = continuationFrom(events);
    if (cont) db.query("UPDATE conversations SET continuation = ? WHERE id = ?").run(cont, sessionId);
    db.query("UPDATE automations SET last_status = ? WHERE id = ?").run(failed ? "failed" : "ok", a.id);
    if (a.deliver) {
      const text = finalText(events) || (failed ? "The run failed — open the conversation in openzo." : "Done (no text output).");
      await notify(user, { title: `Automation: ${a.name}`, text }, a.deliver as ChannelId | "auto").catch((e) => {
        db.query("UPDATE automations SET last_status = ? WHERE id = ?").run(`${failed ? "failed" : "ok"}; delivery failed: ${String(e?.message ?? e).slice(0, 150)}`, a.id);
      });
    }
    audit(user.id, "automation.run", { id: a.id, sessionId, failed });
  } catch (e) {
    db.query("UPDATE automations SET last_status = ? WHERE id = ?").run(`error: ${String(e).slice(0, 200)}`, a.id);
  }
}

let lastTick = 0;
function tick() {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute === lastTick) return;
  lastTick = minute;
  const date = new Date(minute * 60_000);
  for (const a of automations.enabled()) {
    try {
      if (matches(a.cron, a.tz, date)) void runAutomation(a);
    } catch {}
  }
}

export function startScheduler() {
  setInterval(tick, 5_000).unref?.();
}
