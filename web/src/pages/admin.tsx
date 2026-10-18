import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, Power, ShieldCheck, Trash2, UserPlus, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api, ago, formatBytes } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PageHeader } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface AdminUser {
  id: number;
  name: string;
  role: "admin" | "user";
  disabled: boolean;
  created: number;
  lastSeen: number | null;
  runtime: { state: string; lastUsed: number | null; error: string | null };
  diskBytes: number;
  conversations: number;
}

interface Overview {
  users: AdminUser[];
  system: { ok: boolean; detail: string };
  config: Record<string, string | number>;
}

function NewUser({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const create = async () => {
    try {
      await api("/api/admin/users", { method: "POST", json: { name, password, role: admin ? "admin" : "user" } });
      toast.success(`Created ${name}`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Username</Label>
        <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="alex" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Initial password</Label>
        <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Admin
      </label>
      <DialogFooter>
        <Button onClick={create} disabled={!name || password.length < 8}>
          Create user
        </Button>
      </DialogFooter>
    </div>
  );
}

function Invites() {
  const [list, setList] = useState<any[]>([]);
  const [copied, setCopied] = useState("");
  const load = () => api<{ invites: any[] }>("/api/admin/invites").then((d) => setList(d.invites));
  useEffect(() => {
    void load();
  }, []);
  const create = async () => {
    const { code } = await api<{ code: string }>("/api/admin/invites", { method: "POST", json: { days: 7 } });
    void load();
    copy(code);
  };
  const copy = (code: string) => {
    void navigator.clipboard.writeText(`${location.origin}/?invite=${code}`);
    setCopied(code);
    toast.success("Invite link copied");
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Invite links work once and expire after 7 days.</p>
        <Button size="sm" onClick={create}>
          <Plus className="size-4" /> New invite
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        {list.length === 0 && <p className="p-4 text-sm text-muted-foreground">No invites.</p>}
        {list.map((i) => (
          <div key={i.code} className="flex items-center gap-3 border-b px-4 py-2.5 text-sm last:border-b-0">
            <code className="font-mono text-xs">{i.code}</code>
            <span className="flex-1 text-xs text-muted-foreground">
              {i.used_by_name ? `used by ${i.used_by_name}` : i.expires && i.expires < Date.now() ? "expired" : `expires ${new Date(i.expires).toLocaleDateString()}`}
            </span>
            {!i.used_by_name && (
              <Button variant="ghost" size="sm" onClick={() => copy(i.code)}>
                {copied === i.code ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api(`/api/admin/invites/${i.code}`, { method: "DELETE" });
                void load();
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    void api<{ audit: any[] }>("/api/admin/audit").then((d) => setRows(d.audit));
  }, []);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {rows.map((r) => (
        <div key={r.id} className="flex gap-3 border-b px-4 py-2 font-mono text-xs last:border-b-0">
          <span className="w-36 shrink-0 text-muted-foreground">{new Date(r.ts).toLocaleString()}</span>
          <span className="w-24 shrink-0 truncate">{r.user_name ?? "—"}</span>
          <span className="w-44 shrink-0">{r.action}</span>
          <span className="truncate text-muted-foreground">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

export default function AdminPage() {
  const { boot } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api<Overview>("/api/admin/overview").then(setData);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const patch = async (u: AdminUser, body: Record<string, unknown>) => {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: body });
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (u: AdminUser) => {
    const purge = confirm(`Delete ${u.name}? Press OK to also delete their files (cannot be undone), Cancel to keep them.`);
    if (!confirm(`Really delete the account ${u.name}${purge ? " and all their files" : ""}?`)) return;
    await api(`/api/admin/users/${u.id}${purge ? "?purge=1" : ""}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    void load();
  };

  const resetPassword = async (u: AdminUser) => {
    const p = prompt(`New password for ${u.name} (min 8 characters)`);
    if (p) await patch(u, { password: p });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Admin" description="Users, runtimes and access for this openzo server.">
        <Button size="sm" onClick={() => setAdding(true)}>
          <UserPlus className="size-4" /> Add user
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {!data ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            <div className={cn("flex items-start gap-3 rounded-xl border p-4 text-sm", data.system.ok ? "bg-card" : "border-destructive/40 bg-destructive/5")}>
              {data.system.ok ? <ShieldCheck className="size-5 shrink-0 text-emerald-600" /> : <AlertTriangle className="size-5 shrink-0 text-destructive" />}
              <div>
                <div className="font-medium">{data.system.ok ? "System healthy" : "System problem"}</div>
                <div className="text-muted-foreground">{data.system.detail}</div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
                  {Object.entries(data.config).map(([k, v]) => (
                    <span key={k}>
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
                {data.config.driver === "process" && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Process driver: users are not isolated from each other or from the host. Use the gvisor driver for anyone you don't fully trust.</p>
                )}
              </div>
            </div>

            <Tabs defaultValue="users">
              <TabsList>
                <TabsTrigger value="users">Users ({data.users.length})</TabsTrigger>
                <TabsTrigger value="invites">Invites</TabsTrigger>
                <TabsTrigger value="audit">Audit log</TabsTrigger>
              </TabsList>
              <TabsContent value="users">
                <div className="overflow-x-auto rounded-xl border bg-card">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">User</th>
                        <th className="px-4 py-2 font-medium">Runtime</th>
                        <th className="px-4 py-2 font-medium">Disk</th>
                        <th className="px-4 py-2 font-medium">Chats</th>
                        <th className="px-4 py-2 font-medium">Last seen</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.users.map((u) => (
                        <tr key={u.id} className={cn("border-b last:border-b-0", u.disabled && "opacity-50")}>
                          <td className="px-4 py-2.5">
                            <div className="font-medium">
                              {u.name} {u.role === "admin" && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">admin</span>}
                              {u.disabled && <span className="ml-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive uppercase">disabled</span>}
                            </div>
                            <div className="text-xs text-muted-foreground">joined {ago(u.created)}</div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={cn("text-xs", u.runtime.state === "running" && "text-emerald-600", u.runtime.state === "error" && "text-destructive")}>{u.runtime.state}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs">{formatBytes(u.diskBytes)}</td>
                          <td className="px-4 py-2.5 text-xs">{u.conversations}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{ago(u.lastSeen)}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex justify-end gap-1">
                              {u.runtime.state === "running" && (
                                <Button variant="ghost" size="sm" title="Stop runtime" onClick={async () => (await api(`/api/admin/users/${u.id}/stop`, { method: "POST" }), load())}>
                                  <Power className="size-4" />
                                </Button>
                              )}
                              {u.id !== boot?.user?.id && (
                                <>
                                  <Button variant="ghost" size="sm" onClick={() => patch(u, { role: u.role === "admin" ? "user" : "admin" })}>
                                    {u.role === "admin" ? "Demote" : "Make admin"}
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => patch(u, { disabled: !u.disabled })}>
                                    {u.disabled ? "Enable" : "Disable"}
                                  </Button>
                                </>
                              )}
                              <Button variant="ghost" size="sm" onClick={() => resetPassword(u)}>
                                Reset password
                              </Button>
                              {u.id !== boot?.user?.id && (
                                <Button variant="ghost" size="sm" onClick={() => remove(u)} title="Delete">
                                  <Trash2 className="size-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </TabsContent>
              <TabsContent value="invites">
                <Invites />
              </TabsContent>
              <TabsContent value="audit">
                <Audit />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
          </DialogHeader>
          <NewUser
            onDone={() => {
              setAdding(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
