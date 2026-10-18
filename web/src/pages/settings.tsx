import { useEffect, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ago } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

interface Preset {
  id: string;
  label: string;
  hint: string;
  baseUrl?: string;
  needsKey: boolean;
  defaultModel?: string;
  defaultFast?: string;
}

interface Settings {
  model: { preset: string; baseUrl?: string; apiKey?: string; model?: string; fastModel?: string; visionModel?: string; contextWindow?: number };
  search: { searxngUrl: string; braveKey: string; tavilyKey: string; exaKey: string };
  persona: string;
  rules: string;
  secrets: { name: string; value: string }[];
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <h2 className="font-medium">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function RuntimePanel() {
  const [rt, setRt] = useState<{ state: string; driver: string; startedAt: number | null; lastUsed: number | null; error: string | null } | null>(null);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api("/api/runtime").then(setRt);
  useEffect(() => {
    void load();
  }, []);
  const restart = async () => {
    setBusy(true);
    try {
      setRt(await api("/api/runtime/restart", { method: "POST" }));
      toast.success("Runtime restarted");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const showLog = async () => setLog(await fetch("/api/runtime/log").then((r) => r.text()));
  return (
    <Section title="Your runtime" description="The agent server that runs your conversations. It starts on demand and sleeps when idle.">
      {rt && (
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">State</div>
            <div className={cn("font-medium", rt.state === "running" && "text-emerald-600", rt.state === "error" && "text-destructive")}>{rt.state}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Driver</div>
            <div className="font-medium">{rt.driver === "gvisor" ? "gVisor container" : "host process"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Started</div>
            <div>{ago(rt.startedAt)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Last used</div>
            <div>{ago(rt.lastUsed)}</div>
          </div>
        </div>
      )}
      {rt?.error && <p className="rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">{rt.error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={restart} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Restart
        </Button>
        <Button variant="ghost" size="sm" onClick={showLog}>
          Show log
        </Button>
      </div>
      {log && <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{log || "(empty)"}</pre>}
    </Section>
  );
}

function AccountPanel() {
  const { boot } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = async () => {
    try {
      await api("/api/me/password", { method: "POST", json: { current, password: next } });
      setCurrent("");
      setNext("");
      toast.success("Password changed. Other sessions were signed out.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Section title="Account" description={`Signed in as ${boot?.user?.name} (${boot?.user?.role}).`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <div>
        <Button size="sm" onClick={change} disabled={!current || next.length < 8}>
          Change password
        </Button>
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api<{ settings: Settings }>("/api/settings").then((d) => setS(d.settings));
    void api<{ presets: Preset[] }>("/api/presets").then((d) => setPresets(d.presets));
  }, []);
  if (!s)
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  const preset = presets.find((p) => p.id === s.model.preset);
  const setModel = (patch: Partial<Settings["model"]>) => setS({ ...s, model: { ...s.model, ...patch } });
  const save = async () => {
    setSaving(true);
    try {
      const d = await api<{ settings: Settings }>("/api/settings", { method: "PUT", json: s });
      setS(d.settings);
      toast.success("Saved. Your runtime restarts with the new settings on the next message.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveBar = (
    <Button onClick={save} disabled={saving}>
      {saving && <Loader2 className="size-4 animate-spin" />} Save changes
    </Button>
  );
  const usesBase = !["anthropic", "gateway", "mock"].includes(s.model.preset);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" description="Your model, tools, instructions and account. Only you can see these.">
        {saveBar}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <Tabs defaultValue="model" className="mx-auto max-w-3xl">
          <TabsList className="mb-4 flex-wrap">
            <TabsTrigger value="model">Model</TabsTrigger>
            <TabsTrigger value="search">Web search</TabsTrigger>
            <TabsTrigger value="persona">Persona & rules</TabsTrigger>
            <TabsTrigger value="secrets">Secrets</TabsTrigger>
            <TabsTrigger value="account">Account & runtime</TabsTrigger>
          </TabsList>

          <TabsContent value="model" className="flex flex-col gap-4">
            <Section title="Provider" description="Pick where your agent's model calls go. Keys stay on this server and are only passed to your own runtime.">
              <div className="grid gap-2 sm:grid-cols-3">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setModel({ preset: p.id })}
                    className={cn("rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent", s.model.preset === p.id && "border-primary ring-1 ring-primary")}
                  >
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.hint}</div>
                  </button>
                ))}
              </div>
            </Section>
            {s.model.preset !== "mock" && (
              <Section title="Connection">
                {usesBase && (
                  <Field label="Base URL" hint={preset?.baseUrl ? `Default: ${preset.baseUrl}` : "The /v1 root of an OpenAI-compatible API."}>
                    <Input value={s.model.baseUrl ?? ""} onChange={(e) => setModel({ baseUrl: e.target.value })} placeholder={preset?.baseUrl ?? "https://…/v1"} />
                  </Field>
                )}
                {s.model.preset !== "free" && (
                  <Field label="API key" hint={preset?.needsKey ? "Required." : "Optional for local servers."}>
                    <Input type="password" value={s.model.apiKey ?? ""} onChange={(e) => setModel({ apiKey: e.target.value })} placeholder="sk-…" autoComplete="off" />
                  </Field>
                )}
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Main model">
                    <Input value={s.model.model ?? ""} onChange={(e) => setModel({ model: e.target.value })} placeholder={preset?.defaultModel ?? "model id"} />
                  </Field>
                  <Field label="Fast model" hint="Used by the task_fast subagent.">
                    <Input value={s.model.fastModel ?? ""} onChange={(e) => setModel({ fastModel: e.target.value })} placeholder={preset?.defaultFast ?? "same as main"} />
                  </Field>
                  <Field label="Vision model" hint="Used by the look tool.">
                    <Input value={s.model.visionModel ?? ""} onChange={(e) => setModel({ visionModel: e.target.value })} placeholder="same as fast" />
                  </Field>
                </div>
                <Field label="Context window (tokens)" hint="When to compact long conversations. Default 128000.">
                  <Input type="number" value={s.model.contextWindow ?? ""} onChange={(e) => setModel({ contextWindow: Number(e.target.value) || undefined })} placeholder="128000" className="w-48" />
                </Field>
              </Section>
            )}
          </TabsContent>

          <TabsContent value="search">
            <Section title="Web search backend" description="The first one configured is used. With none, DuckDuckGo is tried (often blocked from datacenter IPs).">
              <Field label="SearXNG URL" hint="A SearXNG instance with the JSON format enabled. The VPS compose file runs one for you.">
                <Input value={s.search.searxngUrl} onChange={(e) => setS({ ...s, search: { ...s.search, searxngUrl: e.target.value } })} placeholder="http://searxng:8080" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Brave API key">
                  <Input type="password" value={s.search.braveKey} onChange={(e) => setS({ ...s, search: { ...s.search, braveKey: e.target.value } })} />
                </Field>
                <Field label="Tavily API key">
                  <Input type="password" value={s.search.tavilyKey} onChange={(e) => setS({ ...s, search: { ...s.search, tavilyKey: e.target.value } })} />
                </Field>
                <Field label="Exa API key">
                  <Input type="password" value={s.search.exaKey} onChange={(e) => setS({ ...s, search: { ...s.search, exaKey: e.target.value } })} />
                </Field>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="persona" className="flex flex-col gap-4">
            <Section title="Persona" description="Who your agent is: name, tone, how it talks to you. Added to every conversation.">
              <Textarea rows={6} value={s.persona} onChange={(e) => setS({ ...s, persona: e.target.value })} placeholder="You are Juno, my research partner. Be blunt and brief." />
            </Section>
            <Section title="Rules" description="Standing instructions, one per line.">
              <Textarea rows={6} value={s.rules} onChange={(e) => setS({ ...s, rules: e.target.value })} placeholder={"Always answer in British English.\nNever delete files without asking first."} />
            </Section>
          </TabsContent>

          <TabsContent value="secrets">
            <Section title="Secrets" description="Environment variables available to your agent and its shell — API keys for services you want it to call. Values are write-only.">
              {s.secrets.map((x, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={x.name}
                    onChange={(e) => setS({ ...s, secrets: s.secrets.map((y, j) => (j === i ? { ...y, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") } : y)) })}
                    placeholder="GITHUB_TOKEN"
                    className="w-56 font-mono"
                  />
                  <Input type="password" value={x.value} onChange={(e) => setS({ ...s, secrets: s.secrets.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} placeholder="value" className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => setS({ ...s, secrets: s.secrets.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <div>
                <Button variant="outline" size="sm" onClick={() => setS({ ...s, secrets: [...s.secrets, { name: "", value: "" }] })}>
                  <Plus className="size-4" /> Add secret
                </Button>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="account" className="flex flex-col gap-4">
            <RuntimePanel />
            <AccountPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
