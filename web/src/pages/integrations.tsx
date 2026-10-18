import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Plug, Plus, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ago } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  bundles: { id: string; label: string; default: boolean }[];
  hosts: string[];
  setupUrl: string;
  client?: { source: "env" | "admin"; clientId: string; hasSecret: boolean } | null;
  envPrefix?: string;
}

interface Connection {
  id: number;
  provider: string;
  kind: "oauth" | "apikey";
  label: string;
  scopes: string[];
  bundles: string[];
  hosts: string[];
  apiBase?: string;
  lastUsed: number | null;
  created: number;
}

interface Catalogue {
  redirectUri: string;
  providers: ProviderInfo[];
  connections: Connection[];
}

const KEY_PRESETS = [
  { name: "OpenWeather", apiBase: "https://api.openweathermap.org", placement: "query", param: "appid", header: "", prefix: "" },
  { name: "Airtable", apiBase: "https://api.airtable.com", placement: "header", header: "Authorization", prefix: "Bearer ", param: "" },
  { name: "Todoist", apiBase: "https://api.todoist.com", placement: "header", header: "Authorization", prefix: "Bearer ", param: "" },
  { name: "Custom", apiBase: "https://", placement: "header", header: "Authorization", prefix: "Bearer ", param: "" },
] as const;

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs hover:bg-muted"
      title="Copy"
    >
      <span className="truncate">{text}</span>
      {done ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}

function ConnectDialog({ provider, onClose }: { provider: ProviderInfo | null; onClose: () => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (provider) setChosen(provider.bundles.filter((b) => b.default).map((b) => b.id));
  }, [provider]);
  const go = async () => {
    if (!provider) return;
    setBusy(true);
    try {
      const r = await api<{ url: string }>(`/api/integrations/${provider.id}/connect`, { method: "POST", json: provider.bundles.length ? { bundles: chosen } : {} });
      window.location.href = r.url;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!provider} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider?.label}</DialogTitle>
          <DialogDescription>You'll sign in at {provider?.label} and come back here. Tokens stay on this server; the agent calls the API through it.</DialogDescription>
        </DialogHeader>
        {!!provider?.bundles.length && (
          <div className="flex flex-col gap-2">
            <Label>What may the agent use?</Label>
            {provider.bundles.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={chosen.includes(b.id)} onCheckedChange={(v) => setChosen((c) => (v ? [...c, b.id] : c.filter((x) => x !== b.id)))} />
                {b.label}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={go} disabled={busy || (!!provider?.bundles.length && !chosen.length)}>
            {busy && <Loader2 className="size-4 animate-spin" />} Continue to {provider?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClientDialog({ provider, redirectUri, onClose, onSaved }: { provider: ProviderInfo | null; redirectUri: string; onClose: () => void; onSaved: () => void }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setClientId(provider?.client?.clientId ?? "");
    setSecret("");
  }, [provider]);
  if (!provider) return null;
  const fromEnv = provider.client?.source === "env";
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/integrations/${provider.id}/client`, { method: "PUT", json: { clientId, ...(secret ? { clientSecret: secret } : {}) } });
      toast.success(`${provider.label} OAuth app saved`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api(`/api/integrations/${provider.id}/client`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    onSaved();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider.label} OAuth app</DialogTitle>
          <DialogDescription>
            Register an OAuth app at{" "}
            <a href={provider.setupUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {provider.label}'s developer console
            </a>{" "}
            with this redirect URI, then paste its credentials. Every user on this server connects their own account through it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Redirect URI</Label>
            <CopyText text={redirectUri} />
          </div>
          {fromEnv ? (
            <p className="text-sm text-muted-foreground">
              Set by environment variables (<code className="font-mono text-xs">{provider.envPrefix}CLIENT_ID</code>). Change them on the host and restart.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>Client ID</Label>
                <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Client secret</Label>
                <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={provider.client?.hasSecret ? "•••••••• (stored — leave blank to keep)" : ""} className="font-mono" />
              </div>
              <p className="text-xs text-muted-foreground">
                Or set <code className="font-mono">{provider.envPrefix}CLIENT_ID</code> / <code className="font-mono">_CLIENT_SECRET</code> on the host.
              </p>
            </>
          )}
        </div>
        {!fromEnv && (
          <DialogFooter>
            {provider.client && (
              <Button variant="ghost" className="mr-auto text-destructive" onClick={remove}>
                Remove
              </Button>
            )}
            <Button onClick={save} disabled={busy || !clientId.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [preset, setPreset] = useState<(typeof KEY_PRESETS)[number]>(KEY_PRESETS[0]);
  const [form, setForm] = useState({ name: "", apiBase: "", placement: "header", header: "", prefix: "", param: "", key: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm({ name: preset.name === "Custom" ? "" : preset.name, apiBase: preset.apiBase, placement: preset.placement, header: preset.header, prefix: preset.prefix, param: preset.param, key: "" });
  }, [preset, open]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/integrations/apikey", { method: "POST", json: form });
      toast.success(`${form.name} connected`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an API key</DialogTitle>
          <DialogDescription>For services without OAuth. The key is stored encrypted and only sent to the API base's host.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {KEY_PRESETS.map((p) => (
            <button key={p.name} onClick={() => setPreset(p)} className={`rounded-md border px-2 py-0.5 text-xs ${preset.name === p.name ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={set("name")} placeholder="My API" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>API base</Label>
            <Input value={form.apiBase} onChange={set("apiBase")} className="font-mono text-xs" />
          </div>
          <div className="col-span-2 flex items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={form.placement === "header"} onChange={() => setForm((f) => ({ ...f, placement: "header", header: f.header || "Authorization" }))} /> Header
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={form.placement === "query"} onChange={() => setForm((f) => ({ ...f, placement: "query", param: f.param || "api_key" }))} /> Query parameter
            </label>
          </div>
          {form.placement === "header" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>Header</Label>
                <Input value={form.header} onChange={set("header")} className="font-mono text-xs" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Prefix</Label>
                <Input value={form.prefix} onChange={set("prefix")} className="font-mono text-xs" placeholder="(none)" />
              </div>
            </>
          ) : (
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label>Parameter</Label>
              <Input value={form.param} onChange={set("param")} className="font-mono text-xs" />
            </div>
          )}
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label>Key</Label>
            <Input type="password" value={form.key} onChange={set("key")} className="font-mono" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !form.name.trim() || !form.key.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function IntegrationsPage() {
  const { boot } = useSession();
  const isAdmin = boot?.user?.role === "admin";
  const [data, setData] = useState<Catalogue | null>(null);
  const [connecting, setConnecting] = useState<ProviderInfo | null>(null);
  const [configuring, setConfiguring] = useState<ProviderInfo | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const finishing = useRef(false);

  const load = useCallback(() => api<Catalogue>("/api/integrations").then(setData).catch((e) => toast.error(e.message)), []);

  // Return from the provider: ?connected=, ?error=, or ?finish=<state> when the
  // callback could not see our session and we must complete it ourselves.
  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    const finish = params.get("finish");
    if (connected) toast.success(`Connected ${connected}`);
    if (error) toast.error(`Connection failed: ${error}`);
    if (finish && !finishing.current) {
      finishing.current = true;
      api<{ connection: Connection }>("/api/integrations/finish", { method: "POST", json: { state: finish } })
        .then((r) => toast.success(`Connected ${r.connection.label}`))
        .catch((e) => toast.error(`Connection failed: ${e.message}`))
        .finally(() => load());
    }
    if (connected || error || finish) navigate("/integrations", { replace: true });
    else void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = async (c: Connection) => {
    if (!confirm(`Disconnect ${c.label}? The agent will lose access.`)) return;
    await api(`/api/integrations/connections/${c.id}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    void load();
  };

  const keyConns = data?.connections.filter((c) => c.kind === "apikey") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Integrations" description="Connect your accounts so the agent can read and act on them. Ask it things like “summarise my unread mail” or “file an issue for this”." />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-8">
          {!data ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              <section className="grid gap-3 sm:grid-cols-2">
                {data.providers.map((p) => {
                  const mine = data.connections.filter((c) => c.provider === p.id);
                  return (
                    <div key={p.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            <Plug className="size-4 opacity-60" /> {p.label}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                        </div>
                        {isAdmin && (
                          <button onClick={() => setConfiguring(p)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Configure OAuth app (admin)">
                            <Settings2 className="size-4" />
                          </button>
                        )}
                      </div>
                      {mine.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {mine.map((c) => (
                            <li key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-sm">
                              <span className="min-w-0 truncate" title={c.scopes.join(" ")}>
                                <Check className="mr-1.5 inline size-3.5 text-emerald-600" />
                                {c.label}
                                {c.bundles.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{c.bundles.join(", ")}</span>}
                              </span>
                              <button onClick={() => disconnect(c)} className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive" title="Disconnect">
                                <Trash2 className="size-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {p.configured ? (
                        <Button variant={mine.length ? "outline" : "default"} size="sm" className="mt-auto self-start" onClick={() => setConnecting(p)}>
                          <Plus className="size-3.5" /> {mine.length ? "Add another account" : "Connect"}
                        </Button>
                      ) : (
                        <div className="mt-auto flex flex-col gap-1.5 text-xs text-muted-foreground">
                          <span>An admin hasn't configured OAuth for {p.label} yet. The OAuth app needs this redirect URI:</span>
                          <CopyText text={data.redirectUri} />
                          {isAdmin && (
                            <Button size="sm" variant="outline" className="self-start" onClick={() => setConfiguring(p)}>
                              <Settings2 className="size-3.5" /> Set up {p.label}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-medium">API keys</h2>
                    <p className="text-xs text-muted-foreground">Any HTTPS API that takes a static key — weather, Airtable, Todoist, your own services.</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setAddingKey(true)}>
                    <KeyRound className="size-3.5" /> Add key
                  </Button>
                </div>
                {keyConns.length === 0 ? (
                  <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">No API keys yet.</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border bg-card">
                    {keyConns.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-3 border-b px-4 py-2.5 last:border-b-0">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{c.label}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {c.apiBase} {c.lastUsed ? `· used ${ago(c.lastUsed)}` : ""}
                          </div>
                        </div>
                        <button onClick={() => disconnect(c)} className="rounded p-1 text-muted-foreground hover:text-destructive" title="Remove">
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {isAdmin && (
                <section className="rounded-xl border bg-card p-4 text-sm">
                  <h2 className="font-medium">For admins</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Each provider needs one OAuth app, registered by you, that every user connects through. Use the gear on a card, or set{" "}
                    <code className="font-mono">OPENZO_OAUTH_&lt;PROVIDER&gt;_CLIENT_ID</code> / <code className="font-mono">_CLIENT_SECRET</code> on the host. Register this redirect URI:
                  </p>
                  <div className="mt-2">
                    <CopyText text={data.redirectUri} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    It is derived from the address you're using now; set <code className="font-mono">OPENZO_PUBLIC_URL</code> to pin it.{" "}
                    <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                      Example: GitHub <ExternalLink className="size-3" />
                    </a>
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </div>
      <ConnectDialog provider={connecting} onClose={() => setConnecting(null)} />
      <ClientDialog provider={configuring} redirectUri={data?.redirectUri ?? ""} onClose={() => setConfiguring(null)} onSaved={load} />
      <ApiKeyDialog open={addingKey} onClose={() => setAddingKey(false)} onSaved={load} />
    </div>
  );
}
