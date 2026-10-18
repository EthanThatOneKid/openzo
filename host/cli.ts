// openzo admin CLI: `bun host/cli.ts <command>`.
//   create-user <name> <password> [admin]
//   reset-password <name> <password>
//   invite [days] [admin]
//   list
import { randomBytes } from "node:crypto";
import { hashPassword, validName } from "./auth";
import { db, now, users } from "./db";
import { ensureDirs } from "./runtime";

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "create-user": {
    const [name, password, role] = args;
    if (!name || !password || !validName(name) || password.length < 8) throw new Error("usage: create-user <name> <password ≥8> [admin]");
    const u = users.create(name, await hashPassword(password), role === "admin" ? "admin" : "user", null);
    ensureDirs(name);
    console.log(`created ${u.role} ${u.name}`);
    break;
  }
  case "reset-password": {
    const [name, password] = args;
    const u = users.byName(name ?? "");
    if (!u || !password || password.length < 8) throw new Error("usage: reset-password <name> <password ≥8>");
    users.update(u.id, { pass: await hashPassword(password), disabled: 0 });
    db.query("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    console.log(`password reset for ${u.name}`);
    break;
  }
  case "invite": {
    const days = Number(args[0] ?? 7);
    const code = randomBytes(9).toString("base64url");
    db.query("INSERT INTO invites (code, role, expires, created) VALUES (?, ?, ?, ?)").run(code, args[1] === "admin" ? "admin" : "user", days > 0 ? now() + days * 86_400_000 : null, now());
    console.log(code);
    break;
  }
  case "list":
    for (const u of users.all()) console.log(`${u.name}\t${u.role}\t${u.disabled ? "disabled" : "active"}`);
    break;
  default:
    console.log("usage: bun host/cli.ts create-user|reset-password|invite|list …");
}
