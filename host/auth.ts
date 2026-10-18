// Accounts, browser sessions, and the JWTs the host mints for user runtimes.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config";
import { db, now, users, type User } from "./db";

const COOKIE = "oz_session";
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function validName(name: string): boolean {
  return NAME_RE.test(name) && !["admin-api", "root", "system", "openzo"].includes(name);
}

export const hashPassword = (p: string) => Bun.password.hash(p, { algorithm: "argon2id" });
export const verifyPassword = (p: string, h: string) => Bun.password.verify(p, h).catch(() => false);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(user: User, agent: string | null): string {
  const token = randomBytes(32).toString("base64url");
  db.query("INSERT INTO sessions (token, user_id, expires, created, agent) VALUES (?, ?, ?, ?, ?)").run(
    sha(token),
    user.id,
    now() + config.sessionDays * 86_400_000,
    now(),
    agent,
  );
  return token;
}

export function destroySession(token: string) {
  db.query("DELETE FROM sessions WHERE token = ?").run(sha(token));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionDays * 86400}${secure ? "; Secure" : ""}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function tokenFrom(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === COOKIE) return v.join("=");
  }
  // API clients may use a bearer token (same session tokens).
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

let lastSweep = 0;
export function userFrom(req: Request): User | null {
  const token = tokenFrom(req);
  if (!token) return null;
  if (now() - lastSweep > 3_600_000) {
    lastSweep = now();
    db.query("DELETE FROM sessions WHERE expires < ?").run(now());
  }
  const row = db.query("SELECT user_id, expires FROM sessions WHERE token = ?").get(sha(token)) as
    | { user_id: number; expires: number }
    | null;
  if (!row || row.expires < now()) return null;
  const user = users.byId(row.user_id);
  if (!user || user.disabled) return null;
  return user;
}

export function tokenOf(req: Request) {
  return tokenFrom(req);
}

// HS256 JWT for the user's runtime: eve's jwtHmac() verifies issuer, audience
// and expiry; the principal is the username.
export function agentJwt(user: User): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "openzo-host", aud: "openzo-agent", sub: user.name, name: user.name, iat, nbf: iat - 5, exp: iat + 600 });
  const sig = createHmac("sha256", config.secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// Login throttling: 10 failures per IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
export function throttled(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.n >= 10 && f.until > now();
}
export function recordFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < now()) failures.set(ip, { n: 1, until: now() + 900_000 });
  else f.n++;
}
export function clearFailures(ip: string) {
  failures.delete(ip);
}
