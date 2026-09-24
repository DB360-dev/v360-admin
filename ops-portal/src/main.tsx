import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import "./index.css";
import { configError } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { AuthProvider } from "@/context/AuthContext";
import { OpsProvider } from "@/context/OpsContext";
import { NotificationProvider } from "@/context/NotificationContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfigError } from "@/components/ConfigError";
import { router } from "./App";

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="top-right" richColors closeButton duration={5000} toastOptions={{ style: { fontFamily: "inherit" } }} />;
}

window.addEventListener("unhandledrejection", (e) => console.error("Unhandled promise rejection", e.reason));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ErrorBoundary>
        {configError ? <ConfigError message={configError} /> : (
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <OpsProvider>
                <NotificationProvider>
                  <RouterProvider router={router} />
                  <ThemedToaster />
                </NotificationProvider>
              </OpsProvider>
            </AuthProvider>
          </QueryClientProvider>
        )}
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
