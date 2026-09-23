import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity, Banknote, Boxes, Building2, Coins, Gauge, Inbox, LogOut, Menu, Monitor, Moon, PhoneCall, Ship, Sun, Truck, Users, Webhook, WifiOff, X,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useOps, type OpsRole } from "@/context/OpsContext";
import { useTheme, type ThemeChoice } from "@/context/ThemeContext";
import { useStatusCounts } from "@/hooks/useData";
import { useOpsRealtime } from "@/hooks/useRealtime";
import { useOnline } from "@/hooks/useOnline";
import { CONFIRM_QUEUE, DELIVERY_QUEUE } from "@/lib/status";
import { ROLE_LABEL } from "@/lib/status";
import { ErrorBoundary } from "./ErrorBoundary";

type Badge = "confirm" | "deliver" | "hub";
interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean; roles: OpsRole[]; badge?: Badge; section?: string }

const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: Gauge, end: true, roles: ["v360", "kbb"] },
  { to: "/orders", label: "All orders", icon: Boxes, roles: ["v360", "kbb"] },
  { to: "/confirmations", label: "Confirmations", icon: PhoneCall, roles: ["v360", "kbb"], badge: "confirm", section: "Work queues" },
  { to: "/receiving", label: "Hub receiving", icon: Inbox, roles: ["v360"], badge: "hub" },
  { to: "/shipments", label: "Shipments", icon: Ship, roles: ["v360", "kbb"] },
  { to: "/deliveries", label: "Deliveries", icon: Truck, roles: ["v360", "kbb"], badge: "deliver" },
  { to: "/brands", label: "Brands", icon: Building2, roles: ["v360"], section: "Admin" },
  { to: "/money", label: "Money", icon: Banknote, roles: ["v360"] },
  { to: "/money", label: "My account", icon: Banknote, roles: ["kbb"] },
  { to: "/team", label: "Team & access", icon: Users, roles: ["v360"] },
  { to: "/fx", label: "FX rates", icon: Coins, roles: ["v360"] },
  { to: "/webhooks", label: "Shopify sync", icon: Webhook, roles: ["v360"] },
  { to: "/activity", label: "Activity", icon: Activity, roles: ["v360"] },
];

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const opts: { v: ThemeChoice; icon: LucideIcon; label: string }[] = [
    { v: "light", icon: Sun, label: "Light" }, { v: "dark", icon: Moon, label: "Dark" }, { v: "system", icon: Monitor, label: "System" },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded border border-line p-0.5">
      {opts.map(({ v, icon: Icon, label }) => (
        <button key={v} role="radio" aria-checked={choice === v} title={label} onClick={() => setChoice(v)}
          className={`grid h-7 flex-1 place-items-center rounded-[4px] ${choice === v ? "bg-sunken text-ink" : "text-faint hover:text-ink"}`}>
          <Icon className="h-3.5 w-3.5" /><span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { role, orgName, memberRole } = useOps();
  const { user, signOut } = useAuth();
  const c = useStatusCounts().data ?? {};
  const sum = (ss: string[]) => ss.reduce((n, s) => n + (c[s as keyof typeof c] ?? 0), 0);
  const badges: Record<Badge, number> = {
    confirm: sum(CONFIRM_QUEUE),
    deliver: sum(DELIVERY_QUEUE),
    hub: sum(["dispatched_to_hub", "hub_issue"]),
  };
  const items = NAV.filter((n) => role && n.roles.includes(role));

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded bg-ink text-[11px] font-bold text-bg" aria-hidden>{role === "kbb" ? "K" : "V"}</span>
          {role === "kbb" ? "KBB Fulfilment" : "V360 Operations"}
        </div>
        <div className="mt-1.5 text-[12.5px] text-muted">{memberRole ? ROLE_LABEL[memberRole] ?? memberRole : orgName}</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3" aria-label="Main">
        {items.map(({ to, label, icon: Icon, end, badge, section }) => (
          <div key={`${to}:${label}`}>
            {section && <div className="mb-1 mt-4 px-2 text-[12px] font-medium text-faint">{section}</div>}
            <NavLink to={to} end={end} onClick={onNavigate}
              className={({ isActive }) => `mb-0.5 flex items-center gap-2.5 rounded px-2 py-1.5 text-[14px] transition-colors ${
                isActive ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-sunken hover:text-ink"}`}>
              <Icon className="h-4 w-4" aria-hidden />
              <span className="flex-1">{label}</span>
              {badge && badges[badge] > 0 && (
                <span className="rounded-full bg-sunken px-1.5 text-[12px] font-semibold text-ink">{badges[badge]}</span>
              )}
            </NavLink>
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-line p-3">
        <ThemeSwitch />
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[13px] text-muted" title={user?.email}>{user?.email}</div>
          <button onClick={() => void signOut()} className="rounded p-1.5 text-muted hover:bg-sunken hover:text-ink" title="Sign out">
            <LogOut className="h-4 w-4" /><span className="sr-only">Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const { role } = useOps();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useOpsRealtime(!!role);
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr] print:block">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-surface lg:block print:!hidden"><Sidebar /></aside>
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:hidden print:hidden">
        <button onClick={() => setOpen(true)} className="rounded p-1.5 hover:bg-sunken" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        <span className="font-semibold">{role === "kbb" ? "KBB Fulfilment" : "V360 Operations"}</span>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-[rgb(var(--shadow)/0.45)]" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface shadow-pop">
            <button onClick={() => setOpen(false)} className="absolute right-2 top-3 rounded p-1.5 hover:bg-sunken" aria-label="Close menu"><X className="h-4 w-4" /></button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
      <main className="min-w-0">
        {!online && (
          <div role="status" className="flex items-center gap-2 bg-g-problem-bg px-6 py-2 text-[13.5px] text-g-problem">
            <WifiOff className="h-4 w-4" aria-hidden /> You're offline. Changes won't save until your connection is back.
          </div>
        )}
        <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <ErrorBoundary key={location.pathname}><Outlet /></ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
