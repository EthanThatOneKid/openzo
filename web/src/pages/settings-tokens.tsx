import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ago } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { SettingsTabs } from "@/components/settings-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Token {
  id: string;
  name: string;
  created: number;
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => api<{ tokens: Token[] }>("/api/tokens").then((d) => setTokens(d.tokens));
  useEffect(() => {
    void load();
  }, []);
  const create = async () => {
    try {
      const r = await api<{ token: string }>("/api/tokens", { method: "POST", json: { name: name || "token" } });
      setFresh(r.token);
      setName("");
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const origin = window.location.origin;
  const example = `curl ${origin}/api/ask \\
  -H "Authorization: Bearer ${fresh ?? "oz_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"input": "Summarise the files in my workspace"}'`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" description="Personal access tokens for scripts and other apps." />
      <SettingsTabs />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="What is it for? e.g. home-assistant" onKeyDown={(e) => e.key === "Enter" && create()} />
            <Button onClick={create}>
              <Plus className="size-4" /> Create token
            </Button>
          </div>
          {fresh && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
              <p className="text-sm font-medium">Copy your token now — it won't be shown again.</p>
              <div className="mt-2 flex gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{fresh}</code>
                <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(fresh).then(() => toast.success("Copied"))}>
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          )}
          {tokens === null ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : tokens.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <div className="grid gap-2">
              {tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-xl border p-3">
                  <KeyRound className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">created {ago(t.created)}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => confirm(`Revoke "${t.name}"? Anything using it stops working.`) && api(`/api/tokens/${t.id}`, { method: "DELETE" }).then(load)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <section>
            <h2 className="font-semibold">The ask API</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Same shape as Zo's <code>/zo/ask</code> (that path works here too). Pass <code>conversation_id</code> to continue a conversation and <code>output_format</code> (a JSON schema) for structured output. Every
              other <code>/api</code> endpoint accepts the token as well.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{example}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}
