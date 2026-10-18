import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/personas", label: "Personas & rules" },
  { to: "/settings/channels", label: "Channels" },
  { to: "/settings/tokens", label: "Access tokens" },
];

export function SettingsTabs() {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden border-b px-4 [scrollbar-width:none] md:px-6">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn("border-b-2 px-3 py-2 text-sm whitespace-nowrap", isActive ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
