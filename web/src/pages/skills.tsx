import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Loader2, Search, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Skill {
  slug: string;
  name: string;
  description: string;
  path: string;
}
interface RegistrySkill {
  slug: string;
  name: string;
  description: string;
  category: string;
  author: string;
  homepage: string | null;
}

export default function SkillsPage() {
  const [tab, setTab] = useState<"mine" | "catalog">("mine");
  const [mine, setMine] = useState<Skill[] | null>(null);
  const [catalog, setCatalog] = useState<RegistrySkill[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api<{ skills: Skill[] }>("/api/skills").then((d) => setMine(d.skills));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (tab !== "catalog" || catalog) return;
    api<{ skills: RegistrySkill[] }>("/api/skills/registry")
      .then((d) => setCatalog(d.skills))
      .catch((e) => setCatalogError(e.message));
  }, [tab, catalog]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = catalog ?? [];
    return t ? list.filter((s) => `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(t)) : list;
  }, [catalog, q]);

  const install = async (slug: string) => {
    setBusy(slug);
    try {
      const r = await api<{ installed: string }>("/api/skills/install", { method: "POST", json: { slug } });
      toast.success(`Installed to Skills/${r.installed}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (slug: string) => {
    if (!confirm(`Delete Skills/${slug}?`)) return;
    await api(`/api/skills/${slug}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    void load();
  };
  const installed = new Set((mine ?? []).map((s) => s.slug));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Skills" description="Packaged workflows your agent follows when a request matches. They live in Skills/ in your workspace.">
        <div className="flex rounded-lg border p-0.5 text-sm">
          {(["mine", "catalog"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("rounded-md px-3 py-1", tab === t ? "bg-accent font-medium" : "text-muted-foreground")}>
              {t === "mine" ? "Installed" : "Catalog"}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl">
          {tab === "mine" ? (
            mine === null ? (
              <div className="flex justify-center py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : mine.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
                <Wand2 className="size-8 text-muted-foreground" />
                <p className="max-w-sm text-sm text-muted-foreground">
                  No skills yet. Install one from the catalog, or ask your agent: “turn what we just did into a skill”.
                </p>
                <Button size="sm" onClick={() => setTab("catalog")}>
                  Browse the catalog
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {mine.map((s) => (
                  <div key={s.slug} className="rounded-xl border bg-card p-4 shadow-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{s.name}</div>
                        <Link to={`/files/Skills/${s.slug}`} className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline">
                          Skills/{s.slug}/
                        </Link>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => remove(s.slug)} title="Delete">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{s.description || "No description in SKILL.md."}</p>
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              <div className="relative mb-4">
                <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Zo skills catalog" className="pl-8" />
              </div>
              {catalogError ? (
                <p className="text-sm text-red-600">Couldn't load the catalog: {catalogError}</p>
              ) : catalog === null ? (
                <div className="flex justify-center py-16 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : (
                <div className="grid gap-3">
                  {filtered.map((s) => (
                    <div key={s.slug} className="rounded-xl border bg-card p-4 shadow-xs">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {[s.category, s.author].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <Button size="sm" variant={installed.has(s.slug) ? "outline" : "default"} disabled={busy === s.slug} onClick={() => install(s.slug)}>
                          {busy === s.slug ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                          {installed.has(s.slug) ? "Install again" : "Install"}
                        </Button>
                      </div>
                      <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{s.description}</p>
                    </div>
                  ))}
                  {filtered.length === 0 && <p className="text-sm text-muted-foreground">Nothing matches.</p>}
                </div>
              )}
              <p className="mt-4 text-xs text-muted-foreground">Catalog: Zo's public skills registry. Skills may need API keys — add them under Settings → Secrets.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
