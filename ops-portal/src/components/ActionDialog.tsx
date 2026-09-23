import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { TextArea } from "./ui/Field";

export interface ActionDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Label for the text box. Omit to hide it. */
  noteLabel?: string;
  noteRequired?: boolean;
  notePlaceholder?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (note: string) => void;
  children?: ReactNode;
  /** Extra check before submitting (e.g. a select must be chosen). Return an error message or null. */
  validate?: () => string | null;
}

/** One dialog for every "confirm this action, maybe with a note/reason" step. */
export function ActionDialog(p: ActionDialogProps) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (p.open) { setNote(""); setErr(null); } }, [p.open]);

  const submit = () => {
    const extra = p.validate?.();
    if (extra) { setErr(extra); return; }
    if (p.noteLabel && p.noteRequired && note.trim().length < 3) { setErr("This needs a short reason"); return; }
    setErr(null);
    p.onConfirm(note);
  };

  return (
    <Dialog open={p.open} onClose={p.onClose} onSubmit={submit} busy={p.busy} error={p.error} title={p.title} description={p.description} width="sm"
      footer={<>
        <Button onClick={p.onClose} disabled={p.busy}>Cancel</Button>
        <Button type="submit" variant={p.danger ? "danger" : "primary"} loading={p.busy}>{p.confirmLabel}</Button>
      </>}>
      <div className="space-y-4">
        {p.children}
        {p.noteLabel && (
          <TextArea label={p.noteLabel} optional={!p.noteRequired} value={note} onChange={(e) => setNote(e.target.value)}
            rows={3} placeholder={p.notePlaceholder} error={err} autoFocus={!p.children} />
        )}
        {!p.noteLabel && err && <p role="alert" className="text-[13px] text-danger">{err}</p>}
      </div>
    </Dialog>
  );
}
