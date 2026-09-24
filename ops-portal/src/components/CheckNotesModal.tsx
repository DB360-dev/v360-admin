import { useState } from "react";
import { FileText, MessageSquare, User } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { useAddNote, useOrder, useOrderEvents, useOrderMessages } from "@/hooks/useData";
import { fmtDateTime } from "@/lib/format";
import { Spinner } from "./ui/States";

interface CheckNotesModalProps {
  orderId: string;
  orderNumber: string;
  customerNote?: string | null;
  shopifyNote?: string | null;
  hubNotes?: string | null;
  open: boolean;
  onClose: () => void;
}

export function CheckNotesModal({
  orderId,
  orderNumber,
  customerNote: initialCustomerNote,
  shopifyNote: initialShopifyNote,
  hubNotes: initialHubNotes,
  open,
  onClose,
}: CheckNotesModalProps) {
  const orderQuery = useOrder(orderId);
  const eventsQuery = useOrderEvents(orderId);
  const messagesQuery = useOrderMessages(orderId);
  const addNote = useAddNote();
  const [newNote, setNewNote] = useState("");

  const orderData = orderQuery.data;
  const customerNote = initialCustomerNote ?? orderData?.customer_note;
  const shopifyNote = initialShopifyNote ?? orderData?.shopify_note;
  const hubNotes = initialHubNotes ?? orderData?.hub_notes;

  const events = eventsQuery.data ?? [];
  const notesFromEvents = events.filter((e) => e.note && e.note.trim().length > 0);
  const messages = messagesQuery.data ?? [];

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    addNote.mutate(
      { id: orderId, note: newNote.trim() },
      {
        onSuccess: () => {
          setNewNote("");
          eventsQuery.refetch();
        },
      }
    );
  };

  const hasSpecialNotes = Boolean(customerNote || shopifyNote || hubNotes);
  const isLoading = eventsQuery.isLoading || messagesQuery.isLoading;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Notes & Messages for Order ${orderNumber}`}
      width="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Special Notes Section */}
        {hasSpecialNotes && (
          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-faint">Order Attribute Notes</h3>
            {customerNote && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[13px]">
                <span className="font-semibold text-amber-600 dark:text-amber-400">Customer Note: </span>
                <span className="text-ink">{customerNote}</span>
              </div>
            )}
            {shopifyNote && (
              <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-[13px]">
                <span className="font-semibold text-blue-600 dark:text-blue-400">Shopify Note: </span>
                <span className="text-ink">{shopifyNote}</span>
              </div>
            )}
            {hubNotes && (
              <div className="rounded-md border border-purple-500/30 bg-purple-500/10 p-3 text-[13px]">
                <span className="font-semibold text-purple-600 dark:text-purple-400">Hub Note: </span>
                <span className="text-ink">{hubNotes}</span>
              </div>
            )}
          </div>
        )}

        {/* Add Note Input Form */}
        <form onSubmit={handleAddNote} className="flex items-center gap-2 rounded-lg border border-line bg-sunken/40 p-2">
          <input
            type="text"
            className="input text-[13px] flex-1 bg-surface"
            placeholder="Add a new note to this order..."
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!newNote.trim() || addNote.isPending}>
            {addNote.isPending ? "Adding..." : "Add note"}
          </Button>
        </form>

        {/* Notes Timeline / History */}
        <div className="space-y-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-faint flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" /> Activity Notes & History
          </h3>

          {isLoading ? (
            <Spinner label="Loading notes..." />
          ) : notesFromEvents.length === 0 && messages.length === 0 && !hasSpecialNotes ? (
            <p className="py-4 text-center text-[13px] text-muted">No notes recorded for this order yet.</p>
          ) : (
            <div className="max-h-[280px] overflow-y-auto space-y-2 pr-1">
              {notesFromEvents.map((evt) => (
                <div key={evt.id} className="rounded-lg border border-line bg-surface p-3 text-[13px]">
                  <div className="flex items-center justify-between text-[11.5px] text-muted mb-1">
                    <span className="font-medium text-ink flex items-center gap-1">
                      <User className="h-3 w-3 text-faint" />
                      {evt.actor_label ?? "Staff"}
                    </span>
                    <span>{fmtDateTime(evt.created_at)}</span>
                  </div>
                  <p className="text-ink">{evt.note}</p>
                  {evt.from_status && evt.to_status && (
                    <div className="mt-1 text-[11px] text-faint">
                      Status changed from {evt.from_status} to {evt.to_status}
                    </div>
                  )}
                </div>
              ))}

              {messages.map((msg) => (
                <div key={msg.id} className="rounded-lg border border-primary/20 bg-primary-soft/20 p-3 text-[13px]">
                  <div className="flex items-center justify-between text-[11.5px] text-muted mb-1">
                    <span className="font-medium text-primary flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      Message from {msg.sender_type}
                    </span>
                    <span>{fmtDateTime(msg.created_at)}</span>
                  </div>
                  <p className="text-ink">{msg.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
