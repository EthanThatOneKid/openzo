import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shell";
import { SettingsTabs } from "@/components/settings-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Persona {
  id: number;
  name: string;
  prompt: string;
  active: boolean;
}
interface Rule {
  id: number;
  condition: string;
  instruction: string;
  enabled: boolean;
}
interface Profile {
  personas: Persona[];
  rules: Rule[];
  legacy: { persona: string; rules: string };
}

function PersonaEditor({ initial, onSave }: { initial?: Persona; onSave: (p: { name: string; prompt: string }) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Precise engineer" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Instructions</Label>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} placeholder="You are direct and concise. Lead with the answer…" />
      </div>
      <DialogFooter>
        <Button
          disabled={busy || !name.trim() || !prompt.trim()}
          onClick={async () => {
            setBusy(true);
            await onSave({ name, prompt }).finally(() => setBusy(false));
          }}
        >
          {busy && <Loader2 className="size-4 animate-spin" />} Save
        </Button>
      </DialogFooter>
    </div>
  );
}

function RuleEditor({ initial, onSave }: { initial?: Rule; onSave: (r: { condition: string; instruction: string }) => Promise<void> }) {
  const [condition, setCondition] = useState(initial?.condition ?? "");
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>When (optional)</Label>
        <Input value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="I ask for code" />
        <p className="text-xs text-muted-foreground">Leave empty for a rule that always applies.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Do this</Label>
        <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4} placeholder="Use TypeScript and explain nothing unless asked." />
      </div>
      <DialogFooter>
        <Button
          disabled={busy || !instruction.trim()}
          onClick={async () => {
            setBusy(true);
            await onSave({ condition, instruction }).finally(() => setBusy(false));
          }}
        >
          {busy && <Loader2 className="size-4 animate-spin" />} Save
        </Button>
      </DialogFooter>
    </div>
  );
}

export default function PersonasPage() {
  const [p, setP] = useState<Profile | null>(null);
  const [persona, setPersona] = useState<Persona | "new" | null>(null);
  const [rule, setRule] = useState<Rule | "new" | null>(null);
  const load = () => api<Profile>("/api/profile").then(setP);
  useEffect(() => {
    void load();
  }, []);
  const run = async (fn: () => Promise<Profile>) => {
    try {
      setP(await fn());
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Settings" description="Who your agent is, and the rules it follows in every conversation." />
      <SettingsTabs />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {p === null ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="font-semibold">Personas</h2>
                  <p className="text-sm text-muted-foreground">One persona is active at a time. Changes apply to your next conversation.</p>
                </div>
                <Button size="sm" onClick={() => setPersona("new")}>
                  <Plus className="size-4" /> Persona
                </Button>
              </div>
              <div className="grid gap-2">
                <button
                  onClick={() => run(() => api<Profile>("/api/personas/deactivate", { method: "POST" }))}
                  className={cn("flex items-center gap-3 rounded-xl border p-3 text-left text-sm", !p.personas.some((x) => x.active) ? "border-primary bg-primary/5" : "hover:bg-accent")}
                >
                  <UserRound className="size-4 text-muted-foreground" />
                  <span className="flex-1">Default (no persona)</span>
                  {!p.personas.some((x) => x.active) && <Check className="size-4 text-primary" />}
                </button>
                {p.personas.map((x) => (
                  <div key={x.id} className={cn("flex items-start gap-3 rounded-xl border p-3", x.active ? "border-primary bg-primary/5" : "")}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => run(() => api<Profile>(`/api/personas/${x.id}`, { method: "PATCH", json: { active: true } }))}>
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {x.name}
                        {x.active && <Check className="size-4 text-primary" />}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{x.prompt}</p>
                    </button>
                    <Button variant="ghost" size="sm" onClick={() => setPersona(x)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => confirm(`Delete persona "${x.name}"?`) && run(() => api<Profile>(`/api/personas/${x.id}`, { method: "DELETE" }))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <h2 className="font-semibold">Rules</h2>
                  <p className="text-sm text-muted-foreground">Standing instructions, optionally conditional. Your agent adds rules here when you ask it to remember something.</p>
                </div>
                <Button size="sm" onClick={() => setRule("new")}>
                  <Plus className="size-4" /> Rule
                </Button>
              </div>
              {p.rules.length === 0 ? (
                <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No rules yet.</p>
              ) : (
                <div className="grid gap-2">
                  {p.rules.map((r) => (
                    <div key={r.id} className="flex items-start gap-3 rounded-xl border p-3">
                      <button className="min-w-0 flex-1 text-left text-sm" onClick={() => setRule(r)}>
                        {r.condition && <span className="text-muted-foreground">When {r.condition}: </span>}
                        {r.instruction}
                      </button>
                      <Switch checked={r.enabled} onCheckedChange={(v) => run(() => api<Profile>(`/api/rules/${r.id}`, { method: "PATCH", json: { enabled: v } }))} />
                      <Button variant="ghost" size="sm" onClick={() => run(() => api<Profile>(`/api/rules/${r.id}`, { method: "DELETE" }))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(p.legacy.persona || p.legacy.rules) && (
              <p className="text-xs text-muted-foreground">
                The persona/rules text from the General tab still applies alongside these.
              </p>
            )}
          </div>
        )}
      </div>
      <Dialog open={persona !== null} onOpenChange={(o) => !o && setPersona(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{persona === "new" ? "New persona" : "Edit persona"}</DialogTitle>
          </DialogHeader>
          {persona !== null && (
            <PersonaEditor
              initial={persona === "new" ? undefined : persona}
              onSave={async (v) => {
                await run(() =>
                  persona === "new" ? api<Profile>("/api/personas", { method: "POST", json: { ...v, active: true } }) : api<Profile>(`/api/personas/${persona.id}`, { method: "PATCH", json: v }),
                );
                setPersona(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={rule !== null} onOpenChange={(o) => !o && setRule(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{rule === "new" ? "New rule" : "Edit rule"}</DialogTitle>
          </DialogHeader>
          {rule !== null && (
            <RuleEditor
              initial={rule === "new" ? undefined : rule}
              onSave={async (v) => {
                await run(() => (rule === "new" ? api<Profile>("/api/rules", { method: "POST", json: v }) : api<Profile>(`/api/rules/${rule.id}`, { method: "PATCH", json: v })));
                setRule(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
