import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const { boot, reload } = useSession();
  const setup = boot!.needsSetup;
  const canSignup = boot!.signup !== "closed";
  const inviteParam = new URLSearchParams(location.search).get("invite") ?? "";
  const [mode, setMode] = useState<"login" | "signup">(inviteParam && canSignup ? "signup" : "login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(inviteParam);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const effective = setup ? "setup" : mode;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const path = effective === "setup" ? "/api/setup" : effective === "signup" ? "/api/signup" : "/api/login";
      await api(path, { method: "POST", json: { name: name.trim().toLowerCase(), password, invite } });
      history.replaceState(null, "", "/");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
            <Logo className="size-6" />
          </div>
          <h1 className="font-serif text-3xl tracking-tight">
            {effective === "setup" ? "Set up openzo" : effective === "signup" ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {effective === "setup"
              ? "Create the admin account for this server. You can invite others afterwards."
              : effective === "signup"
                ? "Your own agent, workspace and terminal on this server."
                : "Sign in to your workspace."}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Username</Label>
            <Input id="name" autoComplete="username" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="zandy" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete={effective === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={effective === "login" ? 1 : 8} />
          </div>
          {effective === "signup" && boot!.signup === "invite" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite">Invite code</Label>
              <Input id="invite" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="from your admin" required />
            </div>
          )}
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy} className="mt-1">
            {busy && <Loader2 className="size-4 animate-spin" />}
            {effective === "setup" ? "Create admin account" : effective === "signup" ? "Create account" : "Sign in"}
          </Button>
        </form>

        {!setup && canSignup && (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {mode === "login" ? "No account? " : "Have an account? "}
            <button className="font-medium text-foreground underline underline-offset-2" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
              {mode === "login" ? "Sign up" : "Sign in"}
            </button>
          </p>
        )}
        <p className="mt-6 text-center text-[11px] text-muted-foreground">openzo v{boot!.version} · {boot!.driver} driver</p>
      </div>
    </div>
  );
}
