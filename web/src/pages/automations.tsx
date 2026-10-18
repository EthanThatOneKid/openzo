import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ago } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Automation {
  id: number;
  name: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled: boolean;
  last_run: number | null;
  last_status: string | null;
  last_conversation: string | null;
  next_run: number | null;
  deliver: string;
}

const DELIVER = [
  { id: "", label: "Conversation list only" },
  { id: "auto", label: "My preferred channel" },
  { id: "telegram", label: "Telegram" },
  { id: "email", label: "Email" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "ntfy", label: "ntfy push" },
  { id: "sms", label: "SMS" },
  { id: "webhook", label: "Webhook" },
];

const PRESETS = [
  { label: "Every morning 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 8:30", cron: "30 8 * * 1-5" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
];

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function Editor({ initial, onDone }: { initial?: Automation; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * *");
  const [tz, setTz] = useState(initial?.tz ?? localTz);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [deliver, setDeliver] = useState(initial?.deliver ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, cron, tz, prompt, deliver };
      if (initial) await api(`/api/automations/${initial.id}`, { method: "PATCH", json: body });
      else await api("/api/automations", { method: "POST", json: body });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Schedule (cron)</Label>
        <div className="flex gap-2">
          <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" />
          <Input value={tz} onChange={(e) => setTz(e.target.value)} className="w-44" title="IANA time zone" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.cron} onClick={() => setCron(p.cron)} className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>What should the agent do?</Label>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Check the top Hacker News stories about AI agents and write a short digest to digests/$(date).md" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Send the result to</Label>
        <select value={deliver} onChange={(e) => setDeliver(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm">
          {DELIVER.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Channels are set up in <Link to="/settings/channels" className="underline underline-offset-2">Settings → Channels</Link>.
        </p>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy || !name.trim() || !prompt.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />} Save
        </Button>
      </DialogFooter>
    </div>
  );
}

export default function AutomationsPage() {
  const [list, setList] = useState<Automation[] | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const load = () => api<{ automations: Automation[] }>("/api/automations").then((d) => setList(d.automations));
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const toggle = async (a: Automation) => {
    await api(`/api/automations/${a.id}`, { method: "PATCH", json: { enabled: !a.enabled } });
    void load();
  };
  const run = async (a: Automation) => {
    await api(`/api/automations/${a.id}/run`, { method: "POST" });
    toast("Started — it will appear in your conversations");
    setTimeout(load, 1500);
  };
  const remove = async (a: Automation) => {
    if (!confirm(`Delete "${a.name}"?`)) return;
    await api(`/api/automations/${a.id}`, { method: "DELETE" });
    void load();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Automations" description="Prompts your agent runs on a schedule. Each run is a new conversation.">
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" /> New automation
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {list === null ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : list.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
            <Clock className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No automations yet. Schedule a daily digest, a backup check, a weekly report.</p>
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> Create one
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {list.map((a) => (
              <div key={a.id} className="rounded-xl border bg-card p-4 shadow-xs">
                <div className="flex items-start justify-between gap-3">
                  <button className="min-w-0 text-left" onClick={() => setEditing(a)}>
                    <div className="font-medium">{a.name}</div>
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {a.cron} · {a.tz}
                      {a.deliver && ` · → ${DELIVER.find((d) => d.id === a.deliver)?.label ?? a.deliver}`}
                    </div>
                  </button>
                  <div className="flex items-center gap-1">
                    <Switch checked={a.enabled} onCheckedChange={() => toggle(a)} />
                    <Button variant="ghost" size="sm" onClick={() => run(a)} title="Run now">
                      <Play className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(a)} title="Delete">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{a.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Next: {a.next_run ? new Date(a.next_run).toLocaleString() : "—"}</span>
                  <span>
                    Last: {ago(a.last_run)}
                    {a.last_status && ` (${a.last_status})`}
                  </span>
                  {a.last_conversation && (
                    <Link to={`/c/${a.last_conversation}`} className="underline underline-offset-2">
                      open last run
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "New automation" : "Edit automation"}</DialogTitle>
          </DialogHeader>
          {editing !== null && (
            <Editor
              initial={editing === "new" ? undefined : editing}
              onDone={() => {
                setEditing(null);
                void load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
