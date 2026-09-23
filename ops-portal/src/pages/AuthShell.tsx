import type { ReactNode } from "react";

/** Sign-in frame for the internal operations panel. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2 text-[14px] font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded bg-ink text-[12px] font-bold text-bg" aria-hidden>V</span>
          V360 Operations
        </div>
        <div className="panel p-6 sm:p-8">
          <h1 className="text-[20px]">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[14px] text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-4 text-center text-[12.5px] text-faint">For V360 and KBB staff only. Brands use the brand portal.</p>
      </div>
    </div>
  );
}
