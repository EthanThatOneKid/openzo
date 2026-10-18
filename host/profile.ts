// Personas and rules — Zo's model: any number of personas (name + prompt),
// one active; any number of rules, each an instruction with an optional
// condition. The runtime fetches them at the start of every conversation
// (agent/instructions/zz-user.ts → /internal/profile), so edits apply to the
// next conversation without restarting anything. The agent can manage them
// too ("remember that I…" → a rule).
import { audit, db, now, type User } from "./db";
import { HttpError, body, json, requireUser, route } from "./http";
import { internalRoute } from "./internal";
import { readSettings } from "./settings";

db.exec(`
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  condition TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_persona INTEGER
);
`);

interface Persona { id: number; user_id: number; name: string; prompt: string; created: number; updated: number }
interface Rule { id: number; user_id: number; condition: string; instruction: string; enabled: number; created: number; updated: number }

const personas = (uid: number) => db.query("SELECT * FROM personas WHERE user_id = ? ORDER BY created").all(uid) as Persona[];
const rules = (uid: number) => db.query("SELECT * FROM rules WHERE user_id = ? ORDER BY created").all(uid) as Rule[];
const active = (uid: number) => (db.query("SELECT active_persona FROM profile WHERE user_id = ?").get(uid) as { active_persona: number | null } | null)?.active_persona ?? null;
const setActive = (uid: number, id: number | null) =>
  db.query("INSERT INTO profile (user_id, active_persona) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET active_persona = excluded.active_persona").run(uid, id);

const text = (v: unknown, max: number, what: string) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HttpError(400, `${what} is required`);
  return s.slice(0, max);
};

export function profileOf(u: User) {
  const s = readSettings(u);
  const list = personas(u.id);
  const act = active(u.id);
  return {
    personas: list.map((p) => ({ id: p.id, name: p.name, prompt: p.prompt, active: p.id === act })),
    activePersona: list.find((p) => p.id === act) ?? null,
    rules: rules(u.id).map((r) => ({ id: r.id, condition: r.condition, instruction: r.instruction, enabled: !!r.enabled })),
    // The single persona/rules fields from earlier versions still apply.
    legacy: { persona: s.persona || "", rules: s.rules || "" },
  };
}

function createPersona(u: User, b: any) {
  if (personas(u.id).length >= 50) throw new HttpError(429, "at most 50 personas");
  const row = db.query("INSERT INTO personas (user_id, name, prompt, created, updated) VALUES (?, ?, ?, ?, ?) RETURNING *").get(u.id, text(b.name, 80, "name"), text(b.prompt, 20000, "prompt"), now(), now()) as Persona;
  if (b.active) setActive(u.id, row.id);
  audit(u.id, "persona.create", { id: row.id });
  return row;
}
function updatePersona(u: User, id: number, b: any) {
  const p = db.query("SELECT * FROM personas WHERE id = ? AND user_id = ?").get(id, u.id) as Persona | null;
  if (!p) throw new HttpError(404, "no such persona");
  db.query("UPDATE personas SET name = ?, prompt = ?, updated = ? WHERE id = ?").run(b.name !== undefined ? text(b.name, 80, "name") : p.name, b.prompt !== undefined ? text(b.prompt, 20000, "prompt") : p.prompt, now(), id);
  if (b.active === true) setActive(u.id, id);
  if (b.active === false && active(u.id) === id) setActive(u.id, null);
}
function deletePersona(u: User, id: number) {
  db.query("DELETE FROM personas WHERE id = ? AND user_id = ?").run(id, u.id);
  if (active(u.id) === id) setActive(u.id, null);
}
function createRule(u: User, b: any) {
  if (rules(u.id).length >= 200) throw new HttpError(429, "at most 200 rules");
  const row = db.query("INSERT INTO rules (user_id, condition, instruction, created, updated) VALUES (?, ?, ?, ?, ?) RETURNING *").get(u.id, typeof b.condition === "string" ? b.condition.trim().slice(0, 1000) : "", text(b.instruction, 4000, "instruction"), now(), now()) as Rule;
  audit(u.id, "rule.create", { id: row.id });
  return row;
}
function updateRule(u: User, id: number, b: any) {
  const r = db.query("SELECT * FROM rules WHERE id = ? AND user_id = ?").get(id, u.id) as Rule | null;
  if (!r) throw new HttpError(404, "no such rule");
  db.query("UPDATE rules SET condition = ?, instruction = ?, enabled = ?, updated = ? WHERE id = ?").run(
    typeof b.condition === "string" ? b.condition.trim().slice(0, 1000) : r.condition,
    b.instruction !== undefined ? text(b.instruction, 4000, "instruction") : r.instruction,
    b.enabled === undefined ? r.enabled : b.enabled ? 1 : 0,
    now(),
    id,
  );
}
const deleteRule = (u: User, id: number) => db.query("DELETE FROM rules WHERE id = ? AND user_id = ?").run(id, u.id);

route("GET", "/api/profile", ({ req }) => json(profileOf(requireUser(req))));
route("POST", "/api/personas", async ({ req }) => {
  const u = requireUser(req);
  createPersona(u, await body(req));
  return json(profileOf(u));
});
route("PATCH", "/api/personas/:id", async ({ req, params }) => {
  const u = requireUser(req);
  updatePersona(u, Number(params[0]), await body(req));
  return json(profileOf(u));
});
route("POST", "/api/personas/deactivate", ({ req }) => {
  const u = requireUser(req);
  setActive(u.id, null);
  return json(profileOf(u));
});
route("DELETE", "/api/personas/:id", ({ req, params }) => {
  const u = requireUser(req);
  deletePersona(u, Number(params[0]));
  return json(profileOf(u));
});
route("POST", "/api/rules", async ({ req }) => {
  const u = requireUser(req);
  createRule(u, await body(req));
  return json(profileOf(u));
});
route("PATCH", "/api/rules/:id", async ({ req, params }) => {
  const u = requireUser(req);
  updateRule(u, Number(params[0]), await body(req));
  return json(profileOf(u));
});
route("DELETE", "/api/rules/:id", ({ req, params }) => {
  const u = requireUser(req);
  deleteRule(u, Number(params[0]));
  return json(profileOf(u));
});

// ---------------------------------------------------------------- runtime API

internalRoute("GET", "/profile", ({ user }) => json(profileOf(user)));

internalRoute("POST", "/profile", async ({ req, user }) => {
  const b = await body<{ kind: "persona" | "rule"; action: "create" | "update" | "delete" | "activate"; id?: number; name?: string; prompt?: string; condition?: string; instruction?: string; enabled?: boolean }>(req);
  if (b.kind === "rule") {
    if (b.action === "create") createRule(user, b);
    else if (b.action === "update") updateRule(user, Number(b.id), b);
    else if (b.action === "delete") deleteRule(user, Number(b.id));
    else throw new HttpError(400, "rules support create, update, delete");
  } else if (b.kind === "persona") {
    if (b.action === "create") createPersona(user, b);
    else if (b.action === "update") updatePersona(user, Number(b.id), b);
    else if (b.action === "delete") deletePersona(user, Number(b.id));
    else if (b.action === "activate") updatePersona(user, Number(b.id), { active: true });
    else throw new HttpError(400, "unknown action");
  } else throw new HttpError(400, "kind must be persona or rule");
  return json(profileOf(user));
});
