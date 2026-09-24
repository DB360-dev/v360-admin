import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useOps, type OpsRole } from "@/context/OpsContext";
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

/** Page restricted to one role; others are sent to their dashboard. */
function Only({ role }: { role: OpsRole }) {
  const ops = useOps();
  return ops.role === role ? <Outlet /> : <Navigate to="/" replace />;
}

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
          { path: "orders", element: <Orders /> },
          { path: "orders/:id", element: <OrderDetail /> },
          { path: "confirmations", element: <Confirmations /> },
          { path: "deliveries", element: <Deliveries /> },
          { path: "shipments", element: <Shipments /> },
          { path: "shipments/:id", element: <ShipmentDetail /> },
          { path: "invoices", element: <Invoices /> },
          { path: "discrepancies", element: <Discrepancies /> },
          { path: "inventory", element: <Restocked /> },
          { path: "money", element: <Money /> },
          {
            element: <Only role="v360" />,
            children: [
              { path: "receiving", element: <Receiving /> },
              { path: "brands", element: <Brands /> },
              { path: "team", element: <Team /> },
              { path: "fx", element: <FxRates /> },
              { path: "webhooks", element: <Webhooks /> },
              { path: "activity", element: <Activity /> },
            ],
          },
          { path: "*", element: <NotFound /> },
        ],
      }],
    }],
  },
]);
