import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Bot,
  Clock,
  FolderOpen,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plug,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  AppWindow,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ago, session } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTheme } from "@/components/theme-provider";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const NAV = [
  { to: "/", label: "Home", icon: MessageSquare, end: true },
  { to: "/sites", label: "Space & sites", icon: Sparkles },
  { to: "/files", label: "Files", icon: FolderOpen },
  { to: "/automations", label: "Automations", icon: Clock },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/skills", label: "Skills", icon: Wand2 },
  { to: "/browser", label: "Browser", icon: AppWindow },
  { to: "/terminal", label: "Terminal", icon: Terminal },
];

function RuntimeDot() {
  const [state, setState] = useState<string>("stopped");
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api<{ state: string }>("/api/runtime")
        .then((r) => alive && setState(r.state))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const color = state === "running" ? "bg-emerald-500" : state === "starting" ? "bg-amber-500 animate-pulse" : state === "error" ? "bg-red-500" : "bg-muted-foreground/40";
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={`Your runtime is ${state}`}>
      <span className={cn("size-1.5 rounded-full", color)} />
      runtime {state}
    </span>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { boot, reload, conversations, refreshConversations } = useSession();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const user = boot!.user!;
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  const logout = async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    session.set(null);
    await reload();
  };

  const remove = async (id: string) => {
    await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    refreshConversations();
    if (location.pathname === `/c/${id}`) navigate("/");
    toast("Conversation removed from the list");
  };

  const item = "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors";

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="size-5" />
          openzo
        </Link>
        <RuntimeDot />
      </div>

      <div className="px-2.5 pb-2">
        <button
          onClick={() => {
            navigate("/");
            onNavigate?.();
            window.dispatchEvent(new Event("openzo:new-chat"));
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border bg-card px-3 py-2 text-sm font-medium shadow-xs hover:bg-sidebar-accent"
        >
          <Plus className="size-4" /> New chat
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-2.5">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => cn(item, isActive && "bg-sidebar-accent text-sidebar-foreground font-medium")}>
            <n.icon className="size-4 opacity-70" />
            {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Conversations</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        {conversations.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">Nothing yet. Start a chat.</p>}
        {conversations.map((c) => (
          <div key={c.id} className="group relative">
            <NavLink
              to={`/c/${c.id}`}
              onClick={onNavigate}
              className={({ isActive }) => cn("block truncate rounded-md py-1.5 pr-8 pl-2.5 text-[13px] text-sidebar-foreground/80 hover:bg-sidebar-accent", isActive && "bg-sidebar-accent text-sidebar-foreground")}
              title={`${c.title} · ${ago(c.updated)}`}
            >
              {c.source.startsWith("automation") && <Clock className="mr-1.5 inline size-3 opacity-60" />}
              {c.title}
            </NavLink>
            <button onClick={() => remove(c.id)} className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground group-hover:block" title="Remove from list">
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

<div className="border-t border-sidebar-border" />

      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <NavLink to="/settings" end={false} onClick={onNavigate} className={({ isActive }) => cn(item, isActive && "bg-sidebar-accent font-medium")}>
          <Settings className="size-4 opacity-70" /> Settings
        </NavLink>
        {user.role === "admin" && (
          <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => cn(item, isActive && "bg-sidebar-accent font-medium")}>
            <Shield className="size-4 opacity-70" /> Admin
          </NavLink>
        )}
        <div className="mt-1 flex items-center justify-between rounded-md px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground uppercase">{user.name[0]}</div>
            <span className="truncate text-sm">{user.name}</span>
          </div>
          <div className="flex items-center">
            <button onClick={() => setTheme(dark ? "light" : "dark")} className="rounded p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Toggle theme">
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <button onClick={logout} className="rounded p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border md:block">
        <SidebarBody />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <button onClick={() => setOpen(true)} className="absolute top-3 left-3 z-10 rounded-md border bg-card p-1.5 md:hidden" aria-label="Menu">
          <Menu className="size-4" />
        </button>
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b px-6 pt-6 pb-4 pl-14 md:pl-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export { Bot };
