// The programmatic API: personal access tokens and POST /api/ask — the same
// shape as Zo's /zo/ask ({input, conversation_id?, output_format?}), so
// scripts written against Zo's API port by swapping the base URL and token.
// Tokens are long-lived sessions tagged "api:<name>", so every /api endpoint
// accepts them as `Authorization: Bearer oz_…` (or X-Openzo-Session).
import { createHash } from "node:crypto";
import { audit, db, now, type User } from "./db";
import { createSession } from "./auth";
import { HttpError, body, json, requireUser, route } from "./http";
import { runTurn } from "./agent-client";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN_DAYS = 3650;

route("GET", "/api/tokens", ({ req }) => {
  const u = requireUser(req);
  const rows = db.query("SELECT token, agent, created, expires FROM sessions WHERE user_id = ? AND agent LIKE 'api:%' ORDER BY created DESC").all(u.id) as any[];
  return json({ tokens: rows.map((r) => ({ id: String(r.token).slice(0, 12), name: String(r.agent).slice(4), created: r.created, expires: r.expires })) });
});

route("POST", "/api/tokens", async ({ req }) => {
  const u = requireUser(req);
  const b = await body<{ name?: string }>(req);
  const name = String(b.name ?? "").trim().slice(0, 60) || "token";
  const count = (db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND agent LIKE 'api:%'").get(u.id) as { n: number }).n;
  if (count >= 20) throw new HttpError(429, "at most 20 access tokens");
  const raw = createSession(u, `api:${name}`);
  const token = `oz_${raw}`;
  // Re-key the row under the prefixed token, valid for ten years.
  db.query("UPDATE sessions SET token = ?, expires = ? WHERE token = ?").run(sha(token), now() + TOKEN_DAYS * 86_400_000, sha(raw));
  audit(u.id, "token.create", { name });
  return json({ token, id: sha(token).slice(0, 12), name });
});

route("DELETE", "/api/tokens/:id", ({ req, params }) => {
  const u = requireUser(req);
  const id = params[0]!;
  if (!/^[0-9a-f]{12}$/.test(id)) throw new HttpError(400, "bad token id");
  db.query("DELETE FROM sessions WHERE user_id = ? AND agent LIKE 'api:%' AND token LIKE ?").run(u.id, `${id}%`);
  audit(u.id, "token.delete", { id });
  return json({ ok: true });
});

async function ask(req: Request) {
  const u: User = requireUser(req);
  const b = await body<{ input?: unknown; conversation_id?: string; output_format?: Record<string, unknown> }>(req);
  if (b.input === undefined || (typeof b.input === "string" && !b.input.trim())) throw new HttpError(400, "input is required");
  let continuation: string | null = null;
  if (b.conversation_id) {
    const row = db.query("SELECT continuation FROM conversations WHERE id = ? AND user_id = ?").get(b.conversation_id, u.id) as { continuation: string | null } | null;
    if (!row) throw new HttpError(404, "no such conversation");
    continuation = row.continuation;
  }
  const r = await runTurn(u, {
    sessionId: b.conversation_id ?? null,
    continuation,
    message: b.input,
    source: "api",
    outputSchema: b.output_format,
  });
  let output: unknown = r.text;
  if (b.output_format) {
    output = r.output;
    if (output === undefined) {
      // Models without native structured output: take the JSON from the text.
      const m = /```(?:json)?\s*([\s\S]*?)```/.exec(r.text)?.[1] ?? r.text;
      try {
        output = JSON.parse(m.trim());
      } catch {
        output = r.text;
      }
    }
  }
  return json({ output, conversation_id: r.sessionId, failed: r.failed }, r.failed ? 502 : 200);
}

route("POST", "/api/ask", ({ req }) => ask(req));
