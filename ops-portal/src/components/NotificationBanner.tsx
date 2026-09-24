import { useNavigate } from "react-router-dom";
import { MessageSquare, X, ArrowRight, BellRing } from "lucide-react";
import { useNotifications } from "@/context/NotificationContext";

export function NotificationBanner() {
  const { activeBanner, dismissBanner, markAsRead } = useNotifications();
  const navigate = useNavigate();

  if (!activeBanner) return null;

  const handleViewOrder = () => {
    markAsRead(activeBanner.id);
    dismissBanner();
    navigate(`/orders/${activeBanner.orderId}`);
  };

  return (
    <div className="relative z-30 mb-4 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary-soft/90 p-4 shadow-md backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <BellRing className="h-5 w-5 animate-pulse" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[12px] font-semibold text-primary-fg">
                <MessageSquare className="h-3 w-3" /> New Note
              </span>
              <h4 className="text-[14px] font-semibold text-ink">
                There is a message/note for order <span className="font-mono text-primary">#{activeBanner.orderNumber}</span>
              </h4>
            </div>
            <p className="line-clamp-2 text-[13px] text-muted">
              <span className="font-medium text-ink">{activeBanner.senderLabel}:</span> "{activeBanner.body}"
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={handleViewOrder}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-fg shadow-sm transition-opacity hover:opacity-90 active:scale-95"
          >
            View Order
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={dismissBanner}
            className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink transition-colors"
            title="Dismiss notification"
            aria-label="Dismiss banner"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
