import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useOps } from "@/context/OpsContext";

export interface OrderNotification {
  id: string;
  orderId: string;
  orderNumber: string;
  senderType: "brand" | "admin";
  senderLabel: string;
  body: string;
  createdAt: string;
  read: boolean;
}

interface NotificationContextType {
  notifications: OrderNotification[];
  unreadCount: number;
  activeBanner: OrderNotification | null;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggleOpen: () => void;
  dismissBanner: () => void;
  markAsRead: (id: string, orderId?: string) => void;
  markAllAsRead: () => void;
  removeNotification: (id: string) => void;
  addNotification: (notif: Omit<OrderNotification, "id" | "createdAt" | "read">) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

const STORAGE_KEY = "v360_ops_read_notifications";

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { role } = useOps();
  const [notifications, setNotifications] = useState<OrderNotification[]>([]);
  const [activeBanner, setActiveBanner] = useState<OrderNotification | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const getReadIds = (): Set<string> => {
    try {
      const item = localStorage.getItem(STORAGE_KEY);
      return item ? new Set(JSON.parse(item)) : new Set();
    } catch {
      return new Set();
    }
  };

  const saveReadId = (id: string) => {
    try {
      const set = getReadIds();
      set.add(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
    } catch {
      // ignore
    }
  };

  const fetchRecentMessages = useCallback(async () => {
    if (!user || !role) return;

    try {
      const { data, error } = await supabase
        .from("order_messages")
        .select(`
          id,
          order_id,
          sender_type,
          sender_label,
          body,
          read_by_admin,
          created_at,
          orders (
            id,
            order_number
          )
        `)
        .order("created_at", { ascending: false })
        .limit(25);

      if (error) {
        console.warn("Could not fetch order notifications:", error);
        return;
      }

      const readIds = getReadIds();

      const notifs: OrderNotification[] = (data || []).map((msg: any) => {
        const isRead = msg.read_by_admin || readIds.has(String(msg.id));
        const ordNum = msg.orders?.order_number || "Unknown";
        return {
          id: String(msg.id),
          orderId: msg.order_id,
          orderNumber: ordNum,
          senderType: msg.sender_type,
          senderLabel: msg.sender_label || (msg.sender_type === "brand" ? "Brand" : "Ops Team"),
          body: msg.body,
          createdAt: msg.created_at,
          read: isRead,
        };
      });

      setNotifications(notifs);
    } catch (e) {
      console.error("Error in fetchRecentMessages:", e);
    }
  }, [role, user]);

  useEffect(() => {
    void fetchRecentMessages();
  }, [fetchRecentMessages]);

  // Realtime subscription for incoming order messages across all orders
  useEffect(() => {
    if (!role) return;

    const channel = supabase
      .channel("ops-notes-channel")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "order_messages" },
        async (payload) => {
          const newMsg = payload.new;
          if (!newMsg || !newMsg.order_id) return;

          // Look up order_number
          const { data: orderData } = await supabase
            .from("orders")
            .select("id, order_number")
            .eq("id", newMsg.order_id)
            .single();

          const orderNum = orderData?.order_number || "Unknown";
          const newNotif: OrderNotification = {
            id: String(newMsg.id || Date.now()),
            orderId: newMsg.order_id,
            orderNumber: orderNum,
            senderType: newMsg.sender_type,
            senderLabel: newMsg.sender_label || (newMsg.sender_type === "brand" ? "Brand" : "Ops Team"),
            body: newMsg.body,
            createdAt: newMsg.created_at || new Date().toISOString(),
            read: false,
          };

          // Trigger top banner
          setActiveBanner(newNotif);

          // Add to notification list
          setNotifications((prev) => {
            if (prev.some((n) => n.id === newNotif.id)) return prev;
            return [newNotif, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [role]);

  const dismissBanner = useCallback(() => {
    setActiveBanner(null);
  }, []);

  const markAsRead = useCallback(async (id: string, orderId?: string) => {
    saveReadId(id);
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    if (orderId) {
      try {
        await supabase.rpc("mark_messages_read", { p_order_id: orderId });
      } catch (e) {
        console.warn("Could not mark messages read in database:", e);
      }
    }
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) =>
      prev.map((n) => {
        saveReadId(n.id);
        if (n.orderId) {
          void supabase.rpc("mark_messages_read", { p_order_id: n.orderId });
        }
        return { ...n, read: true };
      })
    );
  }, []);

  const removeNotification = useCallback((id: string) => {
    saveReadId(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const addNotification = useCallback((notif: Omit<OrderNotification, "id" | "createdAt" | "read">) => {
    const created: OrderNotification = {
      ...notif,
      id: String(Date.now()),
      createdAt: new Date().toISOString(),
      read: false,
    };
    setActiveBanner(created);
    setNotifications((prev) => [created, ...prev]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        activeBanner,
        isOpen,
        setIsOpen,
        toggleOpen,
        dismissBanner,
        markAsRead,
        markAllAsRead,
        removeNotification,
        addNotification,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}
