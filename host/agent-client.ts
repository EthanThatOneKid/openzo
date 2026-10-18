// Host-side calls into a user's runtime: start a conversation, follow its
// stream to the end of a turn, rebuild its history.
import { agentJwt } from "./auth";
import { db, now, type User } from "./db";
import { ensureRuntime, touch } from "./runtime";

export function agentHeaders(user: User): Record<string, string> {
  return { authorization: `Bearer ${agentJwt(user)}`, "content-type": "application/json" };
}

export function titleFrom(message: unknown): string {
  const text =
    typeof message === "string"
      ? message
      : Array.isArray(message)
        ? message.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ")
        : "";
  const t = text.replace(/\s+/g, " ").trim();
  return t ? (t.length > 80 ? `${t.slice(0, 77)}…` : t) : "New conversation";
}

export function recordConversation(user: User, sessionId: string, title: string, source: string, continuation?: string) {
  db.query(
    `INSERT INTO conversations (id, user_id, title, source, continuation, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, continuation = COALESCE(excluded.continuation, conversations.continuation)`,
  ).run(sessionId, user.id, title, source, continuation ?? null, now(), now());
}

export function bumpConversation(user: User, sessionId: string) {
  db.query("UPDATE conversations SET updated = ? WHERE id = ? AND user_id = ?").run(now(), sessionId, user.id);
}

export async function startConversation(user: User, message: string, source: string) {
  const url = await ensureRuntime(user);
  const res = await fetch(`${url}/eve/v1/session`, {
    method: "POST",
    headers: agentHeaders(user),
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`runtime answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { sessionId: string; continuationToken?: string };
  recordConversation(user, body.sessionId, titleFrom(message), source, body.continuationToken);
  return body;
}

const BOUNDARY = new Set(["session.waiting", "session.completed", "session.failed"]);

// Read a session's durable events from `startIndex` to the tail and stop.
export async function readEvents(user: User, sessionId: string, opts: { startIndex?: number; follow?: boolean; timeoutMs?: number; awaitTurn?: boolean } = {}) {
  const url = await ensureRuntime(user);
  const qs = new URLSearchParams({ includeTailIndex: "1" });
  if (opts.startIndex) qs.set("startIndex", String(opts.startIndex));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  const events: any[] = [];
  try {
    const res = await fetch(`${url}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?${qs}`, {
      headers: agentHeaders(user),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const tailHeader = [...res.headers.entries()].find(([k]) => k.toLowerCase().includes("tail"))?.[1];
    const tail = tailHeader !== undefined && /^-?\d+$/.test(tailHeader) ? Number(tailHeader) : undefined;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let index = opts.startIndex ?? 0;
    let sawTurn = false;
    outer: for (;;) {
      if (!opts.follow && tail !== undefined && index >= tail) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        index++;
        if (ev.type === "turn.started") sawTurn = true;
        // A continued session's log can end on the previous turn's boundary;
        // only a boundary after a turn has started ends a follow.
        if (opts.follow && BOUNDARY.has(ev.type) && (sawTurn || !opts.awaitTurn)) break outer;
        if (!opts.follow && tail !== undefined && index >= tail) break outer;
      }
    }
    reader.cancel().catch(() => {});
  } catch (e) {
    if (!ctrl.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
    touch(user.name);
  }
  return events;
}

export function continuationFrom(events: any[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.data?.continuationToken;
    if (typeof t === "string") return t;
  }
  return undefined;
}

// Current end of a session's event log (to follow only what comes next).
export async function tailIndex(user: User, sessionId: string): Promise<number> {
  const url = await ensureRuntime(user);
  const ctrl = new AbortController();
  const res = await fetch(`${url}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?includeTailIndex=1`, { headers: agentHeaders(user), signal: ctrl.signal });
  const tail = [...res.headers.entries()].find(([k]) => k.toLowerCase().includes("tail"))?.[1];
  ctrl.abort();
  res.body?.cancel().catch(() => {});
  if (!res.ok || tail === undefined) throw new Error(`session ${sessionId} not found`);
  return Number(tail);
}

export function finalText(events: any[]): string {
  const parts: string[] = [];
  let sinceLastTurn: string[] = [];
  for (const e of events) {
    if (e.type === "turn.started") sinceLastTurn = [];
    if (e.type === "message.completed" && typeof e.data?.message === "string" && e.data.message.trim()) sinceLastTurn.push(e.data.message.trim());
  }
  parts.push(...sinceLastTurn);
  return parts.join("\n\n");
}

export function structuredOutput(events: any[]): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i]?.data;
    if (d && typeof d === "object" && "output" in d && d.output !== undefined) return d.output;
  }
  return undefined;
}

// One complete turn: start a conversation (sessionId null) or continue one,
// and wait for the agent to finish. Used by channels, the ask API and
// automations.
export async function runTurn(
  user: User,
  opts: { sessionId?: string | null; continuation?: string | null; message: unknown; source: string; title?: string; outputSchema?: unknown; timeoutMs?: number },
): Promise<{ sessionId: string; continuation?: string; text: string; output?: unknown; failed: boolean; events: any[] }> {
  const url = await ensureRuntime(user);
  let sessionId = opts.sessionId ?? null;
  let startIndex = 0;
  let continuation = opts.continuation ?? undefined;
  if (sessionId && continuation) {
    startIndex = await tailIndex(user, sessionId);
    const res = await fetch(`${url}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: agentHeaders(user),
      body: JSON.stringify({ message: opts.message, continuationToken: continuation, ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}) }),
    });
    if (!res.ok) throw new Error(`runtime answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    bumpConversation(user, sessionId);
  } else {
    const res = await fetch(`${url}/eve/v1/session`, {
      method: "POST",
      headers: agentHeaders(user),
      body: JSON.stringify({ message: opts.message, ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}) }),
    });
    if (!res.ok) throw new Error(`runtime answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const b = (await res.json()) as { sessionId: string; continuationToken?: string };
    sessionId = b.sessionId;
    continuation = b.continuationToken;
    recordConversation(user, sessionId, opts.title ?? titleFrom(opts.message), opts.source, continuation);
  }
  const events = await readEvents(user, sessionId, { startIndex, follow: true, awaitTurn: true, timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  const cont = continuationFrom(events) ?? continuation;
  if (cont) db.query("UPDATE conversations SET continuation = ? WHERE id = ?").run(cont, sessionId);
  return {
    sessionId,
    continuation: cont,
    text: finalText(events),
    output: structuredOutput(events),
    failed: events.some((e) => e.type === "session.failed" || e.type === "turn.failed"),
    events,
  };
}
