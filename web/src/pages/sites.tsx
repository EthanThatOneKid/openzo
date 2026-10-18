import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FileText, Globe, Loader2, Lock, Plus, RotateCw, ScrollText, Server, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, authFetch } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Service {
  id: number;
  name: string;
  kind: "static" | "process";
  command: string | null;
  root: string | null;
  port: number | null;
  env: string[];
  spa: boolean;
  public: boolean;
  enabled: boolean;
  domains: string[];
  urls: string[];
  state: string;
  error?: string | null;
}

interface SitesData {
  services: Service[];
  sitesDomain: string | null;
  driver: string;
}

const stateColor: Record<string, string> = {
  running: "bg-emerald-500",
  starting: "bg-amber-500 animate-pulse",
  crashed: "bg-red-500",
  stopped: "bg-muted-foreground/40",
};

function Editor({ initial, onDone }: { initial?: Service; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"static" | "process">(initial?.kind ?? "static");
  const [root, setRoot] = useState(initial?.root ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [port, setPort] = useState(initial?.port ? String(initial.port) : "");
  const [spa, setSpa] = useState(initial?.spa ?? false);
  const [pub, setPub] = useState(initial?.public ?? true);
  const [domains, setDomains] = useState((initial?.domains ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        root: root.trim(),
        spa,
        public: pub,
        domains: domains.split(/[\s,]+/).filter(Boolean),
        port: port.trim() ? Number(port) : null,
      };
      if (kind === "process") body.command = command;
      if (initial) await api(`/api/sites/${initial.name}`, { method: "PATCH", json: body });
      else await api("/api/sites", { method: "POST", json: { ...body, name: name.trim().toLowerCase() } });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {!initial && (
        <div className="flex flex-col gap-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="blog" className="font-mono" />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits and dashes. It becomes part of the URL.</p>
        </div>
      )}
      {!initial && (
        <div className="grid grid-cols-2 gap-2">
          {(["static", "process"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn("rounded-lg border p-3 text-left text-sm", kind === k ? "border-primary bg-primary/5" : "hover:bg-accent")}
            >
              <div className="flex items-center gap-2 font-medium">
                {k === "static" ? <FileText className="size-4" /> : <Server className="size-4" />}
                {k === "static" ? "Static site" : "Service"}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{k === "static" ? "Serve a folder of HTML, CSS and JS." : "Run a command that listens on $PORT — APIs, apps, bots."}</p>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label>{kind === "static" ? "Folder (in your workspace)" : "Working directory (in your workspace)"}</Label>
        <Input value={root} onChange={(e) => setRoot(e.target.value)} placeholder={kind === "static" ? name || "site" : "my-app"} className="font-mono" />
      </div>
      {kind === "process" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label>Command</Label>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="bun run server.ts" className="font-mono" />
            <p className="text-xs text-muted-foreground">Runs with bash in your sandbox and restarts if it crashes. It must listen on the PORT environment variable.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Fixed port (optional)</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="only if the app can't read $PORT" className="w-64 font-mono" />
          </div>
        </>
      )}
      {kind === "static" && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Single-page app
            <span className="block text-xs text-muted-foreground">Unknown paths serve index.html (React Router, Vue Router…).</span>
          </span>
          <Switch checked={spa} onCheckedChange={setSpa} />
        </label>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Public
          <span className="block text-xs text-muted-foreground">Off = only you, signed in to openzo.</span>
        </span>
        <Switch checked={pub} onCheckedChange={setPub} />
      </label>
      <div className="flex flex-col gap-1.5">
        <Label>Custom domains</Label>
        <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="blog.example.com" className="font-mono" />
        <p className="text-xs text-muted-foreground">Point the domain's DNS (A/AAAA or CNAME) at this server. HTTPS is issued automatically when the server runs the bundled Caddy.</p>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy || (!initial && !name.trim()) || (kind === "process" && !command.trim())}>
          {busy && <Loader2 className="size-4 animate-spin" />} {initial ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function LogView({ name }: { name: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      authFetch(`/api/sites/${name}/log`)
        .then((r) => r.text())
        .then((t) => alive && setText(t));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [name]);
  return <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{text || "(no output yet)"}</pre>;
}

function ServiceCard({ s, onEdit, onChanged, onLog }: { s: Service; onEdit: () => void; onChanged: () => void; onLog: () => void }) {
  const isSpace = s.name === "space";
  const patch = async (json: Record<string, unknown>) => {
    try {
      await api(`/api/sites/${s.name}`, { method: "PATCH", json });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const restart = async () => {
    await api(`/api/sites/${s.name}/restart`, { method: "POST" }).catch((e) => toast.error(e.message));
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete "${s.name}"? Its files stay in your workspace.`)) return;
    await api(`/api/sites/${s.name}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    onChanged();
  };
  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-xs", isSpace && "border-primary/30")}>
      <div className="flex items-start justify-between gap-3">
        <button className="min-w-0 text-left" onClick={onEdit}>
          <div className="flex items-center gap-2 font-medium">
            {isSpace ? <Sparkles className="size-4 text-primary" /> : s.kind === "static" ? <FileText className="size-4" /> : <Server className="size-4" />}
            {isSpace ? "Your Space" : s.name}
            <span className={cn("size-1.5 rounded-full", stateColor[s.state] ?? stateColor.stopped)} title={s.state} />
            {!s.public && <Lock className="size-3.5 text-muted-foreground" />}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {s.kind === "static" ? `/workspace/${s.root ?? ""}` : s.command}
          </div>
        </button>
        <div className="flex items-center gap-1">
          <Switch checked={s.enabled} onCheckedChange={(v) => patch({ enabled: v })} title={s.enabled ? "Turn off" : "Turn on"} />
          {s.kind === "process" && (
            <>
              <Button variant="ghost" size="sm" onClick={onLog} title="Log">
                <ScrollText className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={restart} title="Restart">
                <RotateCw className="size-4" />
              </Button>
            </>
          )}
          {!isSpace && (
            <Button variant="ghost" size="sm" onClick={remove} title="Delete">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {s.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{s.error}</p>}
      <div className="mt-3 flex flex-col gap-1">
        {s.urls.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-sm text-primary underline-offset-2 hover:underline">
            <ExternalLink className="size-3.5 shrink-0" />
            {u}
          </a>
        ))}
      </div>
      {isSpace && (
        <p className="mt-3 text-xs text-muted-foreground">
          Edit the files in <Link to="/files/space" className="underline underline-offset-2">space/</Link>, or ask your agent: “add a blog to my space”.
        </p>
      )}
    </div>
  );
}

export default function SitesPage() {
  const [data, setData] = useState<SitesData | null>(null);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const load = () => api<SitesData>("/api/sites").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Sites" description="Your Space, websites and always-on services, served from your workspace.">
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" /> New site or service
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {data === null ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mx-auto grid max-w-3xl gap-3">
            {data.services.map((s) => (
              <ServiceCard key={s.id} s={s} onEdit={() => setEditing(s)} onChanged={load} onLog={() => setLog(s.name)} />
            ))}
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              <Globe className="mt-0.5 size-4 shrink-0" />
              <span>
                {data.sitesDomain
                  ? `Every site also gets its own address at <name>-<you>.${data.sitesDomain}.`
                  : "Sites live under /s/<you>/<name>/ on this server. An admin can set OPENZO_SITES_DOMAIN to give every site its own subdomain."}{" "}
                Ask your agent to build and host things — it uses the same service tool.
              </span>
            </div>
          </div>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "New site or service" : editing?.name === "space" ? "Your Space" : `Edit ${editing?.name}`}</DialogTitle>
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
      <Dialog open={log !== null} onOpenChange={(o) => !o && setLog(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{log} — log</DialogTitle>
          </DialogHeader>
          {log && <LogView name={log} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
