import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useMarkMessagesRead, useOrderMessages, useSendMessage } from "@/hooks/useData";
import { fmtDateTime } from "@/lib/format";
import { Spinner, ErrorState } from "@/components/ui/States";
import type { OrderMessage } from "@/lib/types";

interface Props { orderId: string; brandName: string }

function Bubble({ msg }: { msg: OrderMessage }) {
  const isAdmin = msg.sender_type === "admin";
  return (
    <div className={`flex flex-col gap-0.5 ${isAdmin ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words ${
          isAdmin
            ? "rounded-br-sm bg-primary text-primary-fg"
            : "rounded-bl-sm bg-sunken text-ink border border-line"
        }`}
      >
        {msg.body}
      </div>
      <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-faint">
        <span>{isAdmin ? msg.sender_label : msg.sender_label}</span>
        <span>·</span>
        <span>{fmtDateTime(msg.created_at)}</span>
        {!msg.read_by_brand && !isAdmin && (
          <span className="rounded bg-primary/10 px-1 text-[10.5px] font-medium text-primary">Unread by brand</span>
        )}
      </div>
    </div>
  );
}

export function OrderMessages({ orderId, brandName }: Props) {
  const q = useOrderMessages(orderId);
  const send = useSendMessage({ inlineErrors: true });
  const markRead = useMarkMessagesRead(orderId);
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [q.data?.length]);

  // Mark brand messages as read when admin opens the tab
  useEffect(() => {
    if (q.data && q.data.some((m) => m.sender_type === "brand" && !m.read_by_admin)) {
      markRead.mutate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const submit = () => {
    const body = text.trim();
    if (!body || send.isPending) return;
    send.mutate({ orderId, body }, { onSuccess: () => setText("") });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (q.isLoading) return <Spinner label="Loading messages" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const messages = q.data ?? [];
  const unreadFromBrand = messages.filter((m) => m.sender_type === "brand" && !m.read_by_admin).length;

  return (
    <div className="flex flex-col gap-3">
      {unreadFromBrand > 0 && (
        <div className="rounded-md bg-primary/10 px-3 py-2 text-[13px] text-primary font-medium">
          {unreadFromBrand} unread message{unreadFromBrand > 1 ? "s" : ""} from {brandName}
        </div>
      )}

      {/* Message thread */}
      <div className="flex max-h-[420px] min-h-[180px] flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface p-4">
        {messages.length === 0 ? (
          <p className="m-auto text-[13.5px] text-muted">No messages yet for this order.</p>
        ) : (
          messages.map((msg) => <Bubble key={msg.id} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2">
        <textarea
          className="input min-h-[68px] flex-1 resize-none text-[13.5px]"
          placeholder={`Reply to ${brandName}… (Enter to send, Shift+Enter for new line)`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={send.isPending}
          rows={3}
        />
        <button
          onClick={submit}
          disabled={!text.trim() || send.isPending}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
