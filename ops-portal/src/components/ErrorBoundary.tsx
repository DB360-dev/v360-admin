import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";
import { AlertOctagon } from "lucide-react";

function Crash({ onReload }: { onReload: () => void }) {
  return (
    <div role="alert" className="grid min-h-[60vh] place-items-center px-6">
      <div className="max-w-sm text-center">
        <AlertOctagon className="mx-auto h-7 w-7 text-danger" aria-hidden />
        <h1 className="mt-3 text-[18px]">This page stopped working</h1>
        <p className="mt-2 text-[14px] text-muted">
          Something unexpected happened on our side. Your data is safe. Reload the page to continue.
        </p>
        <button onClick={onReload} className="mt-5 inline-flex h-9 items-center rounded bg-primary px-4 text-[14px] font-medium text-primary-fg hover:bg-primary-hover">
          Reload page
        </button>
      </div>
    </div>
  );
}

/** Catches render crashes anywhere below it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("UI crash", error, info.componentStack); }
  render() {
    return this.state.failed ? <Crash onReload={() => window.location.reload()} /> : this.props.children;
  }
}

/** Router-level fallback (used as errorElement). */
export function RouteError() {
  const err = useRouteError();
  console.error("Route error", err);
  return <Crash onReload={() => window.location.reload()} />;
}
