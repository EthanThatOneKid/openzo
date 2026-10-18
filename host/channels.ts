// Channels: how openzo reaches the user outside the web app, and how the user
// reaches their agent. Zo runs its own phone numbers and inboxes; openzo uses
// the user's own accounts instead:
//
//   telegram  a bot the user creates with @BotFather. Two-way: messages to
//             the bot are a conversation with the agent (host long-polls, no
//             public URL needed); the agent and automations can message you.
//   email     host-wide SMTP set by the admin (OPENZO_SMTP_URL), the user's
//             own address. Outbound.
//   discord   a channel webhook URL. Outbound (files attached).
//   slack     an incoming-webhook URL. Outbound.
//   ntfy      an ntfy.sh (or self-hosted) topic URL — push to any phone.
//   sms       the user's own Twilio account. Outbound.
//   webhook   POST JSON {title, text, user} to any URL.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { audit, db, now, users, type User } from "./db";
import { HttpError, body, json, requireUser, route } from "./http";
import { internalRoute } from "./internal";
import { paths } from "./runtime";
import { runTurn } from "./agent-client";
import { sendMail, smtpConfigured } from "./smtp";

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}'
);
`);

export const CHANNELS = ["telegram", "email", "discord", "slack", "ntfy", "sms", "webhook"] as const;
export type ChannelId = (typeof CHANNELS)[number];

export interface ChannelConfig {
  preferred?: ChannelId | "";
  telegram?: { botToken?: string; chatId?: string; chat?: boolean };
  email?: { address?: string };
  discord?: { webhookUrl?: string };
  slack?: { webhookUrl?: string };
  ntfy?: { topicUrl?: string; token?: string };
  sms?: { accountSid?: string; authToken?: string; from?: string; to?: string };
  webhook?: { url?: string; secret?: string };
}
interface ChannelState {
  telegramOffset?: number;
  telegramPairCode?: string;
  telegramSession?: { id: string; continuation?: string };
  telegramBot?: string;
}

const SECRET_FIELDS: Record<string, string[]> = {
  telegram: ["botToken"],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  ntfy: ["token"],
  sms: ["authToken"],
  webhook: ["secret"],
};
const MASK = "••••";

function load(uid: number): { config: ChannelConfig; state: ChannelState } {
  const row = db.query("SELECT config, state FROM channels WHERE user_id = ?").get(uid) as { config: string; state: string } | null;
  return { config: JSON.parse(row?.config ?? "{}"), state: JSON.parse(row?.state ?? "{}") };
}
function save(uid: number, config: ChannelConfig, state: ChannelState) {
  db.query("INSERT INTO channels (user_id, config, state) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, state = excluded.state").run(
    uid,
    JSON.stringify(config),
    JSON.stringify(state),
  );
}
const saveState = (uid: number, state: ChannelState) => save(uid, load(uid).config, state);

function enabled(c: ChannelConfig, id: ChannelId): boolean {
  switch (id) {
    case "telegram":
      return Boolean(c.telegram?.botToken && c.telegram?.chatId);
    case "email":
      return Boolean(smtpConfigured() && c.email?.address);
    case "discord":
      return Boolean(c.discord?.webhookUrl);
    case "slack":
      return Boolean(c.slack?.webhookUrl);
    case "ntfy":
      return Boolean(c.ntfy?.topicUrl);
    case "sms":
      return Boolean(c.sms?.accountSid && c.sms?.authToken && c.sms?.from && c.sms?.to);
    case "webhook":
      return Boolean(c.webhook?.url);
  }
}

function masked(c: ChannelConfig) {
  const out: any = JSON.parse(JSON.stringify(c));
  for (const [ch, fields] of Object.entries(SECRET_FIELDS)) {
    for (const f of fields) if (out[ch]?.[f]) out[ch][f] = `${MASK}${String(out[ch][f]).slice(-4)}`;
  }
  return out;
}

function merge(prev: ChannelConfig, input: any): ChannelConfig {
  const next: any = { preferred: CHANNELS.includes(input?.preferred) ? input.preferred : input?.preferred === "" ? "" : prev.preferred };
  for (const ch of CHANNELS) {
    const src = input?.[ch];
    const old: any = (prev as any)[ch] ?? {};
    if (src === undefined) {
      if (Object.keys(old).length) next[ch] = old;
      continue;
    }
    const merged: any = {};
    for (const [k, v] of Object.entries(src ?? {})) {
      if (typeof v === "boolean") merged[k] = v;
      else if (typeof v === "string") {
        const t = v.trim();
        merged[k] = t.startsWith(MASK) ? old[k] : t || undefined;
      }
    }
    // chatId is learned by pairing, never typed: keep it unless the bot changed.
    if (ch === "telegram" && old.chatId && merged.chatId === undefined && merged.botToken === old.botToken) merged.chatId = old.chatId;
    next[ch] = merged;
  }
  return next;
}

// ---------------------------------------------------------------- senders

export interface Outgoing {
  title?: string;
  text: string;
  files?: string[]; // absolute host paths
}

const MAX_FILE = 20 * 1024 * 1024;
function fileBlobs(files: string[] = []) {
  return files
    .filter((f) => existsSync(f) && statSync(f).isFile() && statSync(f).size <= MAX_FILE)
    .map((f) => ({ name: basename(f), data: readFileSync(f) }));
}

async function ok(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const tgApi = (token: string, method: string) => `${process.env.OPENZO_TELEGRAM_API ?? "https://api.telegram.org"}/bot${token}/${method}`;

async function tgSend(token: string, chatId: string, text: string) {
  for (let i = 0; i < text.length || i === 0; i += 4000) {
    const chunk = text.slice(i, i + 4000) || "(empty)";
    await ok(await fetch(tgApi(token, "sendMessage"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunk }) }), "Telegram");
  }
}

const senders: Record<ChannelId, (c: ChannelConfig, m: Outgoing, user: User) => Promise<void>> = {
  async telegram(c, m) {
    const { botToken, chatId } = c.telegram!;
    await tgSend(botToken!, chatId!, m.title ? `${m.title}\n\n${m.text}` : m.text);
    for (const f of fileBlobs(m.files)) {
      const form = new FormData();
      form.set("chat_id", chatId!);
      form.set("document", new Blob([f.data]), f.name);
      await ok(await fetch(tgApi(botToken!, "sendDocument"), { method: "POST", body: form }), "Telegram");
    }
  },
  async email(c, m) {
    await sendMail({
      to: c.email!.address!,
      subject: m.title ?? m.text.split("\n")[0]!.slice(0, 80),
      text: m.text,
      attachments: fileBlobs(m.files).map((f) => ({ filename: f.name, content: f.data })),
    });
  },
  async discord(c, m) {
    const content = (m.title ? `**${m.title}**\n${m.text}` : m.text).slice(0, 2000);
    const files = fileBlobs(m.files);
    if (files.length) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ content }));
      files.slice(0, 10).forEach((f, i) => form.set(`files[${i}]`, new Blob([f.data]), f.name));
      await ok(await fetch(c.discord!.webhookUrl!, { method: "POST", body: form }), "Discord");
    } else {
      await ok(await fetch(c.discord!.webhookUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }), "Discord");
    }
  },
  async slack(c, m) {
    await ok(await fetch(c.slack!.webhookUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: m.title ? `*${m.title}*\n${m.text}` : m.text }) }), "Slack");
  },
  async ntfy(c, m) {
    const headers: Record<string, string> = {};
    if (m.title) headers.Title = encodeURIComponent(m.title).length === m.title.length ? m.title : `=?UTF-8?B?${Buffer.from(m.title).toString("base64")}?=`;
    if (c.ntfy!.token) headers.Authorization = `Bearer ${c.ntfy!.token}`;
    await ok(await fetch(c.ntfy!.topicUrl!, { method: "POST", headers, body: m.text }), "ntfy");
  },
  async sms(c, m) {
    const s = c.sms!;
    const form = new URLSearchParams({ To: s.to!, From: s.from!, Body: (m.title ? `${m.title}: ${m.text}` : m.text).slice(0, 1500) });
    await ok(
      await fetch(`${process.env.OPENZO_TWILIO_API ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(s.accountSid!)}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${s.accountSid}:${s.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }),
      "Twilio",
    );
  },
  async webhook(c, m, user) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.webhook!.secret) headers["x-openzo-secret"] = c.webhook!.secret;
    await ok(await fetch(c.webhook!.url!, { method: "POST", headers, body: JSON.stringify({ user: user.name, title: m.title ?? null, text: m.text, ts: now() }) }), "webhook");
  },
};

export function availableChannels(user: User): ChannelId[] {
  const { config } = load(user.id);
  return CHANNELS.filter((ch) => enabled(config, ch));
}

// Send to one channel, or to the user's preferred one, or to the first set up.
export async function notify(user: User, msg: Outgoing, channel?: ChannelId | "auto"): Promise<ChannelId> {
  const { config } = load(user.id);
  let ch: ChannelId | undefined;
  if (channel && channel !== "auto") {
    if (!enabled(config, channel)) throw new HttpError(400, `${channel} is not set up — configure it in Settings → Channels`);
    ch = channel;
  } else {
    ch = config.preferred && enabled(config, config.preferred) ? config.preferred : CHANNELS.find((c) => enabled(config, c));
  }
  if (!ch) throw new HttpError(400, "no channel is set up — the user can add Telegram, email, Discord, Slack, ntfy, SMS or a webhook in Settings → Channels");
  await senders[ch](config, msg, user);
  audit(user.id, "notify", { channel: ch });
  return ch;
}

// Agent paths (/workspace/...) → files on the host.
export function workspaceFile(user: User, p: string): string {
  const root = paths(user.name).workspace;
  const rel = p.replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw new HttpError(400, `${p} is outside the workspace`);
  if (!existsSync(full)) throw new HttpError(404, `${p} does not exist`);
  return full;
}

// ---------------------------------------------------------------- telegram inbound

const pollers = new Map<number, AbortController>();

async function handleTelegram(user: User, token: string, msg: any) {
  const chatId = String(msg.chat?.id ?? "");
  const text: string = msg.text ?? msg.caption ?? "";
  const { config, state } = load(user.id);
  const tg = config.telegram ?? {};

  if (!tg.chatId) {
    // Pairing: the user sends the code shown in Settings → Channels.
    const code = state.telegramPairCode;
    if (code && text.replace(/^\/start\s*/, "").trim() === code) {
      config.telegram = { ...tg, chatId };
      save(user.id, config, { ...state, telegramPairCode: undefined });
      audit(user.id, "channel.telegram.paired", { chatId });
      await tgSend(token, chatId, `Paired with openzo user "${user.name}". Message me any time; /new starts a fresh conversation.`);
    } else {
      await tgSend(token, chatId, "This bot isn't paired yet. Send the pairing code shown in openzo → Settings → Channels.");
    }
    return;
  }
  if (chatId !== tg.chatId) return; // strangers are ignored
  if (text.trim() === "/new") {
    saveState(user.id, { ...load(user.id).state, telegramSession: undefined });
    await tgSend(token, chatId, "Started a new conversation.");
    return;
  }
  if (!tg.chat) {
    await tgSend(token, chatId, "Chatting with the agent over Telegram is turned off in openzo → Settings → Channels.");
    return;
  }
  // Attachments land in the workspace and are referenced in the message.
  let message = text;
  const fileId = msg.document?.file_id ?? msg.photo?.at?.(-1)?.file_id ?? msg.voice?.file_id ?? msg.audio?.file_id;
  if (fileId) {
    try {
      const info = (await (await fetch(tgApi(token, "getFile"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId }) })).json()) as any;
      const fp: string = info.result.file_path;
      const data = await (await fetch(`${process.env.OPENZO_TELEGRAM_API ?? "https://api.telegram.org"}/file/bot${token}/${fp}`)).arrayBuffer();
      const name = msg.document?.file_name ?? `${Date.now()}-${basename(fp)}`;
      await Bun.write(join(paths(user.name).workspace, "Telegram", name), data);
      message = `${text}\n\n[The user sent a file over Telegram, saved at /workspace/Telegram/${name}]`.trim();
    } catch {}
  }
  if (!message) return;
  const typing = setInterval(() => void fetch(tgApi(token, "sendChatAction"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, action: "typing" }) }).catch(() => {}), 4500);
  void fetch(tgApi(token, "sendChatAction"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, action: "typing" }) }).catch(() => {});
  try {
    const sess = load(user.id).state.telegramSession;
    const r = await runTurn(user, {
      sessionId: sess?.id,
      continuation: sess?.continuation,
      message: `${message}\n\n(Sent from Telegram — reply in plain text; long answers are fine.)`,
      source: "telegram",
      title: `Telegram: ${text.slice(0, 60) || "file"}`,
    }).catch(async (e) => {
      // A stale session (runtime reset, deleted conversation): start fresh once.
      if (!sess) throw e;
      return runTurn(user, { message, source: "telegram", title: `Telegram: ${text.slice(0, 60)}` });
    });
    saveState(user.id, { ...load(user.id).state, telegramSession: { id: r.sessionId, continuation: r.continuation } });
    await tgSend(token, chatId, r.text || (r.failed ? "Something went wrong on my side — check the conversation in openzo." : "Done."));
  } catch (e) {
    await tgSend(token, chatId, `openzo error: ${String((e as Error)?.message ?? e).slice(0, 300)}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

async function pollTelegram(userId: number, token: string, signal: AbortSignal) {
  let backoff = 1000;
  const queue: Promise<void>[] = [];
  while (!signal.aborted) {
    const user = users.byId(userId);
    if (!user || user.disabled) return;
    const offset = load(userId).state.telegramOffset ?? 0;
    try {
      const res = await fetch(tgApi(token, "getUpdates"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, timeout: 50, allowed_updates: ["message"] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
      });
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(data.description ?? `getUpdates ${res.status}`);
      for (const upd of data.result ?? []) {
        saveState(userId, { ...load(userId).state, telegramOffset: upd.update_id + 1 });
        if (upd.message) {
          // One turn at a time per user, in order.
          const prev = queue.at(-1) ?? Promise.resolve();
          queue.push(prev.then(() => handleTelegram(users.byId(userId)!, token, upd.message)).catch(() => {}));
          if (queue.length > 20) queue.shift();
        }
      }
      backoff = 1000;
    } catch (e) {
      if (signal.aborted) return;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function restartTelegram(userId: number) {
  pollers.get(userId)?.abort();
  pollers.delete(userId);
  const token = load(userId).config.telegram?.botToken;
  if (!token) return;
  const ctrl = new AbortController();
  pollers.set(userId, ctrl);
  void pollTelegram(userId, token, ctrl.signal);
}

export function startChannels() {
  const rows = db.query("SELECT user_id FROM channels").all() as { user_id: number }[];
  for (const r of rows) restartTelegram(r.user_id);
}

export function stopChannels() {
  for (const c of pollers.values()) c.abort();
  pollers.clear();
}

// ---------------------------------------------------------------- user API

function view(user: User) {
  const { config, state } = load(user.id);
  return {
    config: masked(config),
    enabled: Object.fromEntries(CHANNELS.map((c) => [c, enabled(config, c)])),
    smtp: smtpConfigured(),
    telegram: { bot: state.telegramBot ?? null, paired: Boolean(config.telegram?.chatId), pairCode: config.telegram?.chatId ? null : state.telegramPairCode ?? null, polling: pollers.has(user.id) },
  };
}

route("GET", "/api/channels", ({ req }) => json(view(requireUser(req))));

route("PUT", "/api/channels", async ({ req }) => {
  const u = requireUser(req);
  const prev = load(u.id);
  const next = merge(prev.config, await body(req));
  const state = { ...prev.state };
  if (next.telegram?.botToken !== prev.config.telegram?.botToken) {
    state.telegramOffset = undefined;
    state.telegramSession = undefined;
    state.telegramBot = undefined;
    if (next.telegram) next.telegram.chatId = undefined;
    if (next.telegram?.botToken) {
      const me = (await fetch(tgApi(next.telegram.botToken, "getMe")).then((r) => r.json()).catch(() => null)) as any;
      if (!me?.ok) throw new HttpError(400, "Telegram rejected that bot token");
      state.telegramBot = me.result.username;
    }
  }
  if (next.telegram?.botToken && !next.telegram.chatId && !state.telegramPairCode) state.telegramPairCode = randomBytes(4).toString("hex");
  save(u.id, next, state);
  restartTelegram(u.id);
  audit(u.id, "channels.update");
  return json(view(u));
});

route("POST", "/api/channels/unpair", ({ req }) => {
  const u = requireUser(req);
  const { config, state } = load(u.id);
  if (config.telegram) config.telegram.chatId = undefined;
  save(u.id, config, { ...state, telegramSession: undefined, telegramPairCode: randomBytes(4).toString("hex") });
  return json(view(u));
});

route("POST", "/api/channels/test", async ({ req }) => {
  const u = requireUser(req);
  const b = await body<{ channel: ChannelId }>(req);
  if (!CHANNELS.includes(b.channel)) throw new HttpError(400, "unknown channel");
  try {
    await notify(u, { title: "openzo test", text: `Test message from openzo to ${u.name}. If you can read this, ${b.channel} works.` }, b.channel);
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(502, String((e as Error)?.message ?? e));
  }
  return json({ ok: true });
});

// ---------------------------------------------------------------- runtime API

internalRoute("GET", "/channels", ({ user }) => json({ available: availableChannels(user), preferred: load(user.id).config.preferred || null }));

internalRoute("POST", "/notify", async ({ req, user }) => {
  const b = await body<{ channel?: ChannelId | "auto"; title?: string; text?: string; files?: string[] }>(req);
  if (!b.text?.trim()) throw new HttpError(400, "text is required");
  const files = (b.files ?? []).slice(0, 10).map((f) => workspaceFile(user, f));
  try {
    const ch = await notify(user, { title: b.title, text: b.text, files }, b.channel ?? "auto");
    return json({ ok: true, channel: ch });
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(502, String((e as Error)?.message ?? e));
  }
});
