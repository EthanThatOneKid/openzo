import { useEffect, useState, type ReactNode } from "react";
import { Bell, CheckCircle2, Loader2, Mail, MessageCircle, Phone, Send, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { SettingsTabs } from "@/components/settings-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type ChannelId = "telegram" | "email" | "discord" | "slack" | "ntfy" | "sms" | "webhook";
interface View {
  config: any;
  enabled: Record<ChannelId, boolean>;
  smtp: boolean;
  telegram: { bot: string | null; paired: boolean; pairCode: string | null; polling: boolean };
}

const LABELS: Record<ChannelId, string> = { telegram: "Telegram", email: "Email", discord: "Discord", slack: "Slack", ntfy: "ntfy push", sms: "SMS (Twilio)", webhook: "Webhook" };

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Card({ id, icon, title, description, view, onTest, children }: { id: ChannelId; icon: ReactNode; title: string; description: ReactNode; view: View; onTest: (c: ChannelId) => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 text-muted-foreground">{icon}</div>
          <div>
            <h2 className="flex items-center gap-2 font-medium">
              {title}
              {view.enabled[id] && <CheckCircle2 className="size-4 text-emerald-600" />}
            </h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={!view.enabled[id]} onClick={() => onTest(id)}>
          Send test
        </Button>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export default function ChannelsPage() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<View>("/api/channels").then((v) => {
      setView(v);
      setDraft(v.config);
    });
  useEffect(() => {
    void load();
  }, []);
  // Poll while waiting for Telegram pairing.
  useEffect(() => {
    if (!view?.telegram.pairCode) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [view?.telegram.pairCode]);

  const set = (ch: string, k: string, v: unknown) => setDraft((d: any) => ({ ...d, [ch]: { ...(d[ch] ?? {}), [k]: v } }));
  const val = (ch: string, k: string) => draft?.[ch]?.[k] ?? "";
  const save = async () => {
    setBusy(true);
    try {
      const v = await api<View>("/api/channels", { method: "PUT", json: draft });
      setView(v);
      setDraft(v.config);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async (channel: ChannelId) => {
    try {
      await api("/api/channels/test", { method: "POST", json: { channel } });
      toast.success(`Sent a test via ${LABELS[channel]}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" description="How your agent reaches you — and how you reach it — outside this app.">
        <Button size="sm" onClick={save} disabled={busy || !view}>
          {busy && <Loader2 className="size-4 animate-spin" />} Save channels
        </Button>
      </PageHeader>
      <SettingsTabs />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {!view ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Field label="Preferred channel" hint="Used when the agent or an automation sends a message without naming a channel.">
              <select value={draft.preferred ?? ""} onChange={(e) => setDraft((d: any) => ({ ...d, preferred: e.target.value }))} className="h-9 w-64 rounded-md border bg-transparent px-2 text-sm">
                <option value="">First one set up</option>
                {(Object.keys(LABELS) as ChannelId[]).map((c) => (
                  <option key={c} value={c}>
                    {LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>

            <Card id="telegram" icon={<Send className="size-5" />} title="Telegram" view={view} onTest={test} description="Two-way: chat with your agent from Telegram, and get messages from it. Create a bot with @BotFather and paste its token.">
              <Field label="Bot token" hint={view.telegram.bot ? `Connected to @${view.telegram.bot}` : "From @BotFather → /newbot"}>
                <Input value={val("telegram", "botToken")} onChange={(e) => set("telegram", "botToken", e.target.value)} placeholder="123456:ABC-…" className="font-mono" />
              </Field>
              {view.telegram.bot && !view.telegram.paired && view.telegram.pairCode && (
                <div className="rounded-lg bg-muted p-3 text-sm">
                  Open <a className="text-primary underline" href={`https://t.me/${view.telegram.bot}`} target="_blank" rel="noreferrer">@{view.telegram.bot}</a> and send this code:{" "}
                  <code className="rounded bg-background px-1.5 py-0.5 font-mono text-base">{view.telegram.pairCode}</code>
                  <span className="mt-1 block text-xs text-muted-foreground">This page updates once it's paired. Only the paired chat can talk to your agent.</span>
                </div>
              )}
              {view.telegram.paired && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-emerald-700 dark:text-emerald-400">Paired. Send /new in Telegram to start a fresh conversation.</span>
                  <Button variant="ghost" size="sm" onClick={() => api<View>("/api/channels/unpair", { method: "POST" }).then(setView)}>
                    Unpair
                  </Button>
                </div>
              )}
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Chat with the agent over Telegram
                  <span className="block text-xs text-muted-foreground">Off = notifications only.</span>
                </span>
                <Switch checked={!!draft.telegram?.chat} onCheckedChange={(v) => set("telegram", "chat", v)} />
              </label>
            </Card>

            <Card id="email" icon={<Mail className="size-5" />} title="Email" view={view} onTest={test} description={view.smtp ? "Messages and automation results sent to your inbox." : "This server has no outgoing mail set up (the admin sets OPENZO_SMTP_URL)."}>
              <Field label="Your address">
                <Input value={val("email", "address")} onChange={(e) => set("email", "address", e.target.value)} placeholder="you@example.com" disabled={!view.smtp} />
              </Field>
            </Card>

            <Card id="discord" icon={<MessageCircle className="size-5" />} title="Discord" view={view} onTest={test} description="Posts to a channel through a webhook (Channel settings → Integrations → Webhooks). Files are attached.">
              <Field label="Webhook URL">
                <Input value={val("discord", "webhookUrl")} onChange={(e) => set("discord", "webhookUrl", e.target.value)} placeholder="https://discord.com/api/webhooks/…" className="font-mono" />
              </Field>
            </Card>

            <Card id="slack" icon={<MessageCircle className="size-5" />} title="Slack" view={view} onTest={test} description="Posts through an incoming-webhook URL from a Slack app.">
              <Field label="Webhook URL">
                <Input value={val("slack", "webhookUrl")} onChange={(e) => set("slack", "webhookUrl", e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono" />
              </Field>
            </Card>

            <Card id="ntfy" icon={<Bell className="size-5" />} title="ntfy push" view={view} onTest={test} description="Free push notifications to any phone with the ntfy app — pick a hard-to-guess topic.">
              <Field label="Topic URL">
                <Input value={val("ntfy", "topicUrl")} onChange={(e) => set("ntfy", "topicUrl", e.target.value)} placeholder="https://ntfy.sh/my-secret-topic-8f2a" className="font-mono" />
              </Field>
              <Field label="Access token (optional)">
                <Input value={val("ntfy", "token")} onChange={(e) => set("ntfy", "token", e.target.value)} placeholder="tk_…" className="font-mono" />
              </Field>
            </Card>

            <Card id="sms" icon={<Phone className="size-5" />} title="SMS" view={view} onTest={test} description="Texts from your own Twilio number.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Account SID">
                  <Input value={val("sms", "accountSid")} onChange={(e) => set("sms", "accountSid", e.target.value)} placeholder="AC…" className="font-mono" />
                </Field>
                <Field label="Auth token">
                  <Input value={val("sms", "authToken")} onChange={(e) => set("sms", "authToken", e.target.value)} className="font-mono" />
                </Field>
                <Field label="From (your Twilio number)">
                  <Input value={val("sms", "from")} onChange={(e) => set("sms", "from", e.target.value)} placeholder="+15551234567" />
                </Field>
                <Field label="To (your phone)">
                  <Input value={val("sms", "to")} onChange={(e) => set("sms", "to", e.target.value)} placeholder="+6591234567" />
                </Field>
              </div>
            </Card>

            <Card id="webhook" icon={<Webhook className="size-5" />} title="Webhook" view={view} onTest={test} description="POSTs JSON {user, title, text, ts} to any URL — Home Assistant, n8n, Zapier, your own server.">
              <Field label="URL">
                <Input value={val("webhook", "url")} onChange={(e) => set("webhook", "url", e.target.value)} placeholder="https://example.com/openzo" className="font-mono" />
              </Field>
              <Field label="Shared secret (optional)" hint="Sent as the X-Openzo-Secret header.">
                <Input value={val("webhook", "secret")} onChange={(e) => set("webhook", "secret", e.target.value)} className="font-mono" />
              </Field>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
