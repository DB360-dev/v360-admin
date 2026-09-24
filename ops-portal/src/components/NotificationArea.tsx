import { useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, MessageSquare, CheckCheck, ExternalLink, Trash2, X, Check } from "lucide-react";
import { useNotifications } from "@/context/NotificationContext";
import { fmtDateTime } from "@/lib/format";

export function NotificationToggle() {
  const { unreadCount, toggleOpen, isOpen } = useNotifications();

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleOpen();
      }}
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg border transition-all ${
        isOpen
          ? "border-primary/40 bg-primary-soft text-primary shadow-sm"
          : "border-line bg-surface text-muted hover:bg-sunken hover:text-ink"
      }`}
      title={`Order Notifications (${unreadCount} unread)`}
      aria-label="Toggle order notifications"
    >
      <Bell className="h-4 w-4" />
      {unreadCount > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-fg animate-pulse">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export function NotificationPanel() {
  const {
    notifications,
    unreadCount,
    isOpen,
    setIsOpen,
    markAsRead,
    markAllAsRead,
    removeNotification,
  } = useNotifications();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close panel on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      const timer = setTimeout(() => {
        document.addEventListener("mousedown", handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timer);
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isOpen, setIsOpen]);

  if (!isOpen) return null;

  const handleSelectOrder = (e: React.MouseEvent, orderId: string, notifId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markAsRead(notifId, orderId);
    setIsOpen(false);
    navigate(`/orders/${orderId}`);
  };

  const handleMarkRead = (e: React.MouseEvent, notifId: string, orderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    markAsRead(notifId, orderId);
  };

  const handleDelete = (e: React.MouseEvent, notifId: string) => {
    e.preventDefault();
    e.stopPropagation();
    removeNotification(notifId);
  };

  const handleMarkAllRead = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    markAllAsRead();
  };

  return (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute right-0 top-12 z-50 w-80 sm:w-96 rounded-xl border border-line bg-surface shadow-pop animate-in fade-in zoom-in-95 duration-150"
      role="dialog"
      aria-label="Order Notifications"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold text-ink">Order Messages & Notes</h3>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
              {unreadCount} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-primary hover:bg-primary-soft transition-colors"
              title="Mark all as read"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Read all</span>
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }}
            className="rounded p-1 text-muted hover:bg-sunken hover:text-ink"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Notification List */}
      <div className="max-h-[380px] overflow-y-auto divide-y divide-line/60">
        {notifications.length === 0 ? (
          <div className="p-8 text-center text-muted">
            <Bell className="mx-auto mb-2 h-8 w-8 text-faint opacity-50" />
            <p className="text-[13px]">No order messages or notes yet.</p>
            <p className="mt-1 text-[11.5px] text-faint">
              When a note is added for any order, it will appear here.
            </p>
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`flex flex-col gap-1.5 p-3.5 transition-colors ${
                !n.read ? "bg-primary-soft/30 hover:bg-primary-soft/40" : "hover:bg-sunken/60"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {!n.read && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-primary"
                      title="Unread note"
                    />
                  )}
                  <button
                    type="button"
                    onClick={(e) => handleSelectOrder(e, n.orderId, n.id)}
                    className="truncate font-mono text-[13px] font-bold text-primary hover:underline"
                  >
                    #{n.orderNumber}
                  </button>
                  <span className="rounded bg-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-muted truncate">
                    {n.senderLabel}
                  </span>
                </div>
                <span className="shrink-0 text-[11px] text-faint">
                  {fmtDateTime(n.createdAt)}
                </span>
              </div>

              <p className="text-[12.5px] leading-relaxed text-ink line-clamp-2 pl-4">
                "{n.body}"
              </p>

              <div className="mt-1.5 flex items-center justify-between border-t border-line/40 pt-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={(e) => handleSelectOrder(e, n.orderId, n.id)}
                    className="flex items-center gap-1 text-[12px] font-medium text-primary hover:underline"
                  >
                    View Order
                    <ExternalLink className="h-3 w-3" />
                  </button>
                  {!n.read && (
                    <button
                      type="button"
                      onClick={(e) => handleMarkRead(e, n.id, n.orderId)}
                      className="flex items-center gap-1 text-[11.5px] font-medium text-muted hover:text-ink"
                      title="Mark as read"
                    >
                      <Check className="h-3 w-3 text-primary" />
                      Mark read
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, n.id)}
                  className="rounded p-1 text-faint hover:bg-g-problem-bg hover:text-g-problem transition-colors"
                  title="Delete notification"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
