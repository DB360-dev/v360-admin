import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** When set, the body is a form and Enter submits. */
  onSubmit?: () => void;
  busy?: boolean;
  /** Error from the server, shown at the top of the dialog. */
  error?: string | null;
  width?: "sm" | "md" | "lg";
}

const WIDTH = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl" };

/** Native <dialog>: focus trapping and Esc come from the browser. */
export function Dialog({ open, onClose, title, description, children, footer, onSubmit, busy, error, width = "md" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onSubmit?.();
  };

  const Body = onSubmit ? "form" : "div";

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      onClick={(e) => { if (e.target === ref.current && !busy) onClose(); }}
      className={`w-[calc(100%-2rem)] ${WIDTH[width]} rounded-lg bg-surface text-ink p-0 shadow-pop border border-line backdrop:backdrop-blur-[1px]`}
      aria-labelledby="dialog-title"
    >
      {open && (
        <Body onSubmit={onSubmit ? handleSubmit : undefined} noValidate className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <h2 id="dialog-title" className="text-[16px]">{title}</h2>
              {description && <div className="mt-1 text-[13.5px] text-muted">{description}</div>}
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="-mr-1 rounded p-1 text-muted hover:bg-sunken hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            {error && (
              <div role="alert" className="mb-4 flex gap-2 rounded border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13.5px] text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}
            {children}
          </div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Body>
      )}
    </dialog>
  );
}
