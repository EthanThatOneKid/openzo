// A minimal SMTP client (zero deps): implicit TLS (smtps, 465) or STARTTLS
// (587/25), AUTH PLAIN/LOGIN, one message with optional attachments.
// Configured host-wide by the admin: OPENZO_SMTP_URL=smtps://user:pass@host:465
// and OPENZO_SMTP_FROM="openzo <zo@example.com>".
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Uint8Array; contentType?: string }[];
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.OPENZO_SMTP_URL?.trim());
}

class Conn {
  buf = "";
  waiters: ((line: string) => void)[] = [];
  constructor(public sock: Socket | TLSSocket) {
    this.attach();
  }
  attach() {
    this.sock.setEncoding("utf8");
    this.sock.on("data", (d: string) => {
      this.buf += d;
      // A reply is complete at a line whose 4th char is a space ("250 ok").
      let m: RegExpExecArray | null;
      while ((m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(this.buf))) {
        const end = m.index + m[0].length;
        const reply = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        this.waiters.shift()?.(reply);
      }
    });
  }
  read(): Promise<string> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("SMTP timeout")), 30_000);
      this.waiters.push((l) => (clearTimeout(t), res(l)));
    });
  }
  async cmd(line: string | null, expect: number[]): Promise<string> {
    if (line !== null) this.sock.write(`${line}\r\n`);
    const reply = await this.read();
    const code = Number(reply.trim().split("\n").pop()!.slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP ${line?.split(" ")[0] ?? "greeting"}: ${reply.trim()}`);
    return reply;
  }
}

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function build(from: string, mail: Mail): string {
  const boundary = `oz_${randomBytes(12).toString("hex")}`;
  const head = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encWord(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@openzo>`,
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(b64(mail.text))].join("\r\n");
  if (!mail.attachments?.length) return [...head, textPart].join("\r\n");
  const parts = [`--${boundary}\r\n${textPart}`];
  for (const a of mail.attachments) {
    parts.push(
      `--${boundary}\r\nContent-Type: ${a.contentType ?? "application/octet-stream"}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${wrap(b64(a.content))}`,
    );
  }
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts, `--${boundary}--`].join("\r\n");
}

export async function sendMail(mail: Mail, url = process.env.OPENZO_SMTP_URL, from = process.env.OPENZO_SMTP_FROM): Promise<void> {
  if (!url) throw new Error("email is not configured on this server (OPENZO_SMTP_URL)");
  const u = new URL(url);
  const implicit = u.protocol === "smtps:";
  const port = Number(u.port || (implicit ? 465 : 587));
  const sender = from || decodeURIComponent(u.username) || "openzo@localhost";
  const fromAddr = /<([^>]+)>/.exec(sender)?.[1] ?? sender;
  const sock: Socket | TLSSocket = implicit ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : netConnect({ host: u.hostname, port });
  let c = new Conn(sock);
  try {
    await c.cmd(null, [220]);
    let ehlo = await c.cmd("EHLO openzo", [250]);
    if (!implicit && /STARTTLS/i.test(ehlo) && u.searchParams.get("tls") !== "off") {
      await c.cmd("STARTTLS", [220]);
      sock.removeAllListeners("data");
      const secure = tlsConnect({ socket: sock as Socket, servername: u.hostname });
      await new Promise<void>((res, rej) => (secure.once("secureConnect", () => res()), secure.once("error", rej)));
      c = new Conn(secure);
      ehlo = await c.cmd("EHLO openzo", [250]);
    }
    if (u.username) {
      const user = decodeURIComponent(u.username);
      const pass = decodeURIComponent(u.password);
      if (/AUTH[^\r\n]*PLAIN/i.test(ehlo)) await c.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
      else {
        await c.cmd("AUTH LOGIN", [334]);
        await c.cmd(b64(user), [334]);
        await c.cmd(b64(pass), [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    for (const rcpt of mail.to.split(",").map((s) => s.trim()).filter(Boolean)) await c.cmd(`RCPT TO:<${/<([^>]+)>/.exec(rcpt)?.[1] ?? rcpt}>`, [250, 251]);
    await c.cmd("DATA", [354]);
    const data = build(sender, mail).replace(/\r\n\./g, "\r\n..");
    await c.cmd(`${data}\r\n.`, [250]);
    await c.cmd("QUIT", [221]).catch(() => {});
  } finally {
    c.sock.destroy();
  }
}
