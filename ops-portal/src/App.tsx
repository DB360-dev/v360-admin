import type { ReactElement } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useOps } from "@/context/OpsContext";
import type { Perm } from "@/lib/permissions";
import { FullPageSpinner } from "@/components/ui/States";
import { Layout } from "@/components/Layout";
import { RouteError } from "@/components/ErrorBoundary";
import { Login } from "@/pages/Login";
import { ForgotPassword } from "@/pages/ForgotPassword";
import { ResetPassword } from "@/pages/ResetPassword";
import { NoAccess } from "@/pages/NoAccess";
import { Dashboard } from "@/pages/Dashboard";
import { Orders } from "@/pages/Orders";
import { OrderDetail } from "@/pages/OrderDetail";
import { Confirmations } from "@/pages/Confirmations";
import { Deliveries } from "@/pages/Deliveries";
import { Receiving } from "@/pages/Receiving";
import { Shipments } from "@/pages/Shipments";
import { ShipmentDetail } from "@/pages/ShipmentDetail";
import { Invoices } from "@/pages/Invoices";
import { Brands } from "@/pages/Brands";
import { Team } from "@/pages/Team";
import { Roles } from "@/pages/Roles";
import { Reports } from "@/pages/Reports";
import { reportsFor } from "@/reports";
import { FxRates } from "@/pages/FxRates";
import { Money } from "@/pages/Money";
import { Webhooks } from "@/pages/Webhooks";
import { Activity } from "@/pages/Activity";
import { Discrepancies } from "@/pages/Discrepancies";
import { Restocked } from "@/pages/Restocked";
import { NotFound } from "@/pages/NotFound";

function RequireAuth() {
  const { session, loading, recovery } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (recovery) return <Navigate to="/reset-password" replace />;
  return <Outlet />;
}

/** Must be V360 or KBB staff. */
function RequireOps() {
  const { role, loading, error } = useOps();
  if (loading) return <FullPageSpinner />;
  if (error || !role) return <NoAccess />;
  return <Outlet />;
}

/** Pages that need a permission; others are sent to their dashboard. */
function Need({ perm }: { perm: Perm }) {
  const { can } = useOps();
  return can(perm) ? <Outlet /> : <Navigate to="/" replace />;
}

/** Reports page: anyone whose role allows at least one report. */
function AnyReport() {
  const { role, can } = useOps();
  return reportsFor(role, can).length ? <Outlet /> : <Navigate to="/" replace />;
}

/** Team & roles: V360 admins (every company) and KBB admins (their own). */
function TeamManagers() {
  const { canManageTeam } = useOps();
  return canManageTeam ? <Outlet /> : <Navigate to="/" replace />;
}

const guarded = (perm: Perm, path: string, element: ReactElement) => ({ element: <Need perm={perm} />, children: [{ path, element }] });

export const router = createBrowserRouter([
  { path: "/login", element: <Login />, errorElement: <RouteError /> },
  { path: "/forgot-password", element: <ForgotPassword />, errorElement: <RouteError /> },
  { path: "/reset-password", element: <ResetPassword />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [{
      element: <RequireOps />,
      children: [{
        element: <Layout />,
        children: [
          { index: true, element: <Dashboard /> },
          guarded("orders.view", "orders", <Orders />),
          // Order pages are linked from every queue, so any staff role can open one;
          // what they can see and do on it is decided by permissions.
          { path: "orders/:id", element: <OrderDetail /> },
          guarded("confirmations.view", "confirmations", <Confirmations />),
          guarded("hub.view", "receiving", <Receiving />),
          guarded("shipments.view", "shipments", <Shipments />),
          guarded("shipments.view", "shipments/:id", <ShipmentDetail />),
          guarded("discrepancies.view", "discrepancies", <Discrepancies />),
          guarded("inventory.view", "inventory", <Restocked />),
          guarded("deliveries.view", "deliveries", <Deliveries />),
          guarded("invoices.view", "invoices", <Invoices />),
          guarded("money.view", "money", <Money />),
          guarded("brands.view", "brands", <Brands />),
          guarded("fx.view", "fx", <FxRates />),
          guarded("webhooks.view", "webhooks", <Webhooks />),
          guarded("activity.view", "activity", <Activity />),
          { element: <AnyReport />, children: [{ path: "reports", element: <Reports /> }] },
          {
            element: <TeamManagers />,
            children: [
              { path: "team", element: <Team /> },
              { path: "roles", element: <Roles /> },
            ],
          },
          { path: "*", element: <NotFound /> },
        ],
      }],
    }],
  },
]);
