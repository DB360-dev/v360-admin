import { useEffect, useState } from "react";
import { useSetInvoicePaymentStatus } from "@/hooks/useData";
import type { InvoicePaymentStatus } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

interface EditPaymentStatusModalProps {
  open: boolean;
  onClose: () => void;
  invoiceNumber: string;
  currentStatus: InvoicePaymentStatus;
}

export function EditPaymentStatusModal({
  open,
  onClose,
  invoiceNumber,
  currentStatus,
}: EditPaymentStatusModalProps) {
  const [status, setStatus] = useState<InvoicePaymentStatus>(currentStatus);
  const setPaymentStatus = useSetInvoicePaymentStatus({
    onSuccess: () => {
      onClose();
    },
  });

  useEffect(() => {
    if (open) {
      setStatus(currentStatus);
    }
  }, [open, currentStatus]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceNumber) return;
    setPaymentStatus.mutate({ invoiceNumber, status });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit Invoice Payment Status"
      width="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-1 text-xs">
        <div>
          <span className="text-muted">Invoice #:</span>
          <div className="font-mono text-sm font-semibold text-primary mt-0.5">
            {invoiceNumber}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block font-medium text-ink">Select Payment Status:</label>

          <label className="flex cursor-pointer items-center gap-2 rounded border border-line bg-surface p-2.5 transition-colors hover:bg-surface-hover">
            <input
              type="radio"
              name="paymentStatus"
              value="not_paid"
              checked={status === "not_paid"}
              onChange={() => setStatus("not_paid")}
              className="text-rose-600 focus:ring-rose-500"
            />
            <div>
              <div className="font-semibold text-rose-700">Unpaid (Not Paid)</div>
              <p className="text-[11px] text-muted">No payment has been received yet.</p>
            </div>
          </label>

          <label className="flex cursor-pointer items-center gap-2 rounded border border-line bg-surface p-2.5 transition-colors hover:bg-surface-hover">
            <input
              type="radio"
              name="paymentStatus"
              value="partially_paid"
              checked={status === "partially_paid"}
              onChange={() => setStatus("partially_paid")}
              className="text-amber-600 focus:ring-amber-500"
            />
            <div>
              <div className="font-semibold text-amber-700">Partially Paid</div>
              <p className="text-[11px] text-muted">Partial payment received.</p>
            </div>
          </label>

          <label className="flex cursor-pointer items-center gap-2 rounded border border-line bg-surface p-2.5 transition-colors hover:bg-surface-hover">
            <input
              type="radio"
              name="paymentStatus"
              value="paid"
              checked={status === "paid"}
              onChange={() => setStatus("paid")}
              className="text-emerald-600 focus:ring-emerald-500"
            />
            <div>
              <div className="font-semibold text-emerald-700">Paid</div>
              <p className="text-[11px] text-muted">Full payment settled and confirmed.</p>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={setPaymentStatus.isPending}
          >
            {setPaymentStatus.isPending ? "Saving..." : "Save Payment Status"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
