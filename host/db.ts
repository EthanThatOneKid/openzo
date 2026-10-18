// SQLite schema and queries. One file, WAL mode, no ORM.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DATA } from "./config";

export const db = new Database(join(DATA, "openzo.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL,
  agent TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user',
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires INTEGER,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat',
  continuation TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id, updated DESC);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'UTC',
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER,
  last_status TEXT,
  last_conversation TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
`);

export interface User {
  id: number;
  name: string;
  email: string | null;
  pass: string;
  role: "admin" | "user";
  disabled: number;
  settings: string;
  created: number;
  last_seen: number | null;
}

export const now = () => Date.now();

export function audit(userId: number | null, action: string, detail?: unknown) {
  db.query("INSERT INTO audit (ts, user_id, action, detail) VALUES (?, ?, ?, ?)").run(
    now(),
    userId,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

export const users = {
  count: () => (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
  byId: (id: number) => db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null,
  byName: (name: string) => db.query("SELECT * FROM users WHERE name = ? COLLATE NOCASE").get(name) as User | null,
  all: () => db.query("SELECT * FROM users ORDER BY created").all() as User[],
  create: (name: string, pass: string, role: "admin" | "user", email: string | null) =>
    db
      .query("INSERT INTO users (name, pass, role, email, created) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .get(name, pass, role, email, now()) as User,
  update: (id: number, fields: Partial<Pick<User, "pass" | "role" | "disabled" | "settings" | "email" | "last_seen">>) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    db.query(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...(Object.values(fields) as (string | number | null)[]),
      id,
    );
  },
  remove: (id: number) => db.query("DELETE FROM users WHERE id = ?").run(id),
};
